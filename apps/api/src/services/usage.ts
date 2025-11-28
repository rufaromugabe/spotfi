/**
 * User Usage Service
 */

import { prisma } from '../lib/prisma.js';

/**
 * Get user's total usage
 * 
 * @param username - Username to get usage for
 * @returns Total usage in bytes (historical + active sessions)
 */
export async function getUserTotalUsage(username: string): Promise<bigint> {
  try {
    const result = await prisma.$queryRaw<Array<{ get_user_total_usage: bigint }>>`
      SELECT get_user_total_usage(${username}) as get_user_total_usage
    `;
    
    return result[0]?.get_user_total_usage || 0n;
  } catch (error) {
    console.warn(`get_user_total_usage() function not found, using fallback for ${username}`);
    return 0n;
  }
}

/**
 * Get user's usage breakdown
 * 
 * @param username - Username to get usage for
 * @returns Usage breakdown
 */
export async function getUserUsageBreakdown(username: string) {
  const currentPeriod = new Date();
  currentPeriod.setDate(1); // First day of current month
  currentPeriod.setHours(0, 0, 0, 0);

  // Get historical usage
  const counterUsage = await prisma.$queryRaw<Array<{
    username: string;
    period_start: Date;
    bytes_used: bigint;
  }>>`
    SELECT username, period_start, bytes_used
    FROM user_quota_usage
    WHERE username = ${username}
    AND period_start = ${currentPeriod}
  `;

  // Get active sessions usage
  const activeSessions = await prisma.radAcct.findMany({
    where: {
      userName: username,
      acctStopTime: null
    },
    select: {
      acctInputOctets: true,
      acctOutputOctets: true
    }
  });

  const activeUsage = activeSessions.reduce((sum, session) => {
    return sum + (session.acctInputOctets || 0n) + (session.acctOutputOctets || 0n);
  }, 0n);

  const historicalUsage = counterUsage[0]?.bytes_used || 0n;
  const totalUsage = historicalUsage + activeUsage;

  return {
    historical: historicalUsage,
    active: activeUsage,
    total: totalUsage
  };
}

