import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { WebSocket } from 'ws';
import { activeConnections } from '../websocket/server.js';
import { prisma } from '../lib/prisma.js';
import { commandManager } from '../websocket/command-manager.js';
import { routerRpcService } from '../services/router-rpc.service.js';

function requireAdmin(request: FastifyRequest, reply: FastifyReply, done: Function) {
  const user = request.user as any;
  if (user.role !== 'ADMIN') {
    reply.code(403).send({ error: 'Admin access required' });
    return;
  }
  done();
}

export async function routerManagementRoutes(fastify: FastifyInstance) {
  // Helper function to verify router access
  async function verifyRouterAccess(routerId: string, userId: string, role: string) {
    const where = role === 'ADMIN' ? { id: routerId } : { id: routerId, hostId: userId };
    const router = await prisma.router.findFirst({ where });
    return router;
  }

  // Helper function to check if router is online
  function checkRouterOnline(routerId: string): WebSocket | null {
    const socket = activeConnections.get(routerId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return null;
    }
    return socket;
  }

  // Execute command on router via WebSocket
  async function executeCommand(
    routerId: string,
    command: string,
    params: any = {},
    timeout: number = 30000
  ): Promise<any> {
    const socket = checkRouterOnline(routerId);
    if (!socket) {
      throw new Error('Router is offline');
    }

    return commandManager.sendCommand(routerId, socket, command, params, timeout);
  }

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
    const user = request.user as any;
    const { id } = request.params as { id: string };

    const router = await verifyRouterAccess(id, user.userId, user.role);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const result = await routerRpcService.getSystemInfo(id);
      return { routerId: id, systemInfo: result.data || result };
    } catch (error: any) {
      fastify.log.error(`Error getting system info for router ${id}: ${error.message}`);
      return reply.code(503).send({ error: error.message });
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
    const user = request.user as any;
    const { id } = request.params as { id: string };

    const router = await verifyRouterAccess(id, user.userId, user.role);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const result = await routerRpcService.getBoardInfo(id);
      return { routerId: id, boardInfo: result.data || result };
    } catch (error: any) {
      return reply.code(503).send({ error: error.message });
    }
  });

  // Get network interface status via ubus
  fastify.post('/api/routers/:id/network/interfaces', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['router-management'],
      summary: 'Get network interface status',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          interface: { type: 'string', description: 'Interface name (e.g., lan, wan, wlan0)' }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as any;
    const { id } = request.params as { id: string };
    const body = request.body as { interface?: string };

    const router = await verifyRouterAccess(id, user.userId, user.role);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const result = await routerRpcService.getNetworkInterfaces(id, body.interface);
      return { routerId: id, interface: body.interface, interfaces: result.data || result };
    } catch (error: any) {
      return reply.code(503).send({ error: error.message });
    }
  });

  // Get wireless status via ubus
  fastify.post('/api/routers/:id/wireless/status', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['router-management'],
      summary: 'Get wireless status',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          interface: { type: 'string', description: 'Wireless interface (e.g., wlan0)' }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as any;
    const { id } = request.params as { id: string };
    const body = request.body as { interface?: string };

    const router = await verifyRouterAccess(id, user.userId, user.role);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const interfaceName = body.interface || 'wlan0';
      const result = await routerRpcService.getWirelessStatus(id, interfaceName);
      return { routerId: id, interface: interfaceName, status: result.data || result };
    } catch (error: any) {
      return reply.code(503).send({ error: error.message });
    }
  });

  // Get connected devices (DHCP leases)
  fastify.post('/api/routers/:id/dhcp/leases', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['router-management'],
      summary: 'Get DHCP leases (connected devices)',
      security: [{ bearerAuth: [] }]
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as any;
    const { id } = request.params as { id: string };

    const router = await verifyRouterAccess(id, user.userId, user.role);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const result = await executeCommand(id, 'ubus-call', {
        namespace: 'dhcp',
        method: 'ipv4leases'
      });

      return { routerId: id, leases: result.data || result };
    } catch (error: any) {
      // Fallback to reading /tmp/dhcp.leases file
      try {
        const result = await executeCommand(id, 'read-file', {
          path: '/tmp/dhcp.leases'
        });

        return { routerId: id, leases: result.data || result };
      } catch (fallbackError: any) {
        return reply.code(503).send({ error: fallbackError.message });
      }
    }
  });

  // Get live session statistics for a specific client
  fastify.post('/api/routers/:id/sessions/status', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['router-management'],
      summary: 'Get live client session statistics',
      description: 'Get real-time data usage (bytes-remaining, etc.) for a specific client connected to the router. Requires an updated Uspot version on the router.',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The ID of the router' }
        },
        required: ['id']
      },
      body: {
        type: 'object',
        required: ['macAddress'],
        properties: {
          macAddress: { type: 'string', description: 'The MAC address of the connected client device' }
        }
      },
      response: {
        200: {
          description: 'Successful response with live session data',
          type: 'object',
          properties: {
            routerId: { type: 'string' },
            session: { type: 'object' } // The JSON object from Uspot
          }
        },
        503: {
          description: 'Service unavailable (router offline or command failed)',
          type: 'object',
          properties: {
            error: { type: 'string' }
          }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as any;
    const { id } = request.params as { id: string };
    const { macAddress } = request.body as { macAddress: string };

    const router = await verifyRouterAccess(id, user.userId, user.role);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const result = await executeCommand(id, 'get-session-stats', {
        macAddress: macAddress
      }, 10000); // 10-second timeout

      return { routerId: id, session: result.data || result };
    } catch (error: any) {
      return reply.code(503).send({ error: error.message });
    }
  });

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
    const user = request.user as any;
    const { id } = request.params as { id: string };
    const body = request.body as { config: string; section?: string };

    const router = await verifyRouterAccess(id, user.userId, user.role);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const result = await executeCommand(id, 'uci-command', {
        command: 'show',
        config: body.config,
        section: body.section
      });

      return { routerId: id, config: body.config, data: result.data || result };
    } catch (error: any) {
      return reply.code(503).send({ error: error.message });
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
    const user = request.user as any;
    const { id } = request.params as { id: string };
    const body = request.body as { config: string; section: string; option: string; value: string; commit?: boolean };

    const router = await verifyRouterAccess(id, user.userId, user.role);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const result = await executeCommand(id, 'uci-command', {
        command: 'set',
        config: body.config,
        section: body.section,
        option: body.option,
        value: body.value
      });

      if (body.commit) {
        await executeCommand(id, 'uci-command', {
          command: 'commit',
          config: body.config
        });
      }

      return { routerId: id, success: true, result: result.data || result };
    } catch (error: any) {
      return reply.code(503).send({ error: error.message });
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
    const user = request.user as any;
    const { id } = request.params as { id: string };
    const body = request.body as { config?: string };

    const router = await verifyRouterAccess(id, user.userId, user.role);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const result = await executeCommand(id, 'uci-command', {
        command: 'commit',
        config: body.config
      });

      return { routerId: id, success: true, result: result.data || result };
    } catch (error: any) {
      return reply.code(503).send({ error: error.message });
    }
  });

  // Execute shell command (admin only for security)
  fastify.post('/api/routers/:id/command/execute', {
    preHandler: [fastify.authenticate, requireAdmin],
    schema: {
      tags: ['router-management'],
      summary: 'Execute shell command on router',
      security: [{ bearerAuth: [] }],
      description: 'Execute a shell command on the router (Admin only)',
      body: {
        type: 'object',
        required: ['command'],
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          timeout: { type: 'number', default: 10000, description: 'Command timeout in milliseconds' }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as any;
    const { id } = request.params as { id: string };
    const body = request.body as { command: string; timeout?: number };

    const router = await verifyRouterAccess(id, user.userId, user.role);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const result = await executeCommand(id, 'shell-command', {
        command: body.command
      }, body.timeout || 10000);

      return { routerId: id, command: body.command, result: result.data || result };
    } catch (error: any) {
      return reply.code(503).send({ error: error.message });
    }
  });

  // Reboot router (Admin only)
  fastify.post('/api/routers/:id/system/reboot', {
    preHandler: [fastify.authenticate, requireAdmin],
    schema: {
      tags: ['router-management'],
      summary: 'Reboot router',
      security: [{ bearerAuth: [] }],
      description: 'Admin only - Reboot the router'
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as any;
    const { id } = request.params as { id: string };

    const router = await verifyRouterAccess(id, user.userId, user.role);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      await executeCommand(id, 'reboot');
      return { routerId: id, message: 'Reboot command sent', success: true };
    } catch (error: any) {
      return reply.code(503).send({ error: error.message });
    }
  });

  // Get router logs
  fastify.post('/api/routers/:id/logs', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['router-management'],
      summary: 'Get router logs',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          lines: { type: 'number', default: 50, description: 'Number of log lines to retrieve' }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as any;
    const { id } = request.params as { id: string };
    const body = request.body as { lines?: number };

    const router = await verifyRouterAccess(id, user.userId, user.role);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const result = await executeCommand(id, 'fetch-logs', {
        lines: body.lines || 50
      });

      return { routerId: id, logs: result.data || result };
    } catch (error: any) {
      return reply.code(503).send({ error: error.message });
    }
  });

  // Read file from router
  fastify.post('/api/routers/:id/files/read', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['router-management'],
      summary: 'Read file from router',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'File path on router' }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as any;
    const { id } = request.params as { id: string };
    const body = request.body as { path: string };

    const router = await verifyRouterAccess(id, user.userId, user.role);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const result = await executeCommand(id, 'read-file', {
        path: body.path
      });

      return { routerId: id, path: body.path, content: result.data || result };
    } catch (error: any) {
      return reply.code(503).send({ error: error.message });
    }
  });

  // Service management (Admin only)
  fastify.post('/api/routers/:id/services/:action', {
    preHandler: [fastify.authenticate, requireAdmin],
    schema: {
      tags: ['router-management'],
      summary: 'Control router services',
      security: [{ bearerAuth: [] }],
      description: 'Admin only - Start, stop, restart, or check status of router services',
      params: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'restart', 'status'] }
        }
      },
      body: {
        type: 'object',
        required: ['service'],
        properties: {
          service: { type: 'string', description: 'Service name (e.g., network, firewall, uspot)' }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as any;
    const { id, action } = request.params as { id: string; action: string };
    const body = request.body as { service: string };

    const router = await verifyRouterAccess(id, user.userId, user.role);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const result = await executeCommand(id, 'service-command', {
        service: body.service,
        action: action
      });

      return { routerId: id, service: body.service, action, result: result.data || result };
    } catch (error: any) {
      return reply.code(503).send({ error: error.message });
    }
  });

  // Generic ubus call (Admin only for safety)
  fastify.post('/api/routers/:id/ubus', {
    preHandler: [fastify.authenticate, requireAdmin],
    schema: {
      tags: ['router-management'],
      summary: 'Execute ubus call',
      security: [{ bearerAuth: [] }],
      description: 'Admin only - Execute ubus RPC calls (read and write operations)',
      body: {
        type: 'object',
        required: ['namespace', 'method'],
        properties: {
          namespace: { type: 'string', description: 'ubus namespace' },
          method: { type: 'string', description: 'ubus method' },
          args: { type: 'object', description: 'Method arguments' }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as any;
    const { id } = request.params as { id: string };
    const body = request.body as { namespace: string; method: string; args?: any };

    const router = await verifyRouterAccess(id, user.userId, user.role);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const result = await executeCommand(id, 'ubus-call', {
        namespace: body.namespace,
        method: body.method,
        args: body.args || {}
      });

      return { routerId: id, namespace: body.namespace, method: body.method, result: result.data || result };
    } catch (error: any) {
      return reply.code(503).send({ error: error.message });
    }
  });

  // Get network interface statistics (bytes, packets, errors)
  fastify.post('/api/routers/:id/network/statistics', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['router-management'],
      summary: 'Get network interface statistics',
      security: [{ bearerAuth: [] }],
      description: 'Get detailed statistics for network interfaces (bytes sent/received, packets, errors, etc.)',
      body: {
        type: 'object',
        properties: {
          interface: { type: 'string', description: 'Optional interface name (e.g., eth0, wlan0). If not provided, returns all interfaces' }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as any;
    const { id } = request.params as { id: string };
    const body = request.body as { interface?: string };

    const router = await verifyRouterAccess(id, user.userId, user.role);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const result = await executeCommand(id, 'network-statistics', {
        interface: body.interface
      });

      return { routerId: id, statistics: result.data || result };
    } catch (error: any) {
      return reply.code(503).send({ error: error.message });
    }
  });

  // Get network speed/throughput (real-time)
  fastify.post('/api/routers/:id/network/speed', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['router-management'],
      summary: 'Get network speed/throughput',
      security: [{ bearerAuth: [] }],
      description: 'Get current network speed (bytes/sec) for interfaces. Requires two measurements with delay.',
      body: {
        type: 'object',
        properties: {
          interface: { type: 'string', description: 'Interface name (e.g., eth0, wlan0)' },
          interval: { type: 'number', default: 2, description: 'Measurement interval in seconds (default: 2)' }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as any;
    const { id } = request.params as { id: string };
    const body = request.body as { interface?: string; interval?: number };

    const router = await verifyRouterAccess(id, user.userId, user.role);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const result = await executeCommand(id, 'network-speed', {
        interface: body.interface,
        interval: body.interval || 2
      }, 10000); // 10 second timeout for speed measurement

      return { routerId: id, speed: result.data || result };
    } catch (error: any) {
      return reply.code(503).send({ error: error.message });
    }
  });

  // Get comprehensive network statistics with uptime
  fastify.post('/api/routers/:id/network/comprehensive', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['router-management'],
      summary: 'Get comprehensive network statistics',
      security: [{ bearerAuth: [] }],
      description: 'Get comprehensive network statistics including interface status, statistics, uptime, and speed information'
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as any;
    const { id } = request.params as { id: string };

    const router = await verifyRouterAccess(id, user.userId, user.role);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      // Get all network info in parallel using RouterRpcService
      const [systemInfo, interfaces, statistics] = await Promise.all([
        routerRpcService.getSystemInfo(id).catch(() => null),
        routerRpcService.getNetworkInterfaces(id).catch(() => null),
        executeCommand(id, 'network-statistics', {}).catch(() => null)
      ]);

      return {
        routerId: id,
        systemInfo: systemInfo?.data || systemInfo,
        interfaces: interfaces?.data || interfaces,
        statistics: statistics?.data || statistics,
        timestamp: new Date().toISOString()
      };
    } catch (error: any) {
      return reply.code(503).send({ error: error.message });
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
    const user = request.user as any;
    const { id } = request.params as { id: string };

    const router = await verifyRouterAccess(id, user.userId, user.role);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const systemInfo = await routerRpcService.getSystemInfo(id);
      const sysData = systemInfo.data || systemInfo;
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
    } catch (error: any) {
      return reply.code(503).send({ error: error.message });
    }
  });
}
