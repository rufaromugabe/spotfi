import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import formbody from '@fastify/formbody';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { prisma } from './lib/prisma.js';
import { routerCrudRoutes } from './routes/router-crud.js';
import { routerStatsRoutes } from './routes/router-stats.js';
import { routerManagementRoutes } from './routes/router-management.js';
import { routerSystemRoutes } from './routes/router-system.js';
import { routerNetworkRoutes } from './routes/router-network.js';
import { routerConfigRoutes } from './routes/router-config.js';
import { routerUamConfigRoutes } from './routes/router-uam-config.js';
import { authRoutes } from './routes/auth.js';
import { invoiceRoutes } from './routes/invoices.js';
import { portalRoutes } from './routes/portal.js';
import { quotaRoutes } from './routes/quota.js';
import { sessionRoutes } from './routes/sessions.js';
import { planRoutes } from './routes/plans.js';
import { endUserRoutes } from './routes/end-users.js';
import { userPlanRoutes } from './routes/user-plans.js';
import { setupWebSocket } from './websocket/server.js';
import { startScheduler } from './jobs/scheduler.js';
import { terminalRoutes } from './routes/terminal.js';
import { disconnectWorker } from './queues/disconnect-queue.js';
import { reconciliationWorker } from './queues/reconciliation-queue.js';
import { stopPgNotifyListener } from './services/pg-notify.js';
import { initializeSessionCounts } from './services/session-counter.js';
import { initMqtt } from './lib/mqtt.js';
import { commandManager } from './websocket/command-manager.js';

const fastify = Fastify({
  logger: process.env.NODE_ENV === 'development' ? {
    level: 'info',
    transport: {
      target: 'pino-pretty',
      options: {
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname',
      },
    },
  } : true,
});

// Handle BigInt serialization in JSON responses
// @ts-ignore
BigInt.prototype.toJSON = function () {
  return this.toString();
};

// Register plugins
await fastify.register(cors, {
  origin: process.env.CORS_ORIGIN || '*',
});

await fastify.register(formbody); // Support application/x-www-form-urlencoded

await fastify.register(jwt, {
  secret: process.env.JWT_SECRET || 'change-me-in-production-secret-key',
});

if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'change-me-in-production-secret-key')) {
  fastify.log.warn('🚨 SECURITY WARNING: Using default JWT secret in production! Please set JWT_SECRET.');
}

// Register Swagger
await fastify.register(swagger, {
  openapi: {
    info: {
      title: 'SpotFi API',
      description: 'Cloud ISP Management Platform API',
      version: '1.0.0',
    },
    servers: [
      {
        url: process.env.API_URL || 'http://localhost:8080',
        description: 'Development server',
      },
    ],
    tags: [
      { name: 'auth', description: 'Authentication endpoints' },
      { name: 'routers', description: 'Router management endpoints' },
      { name: 'router-management', description: 'Router remote management via WebSocket bridge' },
      { name: 'invoices', description: 'Billing and invoice endpoints' },
      { name: 'quota', description: 'User quota management endpoints' },
      { name: 'sessions', description: 'Active session management and remote disconnect' },
      { name: 'plans', description: 'Service plan management (CRUD)' },
      { name: 'end-users', description: 'End user registration and management' },
      { name: 'user-plans', description: 'User plan assignment and management' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
  },
});

// Register Swagger UI
await fastify.register(swaggerUi, {
  routePrefix: '/docs',
  uiConfig: {
    docExpansion: 'list',
    deepLinking: false,
  },
  staticCSP: true,
  transformStaticCSP: (header) => header,
});

await fastify.register(websocket);

// Add authenticate decorator
fastify.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
  try {
    const decoded = await request.jwtVerify() as { userId: string; email: string; role: 'ADMIN' | 'HOST' };
    request.user = {
      userId: decoded.userId,
      email: decoded.email,
      role: decoded.role,
    };
  } catch (err) {
    reply.code(401).send({ error: 'Unauthorized' });
  }
});

