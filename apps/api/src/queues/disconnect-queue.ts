/**
 * BullMQ Queue for User Disconnect Processing
 * Handles quota overage and plan expiry disconnects at scale
 */

import { Queue, Worker, Job } from 'bullmq';
import { redis } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { routerRpcService } from '../services/router-rpc.service.js';

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
        select: {
          acctSessionId: true,
          routerId: true,
          callingStationId: true, // MAC Address is required for Uspot kick
          framedIpAddress: true
        }
      });

      if (activeSessions.length === 0) {
        // No active sessions, just disable in RADIUS
        await disableUserInRadius(username);
        await markQueueProcessed(queueId);
        return { sessions: 0, kicked: 0 };
      }

      // Send WebSocket Kick Command to all active routers
      // This works behind NAT because it uses the persistent WebSocket bridge
      const disconnectPromises = activeSessions.map(async (session) => {
        if (!session.routerId || !session.callingStationId) {
          console.warn(`[Disconnect] Cannot kick session ${session.acctSessionId}: Missing RouterID or MAC`);
          return;
        }

        try {
          console.log(`[Disconnect] Kicking user ${username} (MAC: ${session.callingStationId}) from router ${session.routerId} via WebSocket`);
          
          // Sends 'ubus call uspot client_remove' via the bridge
          await routerRpcService.kickClient(session.routerId, session.callingStationId);
          
          return true;
        } catch (error: any) {
          console.error(`[Disconnect] Failed to kick MAC ${session.callingStationId} on router ${session.routerId}: ${error.message}`);
          // We continue anyway to ensure the user is disabled in DB
          return false;
        }
      });

      const results = await Promise.allSettled(disconnectPromises);
      const successful = results.filter(r => r.status === 'fulfilled' && r.value === true).length;

      // Disable user in RADIUS (prevent re-authentication)
      await disableUserInRadius(username);

      // Force close sessions in DB (Accounting Stop might not arrive if router is offline)
      // We set a specific terminate cause so we know the system did it
      await prisma.radAcct.updateMany({
        where: {
          userName: username,
          acctStopTime: null
        },
        data: {
          acctStopTime: new Date(),
          acctTerminateCause: 'Admin-Reset' // Standard RADIUS attribute for forced disconnect
        }
      });

      // Mark queue item as processed
      await markQueueProcessed(queueId);

      return {
        sessions: activeSessions.length,
        kicked: successful,
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

// Helper: Disable user in RadCheck to prevent immediate reconnection
async function disableUserInRadius(username: string) {
  await prisma.$executeRaw`
    INSERT INTO radcheck (username, attribute, op, value)
    VALUES (${username}, 'Auth-Type', ':=', 'Reject')
    ON CONFLICT (username, attribute) 
    DO UPDATE SET value = 'Reject', op = ':='
  `;
}

// Helper: Mark database queue item as processed
async function markQueueProcessed(queueId?: number) {
  if (!queueId) return;
  
  await prisma.disconnectQueue.update({
    where: { id: queueId },
    data: {
      processed: true,
      processedAt: new Date()
    }
  });
}

// Worker event handlers
disconnectWorker.on('completed', (job) => {
  const { username, reason } = job.data;
  const result = job.returnvalue;
  console.log(`✅ Processed disconnect for ${username}: ${result.sessions} session(s) closed, ${result.kicked} router kicks sent via WS - Reason: ${reason}`);
});

disconnectWorker.on('failed', (job, err) => {
  const { username } = job?.data || { username: 'unknown' };
  console.error(`❌ Failed disconnect job for ${username}:`, err.message);
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

