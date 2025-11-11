import { WebSocket } from 'ws';
import { FastifyBaseLogger } from 'fastify';
import { randomBytes } from 'crypto';
import { NasService } from '../services/nas.js';
import { prisma } from '../lib/prisma.js';

export class RouterConnectionHandler {
  private routerId: string;
  private socket: WebSocket;
  private logger: FastifyBaseLogger;
  private nasService: NasService;

  constructor(
    routerId: string,
    socket: WebSocket,
    logger: FastifyBaseLogger
  ) {
    this.routerId = routerId;
    this.socket = socket;
    this.logger = logger;
    this.nasService = new NasService(logger);
  }

  async initialize(clientIp: string): Promise<void> {
    const router = await prisma.router.findUnique({
      where: { id: this.routerId },
      select: { nasipaddress: true, name: true, radiusSecret: true }
    });

    if (!router) {
      throw new Error('Router not found');
    }

    const ipChanged = router.nasipaddress && router.nasipaddress !== clientIp;

    // Update router status and IP
    await prisma.router.update({
      where: { id: this.routerId },
      data: {
        status: 'ONLINE',
        lastSeen: new Date(),
        nasipaddress: clientIp,
        ...(!router.radiusSecret && { 
          radiusSecret: randomBytes(16).toString('hex') 
        })
      }
    });

    // Get updated router info (with generated secret if needed)
    const updatedRouter = await prisma.router.findUnique({
      where: { id: this.routerId },
      select: { name: true, radiusSecret: true }
    });

    if (!updatedRouter || !updatedRouter.radiusSecret) {
      throw new Error('Router configuration incomplete');
    }

    // Handle NAS entries
    if (ipChanged && router.nasipaddress) {
      await this.nasService.handleIpChange(
        router.nasipaddress,
        clientIp,
        { id: this.routerId, name: updatedRouter.name, radiusSecret: updatedRouter.radiusSecret }
      );
    } else {
      await this.nasService.upsertNasEntry({
        id: this.routerId,
        name: updatedRouter.name,
        nasipaddress: clientIp,
        radiusSecret: updatedRouter.radiusSecret
      });
    }

    this.logger.info(`Router ${this.routerId} connected from ${clientIp}`);
  }

  setupMessageHandlers(): void {
    this.socket.on('message', async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        
        switch (message.type) {
          case 'ping':
            this.socket.send(JSON.stringify({
              type: 'pong',
              timestamp: new Date().toISOString()
            }));
            break;

          case 'metrics':
            await this.handleMetrics(message.metrics);
            break;

          default:
            this.logger.warn(`Unknown message type: ${message.type}`);
        }
      } catch (error) {
        this.logger.error(`Message handling error: ${error}`);
      }
    });

    this.socket.on('close', async () => {
      await prisma.router.update({
        where: { id: this.routerId },
        data: { status: 'OFFLINE' }
      }).catch(err => this.logger.error(`Failed to mark router offline: ${err}`));
      
      this.logger.info(`Router ${this.routerId} disconnected`);
    });

    this.socket.on('error', (error: Error) => {
      this.logger.error(`Router ${this.routerId} socket error: ${error.message}`);
    });
  }

  private async handleMetrics(metrics: any): Promise<void> {
    await prisma.router.update({
      where: { id: this.routerId },
      data: {
        lastSeen: new Date(),
        status: 'ONLINE'
      }
    });
  }

  sendWelcome(): void {
    this.socket.send(JSON.stringify({
      type: 'connected',
      routerId: this.routerId,
      timestamp: new Date().toISOString()
    }));
  }
}

