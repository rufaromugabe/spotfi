/**
 * Session Reconciliation Service
 * Ensures DB state matches router state, especially after router reconnections
 */

import { prisma } from '../lib/prisma.js';
import { routerRpcService } from './router-rpc.service.js';
import { FastifyBaseLogger } from 'fastify';
import { disconnectQueue } from '../queues/disconnect-queue.js';
import { reconciliationQueue } from '../queues/reconciliation-queue.js';

interface ReconciliationResult {
  routerId: string;
  dbSessions: number;
  routerClients: number;
  mismatches: number;
  kicked: number;
  errors: number;
}

/**
 * Reconcile sessions for a specific router
 * Compares DB active sessions with router's actual client list
 */
export async function reconcileRouterSessions(
  routerId: string,
  logger: FastifyBaseLogger
): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    routerId,
    dbSessions: 0,
    routerClients: 0,
    mismatches: 0,
    kicked: 0,
    errors: 0
  };

  try {
    // Get all active sessions in DB for this router
    const dbSessions = await prisma.radAcct.findMany({
      where: {
        routerId,
        acctStopTime: null
      },
      select: {
        userName: true,
        callingStationId: true,
        acctSessionId: true
      }
    });

    result.dbSessions = dbSessions.length;

    if (dbSessions.length === 0) {
      logger.debug(`[Reconciliation] Router ${routerId}: No active sessions in DB`);
      return result;
    }

    // Get actual clients from router
    let routerClients: any[] = [];
    try {
      const clientList = await routerRpcService.getLiveClients(routerId);
      // Handle different response formats
      routerClients = Array.isArray(clientList)
        ? clientList
        : (clientList?.clients || clientList?.data || []);

      if (!Array.isArray(routerClients)) {
        routerClients = [];
      }

      result.routerClients = routerClients.length;
    } catch (error: any) {
      logger.warn(`[Reconciliation] Router ${routerId}: Failed to get client list: ${error.message}`);
      result.errors++;
      return result;
    }

    // Build a map of MAC addresses from router
    const routerMacs = new Set(
      routerClients
        .map((client: any) => {
          // Handle different MAC formats (address, mac, MAC, etc.)
          return client.address || client.mac || client.MAC || client.callingStationId;
        })
        .filter((mac: any) => mac && typeof mac === 'string')
        .map((mac: string) => mac.toUpperCase().replace(/[:-]/g, ''))
    );

    // Find sessions that should be terminated
    // These are sessions in DB that are NOT in router's client list
    // OR sessions for users who should be disabled
    const sessionsToTerminate: Array<{ username: string; mac: string }> = [];

    for (const session of dbSessions) {
      if (!session.callingStationId) continue;

      const sessionMac = session.callingStationId.toUpperCase().replace(/[:-]/g, '');

      // Skip if no username
      if (!session.userName) continue;

      // Check if user should be disabled (no active plans, quota exceeded, etc.)
      const shouldBeDisabled = await checkUserShouldBeDisabled(session.userName);

      // If user should be disabled OR session not in router's client list
      if (shouldBeDisabled || !routerMacs.has(sessionMac)) {
        sessionsToTerminate.push({
          username: session.userName,
          mac: session.callingStationId
        });
      }
    }

    result.mismatches = sessionsToTerminate.length;

    if (sessionsToTerminate.length === 0) {
      logger.debug(`[Reconciliation] Router ${routerId}: All sessions match`);
      return result;
    }

    logger.info(`[Reconciliation] Router ${routerId}: Found ${sessionsToTerminate.length} sessions to terminate`);

    // Kick clients that should be terminated
    const kickPromises = sessionsToTerminate.map(async ({ username, mac }) => {
      try {
        await routerRpcService.kickClient(routerId, mac);
        logger.info(`[Reconciliation] Kicked ${username} (MAC: ${mac}) from router ${routerId}`);
        result.kicked++;
        return true;
      } catch (error: any) {
        logger.error(`[Reconciliation] Failed to kick ${mac} from router ${routerId}: ${error.message}`);
        result.errors++;
        return false;
      }
    });

    await Promise.allSettled(kickPromises);

    // Force close terminated sessions in DB
    const usernamesToClose = [...new Set(sessionsToTerminate.map(s => s.username))];
    await prisma.radAcct.updateMany({
      where: {
        routerId,
        userName: { in: usernamesToClose },
        acctStopTime: null
      },
      data: {
        acctStopTime: new Date(),
        acctTerminateCause: 'Admin-Reset'
      }
    });

    return result;
  } catch (error: any) {
    logger.error(`[Reconciliation] Error reconciling router ${routerId}: ${error.message}`);
    result.errors++;
    return result;
  }
}

