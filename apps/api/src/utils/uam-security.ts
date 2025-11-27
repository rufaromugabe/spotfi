import { FastifyRequest } from 'fastify';

export function validateUamSecret(request: FastifyRequest, expectedSecret: string): boolean {
  if (!expectedSecret) return true;

  const querySecret = (request.query as any)?.uamsecret;
  const bodySecret = (request.body as any)?.uamsecret;
  const headerSecret = request.headers['x-uam-secret'];

  return querySecret === expectedSecret || 
         bodySecret === expectedSecret || 
         headerSecret === expectedSecret;
}

export function getClientIp(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return ips.split(',')[0].trim();
  }

  const realIp = request.headers['x-real-ip'];
  if (realIp) {
    return Array.isArray(realIp) ? realIp[0] : realIp;
  }

  return request.socket.remoteAddress || '0.0.0.0';
}
