import { prisma } from '../lib/prisma.js';

// Payment rate per MB in USD - what the platform pays hosts for data usage (configurable)
const PAYMENT_RATE_PER_MB = parseFloat(process.env.PAYMENT_RATE_PER_MB || process.env.BILLING_COST_PER_MB || '0.02');

/**
 * Generate invoices (payments due) for all hosts based on their router usage
 * These represent what the platform owes to hosts for end-user data consumption
 */
export async function generateInvoices(billingPeriod?: Date) {
  try {
    console.log('💰 Generating invoices...');

    const period = billingPeriod || new Date();
    period.setDate(1); // First day of month
    period.setHours(0, 0, 0, 0);

    // Get all routers with their hosts
    const routers = await prisma.router.findMany({
      include: {
        host: {
          select: {
            id: true,
            email: true,
          },
        },
      },
    });

    // Calculate billing period once
    const startOfPeriod = new Date(period);
    const endOfPeriod = new Date(period);
    endOfPeriod.setMonth(endOfPeriod.getMonth() + 1);

    // Process routers in parallel batches for better scalability
    // Process 10 routers at a time to avoid overwhelming the database
    const BATCH_SIZE = 10;
    let invoicesCreated = 0;

    for (let i = 0; i < routers.length; i += BATCH_SIZE) {
      const batch = routers.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map((router: typeof routers[0]) => processRouterInvoice(router, period, startOfPeriod, endOfPeriod))
      );
      invoicesCreated += results.filter(r => r).length;
    }

    console.log(`✨ Invoice generation completed: ${invoicesCreated} invoices created`);
    return invoicesCreated;
  } catch (error) {
    console.error('❌ Error generating invoices:', error);
    throw error;
  }
}

/**
 * Process invoice generation for a single router (extracted for parallel processing)
 */
async function processRouterInvoice(
  router: { id: string; hostId: string; host: { id: string; email: string } },
  period: Date,
  startOfPeriod: Date,
  endOfPeriod: Date
): Promise<boolean> {
  try {
    // Check if invoice already exists for this period
    const existingInvoice = await prisma.invoice.findFirst({
      where: {
        routerId: router.id,
        period: {
          gte: period,
          lt: new Date(period.getFullYear(), period.getMonth() + 1, 1),
        },
      },
    });

    if (existingInvoice) {
      console.log(`⏭️  Invoice already exists for router ${router.id} in period ${period.toISOString()}`);
      return false;
    }

    // Use database aggregation for better performance (scalable)
    // Avoids loading potentially millions of records into memory
    const usageResult = await prisma.$queryRaw<Array<{ total_bytes: bigint }>>`
      SELECT COALESCE(SUM(accttotaloctets), 0)::bigint as total_bytes
      FROM radacct
      WHERE router_id = ${router.id}::text
        AND acctstarttime >= ${startOfPeriod}
        AND acctstarttime < ${endOfPeriod}
    `;

    const totalBytes = Number(usageResult[0]?.total_bytes || 0);
    const usageMB = totalBytes / (1024 * 1024);

    // Calculate payment amount - what the platform owes the host
    const paymentAmount = usageMB * PAYMENT_RATE_PER_MB;

    // Only create invoice if there's actual usage
    if (usageMB > 0) {
      await prisma.invoice.create({
        data: {
          hostId: router.hostId,
          routerId: router.id,
          amount: Math.round(paymentAmount * 100) / 100, // Round to 2 decimals - amount owed TO host
          period,
          usage: Math.round(usageMB * 100) / 100,
          status: 'PENDING', // PENDING = platform hasn't paid host yet
        },
      });

      console.log(`✅ Created payment invoice for host ${router.hostId} (router ${router.id}): ${usageMB.toFixed(2)} MB = $${paymentAmount.toFixed(2)} owed`);
      return true;
    } else {
      console.log(`⏭️  No usage for router ${router.id}, skipping invoice`);
      return false;
    }
  } catch (error) {
    console.error(`❌ Error generating invoice for router ${router.id}:`, error);
    return false; // Don't throw - continue processing other routers
  }
}

/**
 * Get all invoices (payments due) for a host
 * These represent what the platform owes the host for router usage
 */
export async function getHostInvoices(hostId: string) {
  return prisma.invoice.findMany({
    where: { hostId },
    include: {
      router: {
        select: {
          id: true,
          name: true,
        },
      },
    },
    orderBy: { period: 'desc' },
  });
}

/**
 * Mark invoice as paid (Admin only)
 * This is called when the platform has processed payment to the host
 */
export async function markInvoicePaid(invoiceId: string) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
  });

  if (!invoice) {
    throw new Error('Invoice not found');
  }

  if (invoice.status === 'PAID') {
    throw new Error('Invoice is already marked as paid');
  }

  return prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      status: 'PAID',
      paidAt: new Date(),
    },
  });
}

