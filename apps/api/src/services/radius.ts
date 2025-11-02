import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Sync RADIUS accounting data from radacct table to Router totalUsage
 * This aggregates all sessions for each router and updates the total usage
 */
export async function syncRadiusAccounting() {
  try {
    console.log('🔄 Syncing RADIUS accounting data...');

    // Get all routers with MAC addresses
    // After migration is applied, we can use regular Prisma select
    // For now, using raw query to handle both cases gracefully
    let routers: Array<{ id: string; nasipaddress: string | null; macAddress: string | null; lastSeen: Date | null }>;
    
    try {
      routers = await prisma.$queryRaw<Array<{
        id: string;
        nasipaddress: string | null;
        macAddress: string | null;
        lastSeen: Date | null;
      }>>`
        SELECT 
          id,
          nasipaddress,
          COALESCE(mac_address, NULL) as "macAddress",
          "lastSeen"
        FROM routers
      `;
    } catch {
      // Fallback: if mac_address column doesn't exist yet, use regular query
      const allRouters = await prisma.router.findMany({
        select: {
          id: true,
          nasipaddress: true,
          lastSeen: true,
        },
      });
      routers = allRouters.map(r => ({ ...r, macAddress: null }));
    }

    // Process routers in parallel batches for better scalability
    // Process 10 routers at a time to avoid overwhelming the database
    const BATCH_SIZE = 10;
    for (let i = 0; i < routers.length; i += BATCH_SIZE) {
      const batch = routers.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(router => processRouterSync(router)));
    }

    console.log('✨ RADIUS accounting sync completed');
  } catch (error) {
    console.error('❌ Error syncing RADIUS accounting:', error);
    throw error;
  }
}

/**
 * Process sync for a single router (extracted for parallel processing)
 */
