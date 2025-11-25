import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AuthenticatedUser } from '../types/fastify.js';
import { routerRpcService } from '../services/router-rpc.service.js';
import { routerAccessService } from '../services/router-access.service.js';
import { assertAuthenticated, requireAdmin } from '../utils/router-middleware.js';

export async function routerConfigRoutes(fastify: FastifyInstance) {
  // Read UCI configuration
  fastify.post('/api/routers/:id/uci/read', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['router-management'],
      summary: 'Read UCI configuration',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['config'],
        properties: {
          config: { type: 'string', description: 'Config name (e.g., network, wireless, system)' },
          section: { type: 'string', description: 'Optional section name' }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertAuthenticated(request);
    const { id } = request.params as { id: string };
    const body = request.body as { config: string; section?: string };

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      // Use ubus uci call
      const args: any = { config: body.config };
      if (body.section) {
        args.section = body.section;
      }
      const result = await routerRpcService.rpcCall(id, 'uci', 'get', args);
      return { routerId: id, config: body.config, data: result.result || result };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(503).send({ error: errorMessage });
    }
  });

  // Update UCI configuration (Admin only)
  fastify.post('/api/routers/:id/uci/set', {
    preHandler: [fastify.authenticate, requireAdmin],
    schema: {
      tags: ['router-management'],
      summary: 'Update UCI configuration',
      security: [{ bearerAuth: [] }],
      description: 'Admin only - Update UCI configuration values',
      body: {
        type: 'object',
        required: ['config', 'section', 'option', 'value'],
        properties: {
          config: { type: 'string' },
          section: { type: 'string' },
          option: { type: 'string' },
          value: { type: 'string' },
          commit: { type: 'boolean', default: false, description: 'Commit changes immediately' }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertAuthenticated(request);
    const { id } = request.params as { id: string };
    const body = request.body as { config: string; section: string; option: string; value: string; commit?: boolean };

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      // Use ubus uci call
      const result = await routerRpcService.rpcCall(id, 'uci', 'set', {
        config: body.config,
        section: body.section,
        option: body.option,
        value: body.value
      });

      if (body.commit) {
        await routerRpcService.rpcCall(id, 'uci', 'commit', { config: body.config });
      }

      return { routerId: id, success: true, result: result.result || result };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(503).send({ error: errorMessage });
    }
  });

  // Commit UCI changes (Admin only)
  fastify.post('/api/routers/:id/uci/commit', {
    preHandler: [fastify.authenticate, requireAdmin],
    schema: {
      tags: ['router-management'],
      summary: 'Commit UCI configuration changes',
      security: [{ bearerAuth: [] }],
      description: 'Admin only - Commit pending UCI configuration changes',
      body: {
        type: 'object',
        properties: {
          config: { type: 'string', description: 'Optional config name to commit specific config' }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertAuthenticated(request);
    const { id } = request.params as { id: string };
    const body = request.body as { config?: string };

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const result = await routerRpcService.rpcCall(id, 'uci', 'commit', { config: body.config });
      return { routerId: id, success: true, result: result.result || result };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(503).send({ error: errorMessage });
    }
  });
}

