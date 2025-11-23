import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { RadiusAuthService } from '../services/radius-auth.service.js';
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
  const authService = new RadiusAuthService(fastify.log);
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

  // 1. Login Submission
  fastify.post<{ Body: PortalBody }>('/portal/login', async (req, reply) => {
    const { username, password, nasid, ip, userurl } = req.body;

    // Validation
    if (!username || !password || !nasid) {
      return reply.code(400).send({ error: 'Missing credentials or router ID' });
    }

    // 1. Fetch Router (Cache this in production!)
    const router = await prisma.router.findUnique({
      where: { id: nasid },
      select: { id: true, radiusSecret: true, nasipaddress: true }
    });

    if (!router || !router.radiusSecret) {
      return reply.code(401).send({ error: 'Router not authorized' });
    }

    // 2. Single Login Check (Database Indexed Query)
    const activeSession = await prisma.radAcct.findFirst({
      where: { userName: username, acctStopTime: null },
      select: { acctSessionId: true } // Select minimum fields
    });

    if (activeSession) {
      return reply.code(403).send({ 
        error: 'Active session exists',
        message: 'Please disconnect your other device first.' 
      });
    }

    // 3. Quota Check & Sync (updates radreply for FreeRADIUS to read)
    const quota = await updateRadiusQuotaLimit(username);
    if (quota && quota.remaining <= 0n) {
      return reply.code(403).send({ error: 'Quota exceeded' });
    }

    // 4. RADIUS Auth (The Source of Truth)
    const isAuthenticated = await authService.authenticate({
      username,
      password,
      nasIp: router.nasipaddress || '127.0.0.1',
      nasIdentifier: router.id,
      radiusSecret: router.radiusSecret,
      clientIp: ip || '0.0.0.0',
      radiusServer: process.env.RADIUS_HOST || '127.0.0.1',
      radiusPort: parseInt(process.env.RADIUS_PORT || '1812')
    });

    if (!isAuthenticated) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    // 5. Success - Redirect user
    const redirectUrl = userurl || 'http://www.google.com';
    
    // Return JSON for SPA or simple HTML redirect
    return reply.type('text/html').send(`
      <html>
        <head><meta http-equiv="refresh" content="0;url=${redirectUrl}"></head>
        <body>Authenticated. Redirecting...</body>
      </html>
    `);
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

