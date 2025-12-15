import { FastifyBaseLogger } from 'fastify';
import { prisma } from '../lib/prisma.js';

/**
 * NAS (Network Access Server) management service
 * Handles automatic RADIUS NAS entry creation/updates
 * 
 * DUAL SECRET ARCHITECTURE:
 * - Master Secret (from ENV): Used for RADIUS auth (NAS entries in FreeRADIUS)
 * - Unique UAM Secret (from DB): Used for portal/CHAP (NOT used here)
 * 
 * All NAS entries share the same master secret for FreeRADIUS communication.
 */
export class NasService {
  private logger: FastifyBaseLogger;

  constructor(logger: FastifyBaseLogger) {
    this.logger = logger;
  }

  /**
   * Get the master RADIUS secret from environment
   * This is used for all RADIUS communication (NAS entries)
   */
  private getMasterSecret(): string {
    const masterSecret = process.env.RADIUS_MASTER_SECRET;
    if (!masterSecret) {
      this.logger.error('CRITICAL: RADIUS_MASTER_SECRET not set in environment');
      throw new Error('Server misconfiguration: RADIUS_MASTER_SECRET not configured');
    }
    return masterSecret;
  }

  /**
   * Create or update NAS entry for router
   * Called when router connects via WebSocket
   * 
   * Uses MASTER secret from ENV for all NAS entries (FreeRADIUS communication)
   */
  async upsertNasEntry(router: {
    id: string;
    name: string;
    nasipaddress: string;
  }): Promise<void> {
    const masterSecret = this.getMasterSecret();
    
    try {
      await prisma.nas.upsert({
        where: { nasName: router.nasipaddress },
        update: {
          shortName: `rtr-${router.id.substring(0, 8)}`,
          secret: masterSecret, // SECURITY: Use master secret for RADIUS
          description: `${router.name} (Auto-managed)`,
          type: 'other'
        },
        create: {
          nasName: router.nasipaddress,
          shortName: `rtr-${router.id.substring(0, 8)}`,
          type: 'other',
          secret: masterSecret, // SECURITY: Use master secret for RADIUS
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
   * Uses MASTER secret from ENV (not per-router secret)
   */
  async handleIpChange(
    oldIp: string,
    newIp: string,
    router: { id: string; name: string }
  ): Promise<void> {
    await this.removeNasEntry(oldIp, router.id);
    await this.upsertNasEntry({
      id: router.id,
      name: router.name,
      nasipaddress: newIp
    });
    
    this.logger.info(`Router ${router.id} IP changed: ${oldIp} → ${newIp}`);
  }
}

