import { FastifyBaseLogger } from 'fastify';
import { prisma } from '../lib/prisma.js';

/**
 * NAS (Network Access Server) management for FreeRADIUS.
 * Uses master secret from RADIUS_MASTER_SECRET env for all NAS entries.
 */
export class NasService {
  private logger: FastifyBaseLogger;

  constructor(logger: FastifyBaseLogger) {
    this.logger = logger;
  }

  private getMasterSecret(): string {
    const secret = process.env.RADIUS_MASTER_SECRET;
    if (!secret) {
      throw new Error('RADIUS_MASTER_SECRET not configured');
    }
    return secret;
  }

  async upsertNasEntry(router: { id: string; name: string; nasipaddress: string }): Promise<void> {
    const secret = this.getMasterSecret();
    
    try {
      await prisma.nas.upsert({
        where: { nasName: router.nasipaddress },
        update: {
          shortName: `rtr-${router.id.substring(0, 8)}`,
          secret,
          description: `${router.name} (Auto-managed)`,
          type: 'other'
        },
        create: {
          nasName: router.nasipaddress,
          shortName: `rtr-${router.id.substring(0, 8)}`,
          type: 'other',
          secret,
          description: `${router.name} (Auto-managed)`
        }
      });
      this.logger.info(`NAS entry synced for router ${router.id} at ${router.nasipaddress}`);
    } catch (error) {
      this.logger.error(`Failed to upsert NAS entry: ${error}`);
      throw error;
    }
  }

  async removeNasEntry(nasipaddress: string, routerId: string): Promise<void> {
    try {
      await prisma.nas.deleteMany({
        where: {
          nasName: nasipaddress,
          shortName: { contains: routerId.substring(0, 8) }
        }
      });
      this.logger.info(`NAS entry removed for ${nasipaddress}`);
    } catch (error) {
      this.logger.warn(`Failed to remove NAS entry: ${error}`);
    }
  }

  async handleIpChange(oldIp: string, newIp: string, router: { id: string; name: string }): Promise<void> {
    await this.removeNasEntry(oldIp, router.id);
    await this.upsertNasEntry({ ...router, nasipaddress: newIp });
    this.logger.info(`Router ${router.id} IP changed: ${oldIp} → ${newIp}`);
  }
}
