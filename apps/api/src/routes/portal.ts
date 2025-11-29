import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { renderLoginPage } from '../templates/login-page.js';
import { authenticateUser } from '../services/radius-client.js';
import { sendCoARequest, getRouterConfig } from '../services/coa-service.js';

interface PortalQuery {
  nasid?: string;
  uamip?: string;
  uamport?: string;
  userurl?: string;
  error?: string;
}

interface UamLoginBody {
  username?: string;
  password?: string;
  uamip?: string;
  uamport?: string;
  userurl?: string;
  nasid?: string;
}

export async function portalRoutes(fastify: FastifyInstance) {
  const radiusServer1 = process.env.RADIUS_SERVER_1 || '';
  const radiusSecret = process.env.RADIUS_SECRET || '';
  const uamServerUrl = process.env.UAM_SERVER_URL || 'https://api.spotfi.com/uam/login';

  // Extract path from UAM_SERVER_URL for route registration
  let uamServerPath: string;
  try {
    uamServerPath = new URL(uamServerUrl).pathname;
  } catch (error) {
    fastify.log.error(`[UAM] Invalid UAM_SERVER_URL: ${uamServerUrl}. Must be a valid URL (e.g., https://api.spotfi.com/uam/login)`);
    throw new Error(`Invalid UAM_SERVER_URL: ${uamServerUrl}`);
  }

  fastify.get(uamServerPath, async (request: FastifyRequest<{ Querystring: PortalQuery }>, reply: FastifyReply) => {
    const { nasid, uamip, uamport = '80', userurl = 'http://www.google.com', error } = request.query;

    if (!uamip) {
      return reply.code(400).send("Invalid Access: No NAS IP detected.");
    }

    const html = renderLoginPage({
      actionUrl: uamServerUrl,
      uamip,
      uamport,
      userurl: userurl || 'http://www.google.com',
      error
    });

    reply.type('text/html').send(html);
  });

  fastify.post(uamServerPath, async (request: FastifyRequest<{ Body: UamLoginBody; Querystring: PortalQuery }>, reply: FastifyReply) => {
    const body = request.body as UamLoginBody;
    const query = request.query as PortalQuery;
    const { username, password, uamip, uamport = '80', userurl = 'http://www.google.com', nasid } = { ...body, ...query };

    // Helper to avoid infinite redirect loops
    const safeRedirect = (errorMessage: string) => {
      // If we are already in an error state (checked via query params or context), 
      // we might want to show a static error page instead of redirecting.
      // For now, we just append the error.
      return reply.redirect(`${uamServerUrl}?uamip=${uamip || ''}&uamport=${uamport}&userurl=${encodeURIComponent(userurl)}&error=${encodeURIComponent(errorMessage)}`);
    };

    if (!username || !password || !uamip) {
      return safeRedirect('Missing required fields');
    }

    try {
      let routerConfig = nasid ? await getRouterConfig(nasid) : null;
      if (!routerConfig && uamip) {
        routerConfig = await getRouterConfig(undefined, uamip);
      }

      const radiusServer = radiusServer1 || 'localhost';
      const radiusPort = parseInt(process.env.RADIUS_PORT || '1812', 10);
      const routerRadiusSecret = routerConfig?.radiusSecret || radiusSecret;
      const nasIp = routerConfig?.nasipaddress || uamip;
      const nasId = routerConfig?.id || nasid;

      if (!routerRadiusSecret) {
        fastify.log.error(`[UAM] No RADIUS secret configured`);
        return safeRedirect('Server configuration error');
      }

      const authResult = await authenticateUser({
        username,
        password,
        nasIp,
        nasId,
        secret: routerRadiusSecret,
        server: radiusServer,
        port: radiusPort,
        logger: fastify.log
      });

      if (!authResult.success) {
        fastify.log.warn(`[UAM] Authentication failed for ${username}: ${authResult.error}`);
        return safeRedirect('Invalid username or password');
      }

      if (routerConfig) {
        await sendCoARequest({
          nasIp: uamip,
          nasId: routerConfig.id,
          secret: routerRadiusSecret,
          username,
          logger: fastify.log
        });
      }

      return reply.redirect(userurl || 'http://www.google.com');
    } catch (error: any) {
      fastify.log.error(`[UAM] Error processing login: ${error.message}`);
      return safeRedirect('Server error');
    }
  });

  fastify.get('/api', {
    schema: {
      tags: ['portal'],
      summary: 'RFC8908 Captive Portal API',
      querystring: {
        type: 'object',
        properties: {
          nasid: { type: 'string' }
        }
      }
    }
  }, async (request: FastifyRequest<{ Querystring: { nasid?: string } }>, reply: FastifyReply) => {
    const { nasid } = request.query;
    return reply.send({
      captive: true,
      'user-portal-url': `${uamServerUrl}${nasid ? `?nasid=${nasid}` : ''}`
    });
  });
}
