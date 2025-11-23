/**
 * RADIUS Synchronization Service
 * Automatically syncs user plans and limits to RADIUS radcheck/radreply tables
 */

import { prisma } from '../lib/prisma.js';
import { FastifyBaseLogger } from 'fastify';

interface SyncOptions {
  username: string;
  planId?: string;
  logger?: FastifyBaseLogger;
}

/**
 * Sync user's active plan to RADIUS tables
 * This ensures RADIUS authentication uses the correct limits
 */
export async function syncUserToRadius(options: SyncOptions): Promise<void> {
  const { username, planId, logger } = options;

  try {
    // Get end user by username
    const endUser = await prisma.endUser.findUnique({
      where: { username },
    });

    if (!endUser) {
      logger?.warn(`[RADIUS Sync] End user not found: ${username}`);
      await disableUserInRadius(username, logger);
      return;
    }

    // Get user's active plan
    const userPlan = await prisma.userPlan.findFirst({
      where: {
        userId: endUser.id,
        status: 'ACTIVE',
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date() } }
        ]
      },
      include: {
        plan: true
      },
      orderBy: {
        activatedAt: 'desc'
      }
    });

    if (!userPlan) {
      // No active plan - disable user in RADIUS
      await disableUserInRadius(username, logger);
      return;
    }

    const plan = userPlan.plan;

    // Calculate remaining quota
    const quotaUsed = userPlan.dataUsed;
    const quotaLimit = userPlan.dataQuota || plan.dataQuota;
    const remainingQuota = quotaLimit ? quotaLimit - quotaUsed : null;

    // Sync to radcheck (authentication checks)
    await syncRadCheck(username, {
      enabled: true,
      maxSessions: plan.maxSessions,
      logger
    });

    // Sync to radreply (reply attributes - limits)
    await syncRadReply(username, {
      dataQuota: quotaLimit,
      remainingQuota,
      maxUploadSpeed: plan.maxUploadSpeed,
      maxDownloadSpeed: plan.maxDownloadSpeed,
      sessionTimeout: plan.sessionTimeout,
      idleTimeout: plan.idleTimeout,
      validityDays: plan.validityDays,
      logger
    });

    // Update quota tracking
    if (quotaLimit) {
      await updateQuotaTracking(username, quotaLimit, quotaUsed, plan.quotaType, logger);
    }

    logger?.info(`[RADIUS Sync] Synced user ${username} with plan ${plan.name}`);
  } catch (error) {
    logger?.error(`[RADIUS Sync] Error syncing user ${username}: ${error}`);
    throw error;
  }
}

/**
 * Disable user in RADIUS (no active plan)
 */
async function disableUserInRadius(username: string, logger?: FastifyBaseLogger): Promise<void> {
  // Set Auth-Type = Reject in radcheck
  const existing = await prisma.radCheck.findFirst({
    where: {
      userName: username,
      attribute: 'Auth-Type'
    }
  });

  if (existing) {
    await prisma.radCheck.update({
      where: { id: existing.id },
      data: {
        op: ':=',
        value: 'Reject'
      }
    });
  } else {
    await prisma.radCheck.create({
      data: {
        userName: username,
        attribute: 'Auth-Type',
        op: ':=',
        value: 'Reject'
      }
    });
  }

  logger?.info(`[RADIUS Sync] Disabled user ${username} in RADIUS`);
}

/**
 * Sync radcheck table (authentication checks)
 */
async function syncRadCheck(
  username: string,
  options: {
    enabled: boolean;
    maxSessions?: number | null;
    logger?: FastifyBaseLogger;
  }
): Promise<void> {
  const { enabled, maxSessions, logger } = options;

  if (!enabled) {
    await disableUserInRadius(username, logger);
    return;
  }

  // Remove Auth-Type = Reject if exists
  await prisma.radCheck.deleteMany({
    where: {
      userName: username,
      attribute: 'Auth-Type',
      value: 'Reject'
    }
  });

  // Set Simultaneous-Use if maxSessions is set (valid FreeRADIUS attribute for concurrent session limits)
  if (maxSessions !== null && maxSessions !== undefined) {
    const existing = await prisma.radCheck.findFirst({
      where: {
        userName: username,
        attribute: 'Simultaneous-Use'
      }
    });

    if (existing) {
      await prisma.radCheck.update({
        where: { id: existing.id },
        data: {
          op: ':=',
          value: maxSessions.toString()
        }
      });
    } else {
      await prisma.radCheck.create({
        data: {
          userName: username,
          attribute: 'Simultaneous-Use',
          op: ':=',
          value: maxSessions.toString()
        }
      });
    }
  } else {
    // Remove Simultaneous-Use if unlimited
    await prisma.radCheck.deleteMany({
      where: {
        userName: username,
        attribute: 'Simultaneous-Use'
      }
    });
  }
}

/**
 * Sync radreply table (reply attributes - limits)
 */
