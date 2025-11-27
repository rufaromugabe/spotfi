import { prisma } from '../lib/prisma.js';
import { Decimal } from '@prisma/client/runtime/library';

const RATE_MB = new Decimal(process.env.PAYMENT_RATE_PER_MB || '0.02');

export async function generateInvoices(billingPeriod?: Date) {
    const period = billingPeriod || new Date();
  period.setDate(1);
    period.setHours(0, 0, 0, 0);

  const nextMonth = new Date(period);
  nextMonth.setMonth(nextMonth.getMonth() + 1);

  console.log('💰 Generating bulk invoices...');

  // 1. Aggregate ALL usage in one query (Database does the heavy lifting)
  // Assumes you have a view or summary table, or querying radacct directly with indices
  const usageStats = await prisma.$queryRaw<Array<{ 
    routerId: string, 
    hostId: string, 
    totalBytes: bigint 
  }>>`
    SELECT 
      r.id as "routerId",
      r."hostId",
      COALESCE(SUM(da.bytes_in + da.bytes_out), 0)::bigint as "totalBytes"
    FROM routers r
    JOIN router_daily_usage da ON r.id = da.router_id
    WHERE da.usage_date >= DATE(${period}) 
      AND da.usage_date < DATE(${nextMonth})
    GROUP BY r.id, r."hostId"
    HAVING SUM(da.bytes_in + da.bytes_out) > 0
  `;

  let count = 0;

  // 2. Batch create invoices
  // Prisma createMany is vastly more efficient than looping
  // Using Decimal for precise financial calculations
  const invoicesData = usageStats.map(stat => {
    const totalBytes = new Decimal(stat.totalBytes.toString());
    const bytesPerMB = new Decimal(1024 * 1024);
    const usageMB = totalBytes.div(bytesPerMB);
    const amount = usageMB.mul(RATE_MB).toDecimalPlaces(2);

    return {
      hostId: stat.hostId,
      routerId: stat.routerId,
      amount,
      period,
      usage: usageMB.toDecimalPlaces(2),
      status: 'PENDING' as const // Cast for TS
    };
  });

  // 3. Filter existing to avoid duplicates (App Logic or DB Constraint)
  // For scalability, usually a unique constraint on [routerId, period] in DB is best.
  // Assuming DB constraint exists, use skipDuplicates: true
  if (invoicesData.length > 0) {
    const result = await prisma.invoice.createMany({
      data: invoicesData,
      skipDuplicates: true
    });
    count = result.count;
    }

  console.log(`✨ Generated ${count} invoices via batch processing.`);
  return count;
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
