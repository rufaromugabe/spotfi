import { FastifyRequest, FastifyReply } from 'fastify';

// User type definition
export interface AuthenticatedUser {
  userId: string;
  email: string;
  role: 'ADMIN' | 'HOST';
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }

  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

// Type guard for authenticated requests
export interface AuthenticatedRequest extends FastifyRequest {
  user: AuthenticatedUser;
}

// Helper type for routes that require authentication
export type AuthenticatedRouteHandler = (
  request: AuthenticatedRequest,
  reply: FastifyReply
) => Promise<any>;


