import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { renderLoginPage } from '../templates/login-page.js';
import { authenticateUser } from '../services/radius-client.js';
import { prisma } from '../lib/prisma.js';
import {
  validateAndSanitizeUserUrl,
  validateRouterIp,
  validateRouterPort,
  checkRedirectLoop,
  clearRedirectState
} from '../utils/portal-security.js';
import crypto from 'crypto';

interface PortalQuery {
  res?: string;
  uamip?: string;
  uamport?: string;
  challenge?: string;
  mac?: string;
  ip?: string;
  called?: string;
  nasid?: string;
  sessionid?: string;
  timeleft?: string;
  userurl?: string;
  reply?: string;
  reason?: string;
  error?: string;
}

interface UamLoginBody {
  username?: string;
  password?: string;
  uamip?: string;
  uamport?: string;
  userurl?: string;
  nasid?: string;
  challenge?: string;
  mac?: string;
  sessionid?: string;
}

/**
 * Compute CHAP response: MD5(0x00 + password + [uamSecret] + challenge)
 */
function computeChapResponse(password: string, challenge: string, uamSecret?: string): string {
  const challengeBytes = Buffer.from(challenge, 'hex');
  const hash = crypto.createHash('md5');
  hash.update(Buffer.from([0x00]));
  hash.update(password, 'utf8');
  if (uamSecret) {
    hash.update(uamSecret, 'utf8');
  }
  hash.update(challengeBytes);
  return hash.digest('hex');
}

