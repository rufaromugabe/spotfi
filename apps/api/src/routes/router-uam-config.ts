import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AuthenticatedUser } from '../types/fastify.js';
import { routerRpcService } from '../services/router-rpc.service.js';
import { routerAccessService } from '../services/router-access.service.js';
import { UspotSetupService } from '../services/uspot-setup.service.js';
import { assertAuthenticated, requireAdmin } from '../utils/router-middleware.js';

export async function routerUamConfigRoutes(fastify: FastifyInstance) {
  // Async uSpot setup
  fastify.post('/api/routers/:id/uspot/setup/async', {
    preHandler: [fastify.authenticate, requireAdmin],
    schema: {
      tags: ['router-management'],
      summary: 'Start async uSpot setup',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          combinedSSID: { type: 'boolean' },
          ssid: { type: 'string', default: 'SpotFi' },
          password: { type: 'string', default: 'none' }
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
    if (!router) return reply.code(404).send({ error: 'Router not found' });

    try {
      const setupService = new UspotSetupService(fastify.log);
      const { jobId } = await setupService.setupAsync(id, body);

      return reply.code(202).send({
        routerId: id,
        jobId,
        status: 'pending',
        message: 'Setup started. Poll status endpoint for progress.',
        statusUrl: `/api/routers/${id}/uspot/setup/status`,
        jobUrl: `/api/setup/jobs/${jobId}`
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      fastify.log.error(`[uSpot Setup] Failed: ${msg}`);
      return reply.code(500).send({ error: msg });
    }
  });

  // Get setup status by router ID
  fastify.get('/api/routers/:id/uspot/setup/status', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['router-management'],
      summary: 'Get uSpot setup status',
      security: [{ bearerAuth: [] }]
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertAuthenticated(request);
    const { id } = request.params as { id: string };

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) return reply.code(404).send({ error: 'Router not found' });

    const job = UspotSetupService.getJobByRouterId(id);
    if (!job) {
      return reply.code(404).send({ error: 'No setup job found' });
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

  // Get setup status by job ID
  fastify.get('/api/setup/jobs/:jobId', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['router-management'],
      summary: 'Get setup job status',
      security: [{ bearerAuth: [] }]
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertAuthenticated(request);
    const { jobId } = request.params as { jobId: string };

    const job = UspotSetupService.getJobStatus(jobId);
    if (!job) return reply.code(404).send({ error: 'Job not found' });

    const router = await routerAccessService.verifyRouterAccess(job.routerId, request.user as AuthenticatedUser);
    if (!router) return reply.code(403).send({ error: 'Access denied' });

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

  // Configure UAM
  fastify.post('/api/routers/:id/uam/configure', {
    preHandler: [fastify.authenticate, requireAdmin],
    schema: {
      tags: ['router-management'],
      summary: 'Configure uspot captive portal',
      security: [{ bearerAuth: [] }],
      description: 'Configure uspot auth mode. RADIUS secret injected from RADIUS_MASTER_SECRET env.',
      body: {
        type: 'object',
        required: ['authMode'],
        properties: {
          authMode: { type: 'string', enum: ['click-to-continue', 'uam', 'radius', 'credentials'] },
          uamServerUrl: { type: 'string' },
          radiusServer: { type: 'string', description: 'IP:port format' },
          radiusServer2: { type: 'string', description: 'Accounting server IP:port' },
          allowedDomains: { type: 'array', items: { type: 'string' } },
          blockedDomains: { type: 'array', items: { type: 'string' } },
          restartUspot: { type: 'boolean', default: true },
          combinedSSID: { type: 'boolean', default: false },
          ssid: { type: 'string', default: 'SpotFi' },
          password: { type: 'string', default: 'none' }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertAuthenticated(request);
    const { id } = request.params as { id: string };
    const body = request.body as {
      authMode?: 'click-to-continue' | 'uam' | 'radius' | 'credentials';
      uamServerUrl?: string;
      radiusServer?: string;
      radiusServer2?: string;
      allowedDomains?: string[];
      blockedDomains?: string[];
      restartUspot?: boolean;
      combinedSSID?: boolean;
      ssid?: string;
      password?: string;
    };

    // Secrets: masterSecret for RADIUS, uniqueUamSecret for portal CHAP
    const masterSecret = process.env.RADIUS_MASTER_SECRET;
    if (!masterSecret) {
      return reply.code(500).send({ error: 'RADIUS_MASTER_SECRET not configured' });
    }

    if (body.combinedSSID) {
      body.ssid = body.ssid || 'SpotFi';
      body.password = body.password || 'none';
    }

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) return reply.code(404).send({ error: 'Router not found' });

    const uniqueUamSecret = router.radiusSecret;
    if (!uniqueUamSecret) {
      return reply.code(500).send({ error: 'Router missing UAM secret. Re-register router.' });
    }

    try {
      // Configure wireless if requested
      if (body.combinedSSID) {
        const setupService = new UspotSetupService(fastify.log);
        await setupService.configureWireless(id, {
          combinedSSID: body.combinedSSID,
          ssid: body.ssid,
          password: body.password
        });
      }

      // Ensure www-uspot directory exists
      await routerRpcService.rpcCall(id, 'file', 'exec', {
        command: 'sh',
        params: ['-c', 'mkdir -p /www-uspot && [ -f /www-uspot/index.html ] || echo \'<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/hotspot"></head><body>Redirecting...</body></html>\' > /www-uspot/index.html']
      });

      // Ensure uspot section exists
      const sectionName = 'hotspot';
      await routerRpcService.rpcCall(id, 'file', 'exec', {
        command: 'sh',
        params: ['-c', `uci -q show uspot.${sectionName} || (uci set uspot.${sectionName}=uspot && uci set uspot.${sectionName}.enabled=1 && uci set uspot.${sectionName}.interface=${sectionName} && uci set uspot.${sectionName}.setname=uspot_${sectionName} && uci commit uspot)`]
      });

      if (!body.authMode) {
        return reply.code(400).send({ error: 'authMode is required' });
      }
      
      const authMode = body.authMode;
      
      // Validate required fields per mode
      if (authMode === 'uam') {
        if (!body.radiusServer) return reply.code(400).send({ error: 'radiusServer required for UAM' });
        if (!body.uamServerUrl) return reply.code(400).send({ error: 'uamServerUrl required for UAM' });
        try { new URL(body.uamServerUrl); } catch { return reply.code(400).send({ error: 'Invalid uamServerUrl' }); }
        if (!/^[\d.]+:\d+$/.test(body.radiusServer)) return reply.code(400).send({ error: 'radiusServer format: IP:port' });
      } else if (authMode === 'radius') {
        if (!body.radiusServer) return reply.code(400).send({ error: 'radiusServer required for RADIUS' });
        if (!/^[\d.]+:\d+$/.test(body.radiusServer)) return reply.code(400).send({ error: 'radiusServer format: IP:port' });
      }
      
      let uciCommands = [`uci set uspot.${sectionName}.auth_mode='${authMode}'`];
      
      if (authMode === 'click-to-continue') {
        // Clear RADIUS settings
        uciCommands.push(
          `uci delete uspot.${sectionName}.uam_server 2>/dev/null || true`,
          `uci delete uspot.${sectionName}.auth_server 2>/dev/null || true`,
          `uci delete uspot.${sectionName}.auth_secret 2>/dev/null || true`,
          `uci delete uspot.${sectionName}.challenge 2>/dev/null || true`,
          `uci delete uspot.${sectionName}.uam_secret 2>/dev/null || true`,
          `uci delete uspot.${sectionName}.acct_secret 2>/dev/null || true`
        );
      } else {
        // RADIUS modes
        const radiusHost = body.radiusServer!.split(':')[0];
        const radiusPort = body.radiusServer!.split(':')[1] || '1812';
        
        // Get router MAC
        let nasmac = '00:00:00:00:00:00';
        try {
          const macResult = await routerRpcService.rpcCall(id, 'file', 'exec', {
            command: 'sh',
            params: ['-c', "cat /sys/class/net/br-lan/address 2>/dev/null || cat /sys/class/net/eth0/address 2>/dev/null || echo '00:00:00:00:00:00'"]
          });
          nasmac = (macResult?.stdout || '').trim().toUpperCase() || '00:00:00:00:00:00';
        } catch {}
        
        const nasid = router.name?.replace(/[^a-zA-Z0-9-]/g, '-') || `spotfi-${id.slice(0, 8)}`;
        
        // Get hotspot IP
        let hotspotIp = '10.1.30.1';
        try {
          const ipResult = await routerRpcService.rpcCall(id, 'file', 'exec', {
            command: 'sh',
            params: ['-c', "uci -q get network.hotspot.ipaddr || echo '10.1.30.1'"]
          });
          hotspotIp = (ipResult?.stdout || '10.1.30.1').trim();
        } catch {}
        
        // RADIUS auth settings (master secret)
        uciCommands.push(
          `uci set uspot.${sectionName}.auth_server='${radiusHost}'`,
          `uci set uspot.${sectionName}.auth_port='${radiusPort}'`,
          `uci set uspot.${sectionName}.auth_secret='${masterSecret}'`,
          `uci set uspot.${sectionName}.nasid='${nasid}'`,
          `uci set uspot.${sectionName}.nasmac='${nasmac}'`
        );
        
        // UAM mode: portal/CHAP settings (unique secret per router)
        if (authMode === 'uam') {
          uciCommands.push(
            `uci set uspot.${sectionName}.uam_port='3990'`,
            `uci set uspot.${sectionName}.uam_server='${body.uamServerUrl}'`,
            `uci set uspot.${sectionName}.challenge='${uniqueUamSecret}'`,
            `uci set uspot.${sectionName}.uam_secret='${uniqueUamSecret}'`
          );
        }
        
        // Accounting server (master secret)
        if (body.radiusServer2) {
          const acctHost = body.radiusServer2.split(':')[0];
          const acctPort = body.radiusServer2.split(':')[1] || '1813';
          uciCommands.push(
            `uci set uspot.${sectionName}.acct_server='${acctHost}'`,
            `uci set uspot.${sectionName}.acct_port='${acctPort}'`,
            `uci set uspot.${sectionName}.acct_secret='${masterSecret}'`
          );
        }
        
        // Configure uhttpd UAM listener
        if (authMode === 'uam') {
          await routerRpcService.rpcCall(id, 'file', 'exec', {
            command: 'sh',
            params: ['-c', [
              `uci set uhttpd.uam3990=uhttpd`,
              `uci set uhttpd.uam3990.listen_http='${hotspotIp}:3990'`,
              `uci set uhttpd.uam3990.redirect_https='0'`,
              `uci set uhttpd.uam3990.max_requests='5'`,
              `uci set uhttpd.uam3990.no_dirlists='1'`,
              `uci set uhttpd.uam3990.home='/www-uspot'`,
              `uci delete uhttpd.uam3990.ucode_prefix 2>/dev/null || true`,
              `uci add_list uhttpd.uam3990.ucode_prefix='/logon=/usr/share/uspot/handler-uam.uc'`,
              `uci add_list uhttpd.uam3990.ucode_prefix='/logoff=/usr/share/uspot/handler-uam.uc'`,
              `uci add_list uhttpd.uam3990.ucode_prefix='/logout=/usr/share/uspot/handler-uam.uc'`,
              `uci commit uhttpd`
            ].join(' && ')]
          });
        }
      }

      uciCommands.push('uci commit uspot');
      await routerRpcService.rpcCall(id, 'file', 'exec', {
        command: 'sh',
        params: ['-c', uciCommands.join(' && ')]
      });

      if (body.restartUspot !== false) {
        await routerRpcService.rpcCall(id, 'file', 'exec', {
          command: 'sh',
          params: ['-c', '/etc/init.d/uhttpd restart && /etc/init.d/uspot restart']
        });
      }

      // Configure access control for UAM
      if (authMode === 'uam') {
        const setupService = new UspotSetupService(fastify.log);
        
        let dnsServers: string[] | undefined;
        try {
          const dnsResult = await routerRpcService.rpcCall(id, 'file', 'exec', {
            command: 'sh',
            params: ['-c', "uci -q get dhcp.@dnsmasq[0].server 2>/dev/null | tr ' ' '\\n' | grep -v '^$' || echo ''"]
          });
          const routerDns = (dnsResult?.stdout || '').trim().split('\n').filter(Boolean);
          if (routerDns.length > 0) dnsServers = routerDns;
        } catch {}

        await setupService.configureAccessControl(id, {
          whitelist: body.allowedDomains,
          blocklist: body.blockedDomains,
          portalUrls: [body.uamServerUrl!],
          dnsServers
        });
        
        // Configure DHCP Option 114 for RFC8908
        try {
          const dhcpApiUrl = `${new URL(body.uamServerUrl!).origin}/api`;
          await routerRpcService.rpcCall(id, 'file', 'exec', {
            command: 'sh',
            params: ['-c', `uci set dhcp.hotspot.dhcp_option="114,${dhcpApiUrl}" 2>/dev/null || true; uci commit dhcp; /etc/init.d/dnsmasq restart`]
          });
        } catch {}
      }

      return {
        routerId: id,
        success: true,
        message: `Configured with auth_mode '${authMode}'`,
        config: {
          authMode,
          uamServerUrl: body.uamServerUrl,
          radiusServer: body.radiusServer,
          radiusServer2: body.radiusServer2,
          uamSecret: uniqueUamSecret,
          radiusSecret: '********'
        }
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      fastify.log.error(`[UAM Config] Failed: ${msg}`);
      return reply.code(503).send({ error: msg });
    }
  });

  // Get current UAM config
  fastify.get('/api/routers/:id/uam/config', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['router-management'],
      summary: 'Get UAM configuration',
      security: [{ bearerAuth: [] }]
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertAuthenticated(request);
    const { id } = request.params as { id: string };

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) return reply.code(404).send({ error: 'Router not found' });

    const uniqueUamSecret = router.radiusSecret;

    try {
      const uspotConfig = await routerRpcService.rpcCall(id, 'uci', 'get', { config: 'uspot' });
      const values = uspotConfig?.values || uspotConfig || {};
      
      const sectionKey = Object.keys(values).find(key => 
        values[key]['.type'] === 'uspot' || key === 'hotspot' || key === 'captive'
      );
      const section = sectionKey ? values[sectionKey] : {};

      return {
        routerId: id,
        config: {
          authMode: section.auth_mode || section['auth_mode'],
          uamServer: section.uam_server || section['uam_server'],
          uamPort: section.uam_port || section['uam_port'],
          authServer: section.auth_server || section['auth_server'],
          acctServer: section.acct_server || section['acct_server'],
          nasid: section.nasid || section['nasid'],
          nasmac: section.nasmac || section['nasmac'],
          interface: section.interface || section['interface'],
          setname: section.setname || section['setname'],
          uamSecret: uniqueUamSecret,
          radiusSecret: '********',
          authSecret: '********',
          acctSecret: section.acct_server ? '********' : undefined
        }
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(503).send({ error: msg });
    }
  });
}
