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
      const macAddress = url.searchParams.get('mac'); // Optional MAC address parameter

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

          // Extract client IP (may be behind proxy)
          const clientIp = request.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() 
            || request.headers['x-real-ip']?.toString() 
            || request.socket?.remoteAddress 
            || 'unknown';

          // Update router status, NAS IP, and MAC address (if provided)
          prisma.router
            .findUnique({
              where: { id: routerId },
              select: { nasipaddress: true, macAddress: true },
            })
            .then((currentRouter) => {
              const updateData: any = {
                status: 'ONLINE',
                lastSeen: new Date(),
              };

              // Always update nasipaddress when router connects (IP is auto-detected)
              // This ensures IP is set even if router was created without it
              if (clientIp !== 'unknown') {
                if (clientIp !== currentRouter?.nasipaddress) {
                  updateData.nasipaddress = clientIp;
                  if (currentRouter?.nasipaddress) {
                    fastify.log.info(`Router ${routerId} IP changed: ${currentRouter.nasipaddress} → ${clientIp}`);
                  } else {
                    fastify.log.info(`Router ${routerId} IP auto-detected: ${clientIp}`);
                  }
                }
              }

              // Update MAC address if provided (most robust identifier - doesn't change)
              // Normalize MAC address format (remove colons/dashes, uppercase)
              if (macAddress) {
                const normalizedMac = macAddress.replace(/[:-]/g, '').toUpperCase();
                // Format as standard MAC (AA:BB:CC:DD:EE:FF) for consistency
                const formattedMac = normalizedMac.match(/.{2}/g)?.join(':') || normalizedMac;
                
                if (formattedMac !== currentRouter?.macAddress) {
                  updateData.macAddress = formattedMac;
                  fastify.log.info(`Router ${routerId} MAC address ${currentRouter?.macAddress ? 'updated' : 'set'}: ${formattedMac}`);
                }
              }

              return prisma.router.update({
                where: { id: routerId },
                data: updateData,
              });
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
                    const updateData: any = {
                      lastSeen: new Date(),
                      status: 'ONLINE',
                    };
                    
                    // Update MAC address if provided in metrics
                    if (data.metrics.macAddress) {
                      const normalizedMac = data.metrics.macAddress.replace(/[:-]/g, '').toUpperCase();
                      const formattedMac = normalizedMac.match(/.{2}/g)?.join(':') || normalizedMac;
                      updateData.macAddress = formattedMac;
                    }
                    
                    await prisma.router.update({
                      where: { id: routerId },
                      data: updateData,
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

