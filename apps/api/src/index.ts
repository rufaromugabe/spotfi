import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import formbody from '@fastify/formbody';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { prisma } from './lib/prisma.js';
import { routerRoutes } from './routes/routers.js';
import { authRoutes } from './routes/auth.js';
import { invoiceRoutes } from './routes/invoices.js';
import { portalRoutes } from './routes/portal.js';
import { setupWebSocket } from './websocket/server.js';
import { startScheduler } from './jobs/scheduler.js';

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

// Register plugins
await fastify.register(cors, {
  origin: process.env.CORS_ORIGIN || '*',
});

await fastify.register(formbody); // Support application/x-www-form-urlencoded

await fastify.register(jwt, {
  secret: process.env.JWT_SECRET || 'change-me-in-production-secret-key',
});

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
      { name: 'invoices', description: 'Billing and invoice endpoints' },
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
    const decoded = await request.jwtVerify() as any;
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
await fastify.register(routerRoutes, { prefix: '/api/routers' });
await fastify.register(invoiceRoutes);
await fastify.register(portalRoutes);

// Setup WebSocket server
setupWebSocket(fastify);

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
    
// Start production scheduler
startScheduler();
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();

// Graceful shutdown
process.on('SIGTERM', async () => {
  await fastify.close();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await fastify.close();
  await prisma.$disconnect();
  process.exit(0);
});

