import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { renderLoginPage, renderSuccessPage, renderLogonForm } from '../templates/login-page.js';
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
  called?: string;  // Router/AP MAC address
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
 * Compute CHAP response for uspot (OpenWrt captive portal)
 * Algorithm: MD5(0x00 + password + transformed_challenge)
 * If uam_secret exists, challenge is transformed: MD5(challenge_bytes + uam_secret)
 */
function computeChapResponse(password: string, challenge: string, uamSecret?: string): string {
  let challengeBytes = Buffer.from(challenge, 'hex');
  
  if (uamSecret) {
    const transformHash = crypto.createHash('md5');
    transformHash.update(challengeBytes);
    transformHash.update(uamSecret, 'utf8');
    challengeBytes = Buffer.from(transformHash.digest('hex'), 'hex');
  }
  
  const hash = crypto.createHash('md5');
  hash.update(Buffer.from([0x00]));
  hash.update(password, 'utf8');
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

  // GET - Show login page or success page
  fastify.get(uamServerPath, async (request: FastifyRequest<{ Querystring: PortalQuery }>, reply: FastifyReply) => {
    const { res, uamip, uamport, challenge, mac, ip, nasid, sessionid, timeleft, userurl, reply: radiusReply, reason, error } = request.query;

    if (!uamip || !validateRouterIp(uamip)) {
      return reply.code(400).send('Invalid Access: No valid NAS IP detected.');
    }

    const validatedPort = validateRouterPort(uamport, '3990');
    const sanitizedUserUrl = validateAndSanitizeUserUrl(userurl);
    const sessionKey = sessionid || mac || ip || 'anonymous';

    if (res) {
      fastify.log.info(`[UAM] res=${res}, mac=${mac}, ip=${ip}, timeleft=${timeleft}`);
    }

    // Show success page if authenticated
    if (res === 'success') {
      if (sessionid) clearRedirectState(sessionid);
      
      // Look up session and user info for data balance and speed
      let username: string | undefined;
      let dataBalance: { used: bigint; total: bigint | null } | undefined;
      let maxSpeed: { download: bigint | null; upload: bigint | null } | undefined;
      
      try {
        // Find active session by MAC or session ID
        const session = await prisma.radAcct.findFirst({
          where: {
            OR: [
              { callingStationId: mac },
              { acctSessionId: sessionid }
            ],
            acctStopTime: null
          },
          select: { userName: true }
        });
        
        if (session?.userName) {
          username = session.userName;
          
          // Get quota info (data balance)
          const quota = await prisma.radQuota.findFirst({
            where: {
              username: session.userName,
              periodEnd: { gt: new Date() },
              periodStart: { lte: new Date() }
            },
            select: { usedOctets: true, maxOctets: true }
          });
          
          if (quota) {
            dataBalance = { used: quota.usedOctets, total: quota.maxOctets };
          }
          
          // Get speed limits from radreply
          const speedAttrs = await prisma.radReply.findMany({
            where: {
              userName: session.userName,
              attribute: { in: ['WISPr-Bandwidth-Max-Down', 'WISPr-Bandwidth-Max-Up'] }
            },
            select: { attribute: true, value: true }
          });
          
          const downloadSpeed = speedAttrs.find(a => a.attribute === 'WISPr-Bandwidth-Max-Down');
          const uploadSpeed = speedAttrs.find(a => a.attribute === 'WISPr-Bandwidth-Max-Up');
          
          if (downloadSpeed || uploadSpeed) {
            maxSpeed = {
              download: downloadSpeed ? BigInt(downloadSpeed.value) : null,
              upload: uploadSpeed ? BigInt(uploadSpeed.value) : null
            };
          }
        }
      } catch (err) {
        fastify.log.warn(`[UAM] Failed to fetch user info: ${err}`);
      }
      
      const html = renderSuccessPage({
        uamip,
        uamport: validatedPort,
        userurl: sanitizedUserUrl,
        mac,
        ip,
        timeleft,
        sessionid,
        username,
        dataBalance,
        maxSpeed
      });
      return reply.type('text/html').send(html);
    }

    if (checkRedirectLoop(sessionKey)) {
      return reply.code(400).send('Redirect loop detected. Clear browser cache and try again.');
    }

    let errorMessage: string | undefined;
    if (error) errorMessage = error;
    else if (res === 'reject') errorMessage = radiusReply || 'Authentication failed.';
    else if (res === 'failed') errorMessage = reason || 'Authentication failed.';
    else if (res === 'logoff') errorMessage = 'You have been logged off.';

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
    const called = query.called;

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
      // Find router by ID (nasid) or MAC address (called) to get UAM secret
      let routerConfig = null;
      
      if (nasid) {
        routerConfig = await prisma.router.findUnique({
          where: { id: nasid },
          select: { id: true, nasipaddress: true, uamSecret: true, name: true }
        });
      }
      
      if (!routerConfig && called) {
        routerConfig = await prisma.router.findFirst({
          where: { macAddress: { equals: called.toUpperCase(), mode: 'insensitive' } },
          select: { id: true, nasipaddress: true, uamSecret: true, name: true }
        });
      }
      
      if (!routerConfig) {
        fastify.log.error(`[UAM] Router not found: nasid=${nasid}, called=${called}`);
      }

      const nasIp = routerConfig?.nasipaddress || uamip;
      const nasId = routerConfig?.id || nasid;
      const uniqueUamSecret = routerConfig?.uamSecret ?? undefined;

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
      // Use form POST instead of redirect to avoid showing credentials in URL
      const logonUrl = `http://${uamip}:${validatedPort}/logon`;
      
      if (challenge) {
        const chapResponse = computeChapResponse(password, challenge, uniqueUamSecret);
        fastify.log.info(`[UAM] ${username} authenticated, CHAP form (challenge=${challenge.substring(0, 16)}..., uamSecret=${uniqueUamSecret ? 'present' : 'none'})`);
        
        const html = renderLogonForm({
          logonUrl,
          username,
          userurl: sanitizedUserUrl,
          response: chapResponse
        });
        return reply.type('text/html').send(html);
      } else {
        fastify.log.info(`[UAM] ${username} authenticated, PAP form`);
        
        const html = renderLogonForm({
          logonUrl,
          username,
          userurl: sanitizedUserUrl,
          password
        });
        return reply.type('text/html').send(html);
      }
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
