import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AuthenticatedUser } from '../types/fastify.js';
import { routerRpcService } from '../services/router-rpc.service.js';
import { routerAccessService } from '../services/router-access.service.js';
import { UspotSetupService } from '../services/uspot-setup.service.js';
import { assertAuthenticated, requireAdmin } from '../utils/router-middleware.js';

export async function routerUamConfigRoutes(fastify: FastifyInstance) {
  // Async uSpot setup endpoint - returns job ID immediately
  fastify.post('/api/routers/:id/uspot/setup/async', {
    preHandler: [fastify.authenticate, requireAdmin],
    schema: {
      tags: ['router-management'],
      summary: 'Start async uSpot setup (recommended for slow connections)',
      security: [{ bearerAuth: [] }],
      description: 'Admin only - Starts setup in background. Use GET /api/routers/:id/uspot/setup/status to check progress.',
      body: {
        type: 'object',
        properties: {
          combinedSSID: { type: 'boolean', description: 'Create combined 2.4GHz and 5GHz wireless network' },
          ssid: { type: 'string', default: 'SpotFi', description: 'SSID for the wireless network' },
          password: { type: 'string', default: 'none', description: 'Password for the wireless network (use "none" for open network)' }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertAuthenticated(request);
    const { id } = request.params as { id: string };
    const body = request.body as { combinedSSID?: boolean, ssid?: string, password?: string } || {};

    if (body.combinedSSID) {
      body.ssid = body.ssid || 'SpotFi';
      body.password = body.password || 'none';
    }

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const setupService = new UspotSetupService(fastify.log);
      const { jobId } = await setupService.setupAsync(id, body);

      return reply.code(202).send({
        routerId: id,
        jobId,
        status: 'pending',
        message: 'Setup started. Poll /api/routers/:id/uspot/setup/status or /api/setup/jobs/:jobId for progress.',
        statusUrl: `/api/routers/${id}/uspot/setup/status`,
        jobUrl: `/api/setup/jobs/${jobId}`
      });

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      fastify.log.error(`[uSpot Setup Async] Failed to start: ${errorMessage}`);
      return reply.code(500).send({ error: errorMessage });
    }
  });

  // Get setup job status by router ID
  fastify.get('/api/routers/:id/uspot/setup/status', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['router-management'],
      summary: 'Get uSpot setup status for a router',
      security: [{ bearerAuth: [] }],
      description: 'Returns the current setup job status for a router (if any)'
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertAuthenticated(request);
    const { id } = request.params as { id: string };

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    const job = UspotSetupService.getJobByRouterId(id);
    if (!job) {
      return reply.code(404).send({ 
        error: 'No setup job found for this router',
        message: 'Start a setup using POST /api/routers/:id/uspot/setup/async'
      });
    }

    return {
      routerId: id,
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      currentStep: job.currentStep,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      result: job.result,
      error: job.error
    };
  });

  // Get setup job status by job ID
  fastify.get('/api/setup/jobs/:jobId', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['router-management'],
      summary: 'Get setup job status by job ID',
      security: [{ bearerAuth: [] }],
      description: 'Returns the current status of a setup job'
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertAuthenticated(request);
    const { jobId } = request.params as { jobId: string };

    const job = UspotSetupService.getJobStatus(jobId);
    if (!job) {
      return reply.code(404).send({ error: 'Setup job not found' });
    }

    // Verify user has access to this router
    const router = await routerAccessService.verifyRouterAccess(job.routerId, request.user as AuthenticatedUser);
    if (!router) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    return {
      routerId: job.routerId,
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      currentStep: job.currentStep,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      result: job.result,
      error: job.error
    };
  });

  // Full uSpot setup endpoint (synchronous) - kept for backward compatibility
  fastify.post('/api/routers/:id/uspot/setup', {
    preHandler: [fastify.authenticate, requireAdmin],
    schema: {
      tags: ['router-management'],
      summary: 'Complete uSpot setup (sync - may timeout on slow connections)',
      security: [{ bearerAuth: [] }],
      description: 'Admin only - Installs uSpot packages and configures network, firewall, and portal remotely. Use /async endpoint for slow connections.',
      body: {
        type: 'object',
        properties: {
          combinedSSID: { type: 'boolean', description: 'Create combined 2.4GHz and 5GHz wireless network' },
          ssid: { type: 'string', default: 'SpotFi', description: 'SSID for the wireless network' },
          password: { type: 'string', default: 'none', description: 'Password for the wireless network (use "none" for open network)' }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertAuthenticated(request);
    const { id } = request.params as { id: string };
    const body = request.body as { combinedSSID?: boolean, ssid?: string, password?: string } || {};

    if (body.combinedSSID) {
      body.ssid = body.ssid || 'SpotFi';
      body.password = body.password || 'none';
    }

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const setupService = new UspotSetupService(fastify.log);
      const result = await setupService.setup(id, body);

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
          restartUspot: { type: 'boolean', default: true, description: 'Restart uspot service after configuration' },
          combinedSSID: { type: 'boolean', default: false, description: 'Create combined 2.4GHz and 5GHz wireless network' },
          ssid: { type: 'string', default: 'SpotFi', description: 'SSID for the wireless network' },
          password: { type: 'string', default: 'none', description: 'Password for the wireless network (use "none" for open network)' }
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
      combinedSSID?: boolean;
      ssid?: string;
      password?: string;
    };

    if (body.combinedSSID) {
      body.ssid = body.ssid || 'SpotFi';
      body.password = body.password || 'none';
    }

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      // If wireless settings are provided, update them
      if (body.combinedSSID) {
        const setupService = new UspotSetupService(fastify.log);
        await setupService.configureWireless(id, {
          combinedSSID: body.combinedSSID,
          ssid: body.ssid,
          password: body.password
        });
      }

      // Check if uspot named section exists, create if needed
      // uspot uses named sections: config uspot 'sectionname' (NOT config instance)
      const sectionName = 'hotspot';
      await routerRpcService.rpcCall(id, 'file', 'exec', {
        command: 'sh',
        params: ['-c', `uci -q show uspot.${sectionName} || (uci set uspot.${sectionName}=uspot && uci set uspot.${sectionName}.enabled=1 && uci set uspot.${sectionName}.interface=${sectionName} && uci set uspot.${sectionName}.setname=uspot_${sectionName} && uci commit uspot)`]
      });

      // Build UCI commands using named section
      const radiusHost = body.radiusServer.split(':')[0];
      const radiusPort = body.radiusServer.split(':')[1] || '1812';
      
      let uciCommands = [
        // Set auth_mode to 'uam' for RADIUS UAM authentication
        `uci set uspot.${sectionName}.auth_mode='uam'`,
        `uci set uspot.${sectionName}.uam_port='3990'`,
        `uci set uspot.${sectionName}.uam_url='${body.uamServerUrl}'`,
        `uci set uspot.${sectionName}.radius_auth_server='${radiusHost}'`,
        `uci set uspot.${sectionName}.radius_auth_port='${radiusPort}'`,
        `uci set uspot.${sectionName}.radius_secret='${body.radiusSecret}'`
      ];

      if (body.radiusServer2) {
        const acctHost = body.radiusServer2.split(':')[0];
        const acctPort = body.radiusServer2.split(':')[1] || '1813';
        uciCommands.push(`uci set uspot.${sectionName}.radius_acct_server='${acctHost}'`);
        uciCommands.push(`uci set uspot.${sectionName}.radius_acct_port='${acctPort}'`);
      }

      uciCommands.push('uci commit uspot');

      // Execute all UCI commands in one shell call
      await routerRpcService.rpcCall(id, 'file', 'exec', {
        command: 'sh',
        params: ['-c', uciCommands.join(' && ')]
      });

      if (body.restartUspot) {
        // Use file.exec for reliable service restart
        await routerRpcService.rpcCall(id, 'file', 'exec', {
          command: 'sh',
          params: ['-c', '/etc/init.d/uspot restart']
        });
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
      const values = uspotConfig?.values || uspotConfig || {};
      
      // Find uspot sections (named sections of type 'uspot')
      // UCI dump returns sections by name (e.g. 'hotspot') or ID (e.g. cfg123456)
      const sectionKey = Object.keys(values).find(key => 
        values[key]['.type'] === 'uspot' || 
        key === 'hotspot' ||
        key === 'captive'
      );
      
      const section = sectionKey ? values[sectionKey] : {};

      return {
        routerId: id,
        config: {
          authMode: section.auth_mode || section['auth_mode'],
          uamUrl: section.uam_url || section['uam_url'],
          uamPort: section.uam_port || section['uam_port'],
          radiusServer: section.radius_auth_server || section['radius_auth_server'],
          radiusServer2: section.radius_acct_server || section['radius_acct_server'],
          radiusSecret: section.radius_secret || section['radius_secret'] ? '***' : undefined,
          interface: section.interface || section['interface'],
          setname: section.setname || section['setname']
        }
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(503).send({ error: errorMessage });
    }
  });
}

