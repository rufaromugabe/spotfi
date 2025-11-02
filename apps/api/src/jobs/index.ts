import cron from 'node-cron';
import { PrismaClient } from '@prisma/client';
import { syncRadiusAccounting } from '../services/radius.js';
import { generateInvoices } from '../services/billing.js';

/**
 * Start all cron jobs
 */
export function startCronJobs(prisma: PrismaClient) {
  console.log('⏰ Starting cron jobs...');

  // Sync RADIUS accounting data every hour
  cron.schedule('0 * * * *', async () => {
    console.log('🔄 Running hourly RADIUS accounting sync...');
    try {
      await syncRadiusAccounting();
    } catch (error) {
      console.error('❌ Error in RADIUS accounting sync job:', error);
    }
  });

  console.log('✅ Scheduled: RADIUS accounting sync (hourly)');

  // Generate invoices on the 1st of each month at 2 AM
  cron.schedule('0 2 1 * *', async () => {
    console.log('💰 Running monthly invoice generation...');
    try {
      await generateInvoices();
    } catch (error) {
      console.error('❌ Error in invoice generation job:', error);
    }
  });

  console.log('✅ Scheduled: Invoice generation (monthly on 1st at 2 AM)');

  // Update router status - mark routers as offline if not seen in 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try {
      const fiveMinutesAgo = new Date();
      fiveMinutesAgo.setMinutes(fiveMinutesAgo.getMinutes() - 5);

      const result = await prisma.router.updateMany({
        where: {
          status: 'ONLINE',
          lastSeen: {
            lt: fiveMinutesAgo,
          },
        },
        data: {
          status: 'OFFLINE',
        },
      });

      if (result.count > 0) {
        console.log(`📡 Marked ${result.count} router(s) as offline (no activity)`);
      }
    } catch (error) {
      console.error('❌ Error updating router status:', error);
    }
  });

  console.log('✅ Scheduled: Router status check (every 5 minutes)');

  console.log('✨ All cron jobs started');
}

