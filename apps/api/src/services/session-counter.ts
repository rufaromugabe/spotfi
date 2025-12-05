/**
 * Redis-based Active Session Counter Service
 * Maintains real-time session counts per user in Redis for fast reads
 * Updated via database triggers (pg_notify) for consistency
 */

import { redis } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { FastifyBaseLogger } from 'fastify';

const SESSION_COUNT_KEY_PREFIX = 'user:sessions:';
const SESSION_COUNT_TTL = 86400; // 24 hours TTL (sessions should update regularly)

/**
 * Get active session count for a user from Redis
 * Falls back to DB query if Redis is unavailable
 */
export async function getUserActiveSessionCount(
  username: string,
  logger?: FastifyBaseLogger
): Promise<number> {
  try {
    const key = `${SESSION_COUNT_KEY_PREFIX}${username}`;
    const count = await redis.get(key);
    
    if (count !== null) {
      return parseInt(count, 10);
    }
    
    // Fallback to DB query if not in Redis
    logger?.debug(`[SessionCounter] Cache miss for ${username}, querying DB`);
    return await refreshUserSessionCount(username, logger);
  } catch (error: any) {
    logger?.warn(`[SessionCounter] Redis error for ${username}, falling back to DB: ${error.message}`);
    // Fallback to DB query on error
    return await getUserActiveSessionCountFromDB(username);
  }
}

/**
 * Refresh session count from DB and update Redis
 */
export async function refreshUserSessionCount(
  username: string,
  logger?: FastifyBaseLogger
): Promise<number> {
  try {
    const count = await getUserActiveSessionCountFromDB(username);
    await setUserActiveSessionCount(username, count);
    return count;
  } catch (error: any) {
    logger?.error(`[SessionCounter] Failed to refresh count for ${username}: ${error.message}`);
    throw error;
  }
}

/**
 * Set session count in Redis
 */
export async function setUserActiveSessionCount(
  username: string,
  count: number
): Promise<void> {
  const key = `${SESSION_COUNT_KEY_PREFIX}${username}`;
  await redis.setex(key, SESSION_COUNT_TTL, count.toString());
}

/**
 * Increment session count (when session starts)
 */
export async function incrementUserSessionCount(username: string): Promise<void> {
  const key = `${SESSION_COUNT_KEY_PREFIX}${username}`;
  await redis.incr(key);
  await redis.expire(key, SESSION_COUNT_TTL);
}

/**
 * Decrement session count (when session stops)
 */
export async function decrementUserSessionCount(username: string): Promise<void> {
  const key = `${SESSION_COUNT_KEY_PREFIX}${username}`;
  const newCount = await redis.decr(key);
  
  // If count goes negative, refresh from DB (data inconsistency)
  if (newCount < 0) {
    await refreshUserSessionCount(username);
  } else {
    await redis.expire(key, SESSION_COUNT_TTL);
  }
}

/**
 * Get session count directly from DB (fallback)
 */
async function getUserActiveSessionCountFromDB(username: string): Promise<number> {
  const result = await prisma.radAcct.count({
    where: {
      userName: username,
      acctStopTime: null,
    },
  });
  return result;
}

/**
 * Batch refresh session counts for multiple users
 */
export async function refreshMultipleUserSessionCounts(
  usernames: string[],
  logger?: FastifyBaseLogger
): Promise<void> {
  try {
    const counts = await prisma.radAcct.groupBy({
      by: ['userName'],
      where: {
        userName: { in: usernames },
        acctStopTime: null,
      },
      _count: {
        userName: true,
      },
    });

    const pipeline = redis.pipeline();
    for (const { userName, _count } of counts) {
      if (userName) {
        const key = `${SESSION_COUNT_KEY_PREFIX}${userName}`;
        pipeline.setex(key, SESSION_COUNT_TTL, _count.userName.toString());
      }
    }
    
    // Set count to 0 for users not in results
    const countedUsernames = new Set(counts.map(c => c.userName).filter(Boolean));
    for (const username of usernames) {
      if (!countedUsernames.has(username)) {
        const key = `${SESSION_COUNT_KEY_PREFIX}${username}`;
        pipeline.setex(key, SESSION_COUNT_TTL, '0');
      }
    }
    
    await pipeline.exec();
    logger?.debug(`[SessionCounter] Refreshed counts for ${usernames.length} users`);
  } catch (error: any) {
    logger?.error(`[SessionCounter] Failed to batch refresh: ${error.message}`);
    throw error;
  }
}

/**
 * Initialize session counts for all active users (on startup or periodic refresh)
 */
export async function initializeSessionCounts(logger?: FastifyBaseLogger): Promise<void> {
  try {
    logger?.info('[SessionCounter] Initializing session counts from DB...');
    
    // Get all users with active sessions
    const activeUsers = await prisma.radAcct.findMany({
      where: {
        acctStopTime: null,
      },
      select: {
        userName: true,
      },
      distinct: ['userName'],
    });

    const usernames = activeUsers
      .map(u => u.userName)
      .filter((u): u is string => u !== null);

    if (usernames.length === 0) {
      logger?.info('[SessionCounter] No active sessions found');
      return;
    }

    await refreshMultipleUserSessionCounts(usernames, logger);
    logger?.info(`[SessionCounter] Initialized counts for ${usernames.length} users`);
  } catch (error: any) {
    logger?.error(`[SessionCounter] Failed to initialize: ${error.message}`);
    throw error;
  }
}

/**
 * Clear session count for a user (when user is deleted)
 */
export async function clearUserSessionCount(username: string): Promise<void> {
  const key = `${SESSION_COUNT_KEY_PREFIX}${username}`;
  await redis.del(key);
}

