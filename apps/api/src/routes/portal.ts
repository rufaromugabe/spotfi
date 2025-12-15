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
  // uspot UAM redirect parameters (from uspot documentation)
  res?: string;           // Result: already, success, reject, notyet, logoff, failed
  uamip?: string;         // uspot local web server address
  uamport?: string;       // uspot local UAM server port
  challenge?: string;     // MD5 challenge string for CHAP
  mac?: string;           // Client MAC address
  ip?: string;            // Client IP address
  called?: string;        // NAS MAC (nasmac)
  nasid?: string;         // NAS identifier
  sessionid?: string;     // Unique session identifier
  timeleft?: string;      // Seconds remaining (if timeout set)
  userurl?: string;       // Original URL the user was trying to access
  reply?: string;         // Reply-Message from RADIUS
  reason?: string;        // Failure reason (when res=failed)
  // SpotFi internal
  error?: string;         // Error message to display
}

interface UamLoginBody {
  username?: string;
  password?: string;
  uamip?: string;
  uamport?: string;
  userurl?: string;
  nasid?: string;
  // CHAP authentication fields
  challenge?: string;
  mac?: string;
  sessionid?: string;
}

/**
 * Compute CHAP response for uspot authentication
 * Response = MD5(0x00 + password + secret + hexDecode(challenge))
 * 
 * DUAL SECRET ARCHITECTURE:
 * - The uam_secret (per-router) is used for portal verification
 * - This provides security isolation between routers
 */
function computeChapResponse(password: string, challenge: string, uamSecret?: string): string {
  // Decode hex challenge string to bytes
  const challengeBytes = Buffer.from(challenge, 'hex');
  
  // CHAP response: MD5(0x00 + password + [uam_secret] + challenge)
  // The 0x00 is the CHAP identifier (typically 0 for uspot)
  // The uam_secret must match the router's configured uam_secret
  const hash = crypto.createHash('md5');
  hash.update(Buffer.from([0x00])); // CHAP identifier
  hash.update(password, 'utf8');
  if (uamSecret) {
    hash.update(uamSecret, 'utf8');
  }
  hash.update(challengeBytes);
  
  return hash.digest('hex');
}

