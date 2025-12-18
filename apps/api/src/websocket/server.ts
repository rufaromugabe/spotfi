import { FastifyInstance, FastifyRequest } from 'fastify';
import { WebSocket } from 'ws';
import { xTunnelManager } from './x-tunnel.js';
import { prisma } from '../lib/prisma.js';

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
  // Initialize MQTT-based x-Tunnel Gateway (distributed across API cluster)
  xTunnelManager.init(fastify.log);

  fastify.register(async function (fastify: FastifyInstance) {
    // x-Tunnel WebSocket endpoint (MQTT Gateway)
    // Client connects here, all data flows through MQTT to/from router
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

        // Create x-tunnel session via MQTT Gateway
        // All data is routed through MQTT broker - no direct router connection needed
        let session;
        try {
          fastify.log.debug(`[x] Creating MQTT-based x session for router ${routerId}, user ${user.userId}`);
          session = await xTunnelManager.createSession(
            routerId,
            connection,
            user.userId,
            fastify.log
          );
          fastify.log.info(`[x] MQTT x-tunnel established: ${session.sessionId} for router ${routerId}`);
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to create x session';
          fastify.log.error(`[x] x session creation failed: ${errorMessage}`);
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
