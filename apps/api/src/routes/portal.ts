import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { RadClient } from '../lib/radclient.js';
import { prisma } from '../lib/prisma.js';
import { updateRadiusQuotaLimit } from '../services/quota.js';

interface PortalQuery {
  nasid?: string;
  ip?: string;
  userurl?: string;
}

interface PortalBody {
  username?: string;
  password?: string;
  userurl?: string;
  nasid?: string;
  ip?: string;
}

export async function portalRoutes(fastify: FastifyInstance) {
  // RFC8908 Captive Portal API endpoint
  // This allows modern devices (iOS, Android, Windows) to automatically detect the captive portal
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
    
    // RFC8908 API: Devices call this endpoint to detect captive portals
    // Before login: Just indicates portal exists
    // After login: Could provide session info (but requires authentication mechanism)
    // 
    // Note: RFC8908 devices don't send username/password to this endpoint
    // They just check if captive: true to know a portal exists
    // Session info would require cookies/tokens after authentication
    
    const response: any = {
      captive: true,
      'user-portal-url': `${process.env.API_URL || 'https://api.spotfi.com'}/portal${nasid ? `?nasid=${nasid}` : ''}`
    };

    // Optional: If we can identify the user (via session cookie/token in future),
    // we could add session information here. For now, we only return basic portal info.
    // 
    // To add session info after login, you would:
    // 1. Set a session cookie after successful portal login
    // 2. Check for that cookie here
    // 3. Look up active session and quota info
    // 4. Return seconds-remaining and bytes-remaining
    
    // Example future implementation:
    // const sessionToken = request.cookies?.spotfi_session;
    // if (sessionToken && nasid) {
    //   const session = await getSessionFromToken(sessionToken);
    //   if (session && session.routerId === nasid) {
    //     const quotaInfo = await getUserQuota(session.username);
    //     if (quotaInfo) {
    //       response['seconds-remaining'] = calculateRemainingSeconds(quotaInfo);
    //       response['bytes-remaining'] = Number(quotaInfo.remaining);
    //     }
    //   }
    // }

    return reply.send(response);
  });

  // Serve login page
  fastify.get('/portal', async (request: FastifyRequest<{ Querystring: PortalQuery }>, reply: FastifyReply) => {
    const query = request.query;
    
    // Extract uspot parameters
    const nasid = query.nasid || '';
    const ip = query.ip || '';
    const userurl = query.userurl || 'http://www.google.com';

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SpotFi - WiFi Login</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: #ffffff;
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }
        
        .login-container {
            background: white;
            border: 2px solid #000000;
            border-radius: 20px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
            padding: 40px;
            width: 100%;
            max-width: 400px;
            animation: slideUp 0.5s ease-out;
        }
        
        @keyframes slideUp {
            from {
                opacity: 0;
                transform: translateY(30px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        
        .logo {
            text-align: center;
            margin-bottom: 30px;
        }
        
        .logo h1 {
            color: #000000;
            font-size: 32px;
            font-weight: 700;
            margin-bottom: 5px;
        }
        
        .logo p {
            color: #666666;
            font-size: 14px;
        }
        
        .form-group {
            margin-bottom: 20px;
        }
        
        .form-group label {
            display: block;
            margin-bottom: 8px;
            color: #333;
            font-weight: 500;
            font-size: 14px;
        }
        
        .form-group input {
            width: 100%;
            padding: 12px 16px;
            border: 2px solid #e0e0e0;
            border-radius: 10px;
            font-size: 16px;
            transition: all 0.3s ease;
        }
        
        .form-group input:focus {
            outline: none;
            border-color: #000000;
            box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.1);
        }
        
        .form-group input::placeholder {
            color: #999;
        }
        
        .btn-login {
            width: 100%;
            padding: 14px;
            background: #000000;
            color: white;
            border: none;
            border-radius: 10px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            margin-top: 10px;
        }
        
        .btn-login:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(0, 0, 0, 0.3);
            background: #333333;
        }
        
        .btn-login:active {
            transform: translateY(0);
        }
        
        .btn-login:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
        }
        
        .error-message {
            background: #f5f5f5;
            color: #000000;
            border: 1px solid #000000;
            padding: 12px;
            border-radius: 8px;
            margin-bottom: 20px;
            font-size: 14px;
            display: none;
        }
        
        .error-message.show {
            display: block;
        }
        
        .loading {
            display: inline-block;
            width: 16px;
            height: 16px;
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-radius: 50%;
            border-top-color: white;
            animation: spin 0.8s linear infinite;
            margin-right: 8px;
            vertical-align: middle;
        }
        
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        
        .footer {
            text-align: center;
            margin-top: 30px;
            color: #999;
            font-size: 12px;
        }
        
        @media (max-width: 480px) {
            .login-container {
                padding: 30px 20px;
            }
            
            .logo h1 {
                font-size: 28px;
            }
        }
    </style>
</head>
<body>
    <div class="login-container">
        <div class="logo">
            <h1>🛰️ SpotFi</h1>
            <p>Connect to WiFi Network</p>
        </div>
        
        <div class="error-message" id="errorMessage"></div>
        
        <form id="loginForm" method="POST" action="/portal/login">
            <input type="hidden" name="nasid" value="${nasid}">
            <input type="hidden" name="ip" value="${ip}">
            <input type="hidden" name="userurl" value="${userurl}">
            
            <div class="form-group">
                <label for="username">Username</label>
                <input 
                    type="text" 
                    id="username" 
                    name="username" 
                    placeholder="Enter your username" 
                    required 
                    autocomplete="username"
                    autofocus
                >
            </div>
            
            <div class="form-group">
                <label for="password">Password</label>
                <input 
                    type="password" 
                    id="password" 
                    name="password" 
                    placeholder="Enter your password" 
                    required
                    autocomplete="current-password"
                >
            </div>
            
            <button type="submit" class="btn-login" id="loginBtn">
                Connect to WiFi
            </button>
        </form>
        
        <div class="footer">
            <p>© ${new Date().getFullYear()} SpotFi. All rights reserved.</p>
        </div>
    </div>
    
    <script>
        const form = document.getElementById('loginForm');
        const loginBtn = document.getElementById('loginBtn');
        const errorMessage = document.getElementById('errorMessage');
        
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            // Disable button and show loading
            loginBtn.disabled = true;
            loginBtn.innerHTML = '<span class="loading"></span>Connecting...';
            errorMessage.classList.remove('show');
            
            // Submit form
            try {
                // Convert form data to URL-encoded format (Fastify supports this by default)
                const formData = new FormData(form);
                const urlEncodedData = new URLSearchParams();
                
                // Extract all form fields
                for (const [key, value] of formData.entries()) {
                    urlEncodedData.append(key, value.toString());
                }
                
                const response = await fetch('/portal/login', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    body: urlEncodedData.toString()
                });
                
                if (response.ok) {
                    // Check content type
                    const contentType = response.headers.get('content-type');
                    
                    if (contentType && contentType.includes('application/json')) {
                        // JSON response (shouldn't happen but handle it)
                        const data = await response.json();
                        if (data.redirect) {
                            window.location.href = data.redirect;
                        } else {
                            window.location.href = '${userurl}';
                        }
                    } else {
                        // HTML response - extract redirect URL or let meta refresh handle it
                        const html = await response.text();
                        
                        // Try to extract redirect URL from meta refresh or script
                        const metaMatch = html.match(/content="\d+;url=([^"]+)"/);
                        const scriptMatch = html.match(/window\.location\.href\s*=\s*["']([^"']+)["']/);
                        const linkMatch = html.match(/<a\s+href=["']([^"']+)["']/);
                        
                        const redirectUrl = metaMatch?.[1] || scriptMatch?.[1] || linkMatch?.[1];
                        
                        if (redirectUrl) {
                            window.location.href = decodeURIComponent(redirectUrl);
                        } else {
                            // If we can't extract URL, replace current page with response
                            document.open();
                            document.write(html);
                            document.close();
                        }
                    }
                } else {
                    // Error response - try to parse as JSON
                    try {
                        const error = await response.json();
                        showError(error.message || error.error || 'Login failed. Please check your credentials.');
                    } catch (parseError) {
                        // If not JSON, show generic error
                        showError('Login failed. Please check your credentials.');
                    }
                    loginBtn.disabled = false;
                    loginBtn.textContent = 'Connect to WiFi';
                }
            } catch (err) {
                console.error('Login error:', err);
                showError('Network error. Please try again.');
                loginBtn.disabled = false;
                loginBtn.textContent = 'Connect to WiFi';
            }
        });
        
        function showError(message) {
            errorMessage.textContent = message;
            errorMessage.classList.add('show');
            setTimeout(() => {
                errorMessage.classList.remove('show');
            }, 5000);
        }
    </script>
