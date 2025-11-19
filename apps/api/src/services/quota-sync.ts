import { prisma } from '../lib/prisma.js';
import { updateRadiusQuotaLimit } from './quota.js';
import { activeConnections } from '../websocket/server.js';
import { commandManager } from '../websocket/command-manager.js';
import { WebSocket } from 'ws';

/**
 * Real-time quota synchronization service
 * 
 * This service periodically syncs quota usage from active sessions to ensure
 * radreply always has accurate remaining quota for future logins.
 * 
 * Uses the new session stats endpoint to get real-time usage from Uspot.
 */

interface SessionStats {
  mac?: string;
  ip?: string;
  user?: string;
  'bytes-in'?: number;
  'bytes-out'?: number;
  'bytes-remaining'?: number;
  'max-bytes-total'?: number;
}

/**
 * Get session statistics from router via WebSocket
 */
async function getSessionStatsFromRouter(
  routerId: string,
  macAddress: string,
  timeout: number = 5000
): Promise<SessionStats | null> {
  const socket = activeConnections.get(routerId);
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return null;
  }

  try {
    const result = await commandManager.sendCommand(
      routerId,
      socket,
      'get-session-stats',
      { macAddress },
      timeout
    );
    return result.data || result;
  } catch (error) {
    return null;
  }
}

/**
 * Sync quota for a single active session
 * Updates radreply with accurate remaining quota based on real-time usage
 */
