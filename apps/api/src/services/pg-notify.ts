/**
 * PostgreSQL NOTIFY/LISTEN Service
 * Real-time event-driven architecture for disconnect_queue and plan expiry processing
 * 
 * Architecture:
 * - Database trigger sends NOTIFY when disconnect_queue row is inserted
 * - Database trigger sends NOTIFY when user_plans expire
 * - Node.js LISTENs for notifications using dedicated pg connection
 * - Instant processing (ms latency) instead of polling (10s delay)
 * 
 * Benefits:
 * - Eliminates polling overhead
 * - Near real-time quota enforcement
 * - Instant plan expiry detection
 * - Reduces database read load
 */

import { Client } from 'pg';
import { prisma } from '../lib/prisma.js';
import { disconnectQueue } from '../queues/disconnect-queue.js';
import { incrementUserSessionCount, decrementUserSessionCount } from './session-counter.js';
import { FastifyBaseLogger } from 'fastify';

const DISCONNECT_QUEUE_CHANNEL = 'disconnect_queue_notify';
const PLAN_EXPIRY_CHANNEL = 'plan_expiry_notify';
const SESSION_COUNT_CHANNEL = 'session_count_change';

let notifyClient: Client | null = null;
let isListening = false;

/**
 * Start listening for PostgreSQL NOTIFY events
 * Uses a dedicated pg connection for LISTEN (Prisma doesn't support persistent connections)
 */
export async function startPgNotifyListener(logger?: FastifyBaseLogger): Promise<void> {
  if (isListening) {
    logger?.warn('⚠️  PG_NOTIFY listener already started');
    return;
  }

  try {
    // Parse DATABASE_URL to create pg client
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL environment variable not set');
    }

    // Create dedicated client for LISTEN/NOTIFY (requires persistent connection)
    notifyClient = new Client({
      connectionString: databaseUrl,
      // Keep connection alive for LISTEN
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    });

    await notifyClient.connect();
    logger?.info('✅ Connected to PostgreSQL for NOTIFY listener');

    // Start listening on all channels
    await notifyClient.query(`LISTEN ${DISCONNECT_QUEUE_CHANNEL}`);
    await notifyClient.query(`LISTEN ${PLAN_EXPIRY_CHANNEL}`);
    await notifyClient.query(`LISTEN ${SESSION_COUNT_CHANNEL}`);
    isListening = true;
    logger?.info(`✅ Started PostgreSQL NOTIFY listener on channels: ${DISCONNECT_QUEUE_CHANNEL}, ${PLAN_EXPIRY_CHANNEL}, ${SESSION_COUNT_CHANNEL}`);

    // Set up notification handler
    notifyClient.on('notification', async (msg) => {
      if (msg.channel === DISCONNECT_QUEUE_CHANNEL) {
        logger?.debug(`📨 Received NOTIFY on ${DISCONNECT_QUEUE_CHANNEL}, processing disconnect queue...`);
        // Process disconnect queue immediately when notified
        await processDisconnectQueueOnNotify(logger);
      } else if (msg.channel === PLAN_EXPIRY_CHANNEL) {
        const userId = msg.payload || '';
        logger?.debug(`📨 Received NOTIFY on ${PLAN_EXPIRY_CHANNEL}, processing plan expiry for user: ${userId}`);
        // Process plan expiry immediately when notified
        if (userId) {
          await processPlanExpiryOnNotify(userId, logger);
        }
      } else if (msg.channel === SESSION_COUNT_CHANNEL) {
        // Update Redis session counter
        try {
          const data = JSON.parse(msg.payload || '{}');
          const { username, action } = data;
          
          if (username && action) {
            if (action === 'start') {
              await incrementUserSessionCount(username);
              logger?.debug(`[SessionCounter] Incremented count for ${username}`);
            } else if (action === 'stop') {
              await decrementUserSessionCount(username);
              logger?.debug(`[SessionCounter] Decremented count for ${username}`);
            }
          }
        } catch (error: any) {
          logger?.warn(`[SessionCounter] Failed to process session count notification: ${error.message}`);
        }
      }
    });

    // Handle connection errors
    notifyClient.on('error', (err) => {
      logger?.error(`❌ PostgreSQL NOTIFY client error: ${err.message}`);
      isListening = false;
      // Attempt to reconnect after delay
      setTimeout(() => {
        if (!isListening) {
          logger?.warn('🔄 Attempting to reconnect PostgreSQL NOTIFY listener...');
          startPgNotifyListener(logger).catch(() => {
            logger?.error('❌ Failed to reconnect PostgreSQL NOTIFY listener');
          });
        }
      }, 5000);
    });

    // Handle disconnection
    notifyClient.on('end', () => {
      logger?.warn('⚠️  PostgreSQL NOTIFY client disconnected');
      isListening = false;
    });

  } catch (error: any) {
    logger?.error(`❌ Failed to start PostgreSQL NOTIFY listener: ${error.message}`);
    logger?.warn('⚠️  Falling back to polling mode (10s interval)');
    isListening = false;
  }
}

