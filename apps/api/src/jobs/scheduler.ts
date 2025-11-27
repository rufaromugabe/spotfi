import cron from 'node-cron';
import { generateInvoices } from '../services/billing.js';
import { prisma } from '../lib/prisma.js';
import { sendCoARequest } from '../services/coa-service.js';

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

  // Router status monitoring - every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      
      const result = await prisma.router.updateMany({
        where: {
          status: 'ONLINE',
          lastSeen: { lt: fiveMinutesAgo }
        },
        data: { status: 'OFFLINE' }
      });

      if (result.count > 0) {
        console.log(`📡 ${result.count} router(s) marked offline`);
      }
    } catch (error) {
      console.error('❌ Status check failed:', error);
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

  // Quota enforcement - High-frequency processing (every 10 seconds)
  // Uses recursive timeout pattern for real-time enforcement
  // Critical for high-speed connections (1Gbps = 7GB/minute)
  const runQuotaEnforcement = async () => {
    try {
      const overageUsers = await prisma.disconnectQueue.findMany({
        where: { processed: false },
        orderBy: { createdAt: 'asc' },
        take: 50 // Process in batches
      });

      if (overageUsers.length > 0) {
        console.log(`🚫 Processing ${overageUsers.length} quota overage user(s)`);

        for (const item of overageUsers) {
          try {
            // Find all active sessions for this user
            const activeSessions = await prisma.radAcct.findMany({
              where: {
                userName: item.username,
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

            // Send CoA Disconnect to all active routers
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

            await Promise.allSettled(disconnectPromises);

            // Disable user in RADIUS (prevent re-authentication)
            await prisma.$executeRaw`
              INSERT INTO radcheck (username, attribute, op, value)
              VALUES (${item.username}, 'Auth-Type', ':=', 'Reject')
              ON CONFLICT (username, attribute) 
              DO UPDATE SET value = 'Reject', op = ':='
            `;

            // Mark as processed
            await prisma.disconnectQueue.update({
              where: { id: item.id },
              data: {
                processed: true,
                processedAt: new Date()
              }
            });

            console.log(`✅ Disconnected user ${item.username} (${activeSessions.length} session(s))`);
          } catch (error) {
            console.error(`❌ Failed to process disconnect for ${item.username}:`, error);
            // Mark as processed anyway to prevent infinite retries
            await prisma.disconnectQueue.update({
              where: { id: item.id },
              data: {
                processed: true,
                processedAt: new Date()
              }
            });
          }
        }
      }
    } catch (error) {
      console.error('❌ Disconnect queue processing failed:', error);
    } finally {
      // Schedule next run in 10 seconds (high-frequency for real-time enforcement)
      setTimeout(runQuotaEnforcement, 10000);
    }
  };

  // Start the high-frequency quota enforcement loop
  runQuotaEnforcement();

  // Stale session cleanup - every 5 minutes
  // Prevents orphaned sessions from permanently locking users out of quota
  cron.schedule('*/5 * * * *', async () => {
    try {
      // Close sessions with no update for 2x interim interval (typically 10 minutes)
      // This handles cases where routers lose power or network connectivity
      const staleThreshold = new Date(Date.now() - 10 * 60 * 1000);
      
      const result = await prisma.radAcct.updateMany({
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
      
      if (result.count > 0) {
        console.log(`🧹 Cleaned up ${result.count} stale session(s)`);
      }
    } catch (error) {
      console.error('❌ Stale session cleanup failed:', error);
    }
  });

  console.log('✅ Scheduler ready');
  console.log('   → Invoices: Monthly (1st at 2 AM)');
  console.log('   → Status checks: Every 5 minutes');
  console.log('   → Daily stats: Daily at 1 AM');
  console.log('   → Quota enforcement: Every 10 seconds (high-frequency, real-time)');
  console.log('   → Stale session cleanup: Every 5 minutes');
  console.log('   → Quota tracking: Native (database triggers + Interim-Updates)');
  console.log('   → Session tracking: Real-time (database triggers)');
}

