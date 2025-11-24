import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { RouterCreateSchema } from '@spotfi/shared';
import { randomBytes } from 'crypto';
import { WebSocket } from 'ws';
import { activeConnections } from '../websocket/server.js';
import { NasService } from '../services/nas.js';
import { prisma } from '../lib/prisma.js';

// Helper function to check actual router connection status
function checkRouterConnectionStatus(routerId: string): 'ONLINE' | 'OFFLINE' {
  const socket = activeConnections.get(routerId);
  const isActuallyOnline = socket && socket.readyState === WebSocket.OPEN;
  return isActuallyOnline ? 'ONLINE' : 'OFFLINE';
}

// Helper function to update router status in DB asynchronously (fire-and-forget)
async function updateRouterStatusIfNeeded(
  routerId: string,
  dbStatus: string,
  actualStatus: 'ONLINE' | 'OFFLINE',
  logger: any
): Promise<void> {
  if (dbStatus !== actualStatus) {
    // Update DB asynchronously - don't block response
    prisma.router
      .update({
        where: { id: routerId },
        data: {
          status: actualStatus,
          ...(actualStatus === 'ONLINE' && { lastSeen: new Date() })
        }
      })
      .catch((err: unknown) => {
        logger.error(`Failed to update router status for ${routerId}: ${err}`);
      });
  }
}

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

    // Check actual WebSocket connection status and update DB if needed
    const routersWithRealStatus = routers.map((router: typeof routers[0]) => {
      const actualStatus = checkRouterConnectionStatus(router.id);
      
      // Update DB asynchronously if status differs (don't block response)
      if (router.status !== actualStatus) {
        updateRouterStatusIfNeeded(router.id, router.status, actualStatus, fastify.log);
      }

      return {
        ...router,
        status: actualStatus
      };
    });

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

    // Check actual WebSocket connection status (real-time)
    const actualStatus = checkRouterConnectionStatus(id);

    // Update DB asynchronously if status differs (don't block response)
    if (router.status !== actualStatus) {
      updateRouterStatusIfNeeded(id, router.status, actualStatus, fastify.log);
    }

    // Return router with corrected status
    return {
      router: {
        ...router,
        status: actualStatus
      }
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

  // Get router usage statistics for a specific time period
  fastify.get('/:id/usage', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['routers'],
      summary: 'Get router usage statistics for a time period',
      description: 'Calculate total data usage (bytes in/out) for a router over a specified time period',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' }
        },
        required: ['id']
      },
      querystring: {
        type: 'object',
        properties: {
          startDate: { 
            type: 'string', 
            format: 'date-time',
            description: 'Start date (ISO 8601). Defaults to 30 days ago if not provided.'
          },
          endDate: { 
            type: 'string', 
            format: 'date-time',
            description: 'End date (ISO 8601). Defaults to now if not provided.'
          },
          groupBy: {
            type: 'string',
            enum: ['day', 'week', 'month', 'none'],
            default: 'none',
            description: 'Group usage by time period. "none" returns total only.'
          }
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            routerId: { type: 'string' },
            routerName: { type: 'string' },
            period: {
              type: 'object',
              properties: {
                start: { type: 'string', format: 'date-time' },
                end: { type: 'string', format: 'date-time' }
              }
            },
            total: {
              type: 'object',
              properties: {
                bytesIn: { type: 'number' },
                bytesOut: { type: 'number' },
                totalBytes: { type: 'number' },
                totalGB: { type: 'number' },
                sessions: { type: 'number' }
              }
            },
            grouped: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  period: { type: 'string' },
                  bytesIn: { type: 'number' },
                  bytesOut: { type: 'number' },
                  totalBytes: { type: 'number' },
                  totalGB: { type: 'number' },
                  sessions: { type: 'number' }
                }
              }
            }
          }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as any;
    const { id } = request.params as { id: string };
    const query = request.query as {
      startDate?: string;
      endDate?: string;
      groupBy?: 'day' | 'week' | 'month' | 'none';
    };

    const where = user.role === 'ADMIN' ? { id } : { id, hostId: user.userId };
    const router = await prisma.router.findFirst({ where });
    
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    // Parse dates or use defaults
    const endDate = query.endDate ? new Date(query.endDate) : new Date();
    const startDate = query.startDate 
      ? new Date(query.startDate) 
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // Default: 30 days ago

    if (startDate >= endDate) {
      return reply.code(400).send({ error: 'Start date must be before end date' });
    }

    const groupBy = query.groupBy || 'none';

    try {
      if (groupBy === 'none') {
        // Use materialized counters table (router_daily_usage) instead of scanning radacct
        // This queries hundreds of rows instead of millions - 1000x faster
        const stats = await prisma.$queryRaw<[{
          total_bytes_in: bigint;
          total_bytes_out: bigint;
          total_sessions: bigint;
        }]>`
          SELECT 
            COALESCE(SUM(bytes_in), 0)::bigint as total_bytes_in,
            COALESCE(SUM(bytes_out), 0)::bigint as total_bytes_out,
            -- Session count still needs radacct, but this is much faster with date filter
            (SELECT COUNT(*)::bigint FROM radacct 
             WHERE "routerId" = ${id}
               AND acctstarttime >= ${startDate}
               AND acctstarttime < ${endDate}
               AND acctstoptime IS NOT NULL) as total_sessions
          FROM router_daily_usage
          WHERE router_id = ${id}
            AND usage_date >= DATE(${startDate})
            AND usage_date < DATE(${endDate})
        `;

        const result = stats[0] || {
          total_bytes_in: 0n,
          total_bytes_out: 0n,
          total_sessions: 0n
        };

        const totalBytesIn = Number(result.total_bytes_in);
        const totalBytesOut = Number(result.total_bytes_out);
        const totalBytes = totalBytesIn + totalBytesOut;

        return {
          routerId: router.id,
          routerName: router.name,
          period: {
            start: startDate.toISOString(),
            end: endDate.toISOString()
          },
          total: {
            bytesIn: totalBytesIn,
            bytesOut: totalBytesOut,
            totalBytes,
            totalGB: totalBytes / (1024 * 1024 * 1024),
            sessions: Number(result.total_sessions)
          },
          grouped: []
        };
      } else {
        // Grouped by time period
        let dateTrunc: string;
        switch (groupBy) {
          case 'day':
            dateTrunc = 'day';
            break;
          case 'week':
            dateTrunc = 'week';
            break;
          case 'month':
            dateTrunc = 'month';
            break;
          default:
            dateTrunc = 'day';
        }

        // Use materialized counters table for grouped queries (much faster)
        const stats = await prisma.$queryRaw<Array<{
          period: Date;
          total_bytes_in: bigint;
          total_bytes_out: bigint;
          total_sessions: bigint;
        }>>`
          SELECT 
            DATE_TRUNC(${dateTrunc}, usage_date) as period,
            COALESCE(SUM(bytes_in), 0)::bigint as total_bytes_in,
            COALESCE(SUM(bytes_out), 0)::bigint as total_bytes_out,
            -- Session count still needs radacct, but this is much faster with date filter
            (SELECT COUNT(*)::bigint FROM radacct 
             WHERE "routerId" = ${id}
               AND DATE_TRUNC(${dateTrunc}, acctstarttime) = DATE_TRUNC(${dateTrunc}, usage_date)
               AND acctstarttime >= ${startDate}
               AND acctstarttime < ${endDate}
               AND acctstoptime IS NOT NULL) as total_sessions
          FROM router_daily_usage
          WHERE router_id = ${id}
            AND usage_date >= DATE(${startDate})
            AND usage_date < DATE(${endDate})
          GROUP BY DATE_TRUNC(${dateTrunc}, usage_date)
          ORDER BY period ASC
        `;

        const grouped = stats.map((row: typeof stats[0]) => {
          const bytesIn = Number(row.total_bytes_in);
          const bytesOut = Number(row.total_bytes_out);
          const totalBytes = bytesIn + bytesOut;
          
          return {
            period: row.period.toISOString(),
            bytesIn,
            bytesOut,
            totalBytes,
            totalGB: totalBytes / (1024 * 1024 * 1024),
            sessions: Number(row.total_sessions)
          };
        });

        // Calculate totals
        const totalBytesIn = grouped.reduce((sum: number, g: typeof grouped[0]) => sum + g.bytesIn, 0);
        const totalBytesOut = grouped.reduce((sum: number, g: typeof grouped[0]) => sum + g.bytesOut, 0);
        const totalBytes = totalBytesIn + totalBytesOut;
        const totalSessions = grouped.reduce((sum: number, g: typeof grouped[0]) => sum + g.sessions, 0);

        return {
          routerId: router.id,
          routerName: router.name,
          period: {
            start: startDate.toISOString(),
            end: endDate.toISOString()
          },
          total: {
            bytesIn: totalBytesIn,
            bytesOut: totalBytesOut,
            totalBytes,
            totalGB: totalBytes / (1024 * 1024 * 1024),
            sessions: totalSessions
          },
          grouped
        };
      }
    } catch (error: any) {
      fastify.log.error(`Error calculating router usage: ${error}`);
      return reply.code(500).send({ error: 'Failed to calculate usage statistics' });
    }
  });
}
