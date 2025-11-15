import { WebSocket } from 'ws';
import { FastifyBaseLogger } from 'fastify';
import { activeConnections } from './server.js';
import { prisma } from '../lib/prisma.js';

/**
 * SSH Tunnel Session Manager
 * Manages SSH sessions between frontend clients and routers
 */
export class SshTunnelManager {
  private static sessions = new Map<string, SshTunnelSession>();
  private static readonly SESSION_TIMEOUT = 3600000; // 1 hour

  /**
   * Ping router to verify it's responsive before creating SSH session
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
   * Create a new SSH tunnel session
   */
  static async createSession(
    routerId: string,
    clientSocket: WebSocket,
    userId: string,
    logger: FastifyBaseLogger
  ): Promise<SshTunnelSession> {
    // Check if router is online
    const routerSocket = activeConnections.get(routerId);
    if (!routerSocket || routerSocket.readyState !== WebSocket.OPEN) {
      throw new Error('Router is offline');
    }

    // Ping router to verify it's responsive
    logger.info(`[SSH] Pinging router ${routerId} before SSH session creation...`);
    const pingStartTime = Date.now();
    const isResponsive = await this.pingRouter(routerSocket, routerId, 3000);
    const pingDuration = Date.now() - pingStartTime;
    
    if (!isResponsive) {
      logger.warn(`[SSH] Router ${routerId} did not respond to ping after ${pingDuration}ms, rejecting SSH connection`);
      throw new Error('Router is not responding');
    }

    logger.info(`[SSH] Router ${routerId} is responsive (ping: ${pingDuration}ms), proceeding with SSH session creation`);

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
    const session = new SshTunnelSession(
      sessionId,
      routerId,
      clientSocket,
      routerSocket,
      userId,
      logger
    );

    this.sessions.set(sessionId, session);
    logger.debug(`[SSH] Active sessions: ${this.sessions.size}`);

    // Cleanup on timeout
    setTimeout(() => {
      if (this.sessions.has(sessionId)) {
        logger.info(`[SSH] SSH session ${sessionId} timed out after ${this.SESSION_TIMEOUT / 1000}s`);
        session.close();
      }
    }, this.SESSION_TIMEOUT);

    logger.info(`[SSH] SSH tunnel session created: ${sessionId} for router ${routerId}`);
    return session;
  }

  /**
   * Get session by ID
   */
  static getSession(sessionId: string): SshTunnelSession | undefined {
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
  static getRouterSessions(routerId: string): SshTunnelSession[] {
    return Array.from(this.sessions.values()).filter(
      session => session.routerId === routerId
    );
  }
}

/**
 * SSH Tunnel Session
 * Manages bidirectional data flow between frontend and router
 */
export class SshTunnelSession {
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
    this.startSshSession();
  }

  /**
   * Setup handlers for frontend client WebSocket
   */
  private setupClientHandlers(): void {
    // Forward data from frontend to router
    this.clientSocket.on('message', (data: Buffer | string) => {
      if (this.isClosed) {
        this.logger.debug(`[SSH ${this.sessionId}] Ignoring message from client (session closed)`);
        return;
      }

      try {
        // Convert to Buffer if string (shouldn't happen with xterm.js, but be safe)
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
        this.logger.debug(`[SSH ${this.sessionId}] Received ${buffer.length} bytes from client, forwarding to router`);
        // Send SSH data to router
        this.sendToRouter(buffer);
      } catch (error) {
        this.logger.error(`[SSH ${this.sessionId}] Error forwarding client data: ${error}`);
        this.close();
      }
    });

    // Handle client disconnect
    this.clientSocket.on('close', () => {
      this.logger.info(`SSH client disconnected: ${this.sessionId}`);
      this.close();
    });

    this.clientSocket.on('error', (error) => {
      this.logger.error(`SSH client error: ${error}`);
      this.close();
    });
  }

  /**
   * Start SSH session on router
   */
  private startSshSession(): void {
    try {
      // Send SSH session start command to router
      const startCommand = {
        type: 'ssh-start',
        sessionId: this.sessionId,
        timestamp: new Date().toISOString()
      };

      const commandStr = JSON.stringify(startCommand);
      this.logger.info(`[SSH ${this.sessionId}] Sending ssh-start command to router`);
      this.logger.debug(`[SSH ${this.sessionId}] Start command: ${commandStr}`);
      this.routerSocket.send(commandStr);
    } catch (error) {
      this.logger.error(`[SSH ${this.sessionId}] Error starting SSH session: ${error}`);
      this.close();
    }
  }

  /**
   * Send data to router (frontend → router)
   */
  private sendToRouter(data: Buffer): void {
    if (this.routerSocket.readyState !== WebSocket.OPEN) {
      this.logger.warn(`[SSH ${this.sessionId}] Router socket not open (state: ${this.routerSocket.readyState})`);
      throw new Error('Router socket not open');
    }

    // Send SSH data to router wrapped in JSON for routing
    const message = {
      type: 'ssh-data',
      sessionId: this.sessionId,
      data: data.toString('base64') // Base64 encode binary data
    };

    const messageStr = JSON.stringify(message);
    this.logger.debug(`[SSH ${this.sessionId}] Sending ${data.length} bytes to router (encoded: ${messageStr.length} chars)`);
    this.routerSocket.send(messageStr);
  }

  /**
   * Send data to frontend client (router → frontend)
   * Called by connection handler when router sends SSH data
   */
  public sendToClient(data: Buffer): void {
    if (this.isClosed) {
      this.logger.debug(`[SSH ${this.sessionId}] Ignoring data to client (session closed)`);
      return;
    }

    if (this.clientSocket.readyState !== WebSocket.OPEN) {
      this.logger.warn(`[SSH ${this.sessionId}] Client socket not open (state: ${this.clientSocket.readyState}), cannot send ${data.length} bytes`);
      return;
    }

    try {
      // Send binary data directly to frontend (xterm.js expects binary)
      this.logger.debug(`[SSH ${this.sessionId}] Sending ${data.length} bytes to client`);
      this.clientSocket.send(data);
    } catch (error) {
      this.logger.error(`[SSH ${this.sessionId}] Error sending data to client: ${error}`);
      this.close();
    }
  }

  /**
   * Close SSH session
   */
  public close(): void {
    if (this.isClosed) {
      this.logger.debug(`[SSH ${this.sessionId}] Session already closed`);
      return;
    }
    this.isClosed = true;
    this.logger.info(`[SSH ${this.sessionId}] Closing SSH session`);

    try {
      // Send SSH stop command to router
      if (this.routerSocket.readyState === WebSocket.OPEN) {
        const stopCommand = {
          type: 'ssh-stop',
          sessionId: this.sessionId,
          timestamp: new Date().toISOString()
        };
        this.logger.debug(`[SSH ${this.sessionId}] Sending ssh-stop command to router`);
        this.routerSocket.send(JSON.stringify(stopCommand));
      } else {
        this.logger.debug(`[SSH ${this.sessionId}] Router socket not open, skipping ssh-stop`);
      }

      // Close client connection
      if (this.clientSocket.readyState === WebSocket.OPEN) {
        this.logger.debug(`[SSH ${this.sessionId}] Closing client socket`);
        this.clientSocket.close();
      } else {
        this.logger.debug(`[SSH ${this.sessionId}] Client socket already closed (state: ${this.clientSocket.readyState})`);
      }
    } catch (error) {
      this.logger.error(`[SSH ${this.sessionId}] Error closing SSH session: ${error}`);
    }

    this.logger.info(`[SSH ${this.sessionId}] SSH session closed`);
  }
}

