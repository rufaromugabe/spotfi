/**
 * Session Management Routes
 * Handles active session viewing and remote disconnect
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../lib/prisma.js';

export async function sessionRoutes(fastify: FastifyInstance) {
  // List active sessions
  fastify.get('/api/sessions', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['sessions'],
      summary: 'List active sessions',
      description: 'Get all active user sessions across routers',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          routerId: { type: 'string' },
          username: { type: 'string' },
          page: { type: 'number', minimum: 1, default: 1 },
          limit: { type: 'number', minimum: 1, maximum: 100, default: 50 }
        }
      }
    }
  }, async (request: FastifyRequest) => {
    const user = request.user as any;
    const query = request.query as {
      routerId?: string;
      username?: string;
      page?: number;
      limit?: number;
    };

    const pageNum = Math.max(1, Number(query.page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(query.limit) || 50));
    const skip = (pageNum - 1) * limitNum;

    // Build where clause
    const where: any = {
      acctStopTime: null // Active sessions only
    };

    // Filter by router if user is not admin
    if (user.role !== 'ADMIN') {
      const routers = await prisma.router.findMany({
        where: { hostId: user.userId },
        select: { id: true }
      });
      where.routerId = { in: routers.map(r => r.id) };
    } else if (query.routerId) {
      where.routerId = query.routerId;
    }

    if (query.username) {
      where.userName = query.username;
    }

    const [sessions, total] = await Promise.all([
      prisma.radAcct.findMany({
        where,
        include: {
          router: {
            select: {
              id: true,
              name: true,
              nasipaddress: true
            }
          }
        },
        orderBy: { acctStartTime: 'desc' },
        skip,
        take: limitNum
      }),
      prisma.radAcct.count({ where })
    ]);

    return {
      sessions: sessions.map(s => ({
        sessionId: s.acctSessionId,
        username: s.userName,
        routerId: s.routerId,
        routerName: s.router?.name,
        startTime: s.acctStartTime,
        bytesIn: Number(s.acctInputOctets || 0),
        bytesOut: Number(s.acctOutputOctets || 0),
        totalBytes: Number(s.acctInputOctets || 0) + Number(s.acctOutputOctets || 0),
        clientIp: s.framedIpAddress
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum)
      }
    };
  });

  // Disconnect a session (Admin only)
  fastify.post('/api/sessions/:sessionId/disconnect', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['sessions'],
      summary: 'Disconnect active session',
      description: 'Remotely disconnect a user session (Admin only)',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as any;
    
    if (user.role !== 'ADMIN') {
      return reply.code(403).send({ error: 'Admin access required' });
    }

    const { sessionId } = request.params as { sessionId: string };

    // Find active session
    const session = await prisma.radAcct.findFirst({
      where: {
        acctSessionId: sessionId,
        acctStopTime: null
      },
      include: {
        router: {
          select: {
            id: true,
            nasipaddress: true
          }
        }
      }
    });

    if (!session) {
      return reply.code(404).send({ error: 'Active session not found' });
    }

    // Mark session as stopped
    await prisma.radAcct.update({
      where: { radAcctId: session.radAcctId },
      data: {
        acctStopTime: new Date(),
        acctTerminateCause: 'Admin-Reset'
      }
    });

    fastify.log.info(`Session ${sessionId} disconnected by admin ${user.userId}`);

    return {
      success: true,
      message: 'Session disconnected',
      session: {
        sessionId: session.acctSessionId,
        username: session.userName,
        routerId: session.routerId
      }
    };
  });

  // Disconnect user from all routers
  fastify.post('/api/sessions/user/:username/disconnect', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['sessions'],
      summary: 'Disconnect user from all routers',
      description: 'Remotely disconnect a user from all active sessions (Admin only)',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          username: { type: 'string' }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as any;
    
    if (user.role !== 'ADMIN') {
      return reply.code(403).send({ error: 'Admin access required' });
    }

    const { username } = request.params as { username: string };

    // Find all active sessions for user
    const sessions = await prisma.radAcct.findMany({
      where: {
        userName: username,
        acctStopTime: null
      }
    });

    if (sessions.length === 0) {
      return reply.code(404).send({ error: 'No active sessions found for user' });
    }

    // Disconnect all sessions
    await prisma.radAcct.updateMany({
      where: {
        userName: username,
        acctStopTime: null
      },
      data: {
        acctStopTime: new Date(),
        acctTerminateCause: 'Admin-Reset'
      }
    });

    fastify.log.info(`User ${username} disconnected from ${sessions.length} session(s) by admin ${user.userId}`);

    return {
      success: true,
      message: `Disconnected ${sessions.length} session(s)`,
      username,
      sessionsDisconnected: sessions.length
    };
  });
}