export async function portalRoutes(fastify: FastifyInstance) {
  const radiusServer1 = process.env.RADIUS_SERVER_1 || '';
  // SECURITY: Use Master Secret from environment for all RADIUS authentication
  // This is the single source of truth for RADIUS shared secret
  const masterSecret = process.env.RADIUS_MASTER_SECRET || '';
  const uamServerUrl = process.env.UAM_SERVER_URL || 'https://api.spotfi.com/uam/login';
  
  if (!masterSecret) {
    fastify.log.warn('[Portal] RADIUS_MASTER_SECRET not set - RADIUS authentication will fail');
  }

  // Extract path from UAM_SERVER_URL for route registration
  let uamServerPath: string;
  try {
    uamServerPath = new URL(uamServerUrl).pathname;
  } catch (error) {
    fastify.log.error(`[UAM] Invalid UAM_SERVER_URL: ${uamServerUrl}. Must be a valid URL (e.g., https://api.spotfi.com/uam/login)`);
    throw new Error(`Invalid UAM_SERVER_URL: ${uamServerUrl}`);
  }

  fastify.get(uamServerPath, async (request: FastifyRequest<{ Querystring: PortalQuery }>, reply: FastifyReply) => {
    const { 
      res, uamip, uamport, challenge, mac, ip, called, nasid, sessionid,
      userurl, reply: radiusReply, reason, error 
    } = request.query;

    // SECURITY: Validate router IP address
    if (!uamip || !validateRouterIp(uamip)) {
      fastify.log.warn(`[UAM] Invalid or missing router IP: ${uamip}`);
      return reply.code(400).send("Invalid Access: No valid NAS IP detected.");
    }

    // SECURITY: Validate and sanitize port
    const validatedPort = validateRouterPort(uamport, '3990');

    // SECURITY: Validate and sanitize user URL (prevents open redirect)
    const sanitizedUserUrl = validateAndSanitizeUserUrl(userurl);

    // SECURITY: Check for redirect loops
    const sessionId = sessionid || mac || ip || 'anonymous';
    if (checkRedirectLoop(sessionId)) {
      fastify.log.warn(`[UAM] Redirect loop detected for session: ${sessionId}`);
      return reply.code(400).send("Redirect loop detected. Please clear your browser cache and try again.");
    }

    // Error message handling
    let errorMessage: string | undefined;
    if (error) {
      errorMessage = error;
    } else if (res === 'reject') {
      errorMessage = radiusReply || 'Authentication failed. Please check your credentials.';
    } else if (res === 'failed') {
      errorMessage = reason || 'Authentication failed. Please try again.';
    } else if (res === 'logoff') {
      errorMessage = 'You have been logged off.';
    }

    // Log the UAM request for debugging
    if (res) {
      fastify.log.info(`[UAM] Received redirect: res=${res}, mac=${mac}, ip=${ip}, challenge=${challenge ? 'yes' : 'no'}`);
    }

    const html = renderLoginPage({
      actionUrl: uamServerUrl,
      uamip,
      uamport: validatedPort,
      userurl: sanitizedUserUrl,
      error: errorMessage,
      // Pass additional params for form submission
      challenge,
      mac,
      nasid,
      sessionid
    });
    
    reply.type('text/html').send(html);
  });

  fastify.post(uamServerPath, async (request: FastifyRequest<{ Body: UamLoginBody; Querystring: PortalQuery }>, reply: FastifyReply) => {
    const body = request.body as UamLoginBody;
    const query = request.query as PortalQuery;
    
    // Extract and validate inputs
    const username = body.username;
    const password = body.password;
    const uamip = body.uamip || query.uamip;
    const uamport = body.uamport || query.uamport;
    const userurl = body.userurl || query.userurl;
    const nasid = body.nasid || query.nasid;
    const sessionid = body.sessionid || query.sessionid || query.mac || query.ip;
    // CHAP challenge - from form body (preferred) or query string
    const challenge = body.challenge || query.challenge;

    // SECURITY: Validate router IP
    if (!uamip || !validateRouterIp(uamip)) {
      fastify.log.warn(`[UAM] Invalid router IP in POST: ${uamip}`);
      return reply.code(400).send("Invalid Access: No valid NAS IP detected.");
    }

    // SECURITY: Validate and sanitize port
    const validatedPort = validateRouterPort(uamport, '3990');

    // SECURITY: Validate and sanitize user URL (prevents open redirect)
    const sanitizedUserUrl = validateAndSanitizeUserUrl(userurl);

    // Helper to avoid infinite redirect loops
    const safeRedirect = (errorMessage: string) => {
      const errorParam = encodeURIComponent(errorMessage);
      return reply.redirect(`${uamServerUrl}?uamip=${encodeURIComponent(uamip)}&uamport=${encodeURIComponent(validatedPort)}&userurl=${encodeURIComponent(sanitizedUserUrl)}&error=${errorParam}`);
    };

    if (!username || !password) {
      return safeRedirect('Missing required fields');
    }

    try {
      // Get router config for RADIUS authentication and UAM secret
      // DUAL SECRET ARCHITECTURE:
      // - masterSecret (from ENV): Used for RADIUS authentication
      // - uniqueUamSecret (from DB): Used for CHAP response calculation
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

      const radiusServer = radiusServer1 || 'localhost';
      const radiusPort = parseInt(process.env.RADIUS_PORT || '1812', 10);
      const nasIp = routerConfig?.nasipaddress || uamip;
      const nasId = routerConfig?.id || nasid;
      // Unique UAM secret for CHAP calculation (per-router isolation)
      const uniqueUamSecret = routerConfig?.radiusSecret;

      // SECURITY: Always use Master Secret from environment
      // Never use per-router secrets - all routers share the same secret
      if (!masterSecret) {
        fastify.log.error(`[UAM] CRITICAL: RADIUS_MASTER_SECRET not configured in environment`);
        return safeRedirect('Server configuration error');
      }

      const authResult = await authenticateUser({
        username,
        password,
        nasIp,
        nasId,
        secret: masterSecret, // SECURITY: Use master secret from environment
        server: radiusServer,
        port: radiusPort,
        logger: fastify.log
      });

      if (!authResult.success) {
        fastify.log.warn(`[UAM] Authentication failed for ${username}: ${authResult.error}`);
        return safeRedirect('Invalid username or password');
      }

      // SECURITY: Clear redirect state on successful auth
      if (sessionid) {
        clearRedirectState(sessionid);
      }

      // Successful authentication - redirect to router's logon endpoint to complete UAM flow
      // uspot expects either:
      //   - PAP mode: /logon?username=X&password=Y (password in plaintext)
      //   - CHAP mode: /logon?username=X&response=Y (CHAP response hash)
      // 
      // IMPORTANT: If router provides a challenge, we MUST use CHAP mode
      // Otherwise the router will reject the authentication with res=reject
      // 
      // DUAL SECRET ARCHITECTURE for CHAP:
      // - Master Secret: Used for RADIUS authentication (above)
      // - Unique UAM Secret: Used for CHAP response calculation (per-router)
      // 
      // SECURITY: Use sanitized user URL to prevent open redirect
      let logonUrl: string;
      
      if (challenge && uniqueUamSecret) {
        // CHAP mode: compute response = MD5(0x00 + password + uam_secret + challenge)
        // The unique UAM secret provides per-router security isolation
        const chapResponse = computeChapResponse(password, challenge, uniqueUamSecret);
        logonUrl = `http://${uamip}:${validatedPort}/logon?username=${encodeURIComponent(username)}&response=${chapResponse}&userurl=${encodeURIComponent(sanitizedUserUrl)}`;
        fastify.log.info(`[UAM] Authentication successful for ${username}, redirecting with CHAP response (unique secret)`);
      } else if (challenge) {
        // CHAP mode without unique secret (fallback to standard CHAP)
        fastify.log.warn(`[UAM] Router ${nasId} has no unique UAM secret, using standard CHAP`);
        const chapResponse = computeChapResponse(password, challenge);
        logonUrl = `http://${uamip}:${validatedPort}/logon?username=${encodeURIComponent(username)}&response=${chapResponse}&userurl=${encodeURIComponent(sanitizedUserUrl)}`;
        fastify.log.info(`[UAM] Authentication successful for ${username}, redirecting with CHAP response (standard)`);
      } else {
        // PAP mode: send password in plaintext (only for local network)
        logonUrl = `http://${uamip}:${validatedPort}/logon?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&userurl=${encodeURIComponent(sanitizedUserUrl)}`;
        fastify.log.info(`[UAM] Authentication successful for ${username}, redirecting with PAP password`);
      }
      
      return reply.redirect(logonUrl);
    } catch (error: any) {
      fastify.log.error(`[UAM] Error processing login: ${error.message}`);
      return safeRedirect('Server error');
    }
  });

  // RFC 8908 Captive Portal API endpoint
  // Handles detection requests from Android, iOS, Windows, macOS
  fastify.get('/api', {
    schema: {
      tags: ['portal'],
      summary: 'RFC 8908 Captive Portal API',
      description: 'Returns JSON indicating captive portal status per RFC 8908',
      querystring: {
        type: 'object',
        properties: {
          nasid: { type: 'string' }
        }
      }
    }
  }, async (request: FastifyRequest<{ Querystring: { nasid?: string } }>, reply: FastifyReply) => {
    const { nasid } = request.query;
    
    // SECURITY: Set proper Content-Type per RFC 8908
    reply.type('application/captive+json');
    
    // RFC 8908 compliant response
    const response: Record<string, unknown> = {
      captive: true,
      'user-portal-url': `${uamServerUrl}${nasid ? `?nasid=${encodeURIComponent(nasid)}` : ''}`
    };

    // Optional RFC 8908 fields (uncomment if needed)
    // response['venue-info-url'] = `${uamServerUrl}/terms`; // Terms of service URL
    // response['can-extend-session'] = false; // Whether user can extend session
    // response['seconds-remaining'] = 3600; // Session timeout in seconds (if applicable)

    return reply.send(response);
  });

  // Android captive portal detection endpoint
  // Android checks http://connectivitycheck.gstatic.com/generate_204
  // Router redirects this to our API endpoint
  fastify.get('/generate_204', async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(302).redirect('/api');
  });

  // iOS/macOS captive portal detection endpoint
  // iOS checks http://captive.apple.com/hotspot-detect.html
  // Router redirects this to our API endpoint
  fastify.get('/hotspot-detect.html', async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(302).redirect('/api');
  });
}
