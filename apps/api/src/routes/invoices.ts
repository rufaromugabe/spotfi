import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { getHostInvoices, markInvoicePaid } from '../services/billing.js';

const prisma = new PrismaClient();

export async function invoiceRoutes(fastify: FastifyInstance) {
  // Get all invoices for current user
  fastify.get(
    '/api/invoices',
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ['invoices'],
        summary: 'List all invoices',
        description: 'Get all invoices for the authenticated user',
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

      const invoices = await getHostInvoices(user.userId);

      return { invoices };
    }
  );

  // Get single invoice
  fastify.get(
    '/api/invoices/:id',
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ['invoices'],
        summary: 'Get invoice details',
        description: 'Get detailed information about a specific invoice',
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

      const invoice = await prisma.invoice.findFirst({
        where: {
          id,
          hostId: user.userId,
        },
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

  // Mark invoice as paid
  fastify.post(
    '/api/invoices/:id/pay',
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ['invoices'],
        summary: 'Mark invoice as paid',
        description: 'Mark an invoice as paid',
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

      try {
        const invoice = await markInvoicePaid(id, user.userId);
        return { invoice, message: 'Invoice marked as paid' };
      } catch (error: any) {
        return reply.code(404).send({ error: error.message });
      }
    }
  );
}

