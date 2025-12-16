import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { renderLoginPage, renderSuccessPage, renderLogonForm } from '../templates/login-page.js';
import { authenticateUser } from '../services/radius-client.js';
import { prisma } from '../lib/prisma.js';
import {
  validateAndSanitizeUserUrl,
  validateRouterIp,
  validateRouterPort,
  checkRedirectLoop,
  clearRedirectState,
  getRedirectState,
  checkLoginRateLimit,
  clearLoginRateLimit,
  getRemainingBlockTime,
  getSecurityHeaders,
  escapeHtml
} from '../utils/portal-security.js';
import crypto from 'crypto';

// In-memory cache for username lookup (sessionid -> username)
// Cleans up after 5 minutes
const usernameCache = new Map<string, { username: string; expiresAt: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function cacheUsername(sessionid: string, username: string): void {
  usernameCache.set(sessionid, {
    username,
    expiresAt: Date.now() + CACHE_TTL
  });
  
  // Cleanup expired entries periodically
  if (usernameCache.size > 100) {
    const now = Date.now();
    for (const [key, value] of usernameCache.entries()) {
      if (value.expiresAt < now) {
        usernameCache.delete(key);
      }
    }
  }
}

function getCachedUsername(sessionid: string | undefined): string | undefined {
  if (!sessionid) return undefined;
  
  const cached = usernameCache.get(sessionid);
  if (!cached) return undefined;
  
  if (cached.expiresAt < Date.now()) {
    usernameCache.delete(sessionid);
    return undefined;
  }
  
  return cached.username;
}

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
  timeleft?: string;  // Legacy, use seconds-remaining instead
  secondsRemaining?: string;  // RFC 8908: seconds-remaining
  bytesRemaining?: string;    // RFC 8908: bytes-remaining
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

  // Helper to set security headers
  const setSecurityHeaders = (reply: FastifyReply) => {
    const headers = getSecurityHeaders();
    for (const [key, value] of Object.entries(headers)) {
      reply.header(key, value);
    }
  };

  // GET - Show login page or success page
  fastify.get(uamServerPath, async (request: FastifyRequest<{ Querystring: PortalQuery & { 'bytes-remaining'?: string; 'seconds-remaining'?: string } }>, reply: FastifyReply) => {
    const query = request.query;
    const { res, uamip, uamport, challenge, mac, ip, nasid, sessionid, timeleft, secondsRemaining, bytesRemaining, userurl, reply: radiusReply, reason, error } = query;
    
    // Handle RFC 8908 parameters (uspot may send with hyphens)
    const finalSecondsRemaining = secondsRemaining || query['seconds-remaining'] || timeleft;
    const finalBytesRemaining = bytesRemaining || query['bytes-remaining'];

    if (!uamip || !validateRouterIp(uamip)) {
      setSecurityHeaders(reply);
      return reply.code(400).send('Invalid Access: No valid NAS IP detected.');
    }

    const validatedPort = validateRouterPort(uamport, '3990');
    const sanitizedUserUrl = validateAndSanitizeUserUrl(userurl);
    // Create more unique session key to reduce collisions in NAT scenarios
    // Combine multiple identifiers when available for better uniqueness
    const sessionKey = sessionid || (mac && ip ? `${mac}-${ip}` : mac || ip) || request.ip || 'anonymous';
    
    // Build current URL for redirect loop detection
    const currentUrl = `${request.url}`;

    if (res) {
      fastify.log.info(`[UAM] res=${res}, mac=${mac}, ip=${ip}, secondsRemaining=${finalSecondsRemaining}, bytesRemaining=${finalBytesRemaining}`);
    }

    // Check redirect loop BEFORE processing (including success to catch router loops)
    // This prevents infinite loops if router keeps redirecting even after authentication
    const isLoopDetected = checkRedirectLoop(sessionKey, currentUrl);
    
    // For success responses, allow first attempt but detect rapid repeated success responses as loops
    // This catches cases where router keeps redirecting with res=success
    if (isLoopDetected) {
      fastify.log.warn(`[UAM] Redirect loop detected for session: ${sessionKey}, res=${res}, url=${currentUrl}`);
      setSecurityHeaders(reply);
      // Clear state to prevent further loops
      clearRedirectState(sessionKey);
      return reply.code(400).type('text/html').send(`
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><title>Redirect Loop Detected</title></head>
        <body style="font-family: system-ui; text-align: center; padding: 2rem;">
          <h2>Redirect Loop Detected</h2>
          <p>Please clear your browser cache and cookies, then try again.</p>
          <p><a href="${sanitizedUserUrl}">Continue to your destination</a></p>
        </body>
        </html>
      `);
    }

    // Show success page if authenticated
    if (res === 'success') {
      // Only clear redirect state on first/legitimate success (low attempt count)
      // If attempts are high, keep tracking to detect loops from repeated success responses
      if (sessionKey) {
        const redirectState = getRedirectState(sessionKey);
        // Only clear if this looks like first/legitimate success (<= 2 attempts in window)
        // Higher attempts indicate a potential loop pattern - keep tracking
        if (!redirectState || redirectState.attempts <= 2) {
          clearRedirectState(sessionKey);
        }
        clearLoginRateLimit(sessionKey);
      }
      
      // Use RFC 8908 parameters from uspot (bytes-remaining, seconds-remaining)
      const bytesRemainingBigInt = finalBytesRemaining ? BigInt(finalBytesRemaining) : null;
      const secondsRemainingNum = finalSecondsRemaining ? parseInt(finalSecondsRemaining) : null;
      
      // Look up username and speed limits (not provided by RFC 8908)
      let username: string | undefined;
      let maxSpeed: { download: bigint | null; upload: bigint | null } | undefined;
      
      // Try cache first (fastest, works even if accounting record doesn't exist yet)
      username = getCachedUsername(sessionid);
      if (username) {
        fastify.log.debug(`[UAM] Found username from cache: ${username}`);
      }
      
      // Fallback to database lookup if not in cache
      if (!username) {
        fastify.log.debug(`[UAM] Username not in cache, checking database: sessionid=${sessionid}, mac=${mac}`);
        try {
          // Find active session to get username
          const session = await prisma.radAcct.findFirst({
            where: {
              OR: [
                { callingStationId: mac },
                { acctSessionId: sessionid }
              ],
              acctStopTime: null
            },
            select: { userName: true },
            orderBy: { acctStartTime: 'desc' }
          });
          
          if (session?.userName) {
            username = session.userName;
          }
        } catch (err) {
          fastify.log.warn(`[UAM] Failed to fetch username from DB: ${err}`);
        }
      }
      
      // Get speed limits if we have username
      if (username) {
        try {
          const speedAttrs = await prisma.radReply.findMany({
            where: {
              userName: username,
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
        } catch (err) {
          fastify.log.warn(`[UAM] Failed to fetch speed limits: ${err}`);
        }
      }
      
      const html = renderSuccessPage({
        uamip: escapeHtml(uamip),
        uamport: escapeHtml(validatedPort),
        userurl: sanitizedUserUrl, // Already validated and sanitized
        mac: mac ? escapeHtml(mac) : undefined,
        ip: ip ? escapeHtml(ip) : undefined,
        secondsRemaining: secondsRemainingNum,
        bytesRemaining: bytesRemainingBigInt,
        sessionid: sessionid ? escapeHtml(sessionid) : undefined,
        username: username ? escapeHtml(username) : undefined,
        maxSpeed
      });
      setSecurityHeaders(reply);
      return reply.type('text/html').send(html);
    }

    // Handle error states - show error page instead of redirecting to prevent loops
    let errorMessage: string | undefined;
    if (error) errorMessage = error;
    else if (res === 'reject') errorMessage = radiusReply || 'Authentication failed.';
    else if (res === 'failed') errorMessage = reason || 'Authentication failed.';
    else if (res === 'logoff') errorMessage = 'You have been logged off.';

    const html = renderLoginPage({
      actionUrl: uamServerUrl,
      uamip: escapeHtml(uamip),
      uamport: escapeHtml(validatedPort),
      userurl: escapeHtml(sanitizedUserUrl),
      error: errorMessage ? escapeHtml(errorMessage) : undefined,
      challenge: challenge ? escapeHtml(challenge) : undefined,
      mac: mac ? escapeHtml(mac) : undefined,
      nasid: nasid ? escapeHtml(nasid) : undefined,
      sessionid: sessionid ? escapeHtml(sessionid) : undefined
    });
    
    setSecurityHeaders(reply);
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
      setSecurityHeaders(reply);
      return reply.code(400).send('Invalid Access: No valid NAS IP detected.');
    }

    const validatedPort = validateRouterPort(uamport, '3990');
    const sanitizedUserUrl = validateAndSanitizeUserUrl(userurl);
    const sessionKey = sessionid || query.mac || query.ip || request.ip || 'anonymous';

    // Check rate limiting BEFORE processing
    if (checkLoginRateLimit(sessionKey)) {
      const remainingTime = getRemainingBlockTime(sessionKey);
      const minutes = Math.floor(remainingTime / 60);
      const seconds = remainingTime % 60;
      fastify.log.warn(`[UAM] Rate limit exceeded for session: ${sessionKey}, blocked for ${minutes}m ${seconds}s`);
      
      const html = renderLoginPage({
        actionUrl: uamServerUrl,
        uamip: escapeHtml(uamip),
        uamport: escapeHtml(validatedPort),
        userurl: escapeHtml(sanitizedUserUrl),
        error: `Too many login attempts. Please try again in ${minutes > 0 ? `${minutes} minute${minutes > 1 ? 's' : ''}` : `${seconds} second${seconds !== 1 ? 's' : ''}`}.`,
        challenge: challenge ? escapeHtml(challenge) : undefined,
        mac: query.mac ? escapeHtml(query.mac) : undefined,
        nasid: nasid ? escapeHtml(nasid) : undefined,
        sessionid: sessionid ? escapeHtml(sessionid) : undefined
      });
      setSecurityHeaders(reply);
      return reply.type('text/html').send(html);
    }

    // Show error page instead of redirecting to prevent loops
    const showError = (errorMessage: string) => {
      const html = renderLoginPage({
        actionUrl: uamServerUrl,
        uamip: escapeHtml(uamip),
        uamport: escapeHtml(validatedPort),
        userurl: escapeHtml(sanitizedUserUrl),
        error: errorMessage ? escapeHtml(errorMessage) : undefined,
        challenge: challenge ? escapeHtml(challenge) : undefined,
        mac: query.mac ? escapeHtml(query.mac) : undefined,
        nasid: nasid ? escapeHtml(nasid) : undefined,
        sessionid: sessionid ? escapeHtml(sessionid) : undefined
      });
      setSecurityHeaders(reply);
      return reply.type('text/html').send(html);
    };

    if (!username || !password) {
      return showError('Missing required fields');
    }

    if (!masterSecret) {
      fastify.log.error('[UAM] RADIUS_MASTER_SECRET not configured');
      return showError('Server configuration error');
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
        // Don't clear rate limit on failure - let it accumulate
        return showError('Invalid username or password');
      }

      // Clear rate limit on successful authentication
      clearLoginRateLimit(sessionKey);

      // Cache username for success page lookup
      if (sessionid) {
        cacheUsername(sessionid, username);
        clearRedirectState(sessionid);
      }

      // Build logon URL - use CHAP if challenge present, else PAP
      // Use form POST instead of redirect to avoid showing credentials in URL
      const logonUrl = `http://${uamip}:${validatedPort}/logon`;
      
      if (challenge) {
        const chapResponse = computeChapResponse(password, challenge, uniqueUamSecret);
        fastify.log.info(`[UAM] ${username} authenticated, CHAP form (challenge=${challenge.substring(0, 16)}..., uamSecret=${uniqueUamSecret ? 'present' : 'none'})`);
        
        const html = renderLogonForm({
          logonUrl, // Router URL - already validated
          username: escapeHtml(username),
          userurl: sanitizedUserUrl, // Already validated
          response: chapResponse // CHAP response is hex, safe
        });
        return reply.type('text/html').send(html);
      } else {
        fastify.log.info(`[UAM] ${username} authenticated, PAP form`);
        
        const html = renderLogonForm({
          logonUrl, // Router URL - already validated
          username: escapeHtml(username),
          userurl: sanitizedUserUrl, // Already validated
          password // Password in hidden field - will be submitted to router, not displayed
        });
        setSecurityHeaders(reply);
        return reply.type('text/html').send(html);
      }
    } catch (error: any) {
      fastify.log.error(`[UAM] Login error: ${error.message}`);
      return showError('Server error. Please try again.');
    }
  });

  // RFC 8908 Captive Portal API
  // Standard endpoint for modern browsers (Chrome, Firefox, Safari)
  fastify.get('/api', {
    schema: {
      tags: ['portal'],
      summary: 'RFC 8908 Captive Portal API',
      querystring: { type: 'object', properties: { nasid: { type: 'string' } } }
    }
  }, async (request: FastifyRequest<{ Querystring: { nasid?: string } }>, reply: FastifyReply) => {
    const { nasid } = request.query;
    setSecurityHeaders(reply);
    reply.type('application/captive+json');
    return reply.send({
      captive: true,
      'user-portal-url': `${uamServerUrl}${nasid ? `?nasid=${encodeURIComponent(nasid)}` : ''}`
    });
  });

  // Android captive portal detection
  // Android checks this endpoint - should return 204 No Content if not captive
  // We return 302 to redirect to portal
  fastify.get('/generate_204', async (request, reply) => {
    setSecurityHeaders(reply);
    // Redirect to portal API endpoint which will then redirect to login
    const nasid = (request.query as { nasid?: string }).nasid;
    const portalUrl = `${uamServerUrl}${nasid ? `?nasid=${encodeURIComponent(nasid)}` : ''}`;
    return reply.code(302).header('Location', portalUrl).send();
  });

  // iOS/macOS captive portal detection
  // iOS checks /hotspot-detect.html or /library/test/success.html
  fastify.get('/hotspot-detect.html', async (request, reply) => {
    setSecurityHeaders(reply);
    const nasid = (request.query as { nasid?: string }).nasid;
    const portalUrl = `${uamServerUrl}${nasid ? `?nasid=${encodeURIComponent(nasid)}` : ''}`;
    return reply.code(302).header('Location', portalUrl).send();
  });

  // iOS/macOS alternative detection endpoint
  fastify.get('/library/test/success.html', async (request, reply) => {
    setSecurityHeaders(reply);
    const nasid = (request.query as { nasid?: string }).nasid;
    const portalUrl = `${uamServerUrl}${nasid ? `?nasid=${encodeURIComponent(nasid)}` : ''}`;
    return reply.code(302).header('Location', portalUrl).send();
  });

  // Windows captive portal detection
  // Windows checks connectivity endpoints
  fastify.get('/ncsi.txt', async (request, reply) => {
    setSecurityHeaders(reply);
    const nasid = (request.query as { nasid?: string }).nasid;
    const portalUrl = `${uamServerUrl}${nasid ? `?nasid=${encodeURIComponent(nasid)}` : ''}`;
    return reply.code(302).header('Location', portalUrl).send();
  });

  // Windows alternative detection
  fastify.get('/connecttest.txt', async (request, reply) => {
    setSecurityHeaders(reply);
    const nasid = (request.query as { nasid?: string }).nasid;
    const portalUrl = `${uamServerUrl}${nasid ? `?nasid=${encodeURIComponent(nasid)}` : ''}`;
    return reply.code(302).header('Location', portalUrl).send();
  });

  // Chrome/Chromium captive portal detection
  // Chrome checks connectivitycheck.gstatic.com (handled by router DNS interception)
  // But also checks local endpoints
  fastify.get('/gen_204', async (request, reply) => {
    setSecurityHeaders(reply);
    const nasid = (request.query as { nasid?: string }).nasid;
    const portalUrl = `${uamServerUrl}${nasid ? `?nasid=${encodeURIComponent(nasid)}` : ''}`;
    return reply.code(302).header('Location', portalUrl).send();
  });

  // Firefox captive portal detection
  fastify.get('/success.txt', async (request, reply) => {
    setSecurityHeaders(reply);
    const nasid = (request.query as { nasid?: string }).nasid;
    const portalUrl = `${uamServerUrl}${nasid ? `?nasid=${encodeURIComponent(nasid)}` : ''}`;
    return reply.code(302).header('Location', portalUrl).send();
  });

  // Linux NetworkManager detection
  fastify.get('/nmcheck.txt', async (request, reply) => {
    setSecurityHeaders(reply);
    const nasid = (request.query as { nasid?: string }).nasid;
    const portalUrl = `${uamServerUrl}${nasid ? `?nasid=${encodeURIComponent(nasid)}` : ''}`;
    return reply.code(302).header('Location', portalUrl).send();
  });
}
