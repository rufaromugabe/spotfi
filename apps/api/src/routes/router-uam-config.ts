import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AuthenticatedUser } from '../types/fastify.js';
import { routerRpcService } from '../services/router-rpc.service.js';
import { routerAccessService } from '../services/router-access.service.js';
import { UspotSetupService } from '../services/uspot-setup.service.js';
import { assertAuthenticated, requireAdmin } from '../utils/router-middleware.js';

export async function routerUamConfigRoutes(fastify: FastifyInstance) {
  // Full uSpot setup endpoint - installs packages and configures everything
  fastify.post('/api/routers/:id/uspot/setup', {
    preHandler: [fastify.authenticate, requireAdmin],
    schema: {
      tags: ['router-management'],
      summary: 'Complete uSpot setup (packages, network, firewall, portal)',
      security: [{ bearerAuth: [] }],
      description: 'Admin only - Installs uSpot packages and configures network, firewall, and portal remotely',
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertAuthenticated(request);
    const { id } = request.params as { id: string };

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const setupService = new UspotSetupService(fastify.log);
      const result = await setupService.setup(id);

      if (!result.success) {
        return reply.code(503).send({
          routerId: id,
          success: false,
          message: result.message,
          results: result
        });
      }

      return {
        routerId: id,
        success: true,
        message: result.message,
        results: result
      };

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      fastify.log.error(`[uSpot Setup] Failed: ${errorMessage}`);
      return reply.code(503).send({ error: errorMessage });
    }
  });

  fastify.post('/api/routers/:id/uam/configure', {
    preHandler: [fastify.authenticate, requireAdmin],
    schema: {
      tags: ['router-management'],
      summary: 'Configure UAM server and RADIUS settings',
      security: [{ bearerAuth: [] }],
      description: 'Admin only - Configure UAM server URL, UAM secret, and RADIUS server settings',
      body: {
        type: 'object',
        required: ['uamServerUrl', 'radiusServer', 'radiusSecret'],
        properties: {
          uamServerUrl: { type: 'string', description: 'Full UAM server URL (e.g., https://api.spotfi.com/uam/login)' },
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
      uamServerUrl: string;
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
      // Check if uspot config exists and has an instance
      let instanceExists = false;
      let configExists = false;
      
      try {
        const uspotConfig = await routerRpcService.rpcCall(id, 'uci', 'get', { config: 'uspot' });
        configExists = true;
        instanceExists = !!(uspotConfig?.['@instance[0]'] || uspotConfig?.values?.['@instance[0]']);
      } catch {
        // Config doesn't exist yet
      }

      // Create config file if it doesn't exist
      if (!configExists) {
        try {
          await routerRpcService.rpcCall(id, 'file', 'exec', {
            command: 'sh',
            params: ['-c', 'touch /etc/config/uspot']
          });
        } catch (e: any) {
          throw new Error(`Failed to create uspot config: ${e.message}`);
        }
      }

      // Create instance if it doesn't exist
      if (!instanceExists) {
        try {
          await routerRpcService.rpcCall(id, 'uci', 'add', { config: 'uspot', type: 'instance' });
          await routerRpcService.rpcCall(id, 'uci', 'set', { config: 'uspot', section: '@instance[-1]', option: 'enabled', value: '1' });
          await routerRpcService.rpcCall(id, 'uci', 'set', { config: 'uspot', section: '@instance[-1]', option: 'interface', value: 'hotspot' });
        } catch (e: any) {
          throw new Error(`Failed to create uspot instance: ${e.message}`);
        }
      }

      const changes: Array<{ config: string; section: string; option: string; value: string }> = [];

      // Set portal URL
      changes.push({ config: 'uspot', section: '@instance[0]', option: 'portal_url', value: body.uamServerUrl });
      
      // Set RADIUS auth server (strip port if included, as uspot uses separate port config)
      const radiusHost = body.radiusServer.split(':')[0];
      const radiusPort = body.radiusServer.split(':')[1] || '1812';
      changes.push({ config: 'uspot', section: '@instance[0]', option: 'radius_auth_server', value: radiusHost });
      changes.push({ config: 'uspot', section: '@instance[0]', option: 'radius_auth_port', value: radiusPort });
      
      // Set RADIUS secret
      changes.push({ config: 'uspot', section: '@instance[0]', option: 'radius_secret', value: body.radiusSecret });

      // Set accounting server if provided
      if (body.radiusServer2) {
        const acctHost = body.radiusServer2.split(':')[0];
        const acctPort = body.radiusServer2.split(':')[1] || '1813';
        changes.push({ config: 'uspot', section: '@instance[0]', option: 'radius_acct_server', value: acctHost });
        changes.push({ config: 'uspot', section: '@instance[0]', option: 'radius_acct_port', value: acctPort });
      }

      for (const change of changes) {
        await routerRpcService.rpcCall(id, 'uci', 'set', change);
      }

      await routerRpcService.rpcCall(id, 'uci', 'commit', { config: 'uspot' });

      if (body.restartUspot) {
        await routerRpcService.rpcCall(id, 'service', 'restart', { name: 'uspot' });
      }

      // Extract base URL from UAM server URL for RFC8908 API endpoint
      const uamUrlObj = new URL(body.uamServerUrl);
      const dhcpApiUrl = `${uamUrlObj.origin}/api`;
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
        // DHCP captive section doesn't exist, skip Option 114
      }

      return {
        routerId: id,
        success: true,
        message: 'UAM and RADIUS configuration updated',
        config: {
          portalUrl: body.uamServerUrl,
          radiusServer: body.radiusServer,
          radiusServer2: body.radiusServer2
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
          radiusSecret: instance.radius_secret || instance['radius_secret'] ? '***' : undefined
        }
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(503).send({ error: errorMessage });
    }
  });
}

