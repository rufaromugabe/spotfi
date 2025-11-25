import { WebSocket } from 'ws';
import { activeConnections } from '../websocket/server.js';
import { prisma } from '../lib/prisma.js';

class RouterStatusService {
  /**
   * Check actual router connection status via WebSocket
   */
  checkConnectionStatus(routerId: string): 'ONLINE' | 'OFFLINE' {
    const socket = activeConnections.get(routerId);
    const isActuallyOnline = socket && socket.readyState === WebSocket.OPEN;
    return isActuallyOnline ? 'ONLINE' : 'OFFLINE';
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
   * Get router with real-time status (checks WebSocket connection)
   * Updates DB asynchronously if status differs
   */
  async getRouterWithRealStatus(
    router: { id: string; status: string; [key: string]: any },
    logger: any
  ) {
    const actualStatus = this.checkConnectionStatus(router.id);
    
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

