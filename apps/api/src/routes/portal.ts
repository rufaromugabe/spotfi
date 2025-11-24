import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { renderLoginPage } from '../templates/login-page.js';

interface PortalQuery {
  nasid?: string;
  uamip?: string; // uspot sends 'uamip', not just 'ip'
  uamport?: string;
  userurl?: string;
  error?: string;
}

export async function portalRoutes(fastify: FastifyInstance) {
  // 1. Serve Login Page
  fastify.get('/portal', async (request: FastifyRequest<{ Querystring: PortalQuery }>, reply: FastifyReply) => {
    const { nasid, uamip, uamport = '80', userurl = 'http://www.google.com', error } = request.query;

    // Security: Don't serve login form if not triggered by a router
    if (!uamip) {
      return reply.code(400).send("Invalid Access: No NAS IP detected.");
    }

    const html = renderLoginPage({
      actionUrl: `http://${uamip}:${uamport}/login`,
      uamip,
      uamport,
      userurl: userurl || 'http://www.google.com',
      error
    });

    reply.type('text/html').send(html);
  });

  // 2. API endpoint for RFC8908 (Captive Portal API)
  // This stays on the cloud because option 114 points here.
  fastify.get('/api/captive-portal', async (request, reply) => {
    return {
      "captive": true,
      "user-portal-url": `${process.env.API_URL || 'https://api.spotfi.com'}/portal`
    };
  });

  // RFC8908 Captive Portal API endpoint (standard requirement)
  fastify.get('/api', {
    schema: {
      tags: ['portal'],
      summary: 'RFC8908 Captive Portal API',
      description: 'Provides portal information for automatic device detection',
      querystring: {
        type: 'object',
        properties: {
          nasid: { type: 'string' },
          username: { type: 'string' }
        }
      }
    }
  }, async (request: FastifyRequest<{ Querystring: { nasid?: string } }>, reply: FastifyReply) => {
    const { nasid } = request.query;
    
    const response: any = {
      captive: true,
      'user-portal-url': `${process.env.API_URL || 'https://api.spotfi.com'}/portal${nasid ? `?nasid=${nasid}` : ''}`
    };

    return reply.send(response);
  });

  // Logout endpoint (for uspot)
  fastify.get('/portal/logout', async (request: FastifyRequest<{ Querystring: PortalQuery }>, reply: FastifyReply) => {
    const query = request.query;
    const userurl = query.userurl || 'http://www.google.com';

    // Uspot handles logout internally, just redirect to destination
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta http-equiv="refresh" content="0;url=${userurl}">
    <script>window.location.href = "${userurl}";</script>
</head>
<body>
    <p>Logging out...</p>
    <p>If you are not redirected, <a href="${userurl}">click here</a>.</p>
</body>
</html>
    `;

    return reply.type('text/html').send(html);
  });
}
