import { FastifyInstance, FastifyRequest } from 'fastify';
import { WebSocket } from 'ws';
import { RouterConnectionHandler } from './connection-handler.js';
import { xTunnelManager } from './x-tunnel.js';
import { commandManager } from './command-manager.js';
import { prisma } from '../lib/prisma.js';
import { mqttService } from '../lib/mqtt.js';
export const activeConnections = new Map<string, WebSocket>();

interface RouterQuery {
  id: string;
  token: string;
  name?: string;
}

interface XTunnelQuery {
  routerId: string;
  token?: string;
}

interface DecodedUser {
  userId: string;
  role: string;
  [key: string]: unknown;
}

export function setupWebSocket(fastify: FastifyInstance) {
  fastify.register(async function (fastify: FastifyInstance) {
    fastify.get('/ws', { websocket: true }, async (connection, request: FastifyRequest<{ Querystring: RouterQuery }>) => {
      const url = new URL(request.url!, `http://${request.headers.host}`);
      const routerId = url.searchParams.get('id');
      const token = url.searchParams.get('token');
      const routerName = url.searchParams.get('name'); // Optional router name from setup script
      const macAddress = url.searchParams.get('mac'); // Optional MAC address

      if (!token) {
        connection.close(1008, 'Missing token');
        return;
      }

      // Token-only mode: Look up router by token
      // If routerId is provided, verify it matches the token (legacy mode)
      let router;
      if (routerId) {
        // Legacy mode: verify both ID and token match
        router = await prisma.router.findFirst({
          where: { id: routerId, token }
        });
      } else {
        // Token-only mode: find router by token only
        router = await prisma.router.findFirst({
          where: { token }
        });
      }

      if (!router) {
        connection.close(1008, 'Invalid token');
        return;
      }

      // Update router MAC address if provided and different
      if (macAddress && router.macAddress !== macAddress) {
        await prisma.router.update({
          where: { id: router.id },
          data: { macAddress }
        }).catch((err) => {
          fastify.log.warn(`Failed to update MAC address for router ${router.id}: ${err}`);
        });
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

        // Use router.id from database (supports both legacy and token-only modes)
        const handler = new RouterConnectionHandler(router.id, connection, fastify.log);
        await handler.initialize(clientIp, routerName || undefined);
        handler.setupMessageHandlers();
        handler.sendWelcome();
        activeConnections.set(router.id, connection);

        // Clean up on disconnect
        connection.on('close', () => {
          activeConnections.delete(router.id);
        });

        connection.on('error', () => {
          activeConnections.delete(router.id);
        });
      } catch (error) {
        fastify.log.error(`Connection setup failed: ${error}`);
        connection.close(1011, 'Setup failed');
      }
    });

    // x Tunnel WebSocket endpoint (for frontend clients)
    fastify.get('/x', { websocket: true }, async (connection, request: FastifyRequest<{ Querystring: XTunnelQuery }>) => {
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
        let user: DecodedUser;
        try {
          const decoded = await fastify.jwt.verify<DecodedUser>(token);
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

        // Check if router is online (in active WebSocket connections)
        let routerSocket = activeConnections.get(routerId);

        // If not connected via WS, try to trigger on-demand connection via MQTT
        if (!routerSocket || routerSocket.readyState !== WebSocket.OPEN) {
          fastify.log.info(`[x] Router ${routerId} not connected via WS. Triggering on-demand connection...`);

          // Construct the WebSocket URL for the router to connect to
          // Using the same host/protocol as the current request, but ensuring /ws path
          const wsProtocol = request.protocol === 'https' ? 'wss' : 'ws';
          const wsHost = request.headers.host;
          const targetUrl = `${wsProtocol}://${wsHost}/ws`;

          try {
            // Publish the "connect" command via MQTT
            // We assume we don't need to pass the token here because the router should have it?
            // Or does the router need a token to connect to /ws?
            // The router code checks if token is in query param, if not it appends its own cfg.Token.
            // So we just send the base URL.
            await mqttService.publish(`spotfi/router/${routerId}/shell/connect`, { url: targetUrl });

            // Wait for connection (poll activeConnections)
            let retries = 0;
            const maxRetries = 20; // Wait up to 10 seconds
            const retryInterval = 500;

            while (retries < maxRetries) {
              await new Promise(r => setTimeout(r, retryInterval));
              routerSocket = activeConnections.get(routerId);
              if (routerSocket && routerSocket.readyState === WebSocket.OPEN) {
                fastify.log.info(`[x] Router ${routerId} connected successfully via on-demand trigger.`);
                break;
              }
              retries++;
            }
          } catch (err: any) {
            fastify.log.error(`[x] Failed to trigger on-demand connection: ${err.message}`);
          }
        }

        if (!routerSocket || routerSocket.readyState !== WebSocket.OPEN) {
          connection.close(1011, 'Router is offline or failed to connect');
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
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to create x session';
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
