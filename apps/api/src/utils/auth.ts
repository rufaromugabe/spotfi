import { FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
) {
  try {
    await request.jwtVerify();
  } catch (err) {
    reply.code(401).send({ error: 'Unauthorized' });
  }
}

export async function requireRole(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedRoles: string[]
) {
  try {
    const user = await request.jwtVerify();
    const userId = (user as any).userId;

    const dbUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    if (!dbUser || !allowedRoles.includes(dbUser.role)) {
      reply.code(403).send({ error: 'Forbidden' });
      return;
    }
  } catch (err) {
    reply.code(401).send({ error: 'Unauthorized' });
  }
}

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply
) {
  return requireRole(request, reply, ['ADMIN']);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

