import { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { RouterConnectionHandler } from './connection-handler.js';
import { SshTunnelManager } from './ssh-tunnel.js';
import { prisma } from '../lib/prisma.js';
export const activeConnections = new Map<string, WebSocket>();

export function setupWebSocket(fastify: FastifyInstance) {
  fastify.register(async function (fastify: FastifyInstance) {
    fastify.get('/ws', { websocket: true }, async (connection, request: any) => {
      const url = new URL(request.url!, `http://${request.headers.host}`);
      const routerId = url.searchParams.get('id');
      const token = url.searchParams.get('token');

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
        const handler = new RouterConnectionHandler(routerId, connection, fastify.log);
        await handler.initialize(clientIp);
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

    // SSH Tunnel WebSocket endpoint (for frontend clients)
    fastify.get('/ssh', { websocket: true }, async (connection, request: any) => {
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
          connection.close(503, 'Router is offline');
          return;
        }

        // Create SSH tunnel session (includes ping verification)
        let session;
        try {
          session = await SshTunnelManager.createSession(
            routerId,
            connection,
            user.userId,
            fastify.log
          );
        } catch (error: any) {
          const errorMessage = error.message || 'Failed to create SSH session';
          fastify.log.error(`SSH session creation failed: ${errorMessage}`);
          
          if (errorMessage.includes('not responding') || errorMessage.includes('offline')) {
            connection.close(503, errorMessage);
          } else {
            connection.close(1011, errorMessage);
          }
          return;
        }

        fastify.log.info(`SSH tunnel established: ${session.sessionId} for router ${routerId} by user ${user.userId}`);

        // Cleanup on disconnect
        connection.on('close', () => {
          SshTunnelManager.closeSession(session.sessionId);
        });

        connection.on('error', (error) => {
          fastify.log.error(`SSH tunnel error: ${error}`);
          SshTunnelManager.closeSession(session.sessionId);
        });
      } catch (error) {
        fastify.log.error(`SSH tunnel setup failed: ${error}`);
        connection.close(1011, 'Setup failed');
      }
    });
  });
}
