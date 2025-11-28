/**
 * BullMQ Queue for User Disconnect Processing
 * Handles quota overage and plan expiry disconnects at scale
 */

import { Queue, Worker, Job } from 'bullmq';
import { redis } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { sendCoARequest } from '../services/coa-service.js';

export interface DisconnectJobData {
  username: string;
  reason: 'QUOTA_EXCEEDED' | 'PLAN_EXPIRED';
  queueId?: number; // Optional: ID from disconnect_queue table
}

// Create queue
export const disconnectQueue = new Queue<DisconnectJobData>('disconnect-users', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000, // 2s, 4s, 8s
    },
    removeOnComplete: {
      age: 3600, // Keep completed jobs for 1 hour
      count: 1000, // Keep last 1000 jobs
    },
    removeOnFail: {
      age: 86400, // Keep failed jobs for 24 hours
    },
  },
});

// Create worker with concurrency for parallel processing
export const disconnectWorker = new Worker<DisconnectJobData>(
  'disconnect-users',
  async (job: Job<DisconnectJobData>) => {
    const { username, reason, queueId } = job.data;

    try {
      // Find all active sessions for this user (batch query)
      const activeSessions = await prisma.radAcct.findMany({
        where: {
          userName: username,
          acctStopTime: null
        },
        include: {
          router: {
            select: {
              id: true,
              nasipaddress: true,
              radiusSecret: true
            }
          }
        }
      });

      if (activeSessions.length === 0) {
        // No active sessions, just disable in RADIUS
        await prisma.$executeRaw`
          INSERT INTO radcheck (username, attribute, op, value)
          VALUES (${username}, 'Auth-Type', ':=', 'Reject')
          ON CONFLICT (username, attribute) 
          DO UPDATE SET value = 'Reject', op = ':='
        `;

        // Mark queue item as processed if queueId provided
        if (queueId) {
          await prisma.disconnectQueue.update({
            where: { id: queueId },
            data: {
              processed: true,
              processedAt: new Date()
            }
          });
        }

        return { sessions: 0, coaSent: 0 };
      }

      // Send CoA Disconnect to all active routers (parallel)
      const disconnectPromises = activeSessions
        .filter(session => session.router?.nasipaddress && session.router?.radiusSecret)
        .map(session => {
          return sendCoARequest({
            nasIp: session.router!.nasipaddress!,
            nasId: session.router!.id,
            secret: session.router!.radiusSecret!,
            username: session.userName!,
            acctSessionId: session.acctSessionId,
            callingStationId: session.callingStationId || undefined,
            calledStationId: session.calledStationId || undefined,
            userIp: session.framedIpAddress || undefined
          });
        });

      const results = await Promise.allSettled(disconnectPromises);
      const successful = results.filter(r => r.status === 'fulfilled').length;

      // Disable user in RADIUS (prevent re-authentication)
      await prisma.$executeRaw`
        INSERT INTO radcheck (username, attribute, op, value)
        VALUES (${username}, 'Auth-Type', ':=', 'Reject')
        ON CONFLICT (username, attribute) 
        DO UPDATE SET value = 'Reject', op = ':='
      `;

      // Mark queue item as processed if queueId provided
      if (queueId) {
        await prisma.disconnectQueue.update({
          where: { id: queueId },
          data: {
            processed: true,
            processedAt: new Date()
          }
        });
      }

      return {
        sessions: activeSessions.length,
        coaSent: successful,
        failed: results.length - successful
      };
    } catch (error: any) {
      console.error(`❌ Failed to process disconnect for ${username}:`, error);
      throw error; // Let BullMQ handle retry
    }
  },
  {
    connection: redis,
    concurrency: 20, // Process 20 users in parallel
    limiter: {
      max: 100, // Max 100 jobs per
      duration: 1000, // 1 second (100 jobs/sec throughput)
    },
  }
);

// Worker event handlers
disconnectWorker.on('completed', (job) => {
  const { username, reason } = job.data;
  const result = job.returnvalue;
  console.log(`✅ Disconnected user ${username} (${result.sessions} session(s), ${result.coaSent} CoA sent) - Reason: ${reason}`);
});

disconnectWorker.on('failed', (job, err) => {
  const { username } = job?.data || { username: 'unknown' };
  console.error(`❌ Failed to disconnect user ${username}:`, err.message);
});

disconnectWorker.on('error', (err) => {
  console.error('❌ Disconnect worker error:', err);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await disconnectWorker.close();
  await disconnectQueue.close();
  await redis.quit();
});

