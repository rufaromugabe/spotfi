import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Sync RADIUS accounting data from radacct table to Router totalUsage
 * This aggregates all sessions for each router and updates the total usage
 */
export async function syncRadiusAccounting() {
  try {
    console.log('🔄 Syncing RADIUS accounting data...');

    // Get all routers
    const routers = await prisma.router.findMany({
      select: {
        id: true,
        nasipaddress: true,
      },
    });

    for (const router of routers) {
      // Find all accounting records for this router
      // Match by nasipaddress if available, or by routerId
      const whereClause: any = {};
      
      if (router.nasipaddress) {
        whereClause.nasipaddress = router.nasipaddress;
      } else {
        whereClause.routerId = router.id;
      }

      const sessions = await prisma.radAcct.findMany({
        where: whereClause,
        select: {
          accttotaloctets: true,
          routerId: true,
        },
      });

      // Calculate total usage in bytes
      const totalBytes = sessions.reduce((sum: number, session) => {
        return sum + Number(session.accttotaloctets || 0);
      }, 0);

      // Convert to MB
      const totalUsageMB = totalBytes / (1024 * 1024);

      // Update router if routerId wasn't set in radacct
      if (router.nasipaddress) {
        // Update radacct records to link them to router
        await prisma.radAcct.updateMany({
          where: {
            nasipaddress: router.nasipaddress,
            routerId: null,
          },
          data: {
            routerId: router.id,
          },
        });
      }

      // Update router totalUsage
      await prisma.router.update({
        where: { id: router.id },
        data: {
          totalUsage: totalUsageMB,
        },
      });

      console.log(`✅ Updated router ${router.id}: ${totalUsageMB.toFixed(2)} MB`);
    }

    console.log('✨ RADIUS accounting sync completed');
  } catch (error) {
    console.error('❌ Error syncing RADIUS accounting:', error);
    throw error;
  }
}

/**
 * Get RADIUS user credentials (radcheck)
 */
export async function getRadiusUser(username: string) {
  return prisma.radCheck.findFirst({
    where: { username },
  });
}

/**
 * Create RADIUS user credentials
 */
export async function createRadiusUser(username: string, password: string) {
  // Check if user already exists
  const existing = await prisma.radCheck.findFirst({
    where: { username },
  });

  if (existing) {
    throw new Error('RADIUS user already exists');
  }

  return prisma.radCheck.create({
    data: {
      username,
      attribute: 'Cleartext-Password',
      op: ':=',
      value: password,
    },
  });
}

/**
 * Update RADIUS user password
 */
export async function updateRadiusUserPassword(username: string, password: string) {
  return prisma.radCheck.updateMany({
    where: { username },
    data: {
      value: password,
    },
  });
}

/**
 * Set RADIUS user attributes (bandwidth limits, quotas)
 */
export async function setRadiusUserAttribute(
  username: string,
  attribute: string,
  value: string
) {
  // Check if attribute already exists
  const existing = await prisma.radReply.findFirst({
    where: {
      username,
      attribute,
    },
  });

  if (existing) {
    return prisma.radReply.update({
      where: { id: existing.id },
      data: { value },
    });
  }

  return prisma.radReply.create({
    data: {
      username,
      attribute,
      op: '=',
      value,
    },
  });
}