export async function portalRoutes(fastify: FastifyInstance) {
  const radiusServer = process.env.RADIUS_SERVER_1 || 'localhost';
  const radiusPort = parseInt(process.env.RADIUS_PORT || '1812', 10);
  const masterSecret = process.env.RADIUS_MASTER_SECRET || '';
  const uamServerUrl = process.env.UAM_SERVER_URL || 'https://api.spotfi.com/uam/login';

  if (!masterSecret) {
    fastify.log.warn('[Portal] RADIUS_MASTER_SECRET not set');
  }

  let uamServerPath: string;
  try {
    uamServerPath = new URL(uamServerUrl).pathname;
  } catch {
    throw new Error(`Invalid UAM_SERVER_URL: ${uamServerUrl}`);
  }

  // GET - Show login page
  fastify.get(uamServerPath, async (request: FastifyRequest<{ Querystring: PortalQuery }>, reply: FastifyReply) => {
    const { res, uamip, uamport, challenge, mac, ip, nasid, sessionid, userurl, reply: radiusReply, reason, error } = request.query;

    if (!uamip || !validateRouterIp(uamip)) {
      return reply.code(400).send('Invalid Access: No valid NAS IP detected.');
    }

    const validatedPort = validateRouterPort(uamport, '3990');
    const sanitizedUserUrl = validateAndSanitizeUserUrl(userurl);
    const sessionKey = sessionid || mac || ip || 'anonymous';

    if (checkRedirectLoop(sessionKey)) {
      return reply.code(400).send('Redirect loop detected. Clear browser cache and try again.');
    }

    let errorMessage: string | undefined;
    if (error) errorMessage = error;
    else if (res === 'reject') errorMessage = radiusReply || 'Authentication failed.';
    else if (res === 'failed') errorMessage = reason || 'Authentication failed.';
    else if (res === 'logoff') errorMessage = 'You have been logged off.';

    if (res) {
      fastify.log.info(`[UAM] res=${res}, mac=${mac}, challenge=${challenge ? 'yes' : 'no'}`);
    }

    const html = renderLoginPage({
      actionUrl: uamServerUrl,
      uamip,
      uamport: validatedPort,
      userurl: sanitizedUserUrl,
      error: errorMessage,
      challenge,
      mac,
      nasid,
      sessionid
    });
    
    reply.type('text/html').send(html);
  });

  // POST - Handle login
  fastify.post(uamServerPath, async (request: FastifyRequest<{ Body: UamLoginBody; Querystring: PortalQuery }>, reply: FastifyReply) => {
    const body = request.body as UamLoginBody;
    const query = request.query as PortalQuery;
    
    const username = body.username;
    const password = body.password;
    const uamip = body.uamip || query.uamip;
    const uamport = body.uamport || query.uamport;
    const userurl = body.userurl || query.userurl;
    const nasid = body.nasid || query.nasid;
    const sessionid = body.sessionid || query.sessionid || query.mac || query.ip;
    const challenge = body.challenge || query.challenge;

    if (!uamip || !validateRouterIp(uamip)) {
      return reply.code(400).send('Invalid Access: No valid NAS IP detected.');
    }

    const validatedPort = validateRouterPort(uamport, '3990');
    const sanitizedUserUrl = validateAndSanitizeUserUrl(userurl);

    const safeRedirect = (errorMessage: string) => {
      const params = new URLSearchParams({
        uamip, uamport: validatedPort, userurl: sanitizedUserUrl, error: errorMessage
      });
      return reply.redirect(`${uamServerUrl}?${params}`);
    };

    if (!username || !password) {
      return safeRedirect('Missing required fields');
    }

    if (!masterSecret) {
      fastify.log.error('[UAM] RADIUS_MASTER_SECRET not configured');
      return safeRedirect('Server configuration error');
    }

    try {
      // Find router to get unique UAM secret
      let routerConfig = null;
      if (nasid) {
        routerConfig = await prisma.router.findUnique({
          where: { id: nasid },
          select: { id: true, nasipaddress: true, radiusSecret: true }
        });
      } else if (uamip) {
        routerConfig = await prisma.router.findFirst({
          where: { nasipaddress: uamip },
          select: { id: true, nasipaddress: true, radiusSecret: true }
        });
      }

      const nasIp = routerConfig?.nasipaddress || uamip;
      const nasId = routerConfig?.id || nasid;
      const uniqueUamSecret = routerConfig?.radiusSecret ?? undefined;

      // Authenticate with RADIUS using master secret
      const authResult = await authenticateUser({
        username,
        password,
        nasIp,
        nasId,
        secret: masterSecret,
        server: radiusServer,
        port: radiusPort,
        logger: fastify.log
      });

      if (!authResult.success) {
        fastify.log.warn(`[UAM] Auth failed for ${username}: ${authResult.error}`);
        return safeRedirect('Invalid username or password');
      }

      if (sessionid) clearRedirectState(sessionid);

      // Build logon URL - use CHAP if challenge present, else PAP
      let logonUrl: string;
      const baseParams = `username=${encodeURIComponent(username)}&userurl=${encodeURIComponent(sanitizedUserUrl)}`;
      
      if (challenge) {
        const chapResponse = computeChapResponse(password, challenge, uniqueUamSecret);
        logonUrl = `http://${uamip}:${validatedPort}/logon?${baseParams}&response=${chapResponse}`;
        fastify.log.info(`[UAM] ${username} authenticated, CHAP redirect`);
      } else {
        logonUrl = `http://${uamip}:${validatedPort}/logon?${baseParams}&password=${encodeURIComponent(password)}`;
        fastify.log.info(`[UAM] ${username} authenticated, PAP redirect`);
      }
      
      return reply.redirect(logonUrl);
    } catch (error: any) {
      fastify.log.error(`[UAM] Login error: ${error.message}`);
      return safeRedirect('Server error');
    }
  });

  // RFC 8908 Captive Portal API
  fastify.get('/api', {
    schema: {
      tags: ['portal'],
      summary: 'RFC 8908 Captive Portal API',
      querystring: { type: 'object', properties: { nasid: { type: 'string' } } }
    }
  }, async (request: FastifyRequest<{ Querystring: { nasid?: string } }>, reply: FastifyReply) => {
    const { nasid } = request.query;
    reply.type('application/captive+json');
    return reply.send({
      captive: true,
      'user-portal-url': `${uamServerUrl}${nasid ? `?nasid=${encodeURIComponent(nasid)}` : ''}`
    });
  });

  // Android captive portal detection
  fastify.get('/generate_204', async (_request, reply) => reply.code(302).redirect('/api'));

  // iOS/macOS captive portal detection
  fastify.get('/hotspot-detect.html', async (_request, reply) => reply.code(302).redirect('/api'));
}
