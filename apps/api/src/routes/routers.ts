import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { RouterCreateSchema, RouterCommandSchema } from '@spotfi/shared';
import { randomBytes } from 'crypto';
import { routerWebSocketConnections } from '../websocket/server.js';
import { requireAdmin } from '../utils/auth.js';

const prisma = new PrismaClient();

export async function routerRoutes(fastify: FastifyInstance) {
  // Get all routers (for current user)
  fastify.get(
    '/',
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ['routers'],
        summary: 'List all routers',
        description: 'Get all routers for the authenticated user',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              routers: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    status: { type: 'string' },
                    lastSeen: { type: 'string', format: 'date-time', nullable: true },
                    totalUsage: { type: 'number' },
                    createdAt: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user as any;

      // Admins can see all routers, hosts can only see their own
      const whereClause = user.role === 'ADMIN' 
        ? {} 
        : { hostId: user.userId };

      const routers = await prisma.router.findMany({
        where: whereClause,
        include: {
          host: {
            select: {
              id: true,
              email: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      return { routers };
    }
  );

  // Get single router
  fastify.get(
    '/:id',
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ['routers'],
        summary: 'Get router by ID',
        description: 'Get detailed information about a specific router',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              router: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  status: { type: 'string' },
                },
              },
            },
          },
          404: {
            type: 'object',
            properties: {
              error: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user as any;
      const { id } = request.params as { id: string };

      // Admins can access any router, hosts can only access their own
      const whereClause = user.role === 'ADMIN'
        ? { id }
        : { id, hostId: user.userId };

      const router = await prisma.router.findFirst({
        where: whereClause,
        include: {
          host: {
            select: {
              id: true,
              email: true,
            },
          },
        },
      });

      if (!router) {
        return reply.code(404).send({ error: 'Router not found' });
      }

      return { router };
    }
  );

  // Create router (Admin only - can assign routers to specific hosts)
  fastify.post(
    '/',
    {
      preHandler: [fastify.authenticate, requireAdmin],
      schema: {
        tags: ['routers'],
        summary: 'Create a new router',
        description: 'Register a new router for a specific host (Admin only)',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['name', 'hostId'],
          properties: {
            name: { type: 'string' },
            hostId: { type: 'string', description: 'ID of the host user (must be HOST role)' },
            nasipaddress: { type: 'string', format: 'ipv4' },
            location: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              router: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  token: { type: 'string' },
                  status: { type: 'string' },
                  createdAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
          400: {
            type: 'object',
            properties: {
              error: { type: 'string' },
            },
          },
          404: {
            type: 'object',
            properties: {
              error: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = RouterCreateSchema.parse(request.body);

      // Validate that the host exists and is a HOST role
      const host = await prisma.user.findUnique({
        where: { id: body.hostId },
        select: { id: true, role: true, email: true },
      });

      if (!host) {
        return reply.code(404).send({ error: 'Host user not found' });
      }

      if (host.role !== 'HOST') {
        return reply.code(400).send({ 
          error: 'Can only assign routers to users with HOST role' 
        });
      }

      // Generate unique token for router
      const token = randomBytes(32).toString('hex');

      const router = await prisma.router.create({
        data: {
          name: body.name,
          hostId: body.hostId, // Use provided hostId, not current user
          token,
          nasipaddress: body.nasipaddress,
          location: body.location,
          status: 'OFFLINE',
        },
        include: {
          host: {
            select: {
              id: true,
              email: true,
            },
          },
        },
      });

      return { router };
    }
  );

  // Update router
  fastify.put(
    '/:id',
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ['routers'],
        summary: 'Update router',
        description: 'Update router information',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            location: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              router: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                },
              },
            },
          },
          404: {
            type: 'object',
            properties: {
              error: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user as any;
      const { id } = request.params as { id: string };
      const body = request.body as Partial<{ name: string; location: string }>;

      // Admins can update any router, hosts can only update their own
      const whereClause = user.role === 'ADMIN'
        ? { id }
        : { id, hostId: user.userId };

      const router = await prisma.router.findFirst({
        where: whereClause,
      });

      if (!router) {
        return reply.code(404).send({ error: 'Router not found' });
      }

      const updated = await prisma.router.update({
        where: { id },
        data: {
          name: body.name,
          location: body.location,
        },
        include: {
          host: {
            select: {
              id: true,
              email: true,
            },
          },
        },
      });

      return { router: updated };
    }
  );

  // Delete router
  fastify.delete(
    '/:id',
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ['routers'],
        summary: 'Delete router',
        description: 'Delete a router',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              message: { type: 'string' },
            },
          },
          404: {
            type: 'object',
            properties: {
              error: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user as any;
      const { id } = request.params as { id: string };

      // Admins can delete any router, hosts can only delete their own
      const whereClause = user.role === 'ADMIN'
        ? { id }
        : { id, hostId: user.userId };

      const router = await prisma.router.findFirst({
        where: whereClause,
      });

      if (!router) {
        return reply.code(404).send({ error: 'Router not found' });
      }

      await prisma.router.delete({
        where: { id },
      });

      return { message: 'Router deleted' };
    }
  );

  // Send command to router
  fastify.post(
    '/:id/command',
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ['routers'],
        summary: 'Send command to router',
        description: 'Send a remote command to a router via WebSocket',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
        },
        body: {
          type: 'object',
          required: ['command'],
          properties: {
            command: {
              type: 'string',
              enum: ['reboot', 'fetch-logs', 'get-status', 'update-config'],
            },
            params: { type: 'object' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              message: { type: 'string' },
              commandId: { type: 'string' },
              command: { type: 'string' },
            },
          },
          503: {
            type: 'object',
            properties: {
              error: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user as any;
      const { id } = request.params as { id: string };
      const body = RouterCommandSchema.parse(request.body);

      // Admins can send commands to any router, hosts can only send to their own
      const whereClause = user.role === 'ADMIN'
        ? { id }
        : { id, hostId: user.userId };

      const router = await prisma.router.findFirst({
        where: whereClause,
      });

      if (!router) {
        return reply.code(404).send({ error: 'Router not found' });
      }

      // Check if router is connected via WebSocket
      const ws = routerWebSocketConnections.get(id);
      if (!ws || ws.readyState !== 1) {
        return reply.code(503).send({ error: 'Router is offline' });
      }

      // Send command via WebSocket
      const commandId = randomBytes(8).toString('hex');
      const message = {
        id: commandId,
        type: 'command',
        command: body.command,
        params: body.params || {},
        timestamp: new Date().toISOString(),
      };

      ws.send(JSON.stringify(message));

      return {
        message: 'Command sent',
        commandId,
        command: body.command,
      };
    }
  );

  // Get router statistics
  fastify.get(
    '/:id/stats',
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ['routers'],
        summary: 'Get router statistics',
        description: 'Get usage statistics and recent sessions for a router',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              router: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  status: { type: 'string' },
                  totalUsage: { type: 'number' },
                },
              },
              stats: {
                type: 'object',
                properties: {
                  monthlyUsageBytes: { type: 'number' },
                  monthlyUsageMB: { type: 'number' },
                  recentSessionsCount: { type: 'number' },
                },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user as any;
      const { id } = request.params as { id: string };

      // Admins can view stats for any router, hosts can only view their own
      const whereClause = user.role === 'ADMIN'
        ? { id }
        : { id, hostId: user.userId };

      const router = await prisma.router.findFirst({
        where: whereClause,
      });

      if (!router) {
        return reply.code(404).send({ error: 'Router not found' });
      }

      // Get recent sessions from radacct
      const recentSessions = await prisma.radAcct.findMany({
        where: { routerId: id },
        orderBy: { acctstarttime: 'desc' },
        take: 100,
        select: {
          acctuniqueid: true,
          username: true,
          acctstarttime: true,
          acctstoptime: true,
          accttotaloctets: true,
        },
      });

      // Calculate total usage for current month
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);

      const monthlySessions = await prisma.radAcct.findMany({
        where: {
          routerId: id,
          acctstarttime: {
            gte: startOfMonth,
          },
        },
      });

      const monthlyUsage = monthlySessions.reduce((sum: number, session) => {
        return sum + Number(session.accttotaloctets || 0);
      }, 0);

      return {
        router: {
          id: router.id,
          name: router.name,
          status: router.status,
          lastSeen: router.lastSeen,
          totalUsage: router.totalUsage,
        },
        stats: {
          monthlyUsageBytes: monthlyUsage,
          monthlyUsageMB: monthlyUsage / (1024 * 1024),
          recentSessionsCount: recentSessions.length,
          recentSessions,
        },
      };
    }
  );
}

