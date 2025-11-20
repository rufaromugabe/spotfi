/**
 * End User Management Routes
 * Registration, profile management, and user operations
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../utils/auth.js';
import { syncUserToRadius, removeUserFromRadius } from '../services/radius-sync.js';
import { z } from 'zod';

const CreateEndUserSchema = z.object({
  username: z.string().min(3).max(50).regex(/^[a-zA-Z0-9_-]+$/, 'Username can only contain letters, numbers, underscores, and hyphens'),
  password: z.string().min(6),
  email: z.string().email().optional().nullable(),
  phone: z.string().optional().nullable(),
  fullName: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  planId: z.string().optional().nullable(), // Optional: assign plan immediately
});

const UpdateEndUserSchema = z.object({
  email: z.string().email().optional().nullable(),
  phone: z.string().optional().nullable(),
  fullName: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED', 'EXPIRED']).optional(),
  password: z.string().min(6).optional(),
});

export async function endUserRoutes(fastify: FastifyInstance) {
  // Register end user
  fastify.post('/api/end-users', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['end-users'],
      summary: 'Register a new end user',
      description: 'Create a new WiFi user with optional plan assignment',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string', minLength: 3, maxLength: 50 },
          password: { type: 'string', minLength: 6 },
          email: { type: 'string', format: 'email' },
          phone: { type: 'string' },
          fullName: { type: 'string' },
          notes: { type: 'string' },
          planId: { type: 'string' },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as any;
    const body = CreateEndUserSchema.parse(request.body);

    // Check if username already exists
    const existing = await prisma.endUser.findUnique({
      where: { username: body.username },
    });

    if (existing) {
      return reply.code(400).send({ error: 'Username already exists' });
    }

    // Hash password
    const hashedPassword = await hashPassword(body.password);

    // Create user
    const endUser = await prisma.endUser.create({
      data: {
        username: body.username,
        password: hashedPassword,
        email: body.email,
        phone: body.phone,
        fullName: body.fullName,
        notes: body.notes,
        createdById: user.userId,
      },
    });

    // Create RADIUS entry (User-Password in radcheck)
    await prisma.radCheck.create({
      data: {
        userName: body.username,
        attribute: 'User-Password',
        op: ':=',
        value: body.password, // RADIUS expects plain text or hashed based on config
      },
    });

    // If plan is provided, assign it
    if (body.planId) {
      const plan = await prisma.plan.findUnique({ where: { id: body.planId } });
      if (!plan) {
        return reply.code(400).send({ error: 'Plan not found' });
      }

      await assignPlanToUser(endUser.id, body.planId, user.userId, fastify.log);
    } else {
      // Sync to RADIUS (will disable user if no plan)
      await syncUserToRadius({
        username: body.username,
        logger: fastify.log,
      });
    }

    return reply.code(201).send({
      id: endUser.id,
      username: endUser.username,
      email: endUser.email,
      fullName: endUser.fullName,
      status: endUser.status,
      createdAt: endUser.createdAt,
    });
  });

  // List end users
  fastify.get('/api/end-users', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['end-users'],
      summary: 'List end users',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'EXPIRED'] },
          search: { type: 'string' },
          page: { type: 'number', minimum: 1, default: 1 },
          limit: { type: 'number', minimum: 1, maximum: 100, default: 50 },
        },
      },
    },
  }, async (request: FastifyRequest) => {
    const query = request.query as {
      status?: string;
      search?: string;
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
    if (query.search) {
      where.OR = [
        { username: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
        { fullName: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [users, total] = await Promise.all([
      prisma.endUser.findMany({
        where,
        include: {
          userPlans: {
            where: { status: 'ACTIVE' },
            include: { plan: true },
            take: 1,
            orderBy: { activatedAt: 'desc' },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
      }),
      prisma.endUser.count({ where }),
    ]);

    return {
      users: users.map(u => ({
        id: u.id,
        username: u.username,
        email: u.email,
        phone: u.phone,
        fullName: u.fullName,
        status: u.status,
        activePlan: u.userPlans[0] ? {
          id: u.userPlans[0].plan.id,
          name: u.userPlans[0].plan.name,
          expiresAt: u.userPlans[0].expiresAt,
        } : null,
        createdAt: u.createdAt,
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    };
  });

  // Get end user by ID
  fastify.get('/api/end-users/:id', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['end-users'],
      summary: 'Get end user by ID',
      security: [{ bearerAuth: [] }],
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const endUser = await prisma.endUser.findUnique({
      where: { id },
      include: {
        userPlans: {
          include: { plan: true },
          orderBy: { assignedAt: 'desc' },
        },
      },
    });

    if (!endUser) {
      return reply.code(404).send({ error: 'User not found' });
    }

    // Get usage statistics
    const activeSessions = await prisma.radAcct.count({
      where: {
        userName: endUser.username,
        acctStopTime: null,
      },
    });

    const totalUsage = await prisma.radAcct.aggregate({
      where: { userName: endUser.username },
      _sum: {
        acctInputOctets: true,
        acctOutputOctets: true,
      },
    });

    const totalBytes = Number(totalUsage._sum.acctInputOctets || 0) + 
                       Number(totalUsage._sum.acctOutputOctets || 0);

    const activePlan = endUser.userPlans.find(up => up.status === 'ACTIVE');

    return {
      id: endUser.id,
      username: endUser.username,
      email: endUser.email,
      phone: endUser.phone,
      fullName: endUser.fullName,
      status: endUser.status,
      notes: endUser.notes,
      activePlan: activePlan ? {
        id: activePlan.plan.id,
        name: activePlan.plan.name,
        dataQuota: activePlan.dataQuota ? Number(activePlan.dataQuota) : null,
        dataUsed: Number(activePlan.dataUsed),
        expiresAt: activePlan.expiresAt,
      } : null,
      usage: {
        activeSessions,
        totalBytes,
      },
      plans: endUser.userPlans.map(up => ({
        id: up.id,
        plan: {
          id: up.plan.id,
          name: up.plan.name,
        },
        status: up.status,
        assignedAt: up.assignedAt,
        expiresAt: up.expiresAt,
      })),
      createdAt: endUser.createdAt,
      updatedAt: endUser.updatedAt,
    };
  });

  // Update end user
  fastify.put('/api/end-users/:id', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['end-users'],
      summary: 'Update end user',
      security: [{ bearerAuth: [] }],
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = UpdateEndUserSchema.parse(request.body);

    const endUser = await prisma.endUser.findUnique({ where: { id } });
    if (!endUser) {
      return reply.code(404).send({ error: 'User not found' });
    }

    const updateData: any = {};
    if (body.email !== undefined) updateData.email = body.email;
    if (body.phone !== undefined) updateData.phone = body.phone;
    if (body.fullName !== undefined) updateData.fullName = body.fullName;
    if (body.notes !== undefined) updateData.notes = body.notes;
    if (body.status !== undefined) updateData.status = body.status;

    // Update password if provided
    if (body.password) {
      const hashedPassword = await hashPassword(body.password);
      updateData.password = hashedPassword;
      
      // Update RADIUS password
      await prisma.radCheck.updateMany({
        where: {
          userName: endUser.username,
          attribute: 'User-Password',
        },
        data: {
          value: body.password, // Update with new password
        },
      });
    }

    const updated = await prisma.endUser.update({
      where: { id },
      data: updateData,
    });

    // If status changed, sync to RADIUS
    if (body.status) {
      if (body.status === 'SUSPENDED' || body.status === 'INACTIVE') {
        await syncUserToRadius({
          username: endUser.username,
          logger: fastify.log,
        });
      }
    }

    return {
      id: updated.id,
      username: updated.username,
      email: updated.email,
      fullName: updated.fullName,
      status: updated.status,
    };
  });

  // Delete end user
  fastify.delete('/api/end-users/:id', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['end-users'],
      summary: 'Delete end user',
      security: [{ bearerAuth: [] }],
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as any;
    
    if (user.role !== 'ADMIN') {
      return reply.code(403).send({ error: 'Admin access required' });
    }

    const { id } = request.params as { id: string };

    const endUser = await prisma.endUser.findUnique({ where: { id } });
    if (!endUser) {
      return reply.code(404).send({ error: 'User not found' });
    }

    // Remove from RADIUS
    await removeUserFromRadius(endUser.username, fastify.log);

    // Delete user (cascades to userPlans)
    await prisma.endUser.delete({ where: { id } });

    return { success: true, message: 'User deleted' };
  });
}

/**
 * Helper function to assign plan to user
 */
async function assignPlanToUser(
  userId: string,
  planId: string,
  assignedById: string,
  logger: any
): Promise<void> {
  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan) {
    throw new Error('Plan not found');
  }

  const endUser = await prisma.endUser.findUnique({ where: { id: userId } });
  if (!endUser) {
    throw new Error('User not found');
  }

  // Deactivate existing active plans
  await prisma.userPlan.updateMany({
    where: {
      userId,
      status: 'ACTIVE',
    },
    data: {
      status: 'EXPIRED',
    },
  });

  // Calculate expiry
  let expiresAt: Date | null = null;
  if (plan.validityDays) {
    expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + plan.validityDays);
  }

  // Create new user plan
  const userPlan = await prisma.userPlan.create({
    data: {
      userId,
      planId,
      status: 'ACTIVE',
      activatedAt: new Date(),
      expiresAt,
      dataQuota: plan.dataQuota,
      assignedById,
    },
  });

  // Sync to RADIUS
  await syncUserToRadius({
    username: endUser.username,
    planId,
    logger,
  });

  logger.info(`Assigned plan ${plan.name} to user ${endUser.username}`);
}

