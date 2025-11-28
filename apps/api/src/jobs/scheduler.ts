import cron from 'node-cron';
import { generateInvoices } from '../services/billing.js';
import { prisma } from '../lib/prisma.js';
import { disconnectQueue } from '../queues/disconnect-queue.js';

/**
 * Production-grade cron scheduler
 * With trigger-based accounting and Interim-Updates, we only need:
 * 1. Monthly invoice generation
 * 2. Router status monitoring
 * 
 * Quota tracking is now handled entirely by:
 * - Database triggers on radacct updates (Interim-Updates from uspot)
 * - No polling required - uspot sends updates every 5 minutes natively
 */
export function startScheduler() {
  console.log('⏰ Starting production scheduler');

  // Invoice generation - 1st of month at 2 AM
  // Note: generateInvoices() already processes routers in batches (10 at a time) for scalability
  cron.schedule('0 2 1 * *', async () => {
    console.log('💰 Generating monthly invoices');
    try {
      await generateInvoices();
      console.log('✅ Invoices generated successfully');
    } catch (error) {
      console.error('❌ Invoice generation failed:', error);
    }
  });

  // Maintenance tasks - every 5 minutes
  // Combines: Router status monitoring + Stale session cleanup
  cron.schedule('*/5 * * * *', async () => {
    try {
      // Router status monitoring
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const routerResult = await prisma.router.updateMany({
        where: {
          status: 'ONLINE',
          lastSeen: { lt: fiveMinutesAgo }
        },
        data: { status: 'OFFLINE' }
      });

      if (routerResult.count > 0) {
        console.log(`📡 ${routerResult.count} router(s) marked offline`);
      }

      // Stale session cleanup
      const staleThreshold = new Date(Date.now() - 10 * 60 * 1000);
      const staleResult = await prisma.radAcct.updateMany({
        where: {
          acctStopTime: null,
          OR: [
            { acctUpdateTime: { lt: staleThreshold } },
            { 
              AND: [
                { acctUpdateTime: null },
                { acctStartTime: { lt: staleThreshold } }
              ]
            }
          ]
        },
        data: {
          acctStopTime: new Date(),
          acctTerminateCause: 'Admin-Reset'
        }
      });
      
      if (staleResult.count > 0) {
        console.log(`🧹 Cleaned up ${staleResult.count} stale session(s)`);
      }
    } catch (error) {
      console.error('❌ Maintenance tasks failed:', error);
    }
  });

  // Daily stats refresh - 1 AM daily
  cron.schedule('0 1 * * *', async () => {
    console.log('📊 Refreshing materialized view (daily stats)');
    try {
      await prisma.$executeRaw`SELECT refresh_daily_stats()`;
      console.log('✅ Daily stats refreshed');
    } catch (error) {
      console.error('❌ Stats refresh failed:', error);
    }
  });

  // Quota enforcement - BullMQ-based (highly scalable)
  // Polls disconnect_queue table and adds jobs to BullMQ for parallel processing
  // Critical for high-speed connections (1Gbps = 7GB/minute)
  const runQuotaEnforcement = async () => {
    try {
      const overageUsers = await prisma.disconnectQueue.findMany({
        where: { processed: false },
        orderBy: { createdAt: 'asc' },
        take: 200 // Process larger batches (BullMQ handles concurrency)
      });

      if (overageUsers.length > 0) {
        console.log(`🚫 Queueing ${overageUsers.length} disconnect job(s) to BullMQ`);

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
          console.log(`✅ Queued ${successful} disconnect job(s) to BullMQ`);
        }
        if (failed > 0) {
          console.error(`❌ Failed to queue ${failed} disconnect job(s)`);
        }
      }
    } catch (error) {
      console.error('❌ Disconnect queue polling failed:', error);
    } finally {
      // Schedule next run in 10 seconds (high-frequency for real-time enforcement)
      setTimeout(runQuotaEnforcement, 10000);
    }
  };

  // Start the high-frequency quota enforcement loop
  runQuotaEnforcement();

  // Plan expiry is handled entirely by pg_cron (database-native)
  // No application cron needed - pg_cron runs every minute in the database

  console.log('✅ Scheduler ready');
  console.log('   → Invoices: Monthly (1st at 2 AM)');
  console.log('   → Maintenance: Every 5 minutes (router status + stale sessions)');
  console.log('   → Daily stats: Daily at 1 AM');
  console.log('   → Quota enforcement: BullMQ (20 parallel workers, 100 jobs/sec)');
  console.log('   → Plan expiry: pg_cron (every minute, database-native)');
  console.log('   → Quota tracking: Native (database triggers + Interim-Updates)');
  console.log('   → Session tracking: Real-time (database triggers)');
}