/**
 * Stop listening for PostgreSQL NOTIFY events
 */
export async function stopPgNotifyListener(logger?: FastifyBaseLogger): Promise<void> {
  if (notifyClient && isListening) {
    try {
      await notifyClient.query(`UNLISTEN ${DISCONNECT_QUEUE_CHANNEL}`);
      await notifyClient.query(`UNLISTEN ${PLAN_EXPIRY_CHANNEL}`);
      await notifyClient.query(`UNLISTEN ${SESSION_COUNT_CHANNEL}`);
      await notifyClient.end();
      isListening = false;
      logger?.info('✅ Stopped PostgreSQL NOTIFY listener');
    } catch (error: any) {
      logger?.error(`❌ Error stopping PostgreSQL NOTIFY listener: ${error.message}`);
    } finally {
      notifyClient = null;
    }
  }
}

/**
 * Process disconnect_queue items immediately (called on NOTIFY)
 * This replaces the polling mechanism with event-driven processing
 */
export async function processDisconnectQueueOnNotify(logger?: FastifyBaseLogger): Promise<void> {
  try {
    // Get unprocessed items (same logic as polling, but triggered by NOTIFY)
    const overageUsers = await prisma.disconnectQueue.findMany({
      where: { processed: false },
      orderBy: { createdAt: 'asc' },
      take: 200 // Process larger batches
    });

    if (overageUsers.length === 0) {
      return;
    }

    logger?.info(`🚫 Processing ${overageUsers.length} disconnect job(s) from NOTIFY trigger`);

    // Add all users to BullMQ queue (parallel processing)
    const jobs = await Promise.allSettled(
      overageUsers.map(item =>
        disconnectQueue.add(
          `disconnect-${item.username}`,
          {
            username: item.username,
            reason: item.reason as 'QUOTA_EXCEEDED' | 'PLAN_EXPIRED',
            queueId: item.id
          },
          {
            jobId: `disconnect-${item.username}-${item.id}`, // Prevent duplicates
            removeOnComplete: true,
            removeOnFail: false
          }
        )
      )
    );

    const successful = jobs.filter(j => j.status === 'fulfilled').length;
    const failed = jobs.filter(j => j.status === 'rejected').length;

    if (successful > 0) {
      logger?.info(`✅ Queued ${successful} disconnect job(s) to BullMQ (NOTIFY-triggered)`);
    }
    if (failed > 0) {
      logger?.error(`❌ Failed to queue ${failed} disconnect job(s)`);
    }
  } catch (error: any) {
    logger?.error(`❌ Failed to process disconnect queue on NOTIFY: ${error.message}`);
  }
}

/**
 * Process plan expiry immediately (called on NOTIFY)
 * This handles instant plan expiry detection via database triggers
 */
async function processPlanExpiryOnNotify(userId: string, logger?: FastifyBaseLogger): Promise<void> {
  try {
    // Call the database function to expire plans and disable users
    const result = await prisma.$queryRaw<Array<{ expired_count: bigint; users_affected: bigint }>>`
      SELECT * FROM batch_expire_plans()
    `;
    
    if (result.length > 0 && result[0].expired_count > 0n) {
      logger?.info(`⏰ Processed plan expiry: ${result[0].expired_count} plan(s) expired, ${result[0].users_affected} user(s) affected`);
    }
    
    // Disable users without active plans (this also sends NOTIFY for disconnect_queue)
    const disableResult = await prisma.$queryRaw<Array<{ disabled_count: bigint }>>`
      SELECT * FROM disable_users_without_plans()
    `;
    
    if (disableResult.length > 0 && disableResult[0].disabled_count > 0n) {
      logger?.info(`🚫 Disabled ${disableResult[0].disabled_count} user(s) without active plans`);
    }
  } catch (error: any) {
    logger?.error(`❌ Failed to process plan expiry on NOTIFY: ${error.message}`);
  }
}

/**
 * Get the NOTIFY channel names (for database triggers)
 */
export function getDisconnectQueueChannel(): string {
  return DISCONNECT_QUEUE_CHANNEL;
}

export function getPlanExpiryChannel(): string {
  return PLAN_EXPIRY_CHANNEL;
}

/**
 * Check if listener is active
 */
export function isListenerActive(): boolean {
  return isListening && notifyClient !== null;
}
