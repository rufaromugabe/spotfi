import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

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

        invoicesCreated++;
        console.log(`✅ Created payment invoice for host ${router.hostId} (router ${router.id}): ${usageMB.toFixed(2)} MB = $${paymentAmount.toFixed(2)} owed`);
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

