import { prisma } from '../lib/prisma.js';

/**
 * Quota management service for cross-router data limits
 */

export interface QuotaInfo {
  remaining: bigint;
  total: bigint;
  used: bigint;
  percentage: number;
}

/**
 * Get user's current quota information
 */
export async function getUserQuota(userName: string): Promise<QuotaInfo | null> {
  const quota = await prisma.radQuota.findFirst({
    where: {
      username: userName,
      periodEnd: { gt: new Date() },
      periodStart: { lte: new Date() }
    },
    orderBy: {
      periodEnd: 'desc'
    }
  });

  if (!quota) {
    return null;
  }

  const remaining = quota.maxOctets - quota.usedOctets;
  const percentage = Number(quota.usedOctets) / Number(quota.maxOctets) * 100;

  return {
    remaining: remaining > 0n ? BigInt(remaining) : 0n,
    total: quota.maxOctets,
    used: quota.usedOctets,
    percentage: Math.min(100, Math.max(0, percentage))
  };
}

/**
 * Create or update user quota
 */
export async function createOrUpdateQuota(
  userName: string,
  maxQuotaGB: number,
  quotaType: string = 'monthly',
  periodDays: number = 30
): Promise<void> {
  const maxOctets = BigInt(Math.floor(maxQuotaGB * 1024 * 1024 * 1024));
  const periodStart = new Date();
  const periodEnd = new Date();
  periodEnd.setDate(periodEnd.getDate() + periodDays);

  await prisma.radQuota.upsert({
    where: {
      username_quotaType_periodStart: {
        username: userName,
        quotaType,
        periodStart
      }
    },
    update: {
      maxOctets,
      periodEnd,
      updatedAt: new Date()
    },
    create: {
      username: userName,
      quotaType,
      maxOctets,
      usedOctets: 0n,
      periodStart,
      periodEnd
    }
  });

  // Update RADIUS reply attribute with remaining quota
  await updateRadiusQuotaLimit(userName);
}

/**
 * Update RADIUS reply attributes with quota and session timeout
 * Sets both ChilliSpot-Max-Total-Octets (data limit) and Session-Timeout (period expiry)
 * This ensures the NAS enforces both limits natively without periodic checks
 * 
 * @returns QuotaInfo if quota exists and has remaining, null otherwise
 */
export async function updateRadiusQuotaLimit(userName: string): Promise<QuotaInfo | null> {
  const now = new Date();
  
  // Optimized: Get quota and period info in a single query
  const quota = await prisma.radQuota.findFirst({
    where: {
      username: userName,
      periodEnd: { gt: now },
      periodStart: { lte: now }
    },
    orderBy: {
      periodEnd: 'desc'
    }
  });

  if (!quota) {
    // No active quota period found - remove attributes
    await prisma.radReply.deleteMany({
      where: {
        userName,
        attribute: { in: ['ChilliSpot-Max-Total-Octets', 'Session-Timeout'] }
      }
    });
    return null;
  }

  // Calculate quota info from the quota record
  const remaining = quota.maxOctets - quota.usedOctets;
  const quotaInfo: QuotaInfo = {
    remaining: remaining > 0n ? BigInt(remaining) : 0n,
    total: quota.maxOctets,
    used: quota.usedOctets,
    percentage: Number(quota.usedOctets) / Number(quota.maxOctets) * 100
  };

  if (quotaInfo.remaining <= 0n) {
    // Quota exhausted - remove attributes
    await prisma.radReply.deleteMany({
      where: {
        userName,
        attribute: { in: ['ChilliSpot-Max-Total-Octets', 'Session-Timeout'] }
      }
    });
    return null;
  }

  // Calculate seconds until period expires
  const secondsUntilExpiry = Math.max(0, Math.floor((quota.periodEnd.getTime() - now.getTime()) / 1000));
  
  // Set data quota limit (remaining quota in bytes)
  await prisma.radReply.upsert({
    where: {
      userName_attribute: {
        userName,
        attribute: 'ChilliSpot-Max-Total-Octets'
      }
    },
    update: {
      value: quotaInfo.remaining.toString()
    },
    create: {
      userName,
      attribute: 'ChilliSpot-Max-Total-Octets',
      op: '=',
      value: quotaInfo.remaining.toString()
    }
  });

  // Set session timeout (period expiry in seconds)
  // NAS will automatically disconnect user when this time expires
  await prisma.radReply.upsert({
    where: {
      userName_attribute: {
        userName,
        attribute: 'Session-Timeout'
      }
    },
    update: {
      value: secondsUntilExpiry.toString()
    },
    create: {
      userName,
      attribute: 'Session-Timeout',
      op: '=',
      value: secondsUntilExpiry.toString()
    }
  });

  return quotaInfo;
}

/**
 * Reset quota for a user (start new period)
 */
export async function resetUserQuota(
  userName: string,
  quotaType: string = 'monthly'
): Promise<void> {
  const periodStart = new Date();
  const periodEnd = new Date();
  periodEnd.setDate(periodEnd.getDate() + 30);

  const quota = await prisma.radQuota.findFirst({
    where: {
      username: userName,
      quotaType,
      periodEnd: { gt: new Date() }
    }
  });

  if (quota) {
    // Reset used quota for new period
    await prisma.radQuota.update({
      where: { id: quota.id },
      data: {
        usedOctets: 0n,
        periodStart,
        periodEnd,
        updatedAt: new Date()
      }
    });
  }

  await updateRadiusQuotaLimit(userName);
}

/**
 * Get quota usage statistics
 */
export async function getQuotaStats(userName?: string) {
  const where = userName ? { username: userName } : {};
  
  const quotas = await prisma.radQuota.findMany({
    where: {
      ...where,
      periodEnd: { gt: new Date() }
    },
    orderBy: {
      periodEnd: 'desc'
    }
  });

  return quotas.map((q: typeof quotas[0]) => ({
    username: q.username,
    quotaType: q.quotaType,
    maxGB: Number(q.maxOctets) / (1024 * 1024 * 1024),
    usedGB: Number(q.usedOctets) / (1024 * 1024 * 1024),
    remainingGB: Number(q.maxOctets - q.usedOctets) / (1024 * 1024 * 1024),
    percentage: Number(q.usedOctets) / Number(q.maxOctets) * 100,
    periodStart: q.periodStart,
    periodEnd: q.periodEnd
  }));
}

/**
 * Check if user has remaining quota
 */
export async function hasRemainingQuota(userName: string): Promise<boolean> {
  const quotaInfo = await getUserQuota(userName);
  return quotaInfo !== null && quotaInfo.remaining > 0n;
}
