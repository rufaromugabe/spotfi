import { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { PrismaClient } from '@prisma/client';
import { SocketStream } from '@fastify/websocket';

const prisma = new PrismaClient();

// Map of router IDs to WebSocket connections
export const routerWebSocketConnections = new Map<string, WebSocket>();

export function setupWebSocket(fastify: FastifyInstance) {
  fastify.register(async function (fastify: FastifyInstance) {
    fastify.get('/ws', { websocket: true }, (connection: SocketStream, request: any) => {
      const url = new URL(request.url!, `http://${request.headers.host}`);
      const routerId = url.searchParams.get('id');
      const token = url.searchParams.get('token');

      if (!routerId || !token) {
        connection.socket.close(1008, 'Missing router ID or token');
        return;
      }

      // Verify token
      prisma.router
        .findFirst({
          where: {
            id: routerId,
            token,
          },
        })
        .then((router: any) => {
          if (!router) {
            connection.socket.close(1008, 'Invalid router credentials');
            return;
          }

          // Store connection
          routerWebSocketConnections.set(routerId, connection.socket);

          // Update router status
          prisma.router
            .update({
              where: { id: routerId },
              data: {
                status: 'ONLINE',
                lastSeen: new Date(),
              },
            })
            .catch((err) => {
              fastify.log.error(err);
            });

          fastify.log.info(`Router ${routerId} connected via WebSocket`);

          // Handle messages from router
          connection.socket.on('message', async (message: Buffer) => {
            try {
              const data = JSON.parse(message.toString());

              fastify.log.info(`Message from router ${routerId}:`, data);

              // Handle different message types
              switch (data.type) {
                case 'ping':
                  connection.socket.send(
                    JSON.stringify({
                      type: 'pong',
                      timestamp: new Date().toISOString(),
                    })
                  );
                  break;

                case 'metrics':
                  // Update router metrics
                  if (data.metrics) {
                    await prisma.router.update({
                      where: { id: routerId },
                      data: {
                        lastSeen: new Date(),
                        status: 'ONLINE',
                      },
                    });
                  }
                  break;

                case 'command-response':
                  // Handle command response
                  fastify.log.info(`Command response from ${routerId}:`, data);
                  break;

                default:
                  fastify.log.warn(`Unknown message type from router ${routerId}:`, data.type);
              }
            } catch (err) {
              fastify.log.error(`Error processing message from router ${routerId}:`, err);
            }
          });

          // Handle connection close
          connection.socket.on('close', async () => {
            routerWebSocketConnections.delete(routerId);
            fastify.log.info(`Router ${routerId} disconnected`);

            // Update router status
            await prisma.router
              .update({
                where: { id: routerId },
                data: {
                  status: 'OFFLINE',
                },
              })
              .catch((err: Error) => {
                fastify.log.error(err);
              });
          });

          // Handle errors
          connection.socket.on('error', (err: Error) => {
            fastify.log.error(`WebSocket error for router ${routerId}:`, err);
          });

          // Send welcome message
          connection.socket.send(
            JSON.stringify({
              type: 'connected',
              routerId,
              timestamp: new Date().toISOString(),
            })
          );
        })
        .catch((err: Error) => {
          fastify.log.error(`Error verifying router credentials:`, err);
          connection.socket.close(1011, 'Internal server error');
        });
    });
  });
}

