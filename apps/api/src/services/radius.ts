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
        lastSeen: true, // Need this for orphan detection
      },
    });

    for (const router of routers) {
      // Find all accounting records for this router
      // Priority: 1) routerId (most reliable), 2) nasipaddress (for initial linking)
      // For routers with dynamic IPs, routerId is set after first match, so we check both
      const whereClause: any = {
        OR: [
          { routerId: router.id }, // Match by routerId first (works even if IP changes)
        ]
      };
      
      // Also match by nasipaddress for new sessions that haven't been linked yet
      if (router.nasipaddress) {
        whereClause.OR.push({ nasipaddress: router.nasipaddress });
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

      // Link any unlinked accounting records to this router
      // This handles cases where IP changed but we still need to link old sessions
      const linkWhere: any = {
        routerId: null, // Only link records that aren't already linked
      };
      
      // Strategy 1: Link records matching current nasipaddress
      if (router.nasipaddress) {
        linkWhere.nasipaddress = router.nasipaddress;
        
        const linkedCount = await prisma.radAcct.updateMany({
          where: linkWhere,
          data: {
            routerId: router.id,
          },
        });
        
        if (linkedCount.count > 0) {
          console.log(`  🔗 Linked ${linkedCount.count} sessions by current IP (${router.nasipaddress})`);
        }
      }
      
      // Strategy 2: If router already has linked sessions, try to link recent unlinked records
      // This handles the case where IP changed but router hasn't reconnected via WebSocket yet
      const routerHasLinkedSessions = sessions.some(s => s.routerId === router.id);
      
      if (routerHasLinkedSessions) {
        // Find recent unlinked sessions (last 24 hours) that might belong to this router
        // Check if there are any recent unlinked records that could be from this router
        const oneDayAgo = new Date();
        oneDayAgo.setHours(oneDayAgo.getHours() - 24);
        
        // Get recent IPs this router has used (from linked sessions)
        const recentLinkedSessions = await prisma.radAcct.findMany({
          where: {
            routerId: router.id,
            acctstarttime: {
              gte: oneDayAgo,
            },
          },
          select: {
            nasipaddress: true,
          },
        });
        
        // Get unique IPs from recent linked sessions
        const recentIPs = [...new Set(recentLinkedSessions.map(s => s.nasipaddress).filter(Boolean))];
        
        // Try to link recent unlinked records that have IPs matching recent router IPs
        // This handles the gap between IP change and WebSocket reconnection
        if (recentIPs.length > 0) {
          const orphanLinkWhere: any = {
            routerId: null,
            nasipaddress: { in: recentIPs },
            acctstarttime: {
              gte: oneDayAgo,
            },
          };
          
          const orphanLinkedCount = await prisma.radAcct.updateMany({
            where: orphanLinkWhere,
            data: {
              routerId: router.id,
            },
          });
          
          if (orphanLinkedCount.count > 0) {
            console.log(`  🔗 Linked ${orphanLinkedCount.count} orphaned sessions (IPs: ${recentIPs.join(', ')})`);
          }
        }
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

