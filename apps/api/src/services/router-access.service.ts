import { prisma } from '../lib/prisma.js';
import { AuthenticatedUser } from '../types/fastify.js';

/**
 * Router Access Service
 * Handles router access verification and authorization
 */
export class RouterAccessService {
  /**
   * Verify that a user has access to a router
   * - ADMINs can access any router
   * - HOSTs can only access routers they own
   * 
   * @param routerId - The router ID to check
   * @param user - The authenticated user
   * @returns The router if access is granted, null otherwise
   */
  async verifyRouterAccess(routerId: string, user: AuthenticatedUser) {
    const where = user.role === 'ADMIN' 
      ? { id: routerId } 
      : { id: routerId, hostId: user.userId };
    
    const router = await prisma.router.findFirst({ where });
    return router;
  }

  /**
   * Check if a user has access to a router (boolean check)
   * 
   * @param routerId - The router ID to check
   * @param user - The authenticated user
   * @returns true if user has access, false otherwise
   */
  async hasAccess(routerId: string, user: AuthenticatedUser): Promise<boolean> {
    const router = await this.verifyRouterAccess(routerId, user);
    return router !== null;
  }

  /**
   * Verify router access and throw error if denied
   * 
   * @param routerId - The router ID to check
   * @param user - The authenticated user
   * @returns The router if access is granted
   * @throws Error if access is denied
   */
  async requireRouterAccess(routerId: string, user: AuthenticatedUser) {
    const router = await this.verifyRouterAccess(routerId, user);
    if (!router) {
      throw new Error('Router not found or access denied');
    }
    return router;
  }
}

export const routerAccessService = new RouterAccessService();