</body>
</html>
    `;

    reply.type('text/html').send(html);
  });

  // Handle login POST request
  fastify.post('/portal/login', async (request: FastifyRequest<{ Body: PortalBody }>, reply: FastifyReply) => {
    const { username, password, nasid, ip, userurl } = request.body;

    if (!username || !password) {
      return reply.code(400).send({ error: 'Username and password are required' });
    }

    try {
      // Find router by NAS ID (router ID) only
      // The flow:
      // 1. When a router is created via POST /api/routers, it generates:
      //    - router.id (unique ID)
      //    - router.radiusSecret (random 32-char hex string)
      //
      // 2. Uspot config has nas_id=$ROUTER_ID, which sends router.id as NAS-Identifier
      //
      // 3. Portal receives request and looks up router by NAS ID (from query param 'nasid')
      //
      // 4. Once router is found, portal uses router.radiusSecret for RADIUS authentication
      
      if (!nasid) {
        fastify.log.warn('Portal login request missing nasid parameter');
        return reply.code(400).send({ 
          error: 'Missing router identifier',
          message: 'The nasid parameter is required. Please ensure uspot is properly configured with nas_id.'
        });
      }

      const router = await prisma.router.findUnique({
        where: { id: nasid },
      });

      if (!router) {
        fastify.log.warn(`Router not found - NAS ID: ${nasid}`);
        return reply.code(401).send({ 
          error: 'Router not found',
          message: `Router with ID '${nasid}' not found. Please ensure the router is properly registered.`
        });
      }

      if (!router.radiusSecret) {
        fastify.log.warn(`Router missing RADIUS secret - NAS ID: ${nasid}`);
        return reply.code(401).send({ 
          error: 'Invalid router configuration',
          message: 'Router is missing RADIUS secret. Please ensure the router is properly configured.'
        });
      }

      fastify.log.info(`Router identified: ${router.id} (${router.name})`);

      // Check for active sessions to prevent simultaneous logins
      const activeSession = await prisma.radAcct.findFirst({
        where: {
          userName: username,
          acctStopTime: null  // Active session (not stopped)
        }
      });

      if (activeSession) {
        fastify.log.warn(`User ${username} already has an active session on router ${activeSession.nasIpAddress}`);
        return reply.code(403).send({
          error: 'Already logged in',
          message: 'You are already logged in to another router. Please disconnect from your current session first.'
        });
      }

      // Update quota limit in RADIUS before authentication
      // This ensures the session limit is set to remaining quota and session timeout
      // Optimized: updateRadiusQuotaLimit now returns quota info, eliminating duplicate queries
      try {
        const quotaInfo = await updateRadiusQuotaLimit(username);
        
        if (!quotaInfo || quotaInfo.remaining <= 0n) {
          fastify.log.warn(`User ${username} quota exhausted or not found`);
          return reply.code(403).send({
            error: 'Quota exhausted',
            message: 'Your data quota has been used up. Please upgrade your plan or wait for the next billing period.'
          });
        }
      } catch (error) {
        fastify.log.warn(`Quota check failed for ${username}: ${error}`);
        // Continue with authentication even if quota check fails
        // FreeRADIUS will handle quota enforcement via radreply
      }

      // Get RADIUS server IP from environment or router's nasipaddress
      // Note: The router's nasipaddress is the router's IP, not the RADIUS server IP
      // For RADIUS server IP, we should use environment variable or router-specific config
      // For now, use environment variable RADIUS_HOST or default to router's IP
      const radiusHost = process.env.RADIUS_HOST || router.nasipaddress || '127.0.0.1';
      const radiusPort = parseInt(process.env.RADIUS_PORT || '1812', 10);

      // Authenticate user via RADIUS
      const radClient = new RadClient({
        host: radiusHost,
        secret: router.radiusSecret,
        port: radiusPort,
      });

      // Get client IP from router (uspot) - more accurate than request IP
      // Router provides the client's hotspot IP (e.g., 10.1.0.50)
      // Request IP would be router's public IP or proxy IP, not the client's IP
      const clientIp = ip || request.ip || request.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || '0.0.0.0';
      
      // Get router's public IP (NAS IP) - this is the router's WAN IP
      // For RADIUS, NAS-IP-Address should be the router's IP, not the client's IP
      const nasIp = router.nasipaddress || clientIp;
      
      // Authenticate user via RADIUS with proper attributes
      // Following RFC2865 and uspot best practices
      const authResult = await radClient.authenticate(username, password, {
        'NAS-IP-Address': nasIp,                    // Router's IP (NAS IP)
        'NAS-Identifier': router.id,                 // Router ID for identification
        'Called-Station-Id': router.macAddress || '', // Router MAC address
        'Calling-Station-Id': clientIp,             // Client's hotspot IP
        'User-Name': username,                      // Username for authentication
        'NAS-Port-Type': 'Wireless-802.11',        // Indicate wireless connection
        'Service-Type': 'Framed-User',             // Standard service type
      }).catch((error) => {
        fastify.log.error(`RADIUS authentication error: ${error.message}`);
        return { accept: false, message: 'RADIUS authentication failed' };
      });

      if (authResult.accept) {
        // Authentication successful - redirect to user's destination
        // Uspot handles the authentication internally via RADIUS, so we just redirect to the destination
        const redirectUrl = userurl || 'http://www.google.com';
        
        // Return HTML that redirects
        const successHtml = `
<!DOCTYPE html>
<html>
<head>
    <meta http-equiv="refresh" content="0;url=${redirectUrl}">
    <script>window.location.href = "${redirectUrl}";</script>
</head>
<body>
    <p>Authentication successful. Redirecting...</p>
    <p>If you are not redirected, <a href="${redirectUrl}">click here</a>.</p>
</body>
</html>
        `;

        fastify.log.info(`Portal authentication successful for router ${router.id}, redirecting to: ${redirectUrl}`);
        return reply.type('text/html').send(successHtml);
      } else {
        // Authentication failed
        return reply.code(401).send({ 
          error: 'Invalid username or password',
          message: 'Please check your credentials and try again.'
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      fastify.log.error(`Portal login error: ${errorMessage}`);
      return reply.code(500).send({ 
        error: 'Authentication service error',
        message: 'Please try again later.'
      });
    }
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

