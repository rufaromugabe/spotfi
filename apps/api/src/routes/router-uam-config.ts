import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AuthenticatedUser } from '../types/fastify.js';
import { routerRpcService } from '../services/router-rpc.service.js';
import { routerAccessService } from '../services/router-access.service.js';
import { assertAuthenticated, requireAdmin } from '../utils/router-middleware.js';

export async function routerUamConfigRoutes(fastify: FastifyInstance) {
  fastify.post('/api/routers/:id/uam/configure', {
    preHandler: [fastify.authenticate, requireAdmin],
    schema: {
      tags: ['router-management'],
      summary: 'Configure UAM server and RADIUS settings',
      security: [{ bearerAuth: [] }],
      description: 'Admin only - Configure UAM server URL, UAM secret, and RADIUS server settings',
      body: {
        type: 'object',
        required: ['apiUrl', 'radiusServer', 'radiusSecret'],
        properties: {
          apiUrl: { type: 'string', description: 'Full API URL (e.g., https://api.spotfi.com)' },
          uamServerPath: { type: 'string', default: '/uam/login', description: 'UAM server path' },
          uamSecret: { type: 'string', description: 'UAM secret for authentication' },
          radiusServer: { type: 'string', description: 'RADIUS server IP or hostname' },
          radiusSecret: { type: 'string', description: 'RADIUS secret' },
          radiusServer2: { type: 'string', description: 'Secondary RADIUS server (optional)' },
          restartUspot: { type: 'boolean', default: true, description: 'Restart uspot service after configuration' }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertAuthenticated(request);
    const { id } = request.params as { id: string };
    const body = request.body as {
      apiUrl: string;
      uamServerPath?: string;
      uamSecret?: string;
      radiusServer: string;
      radiusSecret: string;
      radiusServer2?: string;
      restartUspot?: boolean;
    };

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const uamServerPath = body.uamServerPath || '/uam/login';
      const portalUrl = body.uamSecret 
        ? `${body.apiUrl}${uamServerPath}?uamsecret=${body.uamSecret}`
        : `${body.apiUrl}${uamServerPath}`;

      const changes: Array<{ config: string; section: string; option: string; value: string }> = [];

      changes.push(
        { config: 'uspot', section: '@instance[0]', option: 'portal_url', value: portalUrl },
        { config: 'uspot', section: '@instance[0]', option: 'radius_auth_server', value: body.radiusServer },
        { config: 'uspot', section: '@instance[0]', option: 'radius_secret', value: body.radiusSecret }
      );

      if (body.radiusServer2) {
        changes.push({ config: 'uspot', section: '@instance[0]', option: 'radius_acct_server', value: body.radiusServer2 });
      }

      if (body.uamSecret) {
        try {
          await routerRpcService.rpcCall(id, 'uci', 'set', {
            config: 'uspot',
            section: '@instance[0]',
            option: 'uam_secret',
            value: body.uamSecret
          });
          changes.push({ config: 'uspot', section: '@instance[0]', option: 'uam_secret', value: body.uamSecret });
        } catch {
          fastify.log.info(`[UAM Config] uam_secret option not supported, using URL parameter`);
        }
      }

      for (const change of changes) {
        await routerRpcService.rpcCall(id, 'uci', 'set', change);
      }

      await routerRpcService.rpcCall(id, 'uci', 'commit', { config: 'uspot' });

      if (body.restartUspot) {
        await routerRpcService.rpcCall(id, 'service', 'restart', { name: 'uspot' });
      }

      const dhcpApiUrl = `${body.apiUrl}/api`;
      try {
        const dhcpConfig = await routerRpcService.rpcCall(id, 'uci', 'get', { config: 'dhcp', section: 'captive' });
        if (dhcpConfig) {
          await routerRpcService.rpcCall(id, 'uci', 'set', {
            config: 'dhcp',
            section: 'captive',
            option: 'dhcp_option',
            value: `114,${dhcpApiUrl}`
          });
          await routerRpcService.rpcCall(id, 'uci', 'commit', { config: 'dhcp' });
        }
      } catch {
        fastify.log.warn(`[UAM Config] Could not configure DHCP Option 114 (dhcp.captive may not exist)`);
      }

      return {
        routerId: id,
        success: true,
        message: 'UAM and RADIUS configuration updated',
        config: {
          portalUrl,
          radiusServer: body.radiusServer,
          radiusServer2: body.radiusServer2,
          uamSecret: body.uamSecret ? 'configured' : 'not set'
        }
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      fastify.log.error(`[UAM Config] Failed: ${errorMessage}`);
      return reply.code(503).send({ error: errorMessage });
    }
  });

  fastify.get('/api/routers/:id/uam/config', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['router-management'],
      summary: 'Get current UAM and RADIUS configuration',
      security: [{ bearerAuth: [] }]
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertAuthenticated(request);
    const { id } = request.params as { id: string };

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const uspotConfig = await routerRpcService.rpcCall(id, 'uci', 'get', { config: 'uspot' });
      const instance = uspotConfig?.values?.['@instance[0]'] || uspotConfig?.['@instance[0]'] || {};

      return {
        routerId: id,
        config: {
          portalUrl: instance.portal_url || instance['portal_url'],
          radiusServer: instance.radius_auth_server || instance['radius_auth_server'],
          radiusServer2: instance.radius_acct_server || instance['radius_acct_server'],
          radiusSecret: instance.radius_secret || instance['radius_secret'] ? '***' : undefined,
          uamSecret: instance.uam_secret || instance['uam_secret'] ? '***' : undefined
        }
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(503).send({ error: errorMessage });
    }
  });
}

