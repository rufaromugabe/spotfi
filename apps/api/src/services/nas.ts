import { FastifyBaseLogger } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { randomBytes } from 'crypto';

/**
 * NAS management for FreeRADIUS.
 * Uses unique per-router secrets and specific IP entries.
 */
export class NasService {
  private logger: FastifyBaseLogger;

  constructor(logger: FastifyBaseLogger) {
    this.logger = logger;
  }

  private generateSecret(): string {
    return randomBytes(16).toString('hex');
  }

  async upsertNasEntry(router: { id: string; name: string; nasipaddress?: string }): Promise<void> {
    // In Docker/NAT environments, multiple routers may share the same public IP.
    // We use the router.id as the primary identifier in the nas table.
    const nasName = router.id;

    try {
      const routerData = await prisma.router.findUnique({ where: { id: router.id } });
      let secret = routerData?.radiusSecret;

      if (!secret) {
        secret = this.generateSecret();
        await prisma.router.update({
          where: { id: router.id },
          data: { radiusSecret: secret }
        });
        this.logger.info(`Generated new RADIUS secret for router ${router.id}`);
      }

      await prisma.nas.upsert({
        where: { nasName },
        update: {
          secret,
          shortName: router.name.substring(0, 30),
          description: `Router ${router.name} (Dynamic ID)`
        },
        create: {
          nasName,
          shortName: router.name.substring(0, 30),
          type: 'other',
          secret,
          description: `Router ${router.name} (Dynamic ID)`
        }
      });
      this.logger.info(`NAS entry synced for router ${router.id}`);
    } catch (error) {
      this.logger.error(`Failed to upsert NAS entry: ${error}`);
      throw error;
    }
  }

  // IP is no longer used for identifying NAS entries
  async removeNasEntry(routerId: string): Promise<void> {
    try {
      await prisma.nas.deleteMany({
        where: { nasName: routerId }
      });
      this.logger.info(`Removed NAS entry for Router ${routerId}`);
    } catch (error) {
      this.logger.debug(`Failed to remove NAS entry: ${error}`);
    }
  }
}
