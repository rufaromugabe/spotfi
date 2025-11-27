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
  const uamServerPath = process.env.UAM_SERVER_PATH || '/uam/login';
  const apiUrl = process.env.API_URL || 'https://api.spotfi.com';

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
      actionUrl: `${apiUrl}${uamServerPath}`,
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
      return reply.redirect(`${uamServerPath}?uamip=${uamip}&uamport=${uamport}&userurl=${encodeURIComponent(userurl)}&error=${encodeURIComponent('Invalid UAM Secret')}`);
    }

    if (!username || !password || !uamip) {
      return reply.redirect(`${uamServerPath}?uamip=${uamip || ''}&uamport=${uamport}&userurl=${encodeURIComponent(userurl)}&error=${encodeURIComponent('Missing required fields')}`);
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
        return reply.redirect(`${uamServerPath}?uamip=${uamip}&uamport=${uamport}&userurl=${encodeURIComponent(userurl)}&error=${encodeURIComponent('Server configuration error')}`);
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
        return reply.redirect(`${uamServerPath}?uamip=${uamip}&uamport=${uamport}&userurl=${encodeURIComponent(userurl)}&error=${encodeURIComponent('Invalid username or password')}`);
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
      return reply.redirect(`${uamServerPath}?uamip=${uamip}&uamport=${uamport}&userurl=${encodeURIComponent(userurl)}&error=${encodeURIComponent('Server error')}`);
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
      'user-portal-url': `${apiUrl}${uamServerPath}${nasid ? `?nasid=${nasid}` : ''}`
    });
  });
}
