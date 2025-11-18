import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../lib/prisma.js';
import {
  getUserQuota,
  createOrUpdateQuota,
  resetUserQuota,
  getQuotaStats,
  hasRemainingQuota,
  updateRadiusQuotaLimit
} from '../services/quota.js';

export async function quotaRoutes(fastify: FastifyInstance) {
  // Get user quota information
  fastify.get('/api/quota/:username', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['quota'],
      summary: 'Get user quota information',
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
    const { username } = request.params as { username: string };

    // Only admins can view any user's quota, hosts can only view their own
    if (user.role !== 'ADMIN') {
      return reply.code(403).send({ error: 'Admin access required' });
    }

    const quotaInfo = await getUserQuota(username);
    
    if (!quotaInfo) {
      return reply.code(404).send({ error: 'Quota not found for user' });
    }

    return {
      username,
      quota: {
        totalGB: Number(quotaInfo.total) / (1024 * 1024 * 1024),
        usedGB: Number(quotaInfo.used) / (1024 * 1024 * 1024),
        remainingGB: Number(quotaInfo.remaining) / (1024 * 1024 * 1024),
        percentage: quotaInfo.percentage
      }
    };
  });

  // Create or update user quota
  fastify.post('/api/quota', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['quota'],
      summary: 'Create or update user quota',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['username', 'maxQuotaGB'],
        properties: {
          username: { type: 'string' },
          maxQuotaGB: { type: 'number', minimum: 0.1 },
          quotaType: { type: 'string', default: 'monthly' },
          periodDays: { type: 'number', default: 30, minimum: 1 }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as any;
    const body = request.body as {
      username: string;
      maxQuotaGB: number;
      quotaType?: string;
      periodDays?: number;
    };

    if (user.role !== 'ADMIN') {
      return reply.code(403).send({ error: 'Admin access required' });
    }

    try {
      await createOrUpdateQuota(
        body.username,
        body.maxQuotaGB,
        body.quotaType || 'monthly',
        body.periodDays || 30
      );

      fastify.log.info(`Quota created/updated for user: ${body.username}, ${body.maxQuotaGB} GB`);
      
      return {
        message: 'Quota created/updated successfully',
        username: body.username,
        maxQuotaGB: body.maxQuotaGB
      };
    } catch (error) {
      fastify.log.error(`Error creating quota: ${error}`);
      return reply.code(500).send({ error: 'Failed to create quota' });
    }
  });

  // Reset user quota (start new period)
  fastify.post('/api/quota/:username/reset', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['quota'],
      summary: 'Reset user quota (start new period)',
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
    const { username } = request.params as { username: string };

    if (user.role !== 'ADMIN') {
      return reply.code(403).send({ error: 'Admin access required' });
    }

    try {
      await resetUserQuota(username);
      fastify.log.info(`Quota reset for user: ${username}`);
      
      return { message: 'Quota reset successfully', username };
    } catch (error) {
      fastify.log.error(`Error resetting quota: ${error}`);
      return reply.code(500).send({ error: 'Failed to reset quota' });
    }
  });

  // Get quota statistics
  fastify.get('/api/quota', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['quota'],
      summary: 'Get quota statistics',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          username: { type: 'string' }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as any;
    const { username } = request.query as { username?: string };

    if (user.role !== 'ADMIN') {
      return reply.code(403).send({ error: 'Admin access required' });
    }

    const stats = await getQuotaStats(username);
    return { quotas: stats };
  });

  // Check if user has remaining quota (for portal login)
  fastify.get('/api/quota/:username/check', {
    schema: {
      tags: ['quota'],
      summary: 'Check if user has remaining quota',
      params: {
        type: 'object',
        properties: {
          username: { type: 'string' }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { username } = request.params as { username: string };

    const hasQuota = await hasRemainingQuota(username);
    const quotaInfo = await getUserQuota(username);

    if (!quotaInfo) {
      return {
        hasQuota: false,
        message: 'No quota configured for user'
      };
    }

    return {
      hasQuota,
      remainingGB: Number(quotaInfo.remaining) / (1024 * 1024 * 1024),
      usedGB: Number(quotaInfo.used) / (1024 * 1024 * 1024),
      totalGB: Number(quotaInfo.total) / (1024 * 1024 * 1024),
      percentage: quotaInfo.percentage
    };
  });
}
