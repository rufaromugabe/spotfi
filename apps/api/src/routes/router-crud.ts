import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { RouterCreateSchema } from '@spotfi/shared';
import { randomBytes } from 'crypto';
import { AuthenticatedUser } from '../types/fastify.js';
import { prisma } from '../lib/prisma.js';
import { NasService } from '../services/nas.js';
import { routerAccessService } from '../services/router-access.service.js';
import { routerStatusService } from '../services/router-status.service.js';
import { assertAuthenticated, requireAdmin } from '../utils/router-middleware.js';

export async function routerCrudRoutes(fastify: FastifyInstance) {
  const nasService = new NasService(fastify.log);

  // List routers (with pagination)
  fastify.get('/', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['routers'],
      summary: 'List routers',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'number', minimum: 1, default: 1 },
          limit: { type: 'number', minimum: 1, maximum: 100, default: 50 }
        }
      }
    }
  }, async (request: FastifyRequest) => {
    assertAuthenticated(request);
    const user = request.user as AuthenticatedUser;
    const { page = 1, limit = 50 } = request.query as { page?: number; limit?: number };
    
    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(100, Math.max(1, Number(limit))); // Max 100 per page
    const skip = (pageNum - 1) * limitNum;
    
    const where = user.role === 'ADMIN' ? {} : { hostId: user.userId };

    const [routers, total] = await Promise.all([
      prisma.router.findMany({
        where,
        include: {
          host: {
            select: { id: true, email: true }
          }
        },
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limitNum
      }),
      prisma.router.count({ where })
    ]);

    // Check actual WebSocket connection status and update DB if needed
    const routersWithRealStatus = await Promise.all(
      routers.map((router) => 
        routerStatusService.getRouterWithRealStatus(router, fastify.log)
      )
    );

    return {
      routers: routersWithRealStatus,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
        hasMore: skip + routers.length < total
      }
    };
  });

  // Get single router
  fastify.get('/:id', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['routers'],
      summary: 'Get router details',
      security: [{ bearerAuth: [] }]
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertAuthenticated(request);
    const user = request.user as AuthenticatedUser;
    const { id } = request.params as { id: string };

    const router = await routerAccessService.verifyRouterAccess(id, user);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    const routerWithHost = await prisma.router.findFirst({
      where: { id },
      include: {
        host: {
          select: { id: true, email: true }
        }
      }
    });

    if (!routerWithHost) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    // Check actual WebSocket connection status (real-time)
    const routerWithRealStatus = await routerStatusService.getRouterWithRealStatus(
      routerWithHost,
      fastify.log
    );

    return {
      router: routerWithRealStatus
    };
  });

  // Create router (Admin only)
  fastify.post('/', {
    preHandler: [fastify.authenticate, requireAdmin],
    schema: {
      tags: ['routers'],
      summary: 'Create router',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['name', 'hostId', 'macAddress'],
        properties: {
          name: { type: 'string' },
          hostId: { type: 'string' },
          macAddress: { 
            type: 'string',
            pattern: '^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$|^[0-9A-Fa-f]{12}$'
          },
          location: { type: 'string' }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertAuthenticated(request);
    const body = RouterCreateSchema.parse(request.body);

    // Validate host exists and has HOST role
    const host = await prisma.user.findUnique({
      where: { id: body.hostId },
      select: { id: true, role: true }
    });

    if (!host) {
      return reply.code(404).send({ error: 'Host not found' });
    }

    if (host.role !== 'HOST') {
      return reply.code(400).send({ error: 'User must have HOST role' });
    }

    // Format MAC address
    const normalizedMac = body.macAddress.replace(/[:-]/g, '').toUpperCase();
    const formattedMac = normalizedMac.match(/.{2}/g)?.join(':');

    if (!formattedMac || !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(formattedMac)) {
      return reply.code(400).send({ error: 'Invalid MAC address' });
    }

 
    const uniqueUamSecret = randomBytes(16).toString('hex');

    // Create router with unique UAM secret
    const router = await prisma.router.create({
      data: {
        name: body.name,
        hostId: body.hostId,
        token: randomBytes(32).toString('hex'),
        uamSecret: uniqueUamSecret, // Unique per-router UAM secret
        macAddress: formattedMac,
        location: body.location,
        status: 'OFFLINE'
      },
      include: {
        host: {
          select: { id: true, email: true }
        }
      }
    });

    fastify.log.info(`Router created: ${router.id}`);
    return { router };
  });

  // Update router
  fastify.put('/:id', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['routers'],
      summary: 'Update router',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          location: { type: 'string' }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertAuthenticated(request);
    const user = request.user as AuthenticatedUser;
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; location?: string };

    const router = await routerAccessService.verifyRouterAccess(id, user);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    const updated = await prisma.router.update({
      where: { id },
      data: {
        ...(body.name && { name: body.name }),
        ...(body.location && { location: body.location })
      }
    });

    return { router: updated };
  });

  // Delete router
  fastify.delete('/:id', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['routers'],
      summary: 'Delete router',
      security: [{ bearerAuth: [] }]
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertAuthenticated(request);
    const user = request.user as AuthenticatedUser;
    const { id } = request.params as { id: string };

    const router = await routerAccessService.verifyRouterAccess(id, user);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    // Remove NAS entry if router has IP
    if (router.nasipaddress) {
      await nasService.removeNasEntry(router.nasipaddress, router.id);
    }

    // Delete router (cascades to sessions and invoices)
    await prisma.router.delete({ where: { id } });

    fastify.log.info(`Router deleted: ${id}`);
    return { message: 'Router deleted' };
  });
}

