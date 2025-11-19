import { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { RouterConnectionHandler } from './connection-handler.js';
import { xTunnelManager } from './x-tunnel.js';
import { commandManager } from './command-manager.js';
import { prisma } from '../lib/prisma.js';
export const activeConnections = new Map<string, WebSocket>();

export function setupWebSocket(fastify: FastifyInstance) {
  fastify.register(async function (fastify: FastifyInstance) {
    fastify.get('/ws', { websocket: true }, async (connection, request: any) => {
      const url = new URL(request.url!, `http://${request.headers.host}`);
      const routerId = url.searchParams.get('id');
      const token = url.searchParams.get('token');
      const routerName = url.searchParams.get('name'); // Optional router name from setup script

      if (!routerId || !token) {
        connection.close(1008, 'Missing credentials');
        return;
      }

      // Verify router credentials
      const router = await prisma.router.findFirst({
        where: { id: routerId, token }
      });

      if (!router) {
        connection.close(1008, 'Invalid credentials');
        return;
      }

      // Extract client IP
      const clientIp = 
        request.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() ||
        request.headers['x-real-ip']?.toString() ||
        request.socket?.remoteAddress ||
        'unknown';

      if (clientIp === 'unknown') {
        connection.close(1011, 'Cannot determine IP address');
        return;
      }

      // Handle connection
      try {
        // Initialize command manager logger on first connection
        if (commandManager.getPendingCount() === 0) {
          commandManager.setLogger(fastify.log);
        }
        
        const handler = new RouterConnectionHandler(routerId, connection, fastify.log);
        await handler.initialize(clientIp, routerName || undefined);
        handler.setupMessageHandlers();
        handler.sendWelcome();
        activeConnections.set(routerId, connection);

        // Clean up on disconnect
        connection.on('close', () => {
          activeConnections.delete(routerId);
        });

        connection.on('error', () => {
          activeConnections.delete(routerId);
        });
      } catch (error) {
        fastify.log.error(`Connection setup failed: ${error}`);
        connection.close(1011, 'Setup failed');
      }
    });

    // x Tunnel WebSocket endpoint (for frontend clients)
    fastify.get('/x', { websocket: true }, async (connection, request: any) => {
      try {
        // Extract authentication from query params or Authorization header
        const url = new URL(request.url!, `http://${request.headers.host}`);
        const routerId = url.searchParams.get('routerId');
        
        // Get JWT token from query param or Authorization header
        let token = url.searchParams.get('token');
        if (!token) {
          const authHeader = request.headers.authorization;
          if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.substring(7);
          }
        }

        if (!routerId || !token) {
          connection.close(1008, 'Missing routerId or authentication token');
          return;
        }

        // Verify JWT token (user authentication)
        let user: any;
        try {
          const decoded = await fastify.jwt.verify(token);
          user = decoded;
        } catch (error) {
          connection.close(1008, 'Invalid authentication token');
          return;
        }

        // Verify router exists and user has access
        const where = user.role === 'ADMIN' ? { id: routerId } : { id: routerId, hostId: user.userId };
        const router = await prisma.router.findFirst({ where });

        if (!router) {
          connection.close(1008, 'Router not found or access denied');
          return;
        }

        // Check if router is online
        const routerSocket = activeConnections.get(routerId);
        if (!routerSocket || routerSocket.readyState !== WebSocket.OPEN) {
          connection.close(1011, 'Router is offline');
          return;
        }

        // Create x tunnel session (includes ping verification)
        let session;
        try {
          fastify.log.debug(`[x] Creating x session for router ${routerId}, user ${user.userId}`);
          session = await xTunnelManager.createSession(
            routerId,
            connection,
            user.userId,
            fastify.log
          );
          fastify.log.info(`[x] x tunnel established: ${session.sessionId} for router ${routerId} by user ${user.userId}`);
        } catch (error: any) {
          const errorMessage = error.message || 'Failed to create x session';
          fastify.log.error(`[x] x session creation failed for router ${routerId}: ${errorMessage}`);
          
          // Use valid WebSocket close codes (1000-1015 are standard)
          // 1011 = Internal Error (for router not responding/offline)
          connection.close(1011, errorMessage);
          return;
        }

        // Cleanup on disconnect
        connection.on('close', (code, reason) => {
          fastify.log.info(`[x] Client disconnected: session ${session.sessionId}, code: ${code}, reason: ${reason?.toString() || 'none'}`);
          xTunnelManager.closeSession(session.sessionId);
        });

        connection.on('error', (error) => {
          fastify.log.error(`[x] x tunnel error for session ${session.sessionId}: ${error}`);
          xTunnelManager.closeSession(session.sessionId);
        });
      } catch (error) {
        fastify.log.error(`[x] x tunnel setup failed: ${error}`);
        connection.close(1011, 'Setup failed');
      }
    });
  });
}