async function processRouterSync(router: { 
  id: string; 
  nasipaddress: string | null; 
  macAddress: string | null; 
  lastSeen: Date | null 
}) {
  try {
      // Find all accounting records for this router
      // Priority: 1) routerId (most reliable), 2) MAC address (robust, doesn't change), 3) nasipaddress (fallback)
      // For routers with dynamic IPs, MAC address provides stable identification
      const whereClause: any = {
        OR: [
          { routerId: router.id }, // Match by routerId first (works even if IP changes)
        ]
      };
      
      // Match by MAC address if available (most robust - doesn't change like IP)
      // Note: FreeRADIUS nasidentifier may contain router hostname or MAC depending on router config
      // We match against nasidentifier in case router sends MAC there
      if (router.macAddress) {
        // Normalize MAC address (remove colons, dashes, convert to uppercase)
        const normalizedMac = router.macAddress.replace(/[:-]/g, '').toUpperCase();
        
        // Generate all common MAC formats to match against nasidentifier
        // Some routers may send MAC in nasidentifier field (router-specific configuration)
        const macFormats = [
          normalizedMac, // AABBCCDDEEFF
          normalizedMac.match(/.{2}/g)?.join(':') || normalizedMac, // AA:BB:CC:DD:EE:FF
          normalizedMac.match(/.{2}/g)?.join('-') || normalizedMac, // AA-BB-CC-DD-EE-FF
        ];
        
        // Try matching nasidentifier if router is configured to send MAC there
        // This is optional - if router doesn't send MAC in nasidentifier, we'll fall back to IP
        for (const macFormat of macFormats) {
          whereClause.OR.push({ 
            nasidentifier: { 
              contains: macFormat,
              mode: 'insensitive'
            } 
          });
        }
      }
      
      // Fallback: match by nasipaddress for new sessions that haven't been linked yet
      // This helps with initial linking before MAC address is known
      if (router.nasipaddress) {
        whereClause.OR.push({ nasipaddress: router.nasipaddress });
      }

      // Use database aggregation for better performance (scalable)
      // This avoids loading millions of records into memory
      // Calculate total usage from all records linked to this router
      // The linking happens below, so this query only counts already-linked records
      const usageResult = await prisma.$queryRaw<Array<{ total_bytes: bigint }>>`
        SELECT COALESCE(SUM(accttotaloctets), 0)::bigint as total_bytes
        FROM radacct
        WHERE router_id = ${router.id}::text
      `;

      const totalBytes = Number(usageResult[0]?.total_bytes || 0);
      const totalUsageMB = totalBytes / (1024 * 1024);

      // Link any unlinked accounting records to this router
      // This handles cases where IP changed but we still need to link old sessions
      // Priority: MAC address (most robust) > IP address (fallback)
      
      let totalLinked = 0;
      
      // Strategy 1: Link records matching router MAC address (most robust)
      // Priority: nasmacaddress field (auto-populated by trigger) > nasidentifier (may contain MAC)
      if (router.macAddress) {
        const normalizedMac = router.macAddress.replace(/[:-]/g, '').toUpperCase();
        const macFormats = [
          normalizedMac, // AABBCCDDEEFF
          normalizedMac.match(/.{2}/g)?.join(':') || normalizedMac, // AA:BB:CC:DD:EE:FF
          normalizedMac.match(/.{2}/g)?.join('-') || normalizedMac, // AA-BB-CC-DD-EE-FF
        ];
        
        // Try matching by nasmacaddress field first (most reliable - auto-populated by trigger)
        // Use raw SQL to handle both cases: with and without nasmacaddress column
        try {
          // Try to match using nasmacaddress field (auto-populated by database trigger)
          const macUpdateResult = await prisma.$executeRaw`
            UPDATE radacct
            SET router_id = ${router.id}::text
            WHERE router_id IS NULL
              AND (
                nasmacaddress = ${macFormats[0]}::text
                OR nasmacaddress = ${macFormats[1]}::text
                OR nasmacaddress = ${macFormats[2]}::text
                OR nasidentifier ILIKE ${`%${macFormats[0]}%`}
                OR nasidentifier ILIKE ${`%${macFormats[1]}%`}
                OR nasidentifier ILIKE ${`%${macFormats[2]}%`}
              )
          `.catch(async (error: any) => {
            // If nasmacaddress column doesn't exist yet, use nasidentifier only
            if (error?.message?.includes('nasmacaddress') || error?.message?.includes('column')) {
              return await prisma.$executeRaw`
                UPDATE radacct
                SET router_id = ${router.id}::text
                WHERE router_id IS NULL
                  AND (
                    nasidentifier ILIKE ${`%${macFormats[0]}%`}
                    OR nasidentifier ILIKE ${`%${macFormats[1]}%`}
                    OR nasidentifier ILIKE ${`%${macFormats[2]}%`}
                  )
              `;
            }
            throw error;
          });
          
          // Get count of linked records
          const countResult = await prisma.$queryRaw<Array<{ count: bigint }>>`
            SELECT COUNT(*)::bigint as count
            FROM radacct
            WHERE router_id = ${router.id}::text
              AND (
                nasmacaddress = ${macFormats[0]}::text
                OR nasmacaddress = ${macFormats[1]}::text
                OR nasmacaddress = ${macFormats[2]}::text
                OR nasidentifier ILIKE ${`%${macFormats[0]}%`}
                OR nasidentifier ILIKE ${`%${macFormats[1]}%`}
                OR nasidentifier ILIKE ${`%${macFormats[2]}%`}
              )
          `.catch(() => [{ count: 0n }]);
          
          const linkedCount = Number(countResult[0]?.count || 0);
          if (linkedCount > 0) {
            totalLinked += linkedCount;
            console.log(`  🔗 Linked ${linkedCount} sessions by router MAC address`);
          }
        } catch (error: any) {
          // Final fallback: try with nasidentifier only (backward compatibility)
          try {
            const fallbackResult = await prisma.$executeRaw`
              UPDATE radacct
              SET router_id = ${router.id}::text
              WHERE router_id IS NULL
                AND nasidentifier ILIKE ${`%${router.macAddress.replace(/[:-]/g, '').toUpperCase()}%`}
            `.catch(() => null);
            
            if (fallbackResult) {
              const countResult = await prisma.$queryRaw<Array<{ count: bigint }>>`
                SELECT COUNT(*)::bigint as count
                FROM radacct
                WHERE router_id = ${router.id}::text
                  AND nasidentifier ILIKE ${`%${router.macAddress.replace(/[:-]/g, '').toUpperCase()}%`}
              `.catch(() => [{ count: 0n }]);
              
              const linkedCount = Number(countResult[0]?.count || 0);
              if (linkedCount > 0) {
                totalLinked += linkedCount;
                console.log(`  🔗 Linked ${linkedCount} sessions by MAC in nasidentifier (fallback)`);
              }
            }
          } catch {
            // Silently fail if all MAC matching strategies fail
            console.log(`  ⚠️  Could not link sessions by MAC for router ${router.id}`);
          }
        }
      }
      
      // Strategy 2: Link records matching current nasipaddress (fallback for initial linking)
      if (router.nasipaddress) {
        const ipLinkWhere: any = {
          routerId: null, // Only link records that aren't already linked
          nasipaddress: router.nasipaddress,
        };
        
        const linkedCount = await prisma.radAcct.updateMany({
          where: ipLinkWhere,
          data: {
            routerId: router.id,
          },
        });
        
        if (linkedCount.count > 0) {
          totalLinked += linkedCount.count;
          console.log(`  🔗 Linked ${linkedCount.count} sessions by current IP (${router.nasipaddress})`);
        }
      }
      
      // Strategy 2: If router already has linked sessions, try to link recent unlinked records
      // This handles the case where IP changed but router hasn't reconnected via WebSocket yet
      // Check if router has any linked sessions by querying for at least one
      const hasLinkedSessions = await prisma.radAcct.findFirst({
        where: { routerId: router.id },
        select: { routerId: true },
      });
      
      if (hasLinkedSessions) {
        // Find recent unlinked sessions (last 24 hours) that might belong to this router
        // Check if there are any recent unlinked records that could be from this router
        const oneDayAgo = new Date();
        oneDayAgo.setHours(oneDayAgo.getHours() - 24);
        
        // Get recent IPs and NAS identifiers this router has used (from linked sessions)
        const recentLinkedSessions = await prisma.radAcct.findMany({
          where: {
            routerId: router.id,
            acctstarttime: {
              gte: oneDayAgo,
            },
          },
          select: {
            nasipaddress: true,
            // Note: nasidentifier may not exist in database yet until migration is applied
            // Using optional chaining for backward compatibility
          },
        });
        
        // Get nasidentifier if available (using raw query to handle missing column gracefully)
        const nasIdentifierQuery = await prisma.$queryRaw<Array<{ nasidentifier: string | null }>>`
          SELECT nasidentifier 
          FROM radacct 
          WHERE router_id = ${router.id}::text 
            AND acctstarttime >= ${oneDayAgo}
          LIMIT 1
        `.catch(() => [] as Array<{ nasidentifier: string | null }>);
        
        // Get unique IPs from recent linked sessions
        const recentIPs = [...new Set(recentLinkedSessions.map(s => s.nasipaddress).filter(Boolean))];
        // Get NAS identifiers (may not be available until migration is applied)
        const recentNasIdentifiers = nasIdentifierQuery
          .map(r => r.nasidentifier)
          .filter((id): id is string => Boolean(id));
        
        // Try to link recent unlinked records that match recent router identifiers
        // This handles the gap between identifier change and WebSocket reconnection
        if (recentIPs.length > 0 || recentNasIdentifiers.length > 0) {
          const orphanLinkWhere: any = {
            routerId: null,
            acctstarttime: {
              gte: oneDayAgo,
            },
            OR: [],
          };
          
          if (recentIPs.length > 0) {
            orphanLinkWhere.OR.push({ nasipaddress: { in: recentIPs } });
          }
          
          if (recentNasIdentifiers.length > 0) {
            // Match by nasidentifier (may contain MAC address)
            for (const nasId of recentNasIdentifiers) {
              orphanLinkWhere.OR.push({ 
                nasidentifier: {
                  contains: nasId,
                  mode: 'insensitive',
                } 
              });
            }
          }
          
          if (orphanLinkWhere.OR.length > 0) {
            const orphanLinkedCount = await prisma.radAcct.updateMany({
              where: orphanLinkWhere,
              data: {
                routerId: router.id,
              },
            });
            
            if (orphanLinkedCount.count > 0) {
              console.log(`  🔗 Linked ${orphanLinkedCount.count} orphaned sessions (IPs: ${recentIPs.join(', ') || 'none'}, NAS IDs: ${recentNasIdentifiers.length})`);
            }
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
  } catch (error) {
    console.error(`❌ Error syncing router ${router.id}:`, error);
    // Don't throw - continue processing other routers
  }
}

/**
 * Get RADIUS user credentials (radcheck)
 */
export async function getRadiusUser(username: string) {
  return prisma.radCheck.findFirst({
    where: { userName: username },
  });
}

/**
 * Create RADIUS user credentials
 */
export async function createRadiusUser(username: string, password: string) {
  // Check if user already exists
  const existing = await prisma.radCheck.findFirst({
    where: { userName: username },
  });

  if (existing) {
    throw new Error('RADIUS user already exists');
  }

  return prisma.radCheck.create({
    data: {
      userName: username,
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
    where: { userName: username },
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
      userName: username,
      attribute: attribute,
    },
  });

  if (existing) {
    return prisma.radReply.update({
      where: { id: existing.id },
      data: { value: value },
    });
  }

  return prisma.radReply.create({
    data: {
      userName: username,
      attribute: attribute,
      op: '=',
      value: value,
    },
  });
}

