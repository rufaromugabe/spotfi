import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AuthenticatedUser } from '../types/fastify.js';
import { routerRpcService } from '../services/router-rpc.service.js';
import { routerAccessService } from '../services/router-access.service.js';
import { assertAuthenticated, requireAdmin } from '../utils/router-middleware.js';
import { prisma } from '../lib/prisma.js';

export async function routerSystemRoutes(fastify: FastifyInstance) {
  // Get router system info via ubus
  fastify.post('/api/routers/:id/system/info', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['router-management'],
      summary: 'Get router system information',
      security: [{ bearerAuth: [] }],
      description: 'Get system information (board, uptime, memory, etc.) using ubus'
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertAuthenticated(request);
    const { id } = request.params as { id: string };

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const result = await routerRpcService.getSystemInfo(id);
      return { routerId: id, systemInfo: result.result || result };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      fastify.log.error(`Error getting system info for router ${id}: ${errorMessage}`);
      return reply.code(503).send({ error: errorMessage });
    }
  });

  // Get router board info via ubus
  fastify.post('/api/routers/:id/system/board', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['router-management'],
      summary: 'Get router board information',
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
      const result = await routerRpcService.getBoardInfo(id);
      return { routerId: id, boardInfo: result.result || result };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(503).send({ error: errorMessage });
    }
  });

  // Get system uptime
  fastify.post('/api/routers/:id/system/uptime', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['router-management'],
      summary: 'Get router uptime',
      security: [{ bearerAuth: [] }],
      description: 'Get router uptime in seconds and human-readable format'
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertAuthenticated(request);
    const { id } = request.params as { id: string };

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const systemInfo = await routerRpcService.getSystemInfo(id);
      const sysData = systemInfo.result || systemInfo;
      const uptimeSeconds = parseInt(sysData.uptime || sysData.uptime_seconds || 0);

      // Calculate human-readable uptime
      const days = Math.floor(uptimeSeconds / 86400);
      const hours = Math.floor((uptimeSeconds % 86400) / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      const secs = uptimeSeconds % 60;

      return {
        routerId: id,
        uptime: {
          seconds: uptimeSeconds,
          formatted: `${days}d ${hours}h ${minutes}m ${secs}s`,
          days,
          hours,
          minutes
        },
        bootTime: sysData.boottime ? new Date(sysData.boottime * 1000).toISOString() : null
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(503).send({ error: errorMessage });
    }
  });

  // Update bridge binary via RPC (Admin only)
  fastify.post('/api/routers/:id/bridge/update', {
    preHandler: [fastify.authenticate, requireAdmin],
    schema: {
      tags: ['router-management'],
      summary: 'Update router bridge binary',
      security: [{ bearerAuth: [] }],
      description: 'Admin only - Download and update the spotfi-bridge binary on the router',
      body: {
        type: 'object',
        required: ['downloadUrl'],
        properties: {
          downloadUrl: { 
            type: 'string', 
            description: 'URL to download the new bridge binary',
            format: 'uri'
          },
          architecture: {
            type: 'string',
            description: 'Router architecture (e.g., mipsle, arm64). Auto-detected if not provided',
            enum: ['mipsle', 'mips', 'arm64', 'aarch64', 'x86_64', 'i386']
          },
          timeout: {
            type: 'number',
            default: 60000,
            description: 'Timeout in milliseconds (default: 60s)'
          }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertAuthenticated(request);
    const { id } = request.params as { id: string };
    const body = request.body as { downloadUrl: string; architecture?: string; timeout?: number };

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      // Detect architecture if not provided
      let arch = body.architecture;
      if (!arch) {
        const boardInfo = await routerRpcService.getBoardInfo(id);
        const boardData = boardInfo.result || boardInfo;
        // Map OpenWrt board names to architectures
        const archMap: Record<string, string> = {
          'ramips': 'mipsle',
          'ar71xx': 'mips',
          'ath79': 'mips',
          'bcm53xx': 'arm',
          'ipq40xx': 'arm',
          'ipq806x': 'arm',
          'mediatek': 'mipsle',
          'qualcommax': 'arm64'
        };
        const boardName = boardData?.board_name || '';
        arch = archMap[boardName] || 'mipsle'; // Default to mipsle
        fastify.log.info(`[Bridge Update] Auto-detected architecture: ${arch} for router ${id}`);
      }

      // Create update script
      // 1. Stop current bridge service
      // 2. Download new binary to temp location
      // 3. Verify it's executable
      // 4. Replace old binary
      // 5. Restart service
      const updateScript = [
        'set -e',
        'echo "Stopping spotfi-bridge service..."',
        '/etc/init.d/spotfi-bridge stop || true',
        '',
        `echo "Downloading new binary from ${body.downloadUrl}..."`,
        'TEMP_FILE="/tmp/spotfi-bridge-new"',
        `wget -q -O "$TEMP_FILE" "${body.downloadUrl}" || curl -s -o "$TEMP_FILE" "${body.downloadUrl}" || {`,
        '  echo "ERROR: Failed to download binary"',
        '  exit 1',
        '}',
        '',
        'echo "Verifying binary..."',
        'chmod +x "$TEMP_FILE"',
        'if ! "$TEMP_FILE" --version > /dev/null 2>&1; then',
        '  echo "ERROR: Downloaded file is not a valid executable"',
        '  rm -f "$TEMP_FILE"',
        '  exit 1',
        'fi',
        '',
        'echo "Backing up old binary..."',
        'cp /usr/bin/spotfi-bridge /usr/bin/spotfi-bridge.backup.$(date +%s) || true',
        '',
        'echo "Installing new binary..."',
        'mv "$TEMP_FILE" /usr/bin/spotfi-bridge',
        'chmod +x /usr/bin/spotfi-bridge',
        '',
        'echo "Starting spotfi-bridge service..."',
        '/etc/init.d/spotfi-bridge start',
        '',
        'echo "SUCCESS: Bridge updated and restarted"',
        '/usr/bin/spotfi-bridge --version'
      ].filter(line => line.trim() !== '').join('\n');

      fastify.log.info(`[Bridge Update] Updating bridge for router ${id} from ${body.downloadUrl}`);

      const result = await routerRpcService.rpcCall(id, 'file', 'exec', {
        command: '/bin/sh',
        params: ['-c', updateScript]
      }, body.timeout || 60000);

      return {
        routerId: id,
        success: true,
        message: 'Bridge updated successfully',
        result: result.result || result
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      fastify.log.error(`[Bridge Update] Failed to update bridge for router ${id}: ${errorMessage}`);
      return reply.code(503).send({ 
        error: 'Failed to update bridge: ' + errorMessage,
        routerId: id
      });
    }
  });

  // Run setup script via RPC (Admin only)
  fastify.post('/api/routers/:id/setup/run', {
    preHandler: [fastify.authenticate, requireAdmin],
    schema: {
      tags: ['router-management'],
      summary: 'Run router setup script remotely',
      security: [{ bearerAuth: [] }],
      description: 'Admin only - Downloads and executes the OpenWrt setup script on the router',
      body: {
        type: 'object',
        properties: {
          mqttBroker: {
            type: 'string',
            description: 'MQTT broker URL (optional, defaults to MQTT_BROKER_URL env or mqtt://emqx:1883). Formats: mqtt://host:port, mqtts://host:port, tcp://host:port',
            pattern: '^(mqtt|mqtts|ssl|tcp)://.+'
          },
          scriptUrl: {
            type: 'string',
            description: 'URL to download setup script (optional, defaults to GitHub raw URL)',
            format: 'uri'
          },
          githubToken: {
            type: 'string',
            description: 'GitHub token for private repos (optional)'
          },
          timeout: {
            type: 'number',
            default: 120000,
            description: 'Timeout in milliseconds (default: 120s)'
          }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertAuthenticated(request);
    const { id } = request.params as { id: string };
    const body = request.body as { mqttBroker?: string; scriptUrl?: string; githubToken?: string; timeout?: number };

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      // Get router token and ID from database
      const routerData = await prisma.router.findUnique({
        where: { id },
        select: { token: true, id: true }
      });

      if (!routerData) {
        return reply.code(404).send({ error: 'Router not found' });
      }

      // Determine MQTT broker URL with normalization
      let mqttBroker = body.mqttBroker || process.env.MQTT_BROKER_URL || 'mqtt://emqx:1883';
      
      // Normalize MQTT URL: fix common typos (mqtt// -> mqtt://)
      mqttBroker = mqttBroker.replace(/^(mqtt|mqtts|ssl|tcp)\/\//, '$1://');
      
      // Validate format
      if (!/^(mqtt|mqtts|ssl|tcp):\/\/.+/.test(mqttBroker)) {
        return reply.code(400).send({ 
          error: 'Invalid MQTT broker URL format. Must be: mqtt://host:port, mqtts://host:port, ssl://host:port, or tcp://host:port',
          provided: body.mqttBroker
        });
      }
      
      // Determine script URL (default to GitHub raw URL)
      const scriptUrl = body.scriptUrl || 'https://raw.githubusercontent.com/your-org/spotfi/main/scripts/openwrt-setup-cloud.sh';

      fastify.log.info(`[Setup] Running setup script for router ${id} via RPC`);

      // Create setup command that:
      // 1. Downloads the setup script
      // 2. Makes it executable
      // 3. Runs it with router token, MQTT broker, and router ID
      const setupCommand = [
        'set -e',
        'echo "Downloading setup script..."',
        `SCRIPT_FILE="/tmp/openwrt-setup-cloud.sh"`,
        `wget -q -O "$SCRIPT_FILE" "${scriptUrl}" || curl -s -o "$SCRIPT_FILE" "${scriptUrl}" || {`,
        '  echo "ERROR: Failed to download setup script"',
        '  exit 1',
        '}',
        'chmod +x "$SCRIPT_FILE"',
        '',
        'echo "Running setup script..."',
        // Build command with parameters
        `"$SCRIPT_FILE" "${routerData.token}" "${mqttBroker}" "${routerData.id}"${body.githubToken ? ` "${body.githubToken}"` : ''}`,
        '',
        'echo "SUCCESS: Setup script completed"',
        'rm -f "$SCRIPT_FILE"'
      ].filter(line => line.trim() !== '').join('\n');

      const result = await routerRpcService.rpcCall(id, 'file', 'exec', {
        command: '/bin/sh',
        params: ['-c', setupCommand]
      }, body.timeout || 120000);

      return {
        routerId: id,
        success: true,
        message: 'Setup script executed successfully',
        result: result.result || result
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      fastify.log.error(`[Setup] Failed to run setup script for router ${id}: ${errorMessage}`);
      return reply.code(503).send({ 
        error: 'Failed to run setup script: ' + errorMessage,
        routerId: id
      });
    }
  });

  fastify.post('/api/routers/:id/system/reboot', {
    preHandler: [fastify.authenticate, requireAdmin],
    schema: {
      tags: ['router-management'],
      summary: 'Reboot router',
      security: [{ bearerAuth: [] }],
      description: 'Admin only - Reboot the router'
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertAuthenticated(request);
    const { id } = request.params as { id: string };

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      // Use ubus system.reboot
      await routerRpcService.reboot(id);
      return { routerId: id, message: 'Reboot command sent', success: true };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(503).send({ error: errorMessage });
    }
  });
}

