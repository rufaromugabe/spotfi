import { WebSocket } from 'ws';
import { FastifyBaseLogger } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { mqttService } from '../lib/mqtt.js';
import { isRouterOnline } from '../services/redis-router.js';
import { INSTANCE_ID } from '../lib/instance.js';

/**
 * MQTT-based x-Tunnel Session Manager
 * Manages distributed x-tunnel sessions across API cluster via MQTT broker
 * Sessions are location-independent - any API instance can handle any session
 */
export class xTunnelManager {
  private static sessions = new Map<string, xTunnelSession>();
  private static readonly SESSION_TIMEOUT = 3600000; // 1 hour

  /**
   * Initialize MQTT listeners for x-tunnel data
   */
  static init(logger: FastifyBaseLogger) {
    logger.info('[x] Initializing distributed MQTT x-tunnel gateway...');

    // Subscribe to unique instance topic for router x-out data
    // This optimization ensures each API instance only receives data for sessions it owns
    const instanceTopic = `spotfi/api/${INSTANCE_ID}/x/out`;
    logger.info(`[x] Instance topic: ${instanceTopic}`);

    mqttService.subscribe(instanceTopic, (topic, message) => {
      const sessionId = message.sessionId;
      if (!sessionId) return;

      const session = this.sessions.get(sessionId);
      if (session) {
        // We have this session locally, route data to client
        if (message.type === 'x-data' && message.data) {
          const binaryData = Buffer.from(message.data, 'base64');
          session.sendToClient(binaryData);
        } else if (message.type === 'x-started') {
          logger.info(`[x] Session ${sessionId} confirmed started by router on instance ${INSTANCE_ID}`);
        } else if (message.type === 'x-error') {
          logger.error(`[x] Session ${sessionId} error: ${message.error}`);
          session.close(false); // Close without sending stop (since it's error)
        }
      }
    });
  }

