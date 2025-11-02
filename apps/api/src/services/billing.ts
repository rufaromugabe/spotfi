import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Cost per MB in USD (configurable)
const COST_PER_MB = parseFloat(process.env.BILLING_COST_PER_MB || '0.02');

/**
 * Generate invoices for all routers based on their usage for the billing period
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

    let invoicesCreated = 0;

    for (const router of routers) {
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
        continue;
      }

      // Calculate usage for the billing period
      const startOfPeriod = new Date(period);
      const endOfPeriod = new Date(period);
      endOfPeriod.setMonth(endOfPeriod.getMonth() + 1);

      const sessions = await prisma.radAcct.findMany({
        where: {
          routerId: router.id,
          acctstarttime: {
            gte: startOfPeriod,
            lt: endOfPeriod,
          },
        },
      });

      // Calculate total usage in bytes
      const totalBytes = sessions.reduce((sum, session) => {
        return sum + Number(session.accttotaloctets || 0);
      }, 0);

      // Convert to MB
      const usageMB = totalBytes / (1024 * 1024);

      // Calculate cost
      const amount = usageMB * COST_PER_MB;

      // Only create invoice if there's actual usage
      if (usageMB > 0) {
        await prisma.invoice.create({
          data: {
            hostId: router.hostId,
            routerId: router.id,
            amount: Math.round(amount * 100) / 100, // Round to 2 decimals
            period,
            usage: Math.round(usageMB * 100) / 100,
            status: 'PENDING',
          },
        });

        invoicesCreated++;
        console.log(`✅ Created invoice for router ${router.id}: ${usageMB.toFixed(2)} MB = $${amount.toFixed(2)}`);
      } else {
        console.log(`⏭️  No usage for router ${router.id}, skipping invoice`);
      }
    }

    console.log(`✨ Invoice generation completed: ${invoicesCreated} invoices created`);
    return invoicesCreated;
  } catch (error) {
    console.error('❌ Error generating invoices:', error);
    throw error;
  }
}

/**
 * Get all invoices for a host
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
 * Mark invoice as paid
 */
export async function markInvoicePaid(invoiceId: string, hostId: string) {
  const invoice = await prisma.invoice.findFirst({
    where: {
      id: invoiceId,
      hostId,
    },
  });

  if (!invoice) {
    throw new Error('Invoice not found');
  }

  return prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      status: 'PAID',
      paidAt: new Date(),
    },
  });
}

