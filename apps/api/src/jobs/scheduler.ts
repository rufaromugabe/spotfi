import cron from 'node-cron';
import { generateInvoices } from '../services/billing.js';
import { prisma } from '../lib/prisma.js';

/**
 * Production-grade cron scheduler
 * With trigger-based accounting, we only need:
 * 1. Monthly invoice generation
 * 2. Router status monitoring
 */
export function startScheduler() {
  console.log('⏰ Starting production scheduler');

  // Invoice generation - 1st of month at 2 AM
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

  console.log('✅ Scheduler ready');
  console.log('   → Invoices: Monthly (1st at 2 AM)');
  console.log('   → Status checks: Every 5 minutes');
  console.log('   → Daily stats: Daily at 1 AM');
  console.log('   → Session tracking: Real-time (database triggers)');
}

