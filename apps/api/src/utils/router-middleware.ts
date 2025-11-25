import { FastifyRequest, FastifyReply } from 'fastify';
import { AuthenticatedRequest, AuthenticatedUser } from '../types/fastify.js';

/**
 * Require admin role middleware (Fastify preHandler hook)
 */
export function requireAdmin(request: FastifyRequest, reply: FastifyReply, done: Function) {
  const user = request.user as AuthenticatedUser | undefined;
  if (!user) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }
  
  if (user.role !== 'ADMIN') {
    reply.code(403).send({ error: 'Admin access required' });
    return;
  }
  done();
}

/**
 * Type guard to ensure request.user is set (for use after authentication)
 */
export function assertAuthenticated(request: FastifyRequest): asserts request is AuthenticatedRequest {
  if (!request.user) {
    throw new Error('Request is not authenticated');
  }
}

