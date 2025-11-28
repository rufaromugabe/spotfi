import { WebSocket } from 'ws';
import { FastifyBaseLogger } from 'fastify';
import { activeConnections } from './server.js';
import { prisma } from '../lib/prisma.js';

/**
 * x Tunnel Session Manager
 * Manages x sessions between frontend clients and routers
 */
export class xTunnelManager {
  private static sessions = new Map<string, xTunnelSession>();
  private static readonly SESSION_TIMEOUT = 3600000; // 1 hour

  /**
   * Ping router to verify it's responsive before creating x session
   * Uses native WebSocket ping/pong for reliable connectivity check
   */
  private static async pingRouter(
    routerSocket: WebSocket,
    routerId: string,
    timeout: number = 3000
  ): Promise<boolean> {
    return new Promise((resolve) => {
      // Check socket state first
      if (routerSocket.readyState !== WebSocket.OPEN) {
        resolve(false);
        return;
      }

      let responded = false;
      
      // Set timeout
      const timeoutId = setTimeout(() => {
        if (!responded) {
          responded = true;
          routerSocket.removeListener('pong', pongHandler);
          resolve(false);
        }
      }, timeout);

      // Listen for native WebSocket pong response
      const pongHandler = () => {
        if (!responded) {
          responded = true;
          clearTimeout(timeoutId);
          routerSocket.removeListener('pong', pongHandler);
          resolve(true);
        }
      };

      routerSocket.once('pong', pongHandler);

      // Send native WebSocket ping
      try {
        routerSocket.ping();
      } catch (error) {
        if (!responded) {
          responded = true;
          clearTimeout(timeoutId);
          routerSocket.removeListener('pong', pongHandler);
          resolve(false);
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
    // Check if router is online
    const routerSocket = activeConnections.get(routerId);
    if (!routerSocket || routerSocket.readyState !== WebSocket.OPEN) {
      throw new Error('Router is offline');
    }

    // Ping router to verify it's responsive
    logger.info(`[x] Pinging router ${routerId} before x session creation...`);
    const pingStartTime = Date.now();
    const isResponsive = await this.pingRouter(routerSocket, routerId, 3000);
    const pingDuration = Date.now() - pingStartTime;
    
    if (!isResponsive) {
      logger.warn(`[x] Router ${routerId} did not respond to ping after ${pingDuration}ms, rejecting x connection`);
      throw new Error('Router is not responding');
    }

    logger.info(`[x] Router ${routerId} is responsive (ping: ${pingDuration}ms), proceeding with x session creation`);

    // Verify user has access to router
    const router = await prisma.router.findFirst({
      where: { id: routerId },
      select: { hostId: true }
    });

    if (!router) {
      throw new Error('Router not found');
    }

    // Create session
    const sessionId = `${routerId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const session = new xTunnelSession(
      sessionId,
      routerId,
      clientSocket,
      routerSocket,
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

    logger.info(`[x] x tunnel session created: ${sessionId} for router ${routerId}`);
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
  private routerSocket: WebSocket;
  private logger: FastifyBaseLogger;
  private isClosed: boolean = false;

  constructor(
    sessionId: string,
    routerId: string,
    clientSocket: WebSocket,
    routerSocket: WebSocket,
    userId: string,
    logger: FastifyBaseLogger
  ) {
    this.sessionId = sessionId;
    this.routerId = routerId;
    this.userId = userId;
    this.clientSocket = clientSocket;
    this.routerSocket = routerSocket;
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
      // Send x session start command to router
      const startCommand = {
        type: 'x-start',
        sessionId: this.sessionId,
        timestamp: new Date().toISOString()
      };

      const commandStr = JSON.stringify(startCommand);
      this.logger.info(`[x ${this.sessionId}] Sending x-start command to router`);
      this.logger.debug(`[x ${this.sessionId}] Start command: ${commandStr}`);
      this.routerSocket.send(commandStr);
    } catch (error) {
      this.logger.error(`[x ${this.sessionId}] Error starting x session: ${error}`);
      this.close();
    }
  }

  /**
   * Send data to router (frontend → router)
   */
  private sendToRouter(data: Buffer): void {
    if (this.routerSocket.readyState !== WebSocket.OPEN) {
      this.logger.warn(`[x ${this.sessionId}] Router socket not open (state: ${this.routerSocket.readyState})`);
      throw new Error('Router socket not open');
    }

    // Send x data to router wrapped in JSON for routing
    const message = {
      type: 'x-data',
      sessionId: this.sessionId,
      data: data.toString('base64') // Base64 encode binary data
    };

    const messageStr = JSON.stringify(message);
    this.logger.debug(`[x ${this.sessionId}] Sending ${data.length} bytes to router (encoded: ${messageStr.length} chars)`);
    this.routerSocket.send(messageStr);
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
  public close(): void {
    if (this.isClosed) {
      this.logger.debug(`[x ${this.sessionId}] Session already closed`);
      return;
    }
    this.isClosed = true;
    this.logger.info(`[x ${this.sessionId}] Closing x session`);

    try {
      // Send x stop command to router
      if (this.routerSocket.readyState === WebSocket.OPEN) {
        const stopCommand = {
          type: 'x-stop',
          sessionId: this.sessionId,
          timestamp: new Date().toISOString()
        };
        this.logger.debug(`[x ${this.sessionId}] Sending x-stop command to router`);
        this.routerSocket.send(JSON.stringify(stopCommand));
      } else {
        this.logger.debug(`[x ${this.sessionId}] Router socket not open, skipping x-stop`);
      }

      // Close client connection
      if (this.clientSocket.readyState === WebSocket.OPEN) {
        this.logger.debug(`[x ${this.sessionId}] Closing client socket`);
        this.clientSocket.close();
      } else {
        this.logger.debug(`[x ${this.sessionId}] Client socket already closed (state: ${this.clientSocket.readyState})`);
      }
    } catch (error) {
      this.logger.error(`[x ${this.sessionId}] Error closing x session: ${error}`);
    }

    this.logger.info(`[x ${this.sessionId}] x session closed`);
  }
}

