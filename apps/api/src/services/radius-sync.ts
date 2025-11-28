/**
 * RADIUS Synchronization Service
 * Automatically syncs user plans and limits to RADIUS radcheck/radreply tables
 */

import { prisma } from '../lib/prisma.js';
import { FastifyBaseLogger } from 'fastify';
import { getUserTotalUsage } from './usage.js';

interface SyncOptions {
  username: string;
  logger?: FastifyBaseLogger;
}

/**
 * RADIUS Synchronization Service
 * Uses Upsert to prevent authentication race conditions during updates.
 */
export async function syncUserToRadius({ username, logger }: SyncOptions): Promise<void> {
  try {
    // 1. Fetch end user first, then all active user plans
    const endUser = await prisma.endUser.findUnique({ where: { username } });

    if (!endUser) {
      await disableUserInRadius(username, logger);
      return;
    }

    // Fetch all active plans
    const activePlans = await prisma.userPlan.findMany({
      where: {
        userId: endUser.id,
        status: 'ACTIVE',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
      },
      include: { plan: true },
      orderBy: { activatedAt: 'desc' }
    });

    // 2. Handle "Access Denied" Case
    if (activePlans.length === 0) {
      await disableUserInRadius(username, logger);
      return;
    }

    // 3. Aggregate quotas (SUM - additive pooling)
    // Sum all plan quotas
    let totalQuota = 0n;
    let hasUnlimitedQuota = false;

    for (const userPlan of activePlans) {
      const planQuota = userPlan.dataQuota || userPlan.plan.dataQuota;
      if (planQuota === null) {
        hasUnlimitedQuota = true;
      } else {
        totalQuota += planQuota;
      }
    }

    // Get total usage
    const totalUsed = await getUserTotalUsage(username);

    // If any plan has unlimited quota, remaining is null (unlimited)
    const remaining = hasUnlimitedQuota ? null : (totalQuota > totalUsed ? totalQuota - totalUsed : 0n);

    // 4. Aggregate bandwidth limits (MAX - most permissive)
    let maxDownload = 0n;
    let maxUpload = 0n;
    for (const userPlan of activePlans) {
      const plan = userPlan.plan;
      if (plan.maxDownloadSpeed && plan.maxDownloadSpeed > maxDownload) {
        maxDownload = plan.maxDownloadSpeed;
      }
      if (plan.maxUploadSpeed && plan.maxUploadSpeed > maxUpload) {
        maxUpload = plan.maxUploadSpeed;
      }
    }

    // 5. Aggregate session limits (MAX - most permissive)
    let maxSessions = 1;
    for (const userPlan of activePlans) {
      const plan = userPlan.plan;
      if (plan.maxSessions && plan.maxSessions > maxSessions) {
        maxSessions = plan.maxSessions;
      }
    }

    // 6. Aggregate timeouts (MAX - longest/most permissive)
    let sessionTimeout: number | null = null;
    let idleTimeout: number | null = null;
    for (const userPlan of activePlans) {
      const plan = userPlan.plan;
      if (plan.sessionTimeout && (sessionTimeout === null || plan.sessionTimeout > sessionTimeout)) {
        sessionTimeout = plan.sessionTimeout;
      }
      if (plan.idleTimeout && (idleTimeout === null || plan.idleTimeout > idleTimeout)) {
        idleTimeout = plan.idleTimeout;
      }
    }

    // 7. Prepare Operations (Batch Transaction)
    const ops = [];

    // --- Auth Check (radcheck) ---
    // Ensure user is enabled (Remove Reject)
    ops.push(prisma.radCheck.deleteMany({
      where: { userName: username, attribute: 'Auth-Type', value: 'Reject' }
    }));

    // Simultaneous-Use (MAX from all plans)
    if (maxSessions > 0) {
      ops.push(upsertRadCheck(username, 'Simultaneous-Use', ':=', maxSessions.toString()));
    }

    // --- Attributes (radreply) ---
    // Time Limits (MAX from all plans)
    if (sessionTimeout) {
      ops.push(upsertRadReply(username, 'Session-Timeout', '=', sessionTimeout.toString()));
    }
    if (idleTimeout) {
      ops.push(upsertRadReply(username, 'Idle-Timeout', '=', idleTimeout.toString()));
    }

    // Bandwidth (WISPr) - Convert Bytes/s to Bits/s (MAX from all plans)
    if (maxDownload > 0n) {
      ops.push(upsertRadReply(username, 'WISPr-Bandwidth-Max-Down', '=', (maxDownload * 8n).toString()));
    }
    if (maxUpload > 0n) {
      ops.push(upsertRadReply(username, 'WISPr-Bandwidth-Max-Up', '=', (maxUpload * 8n).toString()));
    }

    // Data Quota (Native Uspot/Coova Support) - SUM from all plans
    // If quota is 0, uspot kicks immediately.
    if (remaining !== null) {
      ops.push(upsertRadReply(username, 'ChilliSpot-Max-Total-Octets', '=', remaining.toString()));
    }

    // Execute all
    await prisma.$transaction(ops);
    
    const planNames = activePlans.map(up => up.plan.name).join(' + ');
    logger?.info(`[RADIUS Sync] Synced ${username} (Plans: ${planNames}, Rem: ${remaining}, Sessions: ${maxSessions})`);

  } catch (error) {
    logger?.error(`[RADIUS Sync] Failed: ${error}`);
    throw error;
  }
}

// Helper for DRY Upserts
function upsertRadCheck(userName: string, attribute: string, op: string, value: string) {
  return prisma.radCheck.upsert({
    where: {
      userName_attribute: { 
        userName, 
        attribute 
    }
    },
    update: { value, op },
    create: { userName, attribute, op, value }
    });
  }

function upsertRadReply(userName: string, attribute: string, op: string, value: string) {
  return prisma.radReply.upsert({
      where: {
      userName_attribute: { 
        userName, 
        attribute 
      }
    },
    update: { value, op },
    create: { userName, attribute, op, value }
  });
}

async function disableUserInRadius(username: string, logger?: FastifyBaseLogger) {
  // Atomic disable: Upsert Auth-Type := Reject
  await upsertRadCheck(username, 'Auth-Type', ':=', 'Reject');
  // Clear session limits to prevent confusion if re-enabled later
  await prisma.radReply.deleteMany({ where: { userName: username } });
  logger?.info(`[RADIUS Sync] Disabled user ${username}`);
}

/**
 * Remove user from RADIUS (cleanup)
 */
export async function removeUserFromRadius(username: string, logger?: FastifyBaseLogger): Promise<void> {
  await Promise.all([
    prisma.radCheck.deleteMany({ where: { userName: username } }),
    prisma.radReply.deleteMany({ where: { userName: username } }),
    prisma.radQuota.deleteMany({ where: { username } })
  ]);

  logger?.info(`[RADIUS Sync] Removed user ${username} from RADIUS`);
}
