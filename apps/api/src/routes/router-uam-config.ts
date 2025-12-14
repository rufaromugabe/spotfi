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
      summary: 'Configure uspot captive portal settings',
      security: [{ bearerAuth: [] }],
      description: 'Admin only - Configure uspot auth mode and settings. Use authMode to switch between click-to-continue (simple), uam (RADIUS UAM), radius (RADIUS credentials), or credentials (local users).',
      body: {
        type: 'object',
        properties: {
          authMode: {
            type: 'string',
            enum: ['click-to-continue', 'uam', 'radius', 'credentials'],
            default: 'uam',
            description: 'Authentication mode: click-to-continue (accept & go), uam (RADIUS UAM with external portal), radius (RADIUS with local login), credentials (local username/password)'
          },
          uamServerUrl: { 
            type: 'string', 
            description: 'UAM portal URL (required for uam mode). Example: https://api.spotfi.com/uam/login' 
          },
          radiusServer: { 
            type: 'string', 
            description: 'RADIUS authentication server IP:port (required for uam/radius modes). Example: 192.168.1.100:1812' 
          },
          radiusSecret: { 
            type: 'string', 
            description: 'RADIUS shared secret (required for uam/radius modes)' 
          },
          radiusServer2: { 
            type: 'string', 
            description: 'RADIUS accounting server IP:port (optional). Example: 192.168.1.100:1813' 
          },
          restartUspot: { type: 'boolean', default: true, description: 'Restart uspot and uhttpd services after configuration' },
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
      authMode?: 'click-to-continue' | 'uam' | 'radius' | 'credentials';
      uamServerUrl?: string;
      radiusServer?: string;
      radiusSecret?: string;
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

      // Ensure /www-uspot directory exists (required by uhttpd)
      await routerRpcService.rpcCall(id, 'file', 'exec', {
        command: 'sh',
        params: ['-c', 'mkdir -p /www-uspot && [ -f /www-uspot/index.html ] || echo \'<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/hotspot"></head><body>Redirecting...</body></html>\' > /www-uspot/index.html']
      });

      // Check if uspot named section exists, create if needed
      // uspot uses named sections: config uspot 'sectionname' (NOT config instance)
      const sectionName = 'hotspot';
      await routerRpcService.rpcCall(id, 'file', 'exec', {
        command: 'sh',
        params: ['-c', `uci -q show uspot.${sectionName} || (uci set uspot.${sectionName}=uspot && uci set uspot.${sectionName}.enabled=1 && uci set uspot.${sectionName}.interface=${sectionName} && uci set uspot.${sectionName}.setname=uspot_${sectionName} && uci commit uspot)`]
      });

      // Determine auth mode (default to 'uam' for backward compatibility)
      const authMode = body.authMode || 'uam';
      
      // Validate required fields based on auth mode
      if ((authMode === 'uam' || authMode === 'radius') && (!body.radiusServer || !body.radiusSecret)) {
        return reply.code(400).send({ 
          error: `radiusServer and radiusSecret are required for auth_mode '${authMode}'` 
        });
      }
      if (authMode === 'uam' && !body.uamServerUrl) {
        return reply.code(400).send({ 
          error: "uamServerUrl is required for auth_mode 'uam'" 
        });
      }
      
      // Build UCI commands using named section
      let uciCommands = [
        `uci set uspot.${sectionName}.auth_mode='${authMode}'`
      ];
      
      // For click-to-continue mode, just set auth_mode and we're done
      if (authMode === 'click-to-continue') {
        // Remove RADIUS settings if switching to click-to-continue
        uciCommands.push(
          `uci delete uspot.${sectionName}.uam_server 2>/dev/null || true`,
          `uci delete uspot.${sectionName}.auth_server 2>/dev/null || true`,
          `uci delete uspot.${sectionName}.auth_secret 2>/dev/null || true`
        );
      } else {
        // For uam/radius modes, configure RADIUS settings
        const radiusHost = body.radiusServer!.split(':')[0];
        const radiusPort = body.radiusServer!.split(':')[1] || '1812';
        
        // Get router MAC for nasmac (required by uspot for RADIUS modes)
        let nasmac = '';
        try {
          const macResult = await routerRpcService.rpcCall(id, 'file', 'exec', {
            command: 'sh',
            params: ['-c', "cat /sys/class/net/br-lan/address 2>/dev/null || cat /sys/class/net/eth0/address 2>/dev/null || echo '00:00:00:00:00:00'"]
          });
          nasmac = (macResult?.stdout || '').trim().toUpperCase();
        } catch {
          nasmac = '00:00:00:00:00:00';
        }
        
        // Generate nasid from router name or use default
        const nasid = router.name?.replace(/[^a-zA-Z0-9-]/g, '-') || `spotfi-${id.slice(0, 8)}`;
        
        // Get hotspot IP for uhttpd UAM listener
        let hotspotIp = '10.1.30.1';
        try {
          const ipResult = await routerRpcService.rpcCall(id, 'file', 'exec', {
            command: 'sh',
            params: ['-c', "uci -q get network.hotspot.ipaddr || echo '10.1.30.1'"]
          });
          hotspotIp = (ipResult?.stdout || '10.1.30.1').trim();
        } catch {}
        
        uciCommands.push(
          `uci set uspot.${sectionName}.auth_server='${radiusHost}'`,
          `uci set uspot.${sectionName}.auth_port='${radiusPort}'`,
          `uci set uspot.${sectionName}.auth_secret='${body.radiusSecret}'`,
          `uci set uspot.${sectionName}.nasid='${nasid}'`,
          `uci set uspot.${sectionName}.nasmac='${nasmac}'`
        );
        
        // UAM mode specific settings
        if (authMode === 'uam') {
          // Generate a challenge secret for CHAP (use RADIUS secret or generate one)
          // The challenge is: MD5(challenge_secret + formatted_mac)
          const challengeSecret = body.radiusSecret || 'spotfi-challenge-secret';
          
          uciCommands.push(
            `uci set uspot.${sectionName}.uam_port='3990'`,
            `uci set uspot.${sectionName}.uam_server='${body.uamServerUrl}'`,
            // CRITICAL: challenge option is required for CHAP authentication
            // Without this, challenge=false is passed to UAM server and auth fails
            `uci set uspot.${sectionName}.challenge='${challengeSecret}'`,
            // uam_secret is used for UAM URL MD5 verification (optional but recommended)
            `uci set uspot.${sectionName}.uam_secret='${challengeSecret}'`
          );
        }
        
        // Accounting server (optional)
        if (body.radiusServer2) {
          const acctHost = body.radiusServer2.split(':')[0];
          const acctPort = body.radiusServer2.split(':')[1] || '1813';
          uciCommands.push(`uci set uspot.${sectionName}.acct_server='${acctHost}'`);
          uciCommands.push(`uci set uspot.${sectionName}.acct_port='${acctPort}'`);
          uciCommands.push(`uci set uspot.${sectionName}.acct_secret='${body.radiusSecret}'`);
        }
        
        // Configure uhttpd UAM listener on port 3990 (required for UAM mode)
        if (authMode === 'uam') {
          const uhttpdUamCommands = [
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
          ];
          
          // Configure uhttpd UAM listener
          await routerRpcService.rpcCall(id, 'file', 'exec', {
            command: 'sh',
            params: ['-c', uhttpdUamCommands.join(' && ')]
          });
        }
      } // End of RADIUS modes block

      uciCommands.push('uci commit uspot');

      // Execute all UCI commands in one shell call
      await routerRpcService.rpcCall(id, 'file', 'exec', {
        command: 'sh',
        params: ['-c', uciCommands.join(' && ')]
      });

      if (body.restartUspot !== false) {
        // Restart both uhttpd (for UAM listener) and uspot
        await routerRpcService.rpcCall(id, 'file', 'exec', {
          command: 'sh',
          params: ['-c', '/etc/init.d/uhttpd restart && /etc/init.d/uspot restart']
        });
      }

      // For UAM mode: Add UAM server to firewall whitelist so unauthenticated clients can reach it
      // This handles both static IPs and Cloudflare-proxied domains
      if (authMode === 'uam' && body.uamServerUrl) {
        try {
          const uamUrlObj = new URL(body.uamServerUrl);
          const uamHost = uamUrlObj.hostname;
          
          // Resolve hostname to IP address
          let uamIp = '';
          try {
            const dns = await import('dns');
            const { promisify } = await import('util');
            const lookup = promisify(dns.lookup);
            const result = await lookup(uamHost);
            uamIp = result.address;
            fastify.log.info(`[UAM Config] Resolved ${uamHost} to ${uamIp}`);
          } catch (dnsErr) {
            fastify.log.warn(`[UAM Config] Could not resolve ${uamHost} - will rely on dynamic DNS ipset`);
          }
          
          fastify.log.info(`[UAM Config] Adding ${uamHost} (IP: ${uamIp}) to firewall whitelist`);
          
          // Add UAM server to whitelist using two methods:
          // 1. Static IP entry (for immediate access)
          // 2. dnsmasq ipset (for Cloudflare/dynamic IPs - resolves on DNS query)
          const addToWhitelist = `
#!/bin/sh
echo "=== Configuring UAM whitelist for ${uamHost} ==="

# STEP 1: Add static IP to firewall ipset
idx=0
found=""
while uci get firewall.@ipset[$idx] >/dev/null 2>&1; do
  name=$(uci get firewall.@ipset[$idx].name 2>/dev/null)
  if [ "$name" = "uspot_wlist" ]; then
    found=$idx
    break
  fi
  idx=$((idx + 1))
done

if [ -n "$found" ]; then
  echo "Found firewall whitelist ipset at index $found"
  uci delete firewall.@ipset[$found].entry 2>/dev/null || true
  ${uamIp ? `uci add_list firewall.@ipset[$found].entry='${uamIp}'` : 'echo "WARNING: No IP resolved"'}
  echo "Added static IP: ${uamIp || 'none'}"
else
  echo "WARNING: Could not find uspot_wlist firewall ipset"
fi

# STEP 2: Configure dnsmasq dynamic ipset (for Cloudflare/changing IPs)
# This makes dnsmasq add resolved IPs to the ipset on DNS queries
echo "Configuring dnsmasq dynamic ipset..."

# Check if dnsmasq ipset for uspot_wlist already exists
dhcp_ipset_exists=""
idx=0
while uci get dhcp.@ipset[$idx] >/dev/null 2>&1; do
  names=$(uci get dhcp.@ipset[$idx].name 2>/dev/null)
  if echo "$names" | grep -q "uspot_wlist"; then
    dhcp_ipset_exists=$idx
    break
  fi
  idx=$((idx + 1))
done

if [ -n "$dhcp_ipset_exists" ]; then
  echo "Updating existing dnsmasq ipset at index $dhcp_ipset_exists"
  uci delete dhcp.@ipset[$dhcp_ipset_exists].domain 2>/dev/null || true
  uci add_list dhcp.@ipset[$dhcp_ipset_exists].domain='${uamHost}'
else
  echo "Creating new dnsmasq ipset"
  uci add dhcp ipset
  uci add_list dhcp.@ipset[-1].name='uspot_wlist'
  uci add_list dhcp.@ipset[-1].domain='${uamHost}'
fi

# Commit all changes
uci commit firewall
uci commit dhcp

# Restart services
/etc/init.d/firewall restart
/etc/init.d/dnsmasq restart

echo "=== Whitelist configured ==="
echo "Static IP: ${uamIp || 'none'}"
echo "Dynamic DNS domain: ${uamHost}"
`;
          
          await routerRpcService.rpcCall(id, 'file', 'exec', {
            command: 'sh',
            params: ['-c', addToWhitelist]
          });
          
          fastify.log.info(`[UAM Config] Whitelist configured for ${uamHost} (IP: ${uamIp || 'dynamic'})`);
          
          // Also configure DHCP Option 114 for RFC8908 Captive Portal API
          const dhcpApiUrl = `${uamUrlObj.origin}/api`;
          try {
            await routerRpcService.rpcCall(id, 'file', 'exec', {
              command: 'sh',
              params: ['-c', `uci set dhcp.hotspot.dhcp_option="114,${dhcpApiUrl}" 2>/dev/null || true; uci commit dhcp`]
            });
          } catch {
            // DHCP section might not exist, that's OK
          }
        } catch (wlistErr: unknown) {
          const errMsg = wlistErr instanceof Error ? wlistErr.message : 'Unknown error';
          fastify.log.warn(`[UAM Config] Could not update whitelist: ${errMsg}`);
        }
      }

      return {
        routerId: id,
        success: true,
        message: `uspot configured with auth_mode '${authMode}'`,
        config: {
          authMode,
          uamServerUrl: body.uamServerUrl,
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
          uamServer: section.uam_server || section['uam_server'],
          uamPort: section.uam_port || section['uam_port'],
          authServer: section.auth_server || section['auth_server'],
          acctServer: section.acct_server || section['acct_server'],
          authSecret: (section.auth_secret || section['auth_secret']) ? '***' : undefined,
          nasid: section.nasid || section['nasid'],
          nasmac: section.nasmac || section['nasmac'],
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

