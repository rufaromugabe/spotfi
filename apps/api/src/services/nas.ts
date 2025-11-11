import { PrismaClient } from '@prisma/client';
import { FastifyBaseLogger } from 'fastify';

const prisma = new PrismaClient();

/**
 * NAS (Network Access Server) management service
 * Handles automatic RADIUS NAS entry creation/updates
 */
export class NasService {
  private logger: FastifyBaseLogger;

  constructor(logger: FastifyBaseLogger) {
    this.logger = logger;
  }

  /**
   * Create or update NAS entry for router
   * Called when router connects via WebSocket
   */
  async upsertNasEntry(router: {
    id: string;
    name: string;
    nasipaddress: string;
    radiusSecret: string;
  }): Promise<void> {
    try {
      await prisma.nas.upsert({
        where: { nasName: router.nasipaddress },
        update: {
          shortName: `rtr-${router.id.substring(0, 8)}`,
          secret: router.radiusSecret,
          description: `${router.name} (Auto-managed)`,
          type: 'other'
        },
        create: {
          nasName: router.nasipaddress,
          shortName: `rtr-${router.id.substring(0, 8)}`,
          type: 'other',
          secret: router.radiusSecret,
          description: `${router.name} (Auto-managed)`
        }
      });

      this.logger.info(`NAS entry synced for router ${router.id} at ${router.nasipaddress}`);
    } catch (error) {
      this.logger.error(`Failed to upsert NAS entry: ${error}`);
      throw error;
    }
  }

  /**
   * Remove NAS entry when router is deleted or IP changes
   */
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

  /**
   * Handle IP change - remove old NAS, create new
   */
  async handleIpChange(
    oldIp: string,
    newIp: string,
    router: { id: string; name: string; radiusSecret: string }
  ): Promise<void> {
    await this.removeNasEntry(oldIp, router.id);
    await this.upsertNasEntry({
      id: router.id,
      name: router.name,
      nasipaddress: newIp,
      radiusSecret: router.radiusSecret
    });
    
    this.logger.info(`Router ${router.id} IP changed: ${oldIp} → ${newIp}`);
  }
}

