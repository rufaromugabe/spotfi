/**
 * RADIUS Synchronization Service
 * Automatically syncs user plans and limits to RADIUS radcheck/radreply tables
 */

import { prisma } from '../lib/prisma.js';
import { FastifyBaseLogger } from 'fastify';

interface SyncOptions {
  username: string;
  logger?: FastifyBaseLogger;
}

/**
 * Optimized RADIUS Sync
 * Uses Upsert to prevent authentication race conditions during updates.
 */
export async function syncUserToRadius({ username, logger }: SyncOptions): Promise<void> {
  try {
    // 1. Fetch end user first, then user plan
    const endUser = await prisma.endUser.findUnique({ where: { username } });

    if (!endUser) {
      await disableUserInRadius(username, logger);
      return;
    }

    const userPlan = await prisma.userPlan.findFirst({
      where: {
        userId: endUser.id,
        status: 'ACTIVE',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
      },
      include: { plan: true },
      orderBy: { activatedAt: 'desc' }
    });

    // 2. Handle "Access Denied" Case
    if (!userPlan) {
      await disableUserInRadius(username, logger);
      return;
    }

    const plan = userPlan.plan;
    const quotaLimit = userPlan.dataQuota || plan.dataQuota;
    const quotaUsed = userPlan.dataUsed;
    
    // Calculate remaining (ensure non-negative)
    const remaining = quotaLimit ? (quotaLimit - quotaUsed > 0n ? quotaLimit - quotaUsed : 0n) : null;

    // 3. Prepare Operations (Batch Transaction)
    const ops = [];

    // --- Auth Check (radcheck) ---
    // Ensure user is enabled (Remove Reject)
    ops.push(prisma.radCheck.deleteMany({
      where: { userName: username, attribute: 'Auth-Type', value: 'Reject' }
    }));

    // Simultaneous-Use
    if (plan.maxSessions) {
      ops.push(upsertRadCheck(username, 'Simultaneous-Use', ':=', plan.maxSessions.toString()));
    }

    // --- Attributes (radreply) ---
    // Clean up attributes we are about to set to ensure no duplicates if logic changed
    // (Optional: only if you strictly need to switch attribute types, otherwise upsert handles it)

    // Time Limits
    if (plan.sessionTimeout) ops.push(upsertRadReply(username, 'Session-Timeout', '=', plan.sessionTimeout.toString()));
    if (plan.idleTimeout) ops.push(upsertRadReply(username, 'Idle-Timeout', '=', plan.idleTimeout.toString()));

    // Bandwidth (WISPr) - Convert Bytes/s to Bits/s
    if (plan.maxDownloadSpeed) {
      ops.push(upsertRadReply(username, 'WISPr-Bandwidth-Max-Down', '=', (plan.maxDownloadSpeed * 8n).toString()));
    }
    if (plan.maxUploadSpeed) {
      ops.push(upsertRadReply(username, 'WISPr-Bandwidth-Max-Up', '=', (plan.maxUploadSpeed * 8n).toString()));
    }

    // Data Quota (Native Uspot/Coova Support)
    // If quota is 0, uspot kicks immediately.
    if (remaining !== null) {
      ops.push(upsertRadReply(username, 'ChilliSpot-Max-Total-Octets', '=', remaining.toString()));
    }

    // Execute all
    await prisma.$transaction(ops);
    logger?.info(`[RADIUS Sync] Synced ${username} (Plan: ${plan.name}, Rem: ${remaining})`);

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
