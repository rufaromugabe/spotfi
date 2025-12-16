import { WebSocket } from 'ws';
import { FastifyBaseLogger } from 'fastify';
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
  private readonly PING_INTERVAL = 30000;
  private readonly PONG_TIMEOUT = 60000;

  constructor(routerId: string, socket: WebSocket, logger: FastifyBaseLogger) {
    this.routerId = routerId;
    this.socket = socket;
    this.logger = logger;
    this.nasService = new NasService(logger);
    this.lastPongTime = Date.now();
  }

  async initialize(clientIp: string, routerName?: string): Promise<void> {
    const router = await prisma.router.findUnique({
      where: { id: this.routerId },
      select: { nasipaddress: true, name: true }
    });

    if (!router) throw new Error('Router not found');

    const ipChanged = router.nasipaddress && router.nasipaddress !== clientIp;
    const nameChanged = routerName?.trim() && router.name !== routerName.trim();

    await recordRouterHeartbeat(this.routerId).catch(err => {
      this.logger.warn(`Failed to record heartbeat: ${err.message}`);
    });

    await prisma.router.update({
      where: { id: this.routerId },
      data: {
        status: 'ONLINE',
        lastSeen: new Date(),
        nasipaddress: clientIp,
        ...(nameChanged && { name: routerName!.trim() })
      }
    });

    if (nameChanged) {
      this.logger.info(`Router ${this.routerId} name updated: ${routerName!.trim()}`);
    }

    const updatedRouter = await prisma.router.findUnique({
      where: { id: this.routerId },
      select: { name: true }
    });

    if (!updatedRouter) throw new Error('Router configuration incomplete');

    // Sync NAS entry (uses master secret from ENV internally)
    if (ipChanged && router.nasipaddress) {
      await this.nasService.handleIpChange(
        router.nasipaddress,
        clientIp,
        { id: this.routerId, name: updatedRouter.name }
      );
    } else {
      await this.nasService.upsertNasEntry({
        id: this.routerId,
        name: updatedRouter.name,
        nasipaddress: clientIp
      });
    }

    this.logger.info(`Router ${this.routerId} connected from ${clientIp}`);

    // Background session reconciliation
    setImmediate(async () => {
      try {
        await queueFailedDisconnectsForRetry(this.routerId, this.logger);
        const result = await reconcileRouterSessions(this.routerId, this.logger);
        if (result.mismatches > 0) {
          this.logger.info(`[Reconciliation] ${this.routerId}: ${result.mismatches} mismatches, ${result.kicked} kicked`);
        }
      } catch (error: any) {
        this.logger.error(`[Reconciliation] Error: ${error.message}`);
      }
    });
  }

  setupMessageHandlers(): void {
    this.socket.on('pong', async () => {
      this.lastPongTime = Date.now();
      await recordRouterHeartbeat(this.routerId).catch(() => {});
    });

    this.socket.on('message', async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        
        switch (message.type) {
          case 'metrics':
            this.lastPongTime = Date.now();
            await recordRouterHeartbeat(this.routerId).catch(() => {});
            await this.handleMetrics(message.metrics);
            break;
          case 'x-data':
            this.handlexData(message);
            break;
          case 'x-started':
            this.logger.info(`[Router ${this.routerId}] x session ${message.sessionId} started`);
            break;
          case 'x-error':
            this.logger.error(`[Router ${this.routerId}] x error: ${message.error}`);
            break;
          case 'rpc-result':
            if (message.id) commandManager.handleResponse(message.id, message);
            break;
          case 'update-router-name':
            await this.handleRouterNameUpdate(message.name);
            break;
          default:
            this.logger.warn(`[Router ${this.routerId}] Unknown message: ${message.type}`);
        }
      } catch (error) {
        this.logger.error(`[Router ${this.routerId}] Message error: ${error}`);
      }
    });

    this.socket.on('close', async () => {
      this.cleanup();
      await Promise.all([
        markRouterOffline(this.routerId).catch(() => {}),
        this.markOfflineInPostgres()
      ]);
      xTunnelManager.closeRouterSessions(this.routerId);
      this.logger.info(`Router ${this.routerId} disconnected`);
    });

    this.socket.on('error', async (error: Error) => {
      this.logger.error(`Router ${this.routerId} error: ${error.message}`);
      this.cleanup();
      await Promise.all([
        markRouterOffline(this.routerId).catch(() => {}),
        this.markOfflineInPostgres()
      ]);
    });

    this.startHealthCheck();
  }

  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(async () => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        this.cleanup();
        await Promise.all([
          markRouterOffline(this.routerId).catch(() => {}),
          this.markOfflineInPostgres()
        ]);
        return;
      }

      const timeSinceLastPong = Date.now() - this.lastPongTime;
      if (timeSinceLastPong > this.PONG_TIMEOUT) {
        this.logger.warn(`Router ${this.routerId} dead (no pong for ${timeSinceLastPong}ms)`);
        this.cleanup();
        await Promise.all([
          markRouterOffline(this.routerId).catch(() => {}),
          this.markOfflineInPostgres()
        ]);
        this.socket.terminate();
        return;
      }

      try {
        this.socket.ping();
      } catch {
        this.cleanup();
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
      this.logger.error(`Failed to mark router offline: ${err}`);
    }
  }

  private cleanup(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    commandManager.clearAll(this.routerId);
  }

  private async handleMetrics(_metrics: any): Promise<void> {
    // Heartbeat already recorded
  }

  private handlexData(message: any): void {
      const { sessionId, data } = message;
    if (!sessionId || !data) return;

      const session = xTunnelManager.getSession(sessionId);
      if (!session) {
      this.logger.warn(`x session not found: ${sessionId}`);
        return;
      }

      const binaryData = Buffer.from(data, 'base64');
      session.sendToClient(binaryData);
  }

  private async handleRouterNameUpdate(name: string): Promise<void> {
    if (!name?.trim()) return;

    try {
      await prisma.router.update({
        where: { id: this.routerId },
        data: { name: name.trim() }
      });
      this.logger.info(`Router ${this.routerId} name updated: ${name.trim()}`);
    } catch (error) {
      this.logger.error(`Failed to update router name: ${error}`);
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