/**
 * Check if a user should be disabled (no active plans, quota exceeded, etc.)
 */
async function checkUserShouldBeDisabled(username: string): Promise<boolean> {
  // Check if user exists
  const endUser = await prisma.endUser.findUnique({
    where: { username },
    select: { id: true }
  });

  if (!endUser) {
    return true; // User doesn't exist, should be disabled
  }

  // Check for active plans
  const activePlans = await prisma.userPlan.findMany({
    where: {
      userId: endUser.id,
      status: 'ACTIVE',
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: new Date() } }
      ]
    }
  });

  if (activePlans.length === 0) {
    return true; // No active plans, should be disabled
  }

  // Check if user is in disconnect queue (quota exceeded, plan expired)
  const pendingDisconnect = await prisma.disconnectQueue.findFirst({
    where: {
      username,
      processed: false
    }
  });

  if (pendingDisconnect) {
    return true; // Has pending disconnect, should be disabled
  }

  // Check radcheck for Auth-Type = Reject
  const authReject = await prisma.radCheck.findFirst({
    where: {
      userName: username,
      attribute: 'Auth-Type',
      value: 'Reject'
    }
  });

  if (authReject) {
    return true; // Explicitly rejected in RADIUS
  }

  return false;
}

/**
 * Reconcile all online routers
 */
// Reconcile all online routers via Queue
export async function reconcileAllRouters(logger: FastifyBaseLogger): Promise<void> {
  try {
    const onlineRouters = await prisma.router.findMany({
      where: { status: 'ONLINE' },
      select: { id: true }
    });

    logger.info(`[Reconciliation] Queueing reconciliation for ${onlineRouters.length} online routers`);

    const queuePromises = onlineRouters.map(router =>
      reconciliationQueue.add(
        `reconcile-${router.id}`,
        { routerId: router.id },
        {
          jobId: `reconcile-${router.id}-${Date.now()}`,
          delay: Math.floor(Math.random() * 10000), // 0-10s jitter
          removeOnComplete: true
        }
      )
    );

    await Promise.all(queuePromises);

    logger.info(`[Reconciliation] All ${onlineRouters.length} jobs queued`);
  } catch (error: any) {
    logger.error(`[Reconciliation] Error in batch reconciliation: ${error.message}`);
  }
}

/**
 * Queue failed disconnects for retry when router comes back online
 */
export async function queueFailedDisconnectsForRetry(
  routerId: string,
  logger: FastifyBaseLogger
): Promise<void> {
  try {
    // Find sessions that should be terminated but router was offline
    // These are sessions where:
    // 1. User should be disabled (no active plans, etc.)
    // 2. Session is still active in DB
    // 3. Router is now online

    const sessionsToDisconnect = await prisma.radAcct.findMany({
      where: {
        routerId,
        acctStopTime: null
      },
      select: {
        userName: true
      },
      distinct: ['userName']
    });

    for (const session of sessionsToDisconnect) {
      if (!session.userName) continue;

      const shouldBeDisabled = await checkUserShouldBeDisabled(session.userName);

      if (shouldBeDisabled) {
        // Queue disconnect job
        await disconnectQueue.add(
          `reconcile-${session.userName}-${Date.now()}`,
          {
            username: session.userName,
            reason: 'PLAN_EXPIRED' // Generic reason for reconciliation
          },
          {
            jobId: `reconcile-${session.userName}`,
            removeOnComplete: true
          }
        );

        logger.info(`[Reconciliation] Queued disconnect for ${session.userName} after router ${routerId} reconnected`);
      }
    }
  } catch (error: any) {
    logger.error(`[Reconciliation] Error queueing failed disconnects for router ${routerId}: ${error.message}`);
  }
}

