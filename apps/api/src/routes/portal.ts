import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

interface PortalQuery {
  nasid?: string;
  uamip?: string; // uspot sends 'uamip', not just 'ip'
  uamport?: string;
  userurl?: string;
  error?: string;
}

export async function portalRoutes(fastify: FastifyInstance) {
  // 1. Serve Login Page
  fastify.get('/portal', async (request: FastifyRequest<{ Querystring: PortalQuery }>, reply: FastifyReply) => {
    const { nasid, uamip, uamport = '80', userurl = 'http://www.google.com', error } = request.query;

    // Rule of Thumb: If we don't have a UAM IP, we can't log the user in.
    // This usually happens if the user accesses the portal directly without being redirected by the router.
    if (!uamip) {
      return reply.send("Error: Invalid access method. Please connect to the WiFi network first.");
    }

    // Construct the Router's Login URL
    // uspot listens on the LAN IP (uamip) at specific port (default 80 or 3990)
    // The form must submit POST to http://<uamip>:<uamport>/login
    const actionUrl = `http://${uamip}:${uamport}/login`;

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WiFi Login</title>
    <link rel="stylesheet" href="/css/style.css"> <!-- Host CSS statically -->
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
        
        .error {
            background: #f5f5f5;
            color: #000000;
            border: 1px solid #000000;
            padding: 12px;
            border-radius: 8px;
            margin-bottom: 20px;
            font-size: 14px;
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
        
        ${error ? `<div class="error">${error}</div>` : ''}
        
        <!-- 
          CRITICAL FIX: Form submits directly to the Router (NAS).
          The Router will then talk to the RADIUS server.
        -->
        <form method="POST" action="${actionUrl}">
            <input type="hidden" name="uamip" value="${uamip}">
            <input type="hidden" name="uamport" value="${uamport}">
            <input type="hidden" name="userurl" value="${userurl}">
            
            <div class="form-group">
                <label>Username</label>
                <input type="text" name="username" required autofocus>
            </div>
            
            <div class="form-group">
                <label>Password</label>
                <input type="password" name="password" required>
            </div>
            
            <button type="submit" class="btn-login">Connect</button>
        </form>
        
        <div class="footer">
            <p>© ${new Date().getFullYear()} SpotFi. All rights reserved.</p>
        </div>
    </div>
</body>
</html>`;

    reply.type('text/html').send(html);
  });

  // 2. API endpoint for RFC8908 (Captive Portal API)
  // This stays on the cloud because option 114 points here.
  fastify.get('/api/captive-portal', async (request, reply) => {
    return {
      "captive": true,
      "user-portal-url": `${process.env.API_URL || 'https://api.spotfi.com'}/portal`
    };
  });

  // Keep the /api endpoint for backward compatibility (RFC8908)
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
    
    const response: any = {
      captive: true,
      'user-portal-url': `${process.env.API_URL || 'https://api.spotfi.com'}/portal${nasid ? `?nasid=${nasid}` : ''}`
    };

    return reply.send(response);
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
