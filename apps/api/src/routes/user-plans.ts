/**
 * User Plan Assignment Routes
 * Assign, update, and manage user plans
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { syncUserToRadius } from '../services/radius-sync.js';
import { getUserTotalUsage } from '../services/usage.js';
import { routerRpcService } from '../services/router-rpc.service.js';
import { z } from 'zod';

const AssignPlanSchema = z.object({
  planId: z.string(),
  dataQuota: z.number().positive().optional().nullable(), // Override plan default
  expiresAt: z.string().datetime().optional().nullable(),
  autoRenew: z.boolean().default(false),
  renewalPlanId: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  idempotencyKey: z.string().optional(), // For idempotent requests
});

export async function userPlanRoutes(fastify: FastifyInstance) {
  // Assign plan to user
  fastify.post('/api/end-users/:userId/plans', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['user-plans'],
      summary: 'Assign plan to user',
      description: 'Assign a service plan to an end user with optional custom quota',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['planId'],
        properties: {
          planId: { type: 'string' },
          dataQuota: { type: 'number', description: 'Override plan quota in bytes' },
          expiresAt: { type: 'string', format: 'date-time' },
          autoRenew: { type: 'boolean' },
          renewalPlanId: { type: 'string' },
          notes: { type: 'string' },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as any;
    const { userId } = request.params as { userId: string };
    const body = AssignPlanSchema.parse(request.body);

    // Verify user exists
    const endUser = await prisma.endUser.findUnique({
      where: { id: userId },
    });

    if (!endUser) {
      return reply.code(404).send({ error: 'User not found' });
    }

    // Verify plan exists
    const plan = await prisma.plan.findUnique({
      where: { id: body.planId },
    });

    if (!plan) {
      return reply.code(404).send({ error: 'Plan not found' });
    }

    // Calculate expiry
    let expiresAt: Date | null = null;
    if (body.expiresAt) {
      expiresAt = new Date(body.expiresAt);
    } else if (plan.validityDays) {
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + plan.validityDays);
    }

    // Use custom quota or plan default
    const dataQuota = body.dataQuota ? BigInt(Math.floor(body.dataQuota)) : plan.dataQuota;

    // Idempotency: Check if plan already assigned with same idempotency key
    // Or check for existing active plan with same planId (idempotent by design)
    if (body.idempotencyKey) {
      const existing = await prisma.userPlan.findFirst({
        where: {
          userId,
          planId: body.planId,
          status: 'ACTIVE',
          // In a real system, you'd store idempotencyKey in a separate table
          // For now, we check if an active plan with same planId exists
        },
        include: { plan: true },
      });

      if (existing) {
        // Return existing plan (idempotent response)
        return reply.code(200).send({
          id: existing.id,
          userId: existing.userId,
          plan: {
            id: existing.plan.id,
            name: existing.plan.name,
          },
          status: existing.status,
          dataQuota: existing.dataQuota ? Number(existing.dataQuota) : null,
          dataUsed: Number(await getUserTotalUsage(endUser.username)),
          expiresAt: existing.expiresAt,
          autoRenew: existing.autoRenew,
          activatedAt: existing.activatedAt,
        });
      }
    }

    // Idempotent approach: Check for existing active plan first, then create or update
    const existingActivePlan = await prisma.userPlan.findFirst({
      where: {
        userId,
        planId: body.planId,
        status: 'ACTIVE',
      },
      include: { plan: true },
    });

    let userPlan;
    if (existingActivePlan) {
      // Update existing active plan (idempotent - safe to retry)
      userPlan = await prisma.userPlan.update({
        where: { id: existingActivePlan.id },
        data: {
          expiresAt,
          dataQuota,
          autoRenew: body.autoRenew,
          renewalPlanId: body.renewalPlanId,
          notes: body.notes,
        },
        include: { plan: true },
      });
    } else {
      // Create new plan assignment
      userPlan = await prisma.userPlan.create({
        data: {
          userId,
          planId: body.planId,
          status: 'ACTIVE',
          activatedAt: new Date(),
          expiresAt,
          dataQuota,
          dataUsed: 0n,
          autoRenew: body.autoRenew,
          renewalPlanId: body.renewalPlanId,
          assignedById: user.userId,
          notes: body.notes,
        },
        include: {
          plan: true,
        },
      });
    }

    // Sync to RADIUS
    await syncUserToRadius({
      username: endUser.username,
      logger: fastify.log,
    });

    return reply.code(201).send({
      id: userPlan.id,
      userId: userPlan.userId,
      plan: {
        id: userPlan.plan.id,
        name: userPlan.plan.name,
      },
      status: userPlan.status,
      dataQuota: userPlan.dataQuota ? Number(userPlan.dataQuota) : null,
      dataUsed: Number(await getUserTotalUsage(endUser.username)),
      expiresAt: userPlan.expiresAt,
      autoRenew: userPlan.autoRenew,
      activatedAt: userPlan.activatedAt,
    });
  });

  // List user plans
  fastify.get('/api/end-users/:userId/plans', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['user-plans'],
      summary: 'List user plans',
      security: [{ bearerAuth: [] }],
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId } = request.params as { userId: string };

    const endUser = await prisma.endUser.findUnique({
      where: { id: userId },
    });

    if (!endUser) {
      return reply.code(404).send({ error: 'User not found' });
    }

    const userPlans = await prisma.userPlan.findMany({
      where: { userId },
      include: {
        plan: true,
      },
      orderBy: { assignedAt: 'desc' },
    });

    // Get total usage
    const totalUsage = await getUserTotalUsage(endUser.username);

    return {
      plans: userPlans.map(up => ({
        id: up.id,
        plan: {
          id: up.plan.id,
          name: up.plan.name,
          description: up.plan.description,
        },
        status: up.status,
        dataQuota: up.dataQuota ? Number(up.dataQuota) : null,
        dataUsed: Number(totalUsage),
        assignedAt: up.assignedAt,
        activatedAt: up.activatedAt,
        expiresAt: up.expiresAt,
        autoRenew: up.autoRenew,
      })),
    };
  });

  // Cancel user plan
  fastify.post('/api/user-plans/:id/cancel', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['user-plans'],
      summary: 'Cancel user plan',
      security: [{ bearerAuth: [] }],
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const userPlan = await prisma.userPlan.findUnique({
      where: { id },
      include: {
        user: true,
      },
    });

    if (!userPlan) {
      return reply.code(404).send({ error: 'User plan not found' });
    }

    // Cancel plan
    await prisma.userPlan.update({
      where: { id },
      data: {
        status: 'CANCELLED',
      },
    });

    // Sync to RADIUS (will disable user if no other active plan)
    await syncUserToRadius({
      username: userPlan.user.username,
      logger: fastify.log,
    });

    // Find active sessions and disconnect them immediately
    // This forces re-authentication with new limits (or rejection if no active plans)
    const activeSessions = await prisma.radAcct.findMany({
      where: {
        userName: userPlan.user.username,
        acctStopTime: null
      },
      select: {
        acctSessionId: true,
        routerId: true,
        callingStationId: true // MAC Address required for WebSocket kick
      }
    });

    // Send WebSocket Kick Command to all active routers
    // This works behind NAT because it uses the persistent WebSocket bridge
    const disconnectPromises = activeSessions
      .filter(session => session.routerId && session.callingStationId)
      .map(async (session) => {
        try {
          await routerRpcService.kickClient(session.routerId!, session.callingStationId!);
          return true;
        } catch (error: any) {
          fastify.log.error(`[Plan Cancel] Failed to kick MAC ${session.callingStationId} on router ${session.routerId}: ${error.message}`);
          return false;
        }
      });

    const results = await Promise.allSettled(disconnectPromises);
    const successful = results.filter(r => r.status === 'fulfilled' && r.value === true).length;

    // Force close sessions in DB (Accounting Stop might not arrive if router is offline)
    await prisma.radAcct.updateMany({
      where: {
        userName: userPlan.user.username,
        acctStopTime: null
      },
      data: {
        acctStopTime: new Date(),
        acctTerminateCause: 'Admin-Reset'
      }
    });

    if (activeSessions.length > 0) {
      fastify.log.info(`Disconnected ${activeSessions.length} active session(s) for user ${userPlan.user.username} after plan cancellation`);
    }

    return { success: true, message: 'Plan cancelled' };
  });

  // Extend user plan
  fastify.post('/api/user-plans/:id/extend', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['user-plans'],
      summary: 'Extend user plan expiry',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['days'],
        properties: {
          days: { type: 'number', minimum: 1 },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { days: number };

    const userPlan = await prisma.userPlan.findUnique({
      where: { id },
    });

    if (!userPlan) {
      return reply.code(404).send({ error: 'User plan not found' });
    }

    if (userPlan.status !== 'ACTIVE') {
      return reply.code(400).send({ error: 'Can only extend active plans' });
    }

    // Extend expiry
    const currentExpiry = userPlan.expiresAt || new Date();
    const newExpiry = new Date(currentExpiry);
    newExpiry.setDate(newExpiry.getDate() + body.days);

    await prisma.userPlan.update({
      where: { id },
      data: {
        expiresAt: newExpiry,
      },
    });

    return {
      success: true,
      message: 'Plan extended',
      newExpiresAt: newExpiry,
    };
  });
}

