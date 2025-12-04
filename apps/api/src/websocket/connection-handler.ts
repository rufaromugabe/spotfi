import { WebSocket } from 'ws';
import { FastifyBaseLogger } from 'fastify';
import { randomBytes } from 'crypto';
import { NasService } from '../services/nas.js';
import { prisma } from '../lib/prisma.js';
import { xTunnelManager } from './x-tunnel.js';
import { commandManager } from './command-manager.js';
import { recordRouterHeartbeat, markRouterOffline } from '../services/redis-router.js';
import { reconcileRouterSessions, queueFailedDisconnectsForRetry } from '../services/session-reconciliation.js';

export class RouterConnectionHandler {
  private routerId: string;
  private socket: WebSocket;
  private logger: FastifyBaseLogger;
  private nasService: NasService;
  private lastPongTime: number;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private readonly PING_INTERVAL = 30000; // 30 seconds
  private readonly PONG_TIMEOUT = 60000; // 60 seconds - mark offline if no pong

  constructor(
    routerId: string,
    socket: WebSocket,
    logger: FastifyBaseLogger
  ) {
    this.routerId = routerId;
    this.socket = socket;
    this.logger = logger;
    this.nasService = new NasService(logger);
    this.lastPongTime = Date.now();
  }

  async initialize(clientIp: string, routerName?: string): Promise<void> {
    const router = await prisma.router.findUnique({
      where: { id: this.routerId },
      select: { nasipaddress: true, name: true, radiusSecret: true }
    });

    if (!router) {
      throw new Error('Router not found');
    }

    const ipChanged = router.nasipaddress && router.nasipaddress !== clientIp;
    const nameChanged = routerName && routerName.trim() && router.name !== routerName.trim();

    // Record initial heartbeat in Redis (immediate, no DB write)
    await recordRouterHeartbeat(this.routerId).catch((err) => {
      this.logger.warn(`Failed to record initial heartbeat for router ${this.routerId}: ${err.message}`);
    });

    // Update router status, IP, and optionally name in Postgres (for persistence)
    await prisma.router.update({
      where: { id: this.routerId },
      data: {
        status: 'ONLINE',
        lastSeen: new Date(),
        nasipaddress: clientIp,
        ...(nameChanged && { name: routerName.trim() }),
        ...(!router.radiusSecret && { 
          radiusSecret: randomBytes(16).toString('hex') 
        })
      }
    });

    if (nameChanged) {
      this.logger.info(`Router ${this.routerId} name updated to: ${routerName.trim()}`);
    }

    // Get updated router info (with generated secret if needed)
    const updatedRouter = await prisma.router.findUnique({
      where: { id: this.routerId },
      select: { name: true, radiusSecret: true }
    });

    if (!updatedRouter || !updatedRouter.radiusSecret) {
      throw new Error('Router configuration incomplete');
    }

    // Handle NAS entries
    if (ipChanged && router.nasipaddress) {
      await this.nasService.handleIpChange(
        router.nasipaddress,
        clientIp,
        { id: this.routerId, name: updatedRouter.name, radiusSecret: updatedRouter.radiusSecret }
      );
    } else {
      await this.nasService.upsertNasEntry({
        id: this.routerId,
        name: updatedRouter.name,
        nasipaddress: clientIp,
        radiusSecret: updatedRouter.radiusSecret
      });
    }

    this.logger.info(`Router ${this.routerId} connected from ${clientIp}`);

    // Reconcile sessions after router reconnects (async, don't block)
    // This ensures any sessions that should be terminated are properly handled
    setImmediate(async () => {
      try {
        // Queue any failed disconnects for retry
        await queueFailedDisconnectsForRetry(this.routerId, this.logger);
        
        // Reconcile sessions (compare DB state with router state)
        const result = await reconcileRouterSessions(this.routerId, this.logger);
        if (result.mismatches > 0) {
          this.logger.info(
            `[Reconciliation] Router ${this.routerId}: ${result.mismatches} mismatches found, ` +
            `${result.kicked} sessions kicked, ${result.errors} errors`
          );
        }
      } catch (error: any) {
        this.logger.error(`[Reconciliation] Error during router ${this.routerId} reconciliation: ${error.message}`);
      }
    });
  }

