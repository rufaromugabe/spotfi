import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { RadClient } from '../lib/radclient.js';
import { prisma } from '../lib/prisma.js';

interface PortalQuery {
  uamip?: string;
  uamport?: string;
  challenge?: string;
  called?: string;
  mac?: string;
  ip?: string;
  nasid?: string;
  userurl?: string;
  res?: string;
}

interface PortalBody {
  username?: string;
  password?: string;
  challenge?: string;
  uamip?: string;
  uamport?: string;
  userurl?: string;
  res?: string;
  called?: string;
  mac?: string;
  ip?: string;
  nasid?: string;
}

export async function portalRoutes(fastify: FastifyInstance) {
  // Serve login page
  fastify.get('/portal', async (request: FastifyRequest<{ Querystring: PortalQuery }>, reply: FastifyReply) => {
    const query = request.query;
    
    // Extract CoovaChilli parameters
    const uamip = query.uamip || '10.1.0.1';
    const uamport = query.uamport || '3990';
    const challenge = query.challenge || '';
    const called = query.called || '';
    const mac = query.mac || '';
    const ip = query.ip || '';
    const nasid = query.nasid || '';
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
            <input type="hidden" name="uamip" value="${uamip}">
            <input type="hidden" name="uamport" value="${uamport}">
            <input type="hidden" name="challenge" value="${challenge}">
            <input type="hidden" name="called" value="${called}">
            <input type="hidden" name="mac" value="${mac}">
            <input type="hidden" name="ip" value="${ip}">
            <input type="hidden" name="nasid" value="${nasid}">
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
                const formData = new FormData(form);
                const response = await fetch('/portal/login', {
                    method: 'POST',
                    body: formData
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
    const { username, password, uamip, uamport, challenge, called, mac, ip, nasid, userurl, res } = request.body;

    if (!username || !password) {
      return reply.code(400).send({ error: 'Username and password are required' });
    }

    try {
      // Find router by NAS ID (router ID) or IP
      // The flow:
      // 1. When a router is created via POST /api/routers, it generates:
      //    - router.id (unique ID)
      //    - router.radiusSecret (random 32-char hex string)
      //    - router.nasipaddress (router's public IP - set later when router connects)
      //
      // 2. CoovaChilli config has HS_NASID=$ROUTER_ID, which sends router.id as NAS-Identifier
      //
      // 3. Portal receives request and looks up router by:
      //    a. NAS ID (from query param 'nasid') - matches router.id
      //    b. Router IP (from query param 'ip' or request IP) - matches router.nasipaddress
      //    c. Request IP (fallback) - matches router.nasipaddress
      //
      // 4. Once router is found, portal uses router.radiusSecret for RADIUS authentication
      
      let router = null;
      
      // Method 1: Find by NAS ID (most reliable - matches router.id)
      if (nasid) {
        router = await prisma.router.findUnique({
          where: { id: nasid },
        });
        fastify.log.debug(`Router lookup by NAS ID: ${nasid} -> ${router ? 'found' : 'not found'}`);
      }

      // Method 2: Find by IP from query parameter
      if (!router && ip) {
        router = await prisma.router.findFirst({
          where: { nasipaddress: ip },
        });
        fastify.log.debug(`Router lookup by IP query param: ${ip} -> ${router ? 'found' : 'not found'}`);
      }

      // Method 3: Find by request IP (router's public IP)
      if (!router) {
        const requestIp = request.ip || request.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || request.socket?.remoteAddress;
        if (requestIp && requestIp !== '127.0.0.1' && requestIp !== '::1') {
          router = await prisma.router.findFirst({
            where: { nasipaddress: requestIp },
          });
          fastify.log.debug(`Router lookup by request IP: ${requestIp} -> ${router ? 'found' : 'not found'}`);
        }
      }

      // Method 4: If UAM IP is provided and it's the hotspot gateway, we can't use it to identify router
      // But we could potentially match by MAC address if provided
      if (!router && mac) {
        // Format MAC address for lookup
        const normalizedMac = mac.replace(/[:-]/g, '').toUpperCase();
        const formattedMac = normalizedMac.match(/.{2}/g)?.join(':');
        if (formattedMac) {
          router = await prisma.router.findFirst({
            where: { macAddress: formattedMac },
          });
          fastify.log.debug(`Router lookup by MAC: ${formattedMac} -> ${router ? 'found' : 'not found'}`);
        }
      }

      if (!router || !router.radiusSecret) {
        const routerCount = await prisma.router.count();
        fastify.log.warn(
          `Router not found or missing RADIUS secret - NAS ID: ${nasid}, IP: ${ip}, Request IP: ${request.ip}, MAC: ${mac}, Available routers: ${routerCount}`
        );
        return reply.code(401).send({ 
          error: 'Invalid router configuration',
          message: 'Unable to identify router. Please ensure the router is properly registered and configured.'
        });
      }

      fastify.log.info(`Router identified: ${router.id} (${router.name})`);

      // Get RADIUS server IP from environment or router's nasipaddress
      // Note: The router's nasipaddress is the router's IP, not the RADIUS server IP
      // For RADIUS server IP, we should use environment variable or router-specific config
      // For now, use environment variable RADIUS_HOST or default to router's IP
      const radiusHost = process.env.RADIUS_HOST || router.nasipaddress || ip || '127.0.0.1';
      const radiusPort = parseInt(process.env.RADIUS_PORT || '1812', 10);

      // Authenticate user via RADIUS
      const radClient = new RadClient({
        host: radiusHost,
        secret: router.radiusSecret,
        port: radiusPort,
      });

      const authResult = await radClient.authenticate(username, password, {
        'NAS-IP-Address': ip || request.ip,
        'NAS-Identifier': nasid || router.id,
        'Called-Station-Id': called || mac || '',
        'Calling-Station-Id': mac || '',
        'User-Name': username,
      }).catch((error) => {
        fastify.log.error(`RADIUS authentication error: ${error.message}`);
        return { accept: false, message: 'RADIUS authentication failed' };
      });

      if (authResult.accept) {
        // Authentication successful - redirect to CoovaChilli success page
        const uamServer = `${uamip || '10.1.0.1'}:${uamport || '3990'}`;
        const redirectUrl = `http://${uamServer}/logon?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&challenge=${challenge || ''}&uamip=${uamip || ''}&uamport=${uamport || ''}&userurl=${encodeURIComponent(userurl || 'http://www.google.com')}`;
        
        // For CoovaChilli UAM, we need to return HTML that redirects
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

  // Logout endpoint (for CoovaChilli)
  fastify.get('/portal/logout', async (request: FastifyRequest<{ Querystring: PortalQuery }>, reply: FastifyReply) => {
    const query = request.query;
    const uamip = query.uamip || '10.1.0.1';
    const uamport = query.uamport || '3990';
    const userurl = query.userurl || 'http://www.google.com';

    const logoutUrl = `http://${uamip}:${uamport}/logout?userurl=${encodeURIComponent(userurl)}`;
    
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta http-equiv="refresh" content="0;url=${logoutUrl}">
    <script>window.location.href = "${logoutUrl}";</script>
</head>
<body>
    <p>Logging out...</p>
    <p>If you are not redirected, <a href="${logoutUrl}">click here</a>.</p>
</body>
</html>
    `;

    return reply.type('text/html').send(html);
  });
}

