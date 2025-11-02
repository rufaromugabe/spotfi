import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { getHostInvoices, markInvoicePaid } from '../services/billing.js';
import { requireAdmin } from '../utils/auth.js';

const prisma = new PrismaClient();

export async function invoiceRoutes(fastify: FastifyInstance) {
  // Get all invoices (earnings/payments due) for current user
  fastify.get(
    '/api/invoices',
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ['invoices'],
        summary: 'List all invoices',
        description: 'Get all payment invoices (earnings) for the authenticated host user',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              invoices: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    amount: { type: 'number' },
                    usage: { type: 'number' },
                    status: { type: 'string' },
                    period: { type: 'string', format: 'date-time' },
                    createdAt: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user as any;

      // Admins can see all invoices, hosts can only see their own earnings
      if (user.role === 'ADMIN') {
        const invoices = await prisma.invoice.findMany({
          include: {
            router: {
              select: {
                id: true,
                name: true,
              },
            },
            host: {
              select: {
                id: true,
                email: true,
              },
            },
          },
          orderBy: { period: 'desc' },
        });
        return { invoices };
      }

      const invoices = await getHostInvoices(user.userId);
      return { invoices };
    }
  );

  // Get single invoice (earnings/payment due)
  fastify.get(
    '/api/invoices/:id',
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ['invoices'],
        summary: 'Get invoice details',
        description: 'Get detailed information about a specific payment invoice (earning)',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              invoice: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  amount: { type: 'number' },
                  usage: { type: 'number' },
                  status: { type: 'string' },
                  period: { type: 'string', format: 'date-time' },
                  paidAt: { type: 'string', format: 'date-time', nullable: true },
                },
              },
            },
          },
          404: {
            type: 'object',
            properties: {
              error: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user as any;
      const { id } = request.params as { id: string };

      // Admins can view any invoice, hosts can only view their own
      const whereClause = user.role === 'ADMIN'
        ? { id }
        : { id, hostId: user.userId };

      const invoice = await prisma.invoice.findFirst({
        where: whereClause,
        include: {
          router: {
            select: {
              id: true,
              name: true,
              location: true,
            },
          },
          host: {
            select: {
              id: true,
              email: true,
            },
          },
        },
      });

      if (!invoice) {
        return reply.code(404).send({ error: 'Invoice not found' });
      }

      return { invoice };
    }
  );

  // Mark invoice as paid (Admin only - platform processes payment to host)
  fastify.post(
    '/api/invoices/:id/pay',
    {
      preHandler: [fastify.authenticate, requireAdmin],
      schema: {
        tags: ['invoices'],
        summary: 'Mark invoice as paid',
        description: 'Mark an invoice as paid when platform has processed payment to host (Admin only)',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              invoice: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  status: { type: 'string' },
                  paidAt: { type: 'string', format: 'date-time' },
                },
              },
              message: { type: 'string' },
            },
          },
          400: {
            type: 'object',
            properties: {
              error: { type: 'string' },
            },
          },
          404: {
            type: 'object',
            properties: {
              error: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      try {
        const invoice = await markInvoicePaid(id);
        return { invoice, message: 'Invoice marked as paid - payment processed to host' };
      } catch (error: any) {
        if (error.message === 'Invoice not found') {
          return reply.code(404).send({ error: error.message });
        }
        return reply.code(400).send({ error: error.message });
      }
    }
  );
}