async function syncRadReply(
  username: string,
  options: {
    dataQuota?: bigint | null;
    remainingQuota?: bigint | null;
    maxUploadSpeed?: bigint | null;
    maxDownloadSpeed?: bigint | null;
    sessionTimeout?: number | null;
    idleTimeout?: number | null;
    validityDays?: number | null;
    logger?: FastifyBaseLogger;
  }
): Promise<void> {
  const {
    dataQuota,
    remainingQuota,
    maxUploadSpeed,
    maxDownloadSpeed,
    sessionTimeout,
    idleTimeout,
    validityDays,
    logger
  } = options;

  // Session-Timeout (27)
  if (sessionTimeout !== null && sessionTimeout !== undefined) {
    await upsertRadReply(username, 'Session-Timeout', sessionTimeout.toString());
  } else {
    await deleteRadReply(username, 'Session-Timeout');
  }

  // Idle-Timeout (28)
  if (idleTimeout !== null && idleTimeout !== undefined) {
    await upsertRadReply(username, 'Idle-Timeout', idleTimeout.toString());
  } else {
    await deleteRadReply(username, 'Idle-Timeout');
  }

  // Bandwidth Limits (Enforced by uspot + ratelimit/tc)
  // uspot supports WISPr attributes natively
  if (maxDownloadSpeed !== null && maxDownloadSpeed !== undefined) {
    // WISPr is in bits per second
    const bitsPerSec = maxDownloadSpeed * 8n;
    await upsertRadReply(username, 'WISPr-Bandwidth-Max-Down', bitsPerSec.toString());
  } else {
    await deleteRadReply(username, 'WISPr-Bandwidth-Max-Down');
  }

  if (maxUploadSpeed !== null && maxUploadSpeed !== undefined) {
    const bitsPerSec = maxUploadSpeed * 8n;
    await upsertRadReply(username, 'WISPr-Bandwidth-Max-Up', bitsPerSec.toString());
  } else {
    await deleteRadReply(username, 'WISPr-Bandwidth-Max-Up');
  }

  // Data Quota (Enforced by uspot BPF accounting)
  // ChilliSpot-Max-Total-Octets is supported by uspot
  if (remainingQuota !== null && remainingQuota !== undefined && remainingQuota > 0n) {
    await upsertRadReply(username, 'ChilliSpot-Max-Total-Octets', remainingQuota.toString());
  } else {
    // Remove quota limit if exhausted or not set
    await deleteRadReply(username, 'ChilliSpot-Max-Total-Octets');
  }
}

/**
 * Upsert a radreply entry
 */
async function upsertRadReply(
  username: string,
  attribute: string,
  value: string
): Promise<void> {
  const existing = await prisma.radReply.findFirst({
    where: {
      userName: username,
      attribute
    }
  });

  if (existing) {
    await prisma.radReply.update({
      where: { id: existing.id },
      data: { value }
    });
  } else {
    await prisma.radReply.create({
      data: {
        userName: username,
        attribute,
        op: '=',
        value
      }
    });
  }
}

/**
 * Delete a radreply entry
 */
async function deleteRadReply(username: string, attribute: string): Promise<void> {
  await prisma.radReply.deleteMany({
    where: {
      userName: username,
      attribute
    }
  });
}

/**
 * Update quota tracking in radquota table
 */
async function updateQuotaTracking(
  username: string,
  maxOctets: bigint,
  usedOctets: bigint,
  quotaType: string,
  logger?: FastifyBaseLogger
): Promise<void> {
  const now = new Date();
  let periodStart: Date;
  let periodEnd: Date;

  // Calculate period based on quota type
  switch (quotaType) {
    case 'DAILY':
      periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      periodEnd = new Date(periodStart);
      periodEnd.setDate(periodEnd.getDate() + 1);
      break;
    case 'WEEKLY':
      const dayOfWeek = now.getDay();
      periodStart = new Date(now);
      periodStart.setDate(now.getDate() - dayOfWeek);
      periodStart.setHours(0, 0, 0, 0);
      periodEnd = new Date(periodStart);
      periodEnd.setDate(periodEnd.getDate() + 7);
      break;
    case 'MONTHLY':
      periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
      periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      break;
    case 'ONE_TIME':
      periodStart = now;
      periodEnd = new Date('2099-12-31'); // Far future
      break;
    default:
      periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
      periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  }

  // Find existing quota for this period (exact match on periodStart)
  const existing = await prisma.radQuota.findFirst({
    where: {
      username,
      quotaType,
      periodStart
    }
  });

  if (existing) {
    await prisma.radQuota.update({
      where: { id: existing.id },
      data: {
        maxOctets,
        usedOctets,
        periodEnd,
        updatedAt: now
      }
    });
  } else {
    await prisma.radQuota.create({
      data: {
        username,
        quotaType,
        maxOctets,
        usedOctets,
        periodStart,
        periodEnd
      }
    });
  }

  logger?.debug(`[RADIUS Sync] Updated quota tracking for ${username}: ${quotaType}`);
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