  setupMessageHandlers(): void {
    // Handle native WebSocket pong frames (more efficient than application-level)
    this.socket.on('pong', async () => {
      this.lastPongTime = Date.now();
      // Record heartbeat in Redis (memory, sub-ms latency, no DB write)
      await recordRouterHeartbeat(this.routerId).catch((err) => {
        this.logger.warn(`Failed to record heartbeat for router ${this.routerId}: ${err.message}`);
      });
    });

    this.socket.on('message', async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        this.logger.debug(`[Router ${this.routerId}] Received message type: ${message.type}`);
        
        switch (message.type) {
          case 'metrics':
            // Metrics indicate connection is alive
            this.lastPongTime = Date.now();
            // Record heartbeat in Redis (metrics indicate router is active)
            await recordRouterHeartbeat(this.routerId).catch((err) => {
              this.logger.warn(`Failed to record heartbeat for router ${this.routerId}: ${err.message}`);
            });
            await this.handleMetrics(message.metrics);
            break;

          case 'x-data':
            // Forward x data from router to frontend client
            this.handlexData(message);
            break;

          case 'x-started':
            // Router confirmed x session started
            this.logger.info(`[Router ${this.routerId}] x session ${message.sessionId} confirmed started by router`);
            break;

          case 'x-error':
            // Router reported x error
            this.logger.error(`[Router ${this.routerId}] x error for session ${message.sessionId}: ${message.error}`);
            break;

          case 'rpc-result':
            // Handle RPC call result (generic ubus response)
            if (message.id) {
              commandManager.handleResponse(message.id, message);
            }
            break;

          case 'update-router-name':
            // Handle router name update from bridge
            await this.handleRouterNameUpdate(message.name);
            break;

          default:
            this.logger.warn(`[Router ${this.routerId}] Unknown message type: ${message.type}`);
        }
      } catch (error) {
        this.logger.error(`[Router ${this.routerId}] Message handling error: ${error}`);
      }
    });

    this.socket.on('close', async () => {
      this.cleanup();
      // Mark offline in Redis (immediate) and Postgres (for persistence)
      await Promise.all([
        markRouterOffline(this.routerId).catch(() => {}),
        this.markOfflineInPostgres()
      ]);
      // Close all x sessions for this router
      xTunnelManager.closeRouterSessions(this.routerId);
      this.logger.info(`Router ${this.routerId} disconnected`);
    });

    this.socket.on('error', async (error: Error) => {
      this.logger.error(`Router ${this.routerId} socket error: ${error.message}`);
      this.cleanup();
      // Mark offline in Redis (immediate) and Postgres (for persistence)
      await Promise.all([
        markRouterOffline(this.routerId).catch(() => {}),
        this.markOfflineInPostgres()
      ]);
    });

    // Start health check with native ping/pong
    this.startHealthCheck();
  }

  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(async () => {
      // Check if connection is still alive
      if (this.socket.readyState !== WebSocket.OPEN) {
        this.cleanup();
        // Mark offline in Redis (immediate) and Postgres (for persistence)
        await Promise.all([
          markRouterOffline(this.routerId).catch(() => {}),
          this.markOfflineInPostgres()
        ]);
        return;
      }

      // Check if we haven't received a pong in too long
      const timeSinceLastPong = Date.now() - this.lastPongTime;
      if (timeSinceLastPong > this.PONG_TIMEOUT) {
        this.logger.warn(`Router ${this.routerId} appears dead (no pong for ${timeSinceLastPong}ms)`);
        this.cleanup();
        // Mark offline in Redis (immediate) and Postgres (for persistence)
        await Promise.all([
          markRouterOffline(this.routerId).catch(() => {}),
          this.markOfflineInPostgres()
        ]);
        this.socket.terminate();
        return;
      }

      // Use native WebSocket ping frame (more efficient than JSON message)
      try {
        this.socket.ping();
      } catch (error) {
        this.logger.error(`Failed to send ping to router ${this.routerId}: ${error}`);
        this.cleanup();
        // Mark offline in Redis (immediate) and Postgres (for persistence)
        await Promise.all([
          markRouterOffline(this.routerId).catch(() => {}),
          this.markOfflineInPostgres()
        ]);
      }
    }, this.PING_INTERVAL);
  }

  private async markOfflineInPostgres(): Promise<void> {
    try {
      await prisma.router.update({
        where: { id: this.routerId },
        data: { status: 'OFFLINE' }
      });
    } catch (err) {
      this.logger.error(`Failed to mark router ${this.routerId} offline in Postgres: ${err}`);
    }
  }

  private cleanup(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    // Clear pending commands for this router
    commandManager.clearAll(this.routerId);
  }

  private async handleMetrics(metrics: any): Promise<void> {
    // Metrics indicate router is active - heartbeat already recorded in Redis
    // No need to update Postgres here (handled by periodic sync job)
  }

  private handlexData(message: any): void {
    try {
      const { sessionId, data } = message;
      
      if (!sessionId || !data) {
        this.logger.warn(`[Router ${this.routerId}] Invalid x data message: missing sessionId or data`);
        return;
      }

      this.logger.debug(`[Router ${this.routerId}] Received x-data from router for session ${sessionId} (data length: ${typeof data === 'string' ? data.length : 'unknown'})`);

      // Get x session
      const session = xTunnelManager.getSession(sessionId);
      if (!session) {
        this.logger.warn(`[Router ${this.routerId}] x session not found: ${sessionId}`);
        return;
      }

      // Decode base64 data and forward to frontend client
      const binaryData = Buffer.from(data, 'base64');
      this.logger.debug(`[Router ${this.routerId}] Decoded ${binaryData.length} bytes from router, forwarding to client session ${sessionId}`);
      session.sendToClient(binaryData);
    } catch (error) {
      this.logger.error(`[Router ${this.routerId}] Error handling x data: ${error}`);
    }
  }

  private async handleRouterNameUpdate(name: string): Promise<void> {
    if (!name || !name.trim()) {
      this.logger.warn(`[Router ${this.routerId}] Invalid router name update: empty name`);
      return;
    }

    try {
      await prisma.router.update({
        where: { id: this.routerId },
        data: { name: name.trim() }
      });
      this.logger.info(`[Router ${this.routerId}] Router name updated to: ${name.trim()}`);
    } catch (error) {
      this.logger.error(`[Router ${this.routerId}] Failed to update router name: ${error}`);
    }
  }

  sendWelcome(): void {
    this.socket.send(JSON.stringify({
      type: 'connected',
      routerId: this.routerId,
      timestamp: new Date().toISOString()
    }));
  }
}

