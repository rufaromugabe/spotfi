import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { renderLoginPage } from '../templates/login-page.js';
import { authenticateUser } from '../services/radius-client.js';
import { sendCoARequest, getRouterConfig } from '../services/coa-service.js';
import { validateUamSecret, getClientIp } from '../utils/uam-security.js';

interface PortalQuery {
  nasid?: string;
  uamip?: string;
  uamport?: string;
  userurl?: string;
  error?: string;
  uamsecret?: string;
}

interface UamLoginBody {
  username?: string;
  password?: string;
  uamip?: string;
  uamport?: string;
  userurl?: string;
  nasid?: string;
  uamsecret?: string;
}

export async function portalRoutes(fastify: FastifyInstance) {
  const uamSecret = process.env.UAM_SECRET || '';
  const radiusServer1 = process.env.RADIUS_SERVER_1 || '';
  const radiusSecret = process.env.RADIUS_SECRET || '';
  const uamServerUrl = process.env.UAM_SERVER_URL || 'https://api.spotfi.com/uam/login';
  const apiUrl = process.env.API_URL || 'https://api.spotfi.com';
  
  // Extract path from UAM_SERVER_URL for route registration
  let uamServerPath: string;
  try {
    uamServerPath = new URL(uamServerUrl).pathname;
  } catch (error) {
    fastify.log.error(`[UAM] Invalid UAM_SERVER_URL: ${uamServerUrl}. Must be a valid URL (e.g., https://api.spotfi.com/uam/login)`);
    throw new Error(`Invalid UAM_SERVER_URL: ${uamServerUrl}`);
  }

  fastify.get(uamServerPath, async (request: FastifyRequest<{ Querystring: PortalQuery }>, reply: FastifyReply) => {
    const { nasid, uamip, uamport = '80', userurl = 'http://www.google.com', error, uamsecret } = request.query;

    if (uamSecret && !validateUamSecret(request, uamSecret)) {
      fastify.log.warn(`[UAM] Invalid UAM secret from ${getClientIp(request)}`);
      return reply.code(403).send("Invalid UAM Secret");
    }

    if (!uamip) {
      return reply.code(400).send("Invalid Access: No NAS IP detected.");
    }

    const html = renderLoginPage({
      actionUrl: uamServerUrl,
      uamip,
      uamport,
      userurl: userurl || 'http://www.google.com',
      error,
      uamsecret: uamsecret || uamSecret
    });

    reply.type('text/html').send(html);
  });

  fastify.post(uamServerPath, async (request: FastifyRequest<{ Body: UamLoginBody; Querystring: PortalQuery }>, reply: FastifyReply) => {
    const body = request.body as UamLoginBody;
    const query = request.query as PortalQuery;
    const { username, password, uamip, uamport = '80', userurl = 'http://www.google.com', nasid, uamsecret } = { ...body, ...query };

    if (uamSecret && !validateUamSecret(request, uamSecret)) {
      fastify.log.warn(`[UAM] Invalid UAM secret from ${getClientIp(request)}`);
      const secretParam = uamSecret ? `&uamsecret=${encodeURIComponent(uamSecret)}` : '';
      return reply.redirect(`${uamServerUrl}?uamip=${uamip}&uamport=${uamport}&userurl=${encodeURIComponent(userurl)}&error=${encodeURIComponent('Invalid UAM Secret')}${secretParam}`);
    }

    if (!username || !password || !uamip) {
      const secretParam = (uamsecret || uamSecret) ? `&uamsecret=${encodeURIComponent(uamsecret || uamSecret)}` : '';
      return reply.redirect(`${uamServerUrl}?uamip=${uamip || ''}&uamport=${uamport}&userurl=${encodeURIComponent(userurl)}&error=${encodeURIComponent('Missing required fields')}${secretParam}`);
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
        const secretParam = (uamsecret || uamSecret) ? `&uamsecret=${encodeURIComponent(uamsecret || uamSecret)}` : '';
        return reply.redirect(`${uamServerUrl}?uamip=${uamip}&uamport=${uamport}&userurl=${encodeURIComponent(userurl)}&error=${encodeURIComponent('Server configuration error')}${secretParam}`);
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
        const secretParam = (uamsecret || uamSecret) ? `&uamsecret=${encodeURIComponent(uamsecret || uamSecret)}` : '';
        return reply.redirect(`${uamServerUrl}?uamip=${uamip}&uamport=${uamport}&userurl=${encodeURIComponent(userurl)}&error=${encodeURIComponent('Invalid username or password')}${secretParam}`);
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
      const secretParam = (uamsecret || uamSecret) ? `&uamsecret=${encodeURIComponent(uamsecret || uamSecret)}` : '';
      return reply.redirect(`${uamServerUrl}?uamip=${uamip}&uamport=${uamport}&userurl=${encodeURIComponent(userurl)}&error=${encodeURIComponent('Server error')}${secretParam}`);
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
