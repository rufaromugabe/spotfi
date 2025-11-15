import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { RouterCreateSchema } from '@spotfi/shared';
import { randomBytes } from 'crypto';
import { WebSocket } from 'ws';
import { activeConnections } from '../websocket/server.js';
import { NasService } from '../services/nas.js';
import { prisma } from '../lib/prisma.js';

function requireAdmin(request: FastifyRequest, reply: FastifyReply, done: Function) {
  const user = request.user as any;
  if (user.role !== 'ADMIN') {
    reply.code(403).send({ error: 'Admin access required' });
    return;
  }
  done();
}

export async function routerRoutes(fastify: FastifyInstance) {
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
    const user = request.user as any;
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

    return {
      routers,
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
    const user = request.user as any;
    const { id } = request.params as { id: string };
    const where = user.role === 'ADMIN' ? { id } : { id, hostId: user.userId };

    const router = await prisma.router.findFirst({
      where,
      include: {
        host: {
          select: { id: true, email: true }
        }
      }
    });

    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    return { router };
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

    // Create router
    const router = await prisma.router.create({
      data: {
        name: body.name,
        hostId: body.hostId,
        token: randomBytes(32).toString('hex'),
        radiusSecret: randomBytes(16).toString('hex'),
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
    const user = request.user as any;
    const { id } = request.params as { id: string };
    const body = request.body as any;
    const where = user.role === 'ADMIN' ? { id } : { id, hostId: user.userId };

    const existing = await prisma.router.findFirst({ where });
    if (!existing) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    const router = await prisma.router.update({
      where: { id },
      data: {
        ...(body.name && { name: body.name }),
        ...(body.location && { location: body.location })
      }
    });

    return { router };
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
    const user = request.user as any;
    const { id } = request.params as { id: string };
    const where = user.role === 'ADMIN' ? { id } : { id, hostId: user.userId };

    const router = await prisma.router.findFirst({ where });
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

  // Send command to router
  fastify.post('/:id/command', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['routers'],
      summary: 'Send command to router',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['command'],
        properties: {
          command: {
            type: 'string',
            enum: ['reboot', 'fetch-logs', 'get-status', 'update-config', 'setup-chilli']
          },
          params: {
            type: 'object',
            description: 'Command parameters (required for setup-chilli)',
            properties: {
              radiusIp: { type: 'string', description: 'RADIUS server IP address' },
              portalUrl: { type: 'string', description: 'Portal URL (optional, defaults to API URL)' }
            }
          }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as any;
    const { id } = request.params as { id: string };
    const { command, params } = request.body as { command: string; params?: any };
    const where = user.role === 'ADMIN' ? { id } : { id, hostId: user.userId };

    const router = await prisma.router.findFirst({ 
      where,
      select: {
        id: true,
        macAddress: true,
        radiusSecret: true,
        hostId: true
      }
    });
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    // For setup-chilli, require admin and validate params
    if (command === 'setup-chilli') {
      if (user.role !== 'ADMIN') {
        return reply.code(403).send({ error: 'Admin access required for chilli setup' });
      }
      if (!params?.radiusIp) {
        return reply.code(400).send({ error: 'radiusIp parameter is required for setup-chilli' });
      }
      if (!router.radiusSecret) {
        return reply.code(400).send({ error: 'Router missing RADIUS secret' });
      }
      if (!router.macAddress) {
        return reply.code(400).send({ error: 'Router missing MAC address' });
      }
    }

    const socket = activeConnections.get(id);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return reply.code(503).send({ error: 'Router offline' });
    }

    const commandPayload: any = {
      type: 'command',
      command,
      timestamp: new Date().toISOString()
    };

    // Add parameters for setup-chilli command
    if (command === 'setup-chilli') {
      commandPayload.params = {
        routerId: router.id,
        radiusSecret: router.radiusSecret,
        macAddress: router.macAddress,
        radiusIp: params.radiusIp,
        portalUrl: params.portalUrl || process.env.API_URL || 'https://api.spotfi.com'
      };
    }

    socket.send(JSON.stringify(commandPayload));

    return { message: 'Command sent', command, ...(command === 'setup-chilli' && { params: { radiusIp: params.radiusIp } }) };
  });

  // Get router statistics
  fastify.get('/:id/stats', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['routers'],
      summary: 'Get router statistics',
      security: [{ bearerAuth: [] }]
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as any;
    const { id } = request.params as { id: string };
    const where = user.role === 'ADMIN' ? { id } : { id, hostId: user.userId };

    const router = await prisma.router.findFirst({ where });
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    // Optimized: Single query instead of two separate queries (2x faster)
    const stats = await prisma.$queryRaw<[{
      total_sessions: bigint;
      active_sessions: bigint;
      total_bytes_in: bigint;
      total_bytes_out: bigint;
    }]>`
      SELECT 
        COUNT(*)::bigint as total_sessions,
        COUNT(*) FILTER (WHERE acctstoptime IS NULL)::bigint as active_sessions,
        COALESCE(SUM(acctinputoctets), 0)::bigint as total_bytes_in,
        COALESCE(SUM(acctoutputoctets), 0)::bigint as total_bytes_out
      FROM radacct
      WHERE "routerId" = ${id}
    `;

    const result = stats[0] || {
      total_sessions: 0n,
      active_sessions: 0n,
      total_bytes_in: 0n,
      total_bytes_out: 0n
    };

    return {
      router: {
        id: router.id,
        name: router.name,
        status: router.status,
        totalUsage: router.totalUsage
      },
      stats: {
        totalSessions: Number(result.total_sessions),
        activeSessions: Number(result.active_sessions),
        totalBytesIn: Number(result.total_bytes_in),
        totalBytesOut: Number(result.total_bytes_out),
        totalBytes: Number(result.total_bytes_in) + Number(result.total_bytes_out)
      }
    };
  });
}
