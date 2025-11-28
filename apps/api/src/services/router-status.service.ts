import { prisma } from '../lib/prisma.js';
import { isRouterOnline } from './redis-router.js';
import { isRouterConnected } from './websocket-redis-adapter.js';

class RouterStatusService {
  /**
   * Check actual router connection status
   * Priority: Redis heartbeat (fastest) > WebSocket connection > Database
   */
  async checkConnectionStatus(routerId: string): Promise<'ONLINE' | 'OFFLINE'> {
    // First check Redis heartbeat (sub-ms latency, most up-to-date)
    const redisOnline = await isRouterOnline(routerId);
    if (redisOnline) {
      return 'ONLINE';
    }
    
    // Check if router is connected (any server) via Redis connection registry
    const isConnected = await isRouterConnected(routerId);
    return isConnected ? 'ONLINE' : 'OFFLINE';
  }

  /**
   * Update router status in DB asynchronously (fire-and-forget)
   * This doesn't block the response and updates the DB in the background
   */
  async updateStatusIfNeeded(
    routerId: string,
    dbStatus: string,
    actualStatus: 'ONLINE' | 'OFFLINE',
    logger: any
  ): Promise<void> {
    if (dbStatus !== actualStatus) {
      // Update DB asynchronously - don't block response
      prisma.router
        .update({
          where: { id: routerId },
          data: {
            status: actualStatus,
            ...(actualStatus === 'ONLINE' && { lastSeen: new Date() })
          }
        })
        .catch((err: unknown) => {
          logger.error(`Failed to update router status for ${routerId}: ${err}`);
        });
    }
  }

  /**
   * Get router with real-time status (checks Redis heartbeat and WebSocket)
   * Updates DB asynchronously if status differs
   */
  async getRouterWithRealStatus(
    router: { id: string; status: string; [key: string]: any },
    logger: any
  ) {
    const actualStatus = await this.checkConnectionStatus(router.id);
    
    // Update DB asynchronously if status differs (don't block response)
    if (router.status !== actualStatus) {
      this.updateStatusIfNeeded(router.id, router.status, actualStatus, logger);
    }

    return {
      ...router,
      status: actualStatus
    };
  }
}

export const routerStatusService = new RouterStatusService();