// Register routes
await fastify.register(authRoutes);
await fastify.register(routerCrudRoutes, { prefix: '/api/routers' });
await fastify.register(routerStatsRoutes, { prefix: '/api/routers' });
await fastify.register(routerManagementRoutes);
await fastify.register(routerSystemRoutes);
await fastify.register(routerNetworkRoutes);
await fastify.register(routerConfigRoutes);
await fastify.register(routerUamConfigRoutes);
await fastify.register(invoiceRoutes);
await fastify.register(portalRoutes);
await fastify.register(quotaRoutes);
await fastify.register(sessionRoutes);
await fastify.register(planRoutes);
await fastify.register(endUserRoutes);
await fastify.register(userPlanRoutes);
await fastify.register(terminalRoutes);

// Setup WebSocket server
// Initialize MQTT connection
// The API uses a generated JWT token for authentication with EMQX
// This replaces the legacy password-based authentication for the backend
const mqttBroker = process.env.MQTT_BROKER_URL || 'mqtt://emqx:1883';
// Default to 'api_user' to match the ACL query in docker-compose
const mqttUsername = process.env.MQTT_USERNAME || 'api_user'; 

// Generate JWT for backend access
// This uses the same JWT_SECRET shared with EMQX
// Generate a long-lived token (10 years) for the backend service
// Payload 'username' must match the MQTT username for ACL checks
const mqttPassword = fastify.jwt.sign({
  username: mqttUsername,
  superuser: true
}, { expiresIn: '3650d' }); 

fastify.log.info(`Generated JWT for MQTT authentication (user: ${mqttUsername})`);

const mqttService = initMqtt(mqttBroker, fastify.log, mqttUsername, mqttPassword);

// Setup WebSocket server (now safe after MQTT is ready)
setupWebSocket(fastify);

import { MqttHandler } from './services/mqtt-handler.js';
new MqttHandler(fastify.log).setup();

// Configure CommandManager to use MQTT
// Set logger for command manager to enable RPC logging
commandManager.setLogger(fastify.log);

// Subscribe to response topic for all routers
// Note: Using regular subscription (not shared) for single-instance deployments
// For multi-instance, use: $share/api_cluster/spotfi/router/+/rpc/response
const responseTopic = 'spotfi/router/+/rpc/response';
mqttService.subscribe(responseTopic, (topic: string, message: any) => {
  // Extract command ID from message (assumes message has id field)
  if (message.id) {
    fastify.log.info(`[RPC] Received response for command ${message.id} from ${topic}`);
    commandManager.handleResponse(message.id, message);
  } else {
    fastify.log.warn(`[RPC] Received response without command ID from ${topic}:`, message);
  }
});
fastify.log.info(`[RPC] Subscribed to MQTT response topic: ${responseTopic}`);


// Health check
fastify.get('/health', {
  schema: {
    tags: ['health'],
    summary: 'Health check',
    description: 'Check if the API server is running',
    response: {
      200: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
}, async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// Start server
const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '8080', 10);
    const host = process.env.HOST || '0.0.0.0';

    await fastify.listen({ port, host });

    console.log(`🚀 Server listening on ${host}:${port}`);

    // Start BullMQ worker (handles disconnect jobs)
    console.log('🚀 Starting BullMQ disconnect worker...');
    // Worker is already initialized when imported (singleton pattern)

    // Start production scheduler
    startScheduler();

    // Initialize Redis session counts (async, don't block startup)
    initializeSessionCounts(fastify.log).catch((err) => {
      fastify.log.warn(`Failed to initialize session counts: ${err.message}`);
    });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();

// Graceful shutdown
process.on('SIGTERM', async () => {
  await fastify.close();
  await stopPgNotifyListener(fastify.log);
  await prisma.$disconnect();
  await disconnectWorker.close();
  await reconciliationWorker.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await fastify.close();
  await stopPgNotifyListener(fastify.log);
  await prisma.$disconnect();
  await disconnectWorker.close();
  await reconciliationWorker.close();
  process.exit(0);
});

