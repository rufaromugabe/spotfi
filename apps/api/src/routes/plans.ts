/**
 * Plan Management Routes
 * CRUD operations for service plans
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { z } from 'zod';

const CreatePlanSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  price: z.number().min(0).default(0),
  currency: z.string().default('USD'),
  dataQuota: z.number().positive().optional().nullable(),
  quotaType: z.enum(['MONTHLY', 'DAILY', 'WEEKLY', 'ONE_TIME']).default('MONTHLY'),
  maxUploadSpeed: z.number().positive().optional().nullable(), // bytes per second
  maxDownloadSpeed: z.number().positive().optional().nullable(), // bytes per second
  sessionTimeout: z.number().positive().optional().nullable(), // seconds
  idleTimeout: z.number().positive().optional().nullable(), // seconds
  maxSessions: z.number().int().positive().optional().nullable(),
  validityDays: z.number().int().positive().optional().nullable(),
  isDefault: z.boolean().default(false),
});

const UpdatePlanSchema = CreatePlanSchema.partial();

export async function planRoutes(fastify: FastifyInstance) {
  // Create plan
  fastify.post('/api/plans', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['plans'],
      summary: 'Create a new service plan',
      description: 'Create a new plan with quotas, bandwidth limits, and time restrictions',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          description: { type: 'string' },
          price: { type: 'number', minimum: 0 },
          currency: { type: 'string', default: 'USD' },
          dataQuota: { type: 'number', description: 'Data quota in bytes' },
          quotaType: { type: 'string', enum: ['MONTHLY', 'DAILY', 'WEEKLY', 'ONE_TIME'] },
          maxUploadSpeed: { type: 'number', description: 'Max upload speed in bytes/sec' },
          maxDownloadSpeed: { type: 'number', description: 'Max download speed in bytes/sec' },
          sessionTimeout: { type: 'number', description: 'Max session duration in seconds' },
          idleTimeout: { type: 'number', description: 'Idle timeout in seconds' },
          maxSessions: { type: 'number', description: 'Max concurrent sessions' },
          validityDays: { type: 'number', description: 'Plan validity in days' },
          isDefault: { type: 'boolean' },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as any;
    
    if (user.role !== 'ADMIN') {
      return reply.code(403).send({ error: 'Admin access required' });
    }

    const body = CreatePlanSchema.parse(request.body);

    // If setting as default, unset other defaults
    if (body.isDefault) {
      await prisma.plan.updateMany({
        where: { isDefault: true },
        data: { isDefault: false }
      });
    }

    // Convert dataQuota to BigInt if provided
    const dataQuota = body.dataQuota ? BigInt(Math.floor(body.dataQuota)) : null;
    const maxUploadSpeed = body.maxUploadSpeed ? BigInt(Math.floor(body.maxUploadSpeed)) : null;
    const maxDownloadSpeed = body.maxDownloadSpeed ? BigInt(Math.floor(body.maxDownloadSpeed)) : null;

    const plan = await prisma.plan.create({
      data: {
        name: body.name,
        description: body.description,
        price: body.price,
        currency: body.currency,
        dataQuota,
        quotaType: body.quotaType,
        maxUploadSpeed,
        maxDownloadSpeed,
        sessionTimeout: body.sessionTimeout,
        idleTimeout: body.idleTimeout,
        maxSessions: body.maxSessions,
        validityDays: body.validityDays,
        isDefault: body.isDefault,
        createdById: user.userId,
      },
    });

    return reply.code(201).send(plan);
  });

  // List plans
  fastify.get('/api/plans', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['plans'],
      summary: 'List all plans',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'ARCHIVED'] },
          page: { type: 'number', minimum: 1, default: 1 },
          limit: { type: 'number', minimum: 1, maximum: 100, default: 50 },
        },
      },
    },
  }, async (request: FastifyRequest) => {
    const query = request.query as {
      status?: string;
      page?: number;
      limit?: number;
    };

    const pageNum = Math.max(1, Number(query.page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(query.limit) || 50));
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};
    if (query.status) {
      where.status = query.status;
    }

    const [plans, total] = await Promise.all([
      prisma.plan.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
      }),
      prisma.plan.count({ where }),
    ]);

    return {
      plans: plans.map(p => ({
        ...p,
        dataQuota: p.dataQuota ? Number(p.dataQuota) : null,
        maxUploadSpeed: p.maxUploadSpeed ? Number(p.maxUploadSpeed) : null,
        maxDownloadSpeed: p.maxDownloadSpeed ? Number(p.maxDownloadSpeed) : null,
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    };
  });

  // Get plan by ID
  fastify.get('/api/plans/:id', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['plans'],
      summary: 'Get plan by ID',
      security: [{ bearerAuth: [] }],
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const plan = await prisma.plan.findUnique({
      where: { id },
      include: {
        _count: {
          select: { userPlans: true },
        },
      },
    });

    if (!plan) {
      return reply.code(404).send({ error: 'Plan not found' });
    }

    return {
      ...plan,
      dataQuota: plan.dataQuota ? Number(plan.dataQuota) : null,
      maxUploadSpeed: plan.maxUploadSpeed ? Number(plan.maxUploadSpeed) : null,
      maxDownloadSpeed: plan.maxDownloadSpeed ? Number(plan.maxDownloadSpeed) : null,
      userCount: plan._count.userPlans,
    };
  });

  // Update plan
  fastify.put('/api/plans/:id', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['plans'],
      summary: 'Update plan',
      security: [{ bearerAuth: [] }],
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as any;
    
    if (user.role !== 'ADMIN') {
      return reply.code(403).send({ error: 'Admin access required' });
    }

    const { id } = request.params as { id: string };
    const body = UpdatePlanSchema.parse(request.body);

    const existing = await prisma.plan.findUnique({ where: { id } });
    if (!existing) {
      return reply.code(404).send({ error: 'Plan not found' });
    }

    // If setting as default, unset other defaults
    if (body.isDefault) {
      await prisma.plan.updateMany({
        where: { isDefault: true, id: { not: id } },
        data: { isDefault: false }
      });
    }

    // Convert to BigInt if provided
    const updateData: any = { ...body };
    if (body.dataQuota !== undefined) {
      updateData.dataQuota = body.dataQuota ? BigInt(Math.floor(body.dataQuota)) : null;
    }
    if (body.maxUploadSpeed !== undefined) {
      updateData.maxUploadSpeed = body.maxUploadSpeed ? BigInt(Math.floor(body.maxUploadSpeed)) : null;
    }
    if (body.maxDownloadSpeed !== undefined) {
      updateData.maxDownloadSpeed = body.maxDownloadSpeed ? BigInt(Math.floor(body.maxDownloadSpeed)) : null;
    }

    const plan = await prisma.plan.update({
      where: { id },
      data: updateData,
    });

    return {
      ...plan,
      dataQuota: plan.dataQuota ? Number(plan.dataQuota) : null,
      maxUploadSpeed: plan.maxUploadSpeed ? Number(plan.maxUploadSpeed) : null,
      maxDownloadSpeed: plan.maxDownloadSpeed ? Number(plan.maxDownloadSpeed) : null,
    };
  });

  // Delete plan
  fastify.delete('/api/plans/:id', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['plans'],
      summary: 'Delete plan',
      security: [{ bearerAuth: [] }],
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as any;
    
    if (user.role !== 'ADMIN') {
      return reply.code(403).send({ error: 'Admin access required' });
    }

    const { id } = request.params as { id: string };

    // Check if plan is in use
    const userPlanCount = await prisma.userPlan.count({
      where: { planId: id, status: 'ACTIVE' },
    });

    if (userPlanCount > 0) {
      return reply.code(400).send({
        error: 'Cannot delete plan with active users',
        activeUsers: userPlanCount,
      });
    }

    await prisma.plan.delete({ where: { id } });

    return { success: true, message: 'Plan deleted' };
  });
}

