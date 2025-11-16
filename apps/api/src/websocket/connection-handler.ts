import { WebSocket } from 'ws';
import { FastifyBaseLogger } from 'fastify';
import { randomBytes } from 'crypto';
import { NasService } from '../services/nas.js';
import { prisma } from '../lib/prisma.js';
import { xTunnelManager } from './x-tunnel.js';

export class RouterConnectionHandler {
  private routerId: string;
  private socket: WebSocket;
  private logger: FastifyBaseLogger;
  private nasService: NasService;
  private lastPongTime: number;
  private lastSeenUpdate: number;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private readonly PING_INTERVAL = 30000; // 30 seconds
  private readonly PONG_TIMEOUT = 60000; // 60 seconds - mark offline if no pong
  private readonly LAST_SEEN_UPDATE_INTERVAL = 600000; // 10 minutes

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
    this.lastSeenUpdate = Date.now();
  }

  async initialize(clientIp: string): Promise<void> {
    const router = await prisma.router.findUnique({
      where: { id: this.routerId },
      select: { nasipaddress: true, name: true, radiusSecret: true }
    });

    if (!router) {
      throw new Error('Router not found');
    }

    const ipChanged = router.nasipaddress && router.nasipaddress !== clientIp;

    // Update router status and IP
    await prisma.router.update({
      where: { id: this.routerId },
      data: {
        status: 'ONLINE',
        lastSeen: new Date(),
        nasipaddress: clientIp,
        ...(!router.radiusSecret && { 
          radiusSecret: randomBytes(16).toString('hex') 
        })
      }
    });

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
  }

  setupMessageHandlers(): void {
    // Handle native WebSocket pong frames (more efficient than application-level)
    this.socket.on('pong', async () => {
      this.lastPongTime = Date.now();
      // Update lastSeen every 10 minutes to reduce database load
      const timeSinceLastUpdate = Date.now() - this.lastSeenUpdate;
      if (timeSinceLastUpdate >= this.LAST_SEEN_UPDATE_INTERVAL) {
        await this.updateLastSeen();
        this.lastSeenUpdate = Date.now();
      }
    });

    this.socket.on('message', async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        this.logger.debug(`[Router ${this.routerId}] Received message type: ${message.type}`);
        
        switch (message.type) {
          case 'metrics':
            // Metrics indicate connection is alive
            this.lastPongTime = Date.now();
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

          default:
            this.logger.warn(`[Router ${this.routerId}] Unknown message type: ${message.type}`);
        }
      } catch (error) {
        this.logger.error(`[Router ${this.routerId}] Message handling error: ${error}`);
      }
    });

    this.socket.on('close', async () => {
      this.cleanup();
      await this.markOffline();
      // Close all x sessions for this router
      xTunnelManager.closeRouterSessions(this.routerId);
      this.logger.info(`Router ${this.routerId} disconnected`);
    });

    this.socket.on('error', async (error: Error) => {
      this.logger.error(`Router ${this.routerId} socket error: ${error.message}`);
      this.cleanup();
      await this.markOffline();
    });

    // Start health check with native ping/pong
    this.startHealthCheck();
  }

  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(async () => {
      // Check if connection is still alive
      if (this.socket.readyState !== WebSocket.OPEN) {
        this.cleanup();
        await this.markOffline();
        return;
      }

      // Check if we haven't received a pong in too long
      const timeSinceLastPong = Date.now() - this.lastPongTime;
      if (timeSinceLastPong > this.PONG_TIMEOUT) {
        this.logger.warn(`Router ${this.routerId} appears dead (no pong for ${timeSinceLastPong}ms)`);
        this.cleanup();
        await this.markOffline();
        this.socket.terminate();
        return;
      }

      // Use native WebSocket ping frame (more efficient than JSON message)
      try {
        this.socket.ping();
      } catch (error) {
        this.logger.error(`Failed to send ping to router ${this.routerId}: ${error}`);
        this.cleanup();
        await this.markOffline();
      }
    }, this.PING_INTERVAL);
  }

  private async updateLastSeen(): Promise<void> {
    try {
      await prisma.router.update({
        where: { id: this.routerId },
        data: {
          lastSeen: new Date(),
          status: 'ONLINE'
        }
      });
    } catch (err) {
      this.logger.error(`Failed to update lastSeen for router ${this.routerId}: ${err}`);
    }
  }

  private cleanup(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  private async markOffline(): Promise<void> {
    try {
      await prisma.router.update({
        where: { id: this.routerId },
        data: { status: 'OFFLINE' }
      });
    } catch (err) {
      this.logger.error(`Failed to mark router ${this.routerId} offline: ${err}`);
    }
  }

  private async handleMetrics(metrics: any): Promise<void> {
    // Update lastSeen when metrics are received (more frequent than ping/pong)
    const timeSinceLastUpdate = Date.now() - this.lastSeenUpdate;
    if (timeSinceLastUpdate >= this.LAST_SEEN_UPDATE_INTERVAL) {
      await this.updateLastSeen();
      this.lastSeenUpdate = Date.now();
    } else {
      // Still update status to ONLINE even if not updating lastSeen
      await prisma.router.update({
        where: { id: this.routerId },
        data: { status: 'ONLINE' }
      }).catch(() => {});
    }
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

  sendWelcome(): void {
    this.socket.send(JSON.stringify({
      type: 'connected',
      routerId: this.routerId,
      timestamp: new Date().toISOString()
    }));
  }
}