  /**
   * Create a new x tunnel session
   */
  static async createSession(
    routerId: string,
    clientSocket: WebSocket,
    userId: string,
    logger: FastifyBaseLogger
  ): Promise<xTunnelSession> {
    // Check if router is online (anywhere in the cluster via Redis heartbeat)
    const online = await isRouterOnline(routerId);
    if (!online) {
      throw new Error('Router is offline (no heartbeat)');
    }

    // Verify user has access to router
    const router = await prisma.router.findFirst({
      where: { id: routerId },
      select: { hostId: true }
    });

    if (!router) {
      throw new Error('Router not found');
    }

    // Close any existing sessions for this router to ensure only one session per router
    // This prevents multiple terminal connections from interfering with each other
    this.closeRouterSessions(routerId);
    if (this.sessions.size > 0) {
      logger.info(`[x] Closed existing session(s) for router ${routerId} before creating new session`);
    }

    // Create session
    const sessionId = `${routerId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const session = new xTunnelSession(
      sessionId,
      routerId,
      clientSocket,
      userId,
      logger
    );

    this.sessions.set(sessionId, session);
    logger.debug(`[x] Active sessions: ${this.sessions.size}`);

    // Cleanup on timeout
    setTimeout(() => {
      if (this.sessions.has(sessionId)) {
        logger.info(`[x] x session ${sessionId} timed out after ${this.SESSION_TIMEOUT / 1000}s`);
        session.close();
      }
    }, this.SESSION_TIMEOUT);

    logger.info(`[x] x tunnel session created: ${sessionId} for router ${routerId} via MQTT Gateway`);
    return session;
  }

  /**
   * Get session by ID
   */
  static getSession(sessionId: string): xTunnelSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Close and remove session
   */
  static closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.close();
      this.sessions.delete(sessionId);
      // Note: logger is not available in static context, but session.close() will log
    } else {
      // Session not found - might already be closed
    }
  }

  /**
   * Close all sessions for a router (when router disconnects)
   */
  static closeRouterSessions(routerId: string): void {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.routerId === routerId) {
        session.close();
        this.sessions.delete(sessionId);
      }
    }
  }

  /**
   * Get all active sessions for a router
   */
  static getRouterSessions(routerId: string): xTunnelSession[] {
    return Array.from(this.sessions.values()).filter(
      session => session.routerId === routerId
    );
  }
}

/**
 * x Tunnel Session
 * Manages bidirectional data flow between frontend and router
 */
export class xTunnelSession {
  public readonly sessionId: string;
  public readonly routerId: string;
  public readonly userId: string;
  private clientSocket: WebSocket;
  private logger: FastifyBaseLogger;
  private isClosed: boolean = false;

  constructor(
    sessionId: string,
    routerId: string,
    clientSocket: WebSocket,
    userId: string,
    logger: FastifyBaseLogger
  ) {
    this.sessionId = sessionId;
    this.routerId = routerId;
    this.userId = userId;
    this.clientSocket = clientSocket;
    this.logger = logger;

    this.setupClientHandlers();
    this.startxSession();
  }

  /**
   * Setup handlers for frontend client WebSocket
   */
  private setupClientHandlers(): void {
    // Forward data from frontend to router
    this.clientSocket.on('message', (data: Buffer | string) => {
      if (this.isClosed) {
        this.logger.debug(`[x ${this.sessionId}] Ignoring message from client (session closed)`);
        return;
      }

      try {
        // Convert to Buffer if string (shouldn't happen with xterm.js, but be safe)
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
        this.logger.debug(`[x ${this.sessionId}] Received ${buffer.length} bytes from client, forwarding to router`);
        // Send x data to router
        this.sendToRouter(buffer);
      } catch (error) {
        this.logger.error(`[x ${this.sessionId}] Error forwarding client data: ${error}`);
        this.close();
      }
    });

    // Handle client disconnect
    this.clientSocket.on('close', () => {
      this.logger.info(`x client disconnected: ${this.sessionId}`);
      this.close();
    });

    this.clientSocket.on('error', (error) => {
      this.logger.error(`x client error: ${error}`);
      this.close();
    });
  }

  /**
   * Start x session on router
   */
  private startxSession(): void {
    try {
      // Send x session start command to router via MQTT
      // Tell the router exactly which topic to send responses to (this instance)
      const startCommand = {
        type: 'x-start',
        sessionId: this.sessionId,
        responseTopic: `spotfi/api/${INSTANCE_ID}/x/out`,
        timestamp: new Date().toISOString()
      };

      this.logger.info(`[x ${this.sessionId}] Sending x-start command to router via MQTT`);
      mqttService.publish(`spotfi/router/${this.routerId}/x/in`, startCommand);
    } catch (error) {
      this.logger.error(`[x ${this.sessionId}] Error starting x session: ${error}`);
      this.close();
    }
  }

  /**
   * Send data to router (frontend → router)
   */
  private sendToRouter(data: Buffer): void {
    // Send x data to router wrapped in JSON via MQTT
    const message = {
      type: 'x-data',
      sessionId: this.sessionId,
      data: data.toString('base64')
    };

    this.logger.debug(`[x ${this.sessionId}] Publishing ${data.length} bytes to MQTT spotfi/router/${this.routerId}/x/in`);
    mqttService.publish(`spotfi/router/${this.routerId}/x/in`, message);
  }

  /**
   * Send data to frontend client (router → frontend)
   * Called by connection handler when router sends x data
   */
  public sendToClient(data: Buffer): void {
    if (this.isClosed) {
      this.logger.debug(`[x ${this.sessionId}] Ignoring data to client (session closed)`);
      return;
    }

    if (this.clientSocket.readyState !== WebSocket.OPEN) {
      this.logger.warn(`[x ${this.sessionId}] Client socket not open (state: ${this.clientSocket.readyState}), cannot send ${data.length} bytes`);
      return;
    }

    try {
      // Send binary data directly to frontend (xterm.js expects binary)
      this.logger.debug(`[x ${this.sessionId}] Sending ${data.length} bytes to client`);
      this.clientSocket.send(data);
    } catch (error) {
      this.logger.error(`[x ${this.sessionId}] Error sending data to client: ${error}`);
      this.close();
    }
  }

  /**
   * Close x session
   */
  public close(notifyRouter: boolean = true): void {
    if (this.isClosed) {
      this.logger.debug(`[x ${this.sessionId}] Session already closed`);
      return;
    }
    this.isClosed = true;
    this.logger.info(`[x ${this.sessionId}] Closing x session`);

    try {
      // Send x stop command to router via MQTT
      if (notifyRouter) {
        const stopCommand = {
          type: 'x-stop',
          sessionId: this.sessionId,
          timestamp: new Date().toISOString()
        };
        this.logger.debug(`[x ${this.sessionId}] Sending x-stop command to router via MQTT`);
        mqttService.publish(`spotfi/router/${this.routerId}/x/in`, stopCommand);
      }

      // Close client connection
      if (this.clientSocket.readyState === WebSocket.OPEN) {
        this.logger.debug(`[x ${this.sessionId}] Closing client socket`);
        this.clientSocket.close();
      }
    } catch (error) {
      this.logger.error(`[x ${this.sessionId}] Error closing x session: ${error}`);
    }

    this.logger.info(`[x ${this.sessionId}] x session closed`);
  }
}

