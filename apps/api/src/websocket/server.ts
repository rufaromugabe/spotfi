import { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { RouterConnectionHandler } from './connection-handler.js';
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
  });
}