async function syncSessionQuota(
  session: {
    userName: string | null;
    nasIpAddress: string;
    acctInputOctets: bigint | null;
    acctOutputOctets: bigint | null;
    callingStationId: string | null;
  },
  routerId: string | null
): Promise<boolean> {
  if (!session.userName || !routerId) {
    return false;
  }

  try {
    // Get real-time session stats from router
    const macAddress = session.callingStationId;
    if (!macAddress) {
      // Fallback to database usage if MAC not available
      return await updateRadiusQuotaLimit(session.userName) !== null;
    }

    const sessionStats = await getSessionStatsFromRouter(routerId, macAddress);
    
    if (sessionStats && sessionStats.user === session.userName) {
      // Calculate total bytes used from session stats
      const bytesIn = sessionStats['bytes-in'] || 0;
      const bytesOut = sessionStats['bytes-out'] || 0;
      const totalUsed = BigInt(bytesIn + bytesOut);

      // Get current quota
      const quota = await prisma.radQuota.findFirst({
        where: {
          username: session.userName,
          periodEnd: { gt: new Date() },
          periodStart: { lte: new Date() }
        },
        orderBy: { periodEnd: 'desc' }
      });

      if (quota) {
        // Calculate remaining quota based on real-time usage
        // Note: This is for radreply updates only - actual quota is updated by trigger on session end
        const remaining = quota.maxOctets - totalUsed;

        if (remaining > 0n) {
          // Update radreply with accurate remaining quota
          await prisma.radReply.upsert({
            where: {
              userName_attribute: {
                userName: session.userName,
                attribute: 'ChilliSpot-Max-Total-Octets'
              }
            },
            update: {
              value: remaining.toString()
            },
            create: {
              userName: session.userName,
              attribute: 'ChilliSpot-Max-Total-Octets',
              op: '=',
              value: remaining.toString()
            }
          });
          return true;
        } else {
          // Quota exhausted - remove attribute
          await prisma.radReply.deleteMany({
            where: {
              userName: session.userName,
              attribute: 'ChilliSpot-Max-Total-Octets'
            }
          });
          return false;
        }
      }
    } else {
      // Fallback: use database quota if session stats unavailable
      return await updateRadiusQuotaLimit(session.userName) !== null;
    }
  } catch (error) {
    // On error, fallback to standard quota update
    try {
      return await updateRadiusQuotaLimit(session.userName) !== null;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Sync quota for all active sessions
 * This ensures radreply has accurate remaining quota for future logins
 */
export async function syncActiveSessionsQuota(): Promise<{
  synced: number;
  failed: number;
  skipped: number;
}> {
  const stats = {
    synced: 0,
    failed: 0,
    skipped: 0
  };

  try {
    // Get all active sessions (acctStopTime is null)
    const activeSessions = await prisma.radAcct.findMany({
      where: {
        acctStopTime: null,
        userName: { not: null }
      },
      select: {
        userName: true,
        nasIpAddress: true,
        acctInputOctets: true,
        acctOutputOctets: true,
        callingStationId: true,
        routerId: true
      },
      take: 1000 // Limit to prevent overload
    });

    if (activeSessions.length === 0) {
      return stats;
    }

    // Group sessions by router for efficient processing
    const sessionsByRouter = new Map<string, typeof activeSessions>();
    for (const session of activeSessions) {
      if (session.routerId) {
        if (!sessionsByRouter.has(session.routerId)) {
          sessionsByRouter.set(session.routerId, []);
        }
        sessionsByRouter.get(session.routerId)!.push(session);
      } else {
        // No router ID - skip or use fallback
        stats.skipped++;
      }
    }

    // Process sessions in parallel batches (10 per router at a time)
    const BATCH_SIZE = 10;
    for (const [routerId, sessions] of sessionsByRouter.entries()) {
      // Check if router is online
      const socket = activeConnections.get(routerId);
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        // Router offline - use fallback method
        for (const session of sessions) {
          if (session.userName) {
            try {
              await updateRadiusQuotaLimit(session.userName);
              stats.synced++;
            } catch {
              stats.failed++;
            }
          } else {
            stats.skipped++;
          }
        }
        continue;
      }

      // Process in batches
      for (let i = 0; i < sessions.length; i += BATCH_SIZE) {
        const batch = sessions.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map((session: typeof sessions[0]) => syncSessionQuota(session, routerId))
        );

        for (const result of results) {
          if (result.status === 'fulfilled' && result.value) {
            stats.synced++;
          } else {
            stats.failed++;
          }
        }
      }
    }

    return stats;
  } catch (error) {
    console.error('Error syncing active sessions quota:', error);
    return stats;
  }
}

/**
 * Sync quota for a specific user
 * Useful when quota is manually updated
 */
export async function syncUserQuota(userName: string): Promise<boolean> {
  try {
    // Check if user has active session
    const activeSession = await prisma.radAcct.findFirst({
      where: {
        userName,
        acctStopTime: null
      },
      select: {
        nasIpAddress: true,
        callingStationId: true,
        routerId: true
      }
    });

    if (activeSession && activeSession.routerId && activeSession.callingStationId) {
      // Use real-time session stats
      const sessionStats = await getSessionStatsFromRouter(
        activeSession.routerId,
        activeSession.callingStationId
      );

      if (sessionStats) {
        const bytesIn = sessionStats['bytes-in'] || 0;
        const bytesOut = sessionStats['bytes-out'] || 0;
        const totalUsed = BigInt(bytesIn + bytesOut);

        const quota = await prisma.radQuota.findFirst({
          where: {
            username: userName,
            periodEnd: { gt: new Date() },
            periodStart: { lte: new Date() }
          },
          orderBy: { periodEnd: 'desc' }
        });

        if (quota) {
          const remaining = quota.maxOctets - totalUsed;
          await prisma.radReply.upsert({
            where: {
              userName_attribute: {
                userName,
                attribute: 'ChilliSpot-Max-Total-Octets'
              }
            },
            update: {
              value: remaining > 0n ? remaining.toString() : '0'
            },
            create: {
              userName,
              attribute: 'ChilliSpot-Max-Total-Octets',
              op: '=',
              value: remaining > 0n ? remaining.toString() : '0'
            }
          });
          return true;
        }
      }
    }

    // Fallback to standard update
    return await updateRadiusQuotaLimit(userName) !== null;
  } catch (error) {
    console.error(`Error syncing quota for user ${userName}:`, error);
    return false;
  }
}

