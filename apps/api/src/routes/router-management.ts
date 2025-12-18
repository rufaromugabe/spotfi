import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AuthenticatedUser } from '../types/fastify.js';
import { routerRpcService } from '../services/router-rpc.service.js';
import { routerAccessService } from '../services/router-access.service.js';
import { assertAuthenticated, requireAdmin } from '../utils/router-middleware.js';

export async function routerManagementRoutes(fastify: FastifyInstance) {
  // Get connected devices (DHCP leases)
  fastify.post('/api/routers/:id/dhcp/leases', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['router-management'],
      summary: 'Get DHCP leases (connected devices)',
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
      const result = await routerRpcService.rpcCall(id, 'dhcp', 'ipv4leases', {});
      return { routerId: id, leases: result.result || result };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(503).send({ error: errorMessage });
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
    assertAuthenticated(request);
    const { id } = request.params as { id: string };
    const { macAddress } = request.body as { macAddress: string };

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      // Use uspot's native client_get via ubus
      const result = await routerRpcService.getClientInfo(id, macAddress);
      return { routerId: id, session: result.result || result };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(503).send({ error: errorMessage });
    }
  });

  // Allowed commands whitelist for security
  const ALLOWED_COMMANDS: Record<string, (target?: string) => string[]> = {
    ping: (target) => ['ping', '-c', '4', target || 'google.com'],
    traceroute: (target) => ['traceroute', target || 'google.com'],
    nslookup: (target) => ['nslookup', target || 'google.com'],
    'cert-refresh': () => ['/usr/bin/spotfi-cert-refresh.sh'],
    'service-restart': () => ['/etc/init.d/network', 'restart']
  };

  // Execute shell command (admin only for security)
  fastify.post('/api/routers/:id/command/execute', {
    preHandler: [fastify.authenticate, requireAdmin],
    schema: {
      tags: ['router-management'],
      summary: 'Execute shell command on router',
      security: [{ bearerAuth: [] }],
      description: 'Execute a permitted shell command on the router (Admin only)',
      body: {
        type: 'object',
        required: ['command'],
        properties: {
          command: { type: 'string', enum: Object.keys(ALLOWED_COMMANDS), description: 'Command to execute' },
          target: { type: 'string', description: 'Optional target for network commands (IP/Domain)' },
          timeout: { type: 'number', default: 10000, description: 'Command timeout in milliseconds' }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    assertAuthenticated(request);
    const { id } = request.params as { id: string };
    const body = request.body as { command: string; target?: string; timeout?: number };

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    const commandGenerator = ALLOWED_COMMANDS[body.command];
    if (!commandGenerator) {
      return reply.code(400).send({ error: 'Command not allowed' });
    }

    try {
      const execParamsRaw = commandGenerator(body.target);
      const execCmd = execParamsRaw[0];
      const execParams = execParamsRaw.slice(1);

      const result = await routerRpcService.rpcCall(id, 'file', 'exec', {
        command: execCmd,
        params: execParams
      }, body.timeout || 10000);

      return { routerId: id, command: body.command, result: result.result || result };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(503).send({ error: errorMessage });
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
    assertAuthenticated(request);
    const { id } = request.params as { id: string };
    const body = request.body as { lines?: number };

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      // Use ubus log.read
      const result = await routerRpcService.rpcCall(id, 'log', 'read', {
        lines: body.lines || 50
      });
      return { routerId: id, logs: result.result || result };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(503).send({ error: errorMessage });
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
    assertAuthenticated(request);
    const { id } = request.params as { id: string };
    const body = request.body as { path: string };

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      // Use ubus file.read
      const result = await routerRpcService.rpcCall(id, 'file', 'read', {
        path: body.path
      });
      return { routerId: id, path: body.path, content: result.result || result };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(503).send({ error: errorMessage });
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
    assertAuthenticated(request);
    const { id, action } = request.params as { id: string; action: string };
    const body = request.body as { service: string };

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      // Use ubus service.* methods
      const result = await routerRpcService.rpcCall(id, 'service', action, {
        name: body.service
      });
      return { routerId: id, service: body.service, action, result: result.result || result };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(503).send({ error: errorMessage });
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
    assertAuthenticated(request);
    const { id } = request.params as { id: string };
    const body = request.body as { namespace: string; method: string; args?: any };

    const router = await routerAccessService.verifyRouterAccess(id, request.user as AuthenticatedUser);
    if (!router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    try {
      const result = await routerRpcService.rpcCall(id, body.namespace, body.method, body.args || {});
      return { routerId: id, namespace: body.namespace, method: body.method, result: result.result || result };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(503).send({ error: errorMessage });
    }
  });
}
