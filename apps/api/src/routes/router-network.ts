import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AuthenticatedUser } from '../types/fastify.js';
import { routerRpcService } from '../services/router-rpc.service.js';
import { routerAccessService } from '../services/router-access.service.js';
import { assertAuthenticated } from '../utils/router-middleware.js';

export async function routerNetworkRoutes(fastify: FastifyInstance) {
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
    assertAuthenticated(request);
    const { id } = request.params as { id: string };
    const body = request.body as { interface?: string };

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const result = await routerRpcService.getNetworkInterfaces(id, body.interface);
      return { routerId: id, interface: body.interface, interfaces: result.result || result };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(503).send({ error: errorMessage });
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
    assertAuthenticated(request);
    const { id } = request.params as { id: string };
    const body = request.body as { interface?: string };

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const interfaceName = body.interface || 'wlan0';
      const result = await routerRpcService.getWirelessStatus(id, interfaceName);
      return { routerId: id, interface: interfaceName, status: result.result || result };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(503).send({ error: errorMessage });
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
    assertAuthenticated(request);
    const { id } = request.params as { id: string };
    const body = request.body as { interface?: string };

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      // Use ubus network.device.status for network statistics
      const result = await routerRpcService.getNetworkStats(id);
      const stats = result.result || result;
      
      // Filter by interface if specified
      if (body.interface && stats) {
        const filtered = Object.keys(stats).reduce((acc: any, key: string) => {
          if (key === body.interface || stats[key]?.name === body.interface) {
            acc[key] = stats[key];
          }
          return acc;
        }, {});
        return { routerId: id, statistics: Object.keys(filtered).length > 0 ? filtered : stats };
      }
      
      return { routerId: id, statistics: stats };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(503).send({ error: errorMessage });
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
    assertAuthenticated(request);
    const { id } = request.params as { id: string };
    const body = request.body as { interface?: string; interval?: number };

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      // Network speed requires two measurements - use network.device.status
      // Note: Real-time speed measurement may need custom implementation
      // For now, return current interface statistics
      if (!body.interface) {
        return reply.code(400).send({ error: 'Interface parameter required for speed measurement' });
      }
      
      const result = await routerRpcService.getNetworkStats(id);
      const stats = result.result || result;
      
      // Find the interface
      const ifaceStats = stats?.[body.interface];
      if (!ifaceStats) {
        return reply.code(404).send({ error: `Interface ${body.interface} not found` });
      }
      
      // Return current statistics (speed calculation would require two measurements)
      return { 
        routerId: id, 
        interface: body.interface,
        speed: {
          rx_bytes: ifaceStats.rx_bytes || 0,
          tx_bytes: ifaceStats.tx_bytes || 0,
          note: 'For real-time speed, two measurements with interval are required. This returns current statistics.'
        }
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(503).send({ error: errorMessage });
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
    assertAuthenticated(request);
    const { id } = request.params as { id: string };

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      // Get all network info in parallel using RouterRpcService
      const [systemInfo, interfaces, statistics] = await Promise.all([
        routerRpcService.getSystemInfo(id).catch(() => null),
        routerRpcService.getNetworkInterfaces(id).catch(() => null),
        routerRpcService.getNetworkStats(id).catch(() => null)
      ]);

      return {
        routerId: id,
        systemInfo: systemInfo?.result || systemInfo,
        interfaces: interfaces?.result || interfaces,
        statistics: statistics?.result || statistics,
        timestamp: new Date().toISOString()
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(503).send({ error: errorMessage });
    }
  });
}

