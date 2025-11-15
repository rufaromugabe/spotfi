import { WebSocket } from 'ws';
import { FastifyBaseLogger } from 'fastify';
import { randomBytes } from 'crypto';
import { NasService } from '../services/nas.js';
import { prisma } from '../lib/prisma.js';

export class RouterConnectionHandler {
  private routerId: string;
  private socket: WebSocket;
  private logger: FastifyBaseLogger;
  private nasService: NasService;
  private lastPongTime: number;
  private lastPingTime: number;
  private lastSeenUpdate: number;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private readonly PING_INTERVAL = 20000; // 20 seconds - more frequent checks
  private readonly PONG_TIMEOUT = 45000; // 45 seconds - mark offline if no pong (2 missed pings)
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
    this.lastPingTime = 0;
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

    // Also handle socket-level errors and close events more aggressively
    this.socket.on('close', async (code, reason) => {
      this.logger.info(`Router ${this.routerId} socket closed (code: ${code})`);
      this.cleanup();
      await this.markOffline();
    });

    this.socket.on('message', async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        
        switch (message.type) {
          case 'metrics':
            // Metrics indicate connection is alive
            this.lastPongTime = Date.now();
            await this.handleMetrics(message.metrics);
            break;

          default:
            this.logger.warn(`Unknown message type: ${message.type}`);
        }
      } catch (error) {
        this.logger.error(`Message handling error: ${error}`);
      }
    });

    // Note: close handler is now above to catch it earlier

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
        this.logger.warn(`Router ${this.routerId} socket not OPEN (state: ${this.socket.readyState})`);
        this.cleanup();
        await this.markOffline();
        return;
      }

      // Check if we haven't received a pong since the last ping
      const timeSinceLastPong = Date.now() - this.lastPongTime;
      const timeSinceLastPing = this.lastPingTime > 0 ? Date.now() - this.lastPingTime : 0;
      
      // If we sent a ping but haven't received a pong within timeout, mark as dead
      if (this.lastPingTime > 0 && timeSinceLastPing > this.PONG_TIMEOUT) {
        this.logger.warn(`Router ${this.routerId} appears dead (no pong for ${timeSinceLastPing}ms, last pong was ${timeSinceLastPong}ms ago)`);
        this.cleanup();
        await this.markOffline();
        try {
          this.socket.terminate();
        } catch (e) {
          // Socket might already be closed
        }
        return;
      }

      // Also check if we haven't received ANY pong in too long (backup check)
      // This catches cases where the connection dies before we send the first ping
      if (timeSinceLastPong > this.PONG_TIMEOUT * 1.5) {
        this.logger.warn(`Router ${this.routerId} appears dead (no pong for ${timeSinceLastPong}ms)`);
        this.cleanup();
        await this.markOffline();
        try {
          this.socket.terminate();
        } catch (e) {
          // Socket might already be closed
        }
        return;
      }

      // Use native WebSocket ping frame (more efficient than JSON message)
      try {
        // Check if socket is actually writable before pinging
        if (this.socket.readyState === WebSocket.OPEN && this.socket.bufferedAmount === 0) {
          this.socket.ping();
          this.lastPingTime = Date.now();
        } else {
          // Socket appears to be stuck, mark as dead
          this.logger.warn(`Router ${this.routerId} socket appears stuck (buffered: ${this.socket.bufferedAmount})`);
          this.cleanup();
          await this.markOffline();
          try {
            this.socket.terminate();
          } catch (e) {
            // Socket might already be closed
          }
        }
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

  sendWelcome(): void {
    this.socket.send(JSON.stringify({
      type: 'connected',
      routerId: this.routerId,
      timestamp: new Date().toISOString()
    }));
  }
}

