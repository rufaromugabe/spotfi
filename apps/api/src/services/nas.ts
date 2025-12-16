import { FastifyBaseLogger } from 'fastify';
import { prisma } from '../lib/prisma.js';

/**
 * NAS management for FreeRADIUS.
 * Uses wildcard entry (0.0.0.0/0) with master secret for all routers.
 */
export class NasService {
  private logger: FastifyBaseLogger;
  private static readonly WILDCARD_NAS_NAME = '0.0.0.0/0';

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
        where: { nasName: NasService.WILDCARD_NAS_NAME },
        update: {
          secret,
          description: 'Master NAS entry (all routers) - Docker-compatible'
        },
        create: {
          nasName: NasService.WILDCARD_NAS_NAME,
          shortName: 'master',
          type: 'other',
          secret,
          description: 'Master NAS entry (all routers) - Docker-compatible'
        }
      });
      this.logger.info(`NAS entry synced (wildcard) for router ${router.id} at ${router.nasipaddress}`);
    } catch (error) {
      this.logger.error(`Failed to upsert NAS entry: ${error}`);
      throw error;
    }
  }

  async removeNasEntry(nasipaddress: string, routerId: string): Promise<void> {
    this.logger.debug(`Skipping NAS entry removal (wildcard entry is shared): router ${routerId}`);
  }

  async handleIpChange(oldIp: string, newIp: string, router: { id: string; name: string }): Promise<void> {
    await this.upsertNasEntry({ ...router, nasipaddress: newIp });
    this.logger.info(`Router ${router.id} IP changed: ${oldIp} → ${newIp}`);
  }
}
