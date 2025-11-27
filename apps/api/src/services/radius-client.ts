import radius from 'radius';
import dgram from 'dgram';
import { FastifyBaseLogger } from 'fastify';

interface RadiusAuthOptions {
  username: string;
  password: string;
  nasIp: string;
  nasId?: string;
  secret: string;
  server: string;
  port?: number;
  logger?: FastifyBaseLogger;
}

interface RadiusAuthResult {
  success: boolean;
  attributes?: Record<string, any>;
  error?: string;
}

export async function authenticateUser(options: RadiusAuthOptions): Promise<RadiusAuthResult> {
  const {
    username,
    password,
    nasIp,
    nasId,
    secret,
    server,
    port = 1812,
    logger
  } = options;

  return new Promise((resolve) => {
    const client = dgram.createSocket('udp4');
    const identifier = Math.floor(Math.random() * 256);
    const timeout = 5000;

    const attributes: Array<[string, string | number]> = [
      ['User-Name', username],
      ['User-Password', password],
      ['NAS-IP-Address', nasIp],
    ];

    if (nasId) {
      attributes.push(['NAS-Identifier', nasId]);
    }

    const packet = radius.encode({
      code: 'Access-Request',
      secret,
      identifier,
      attributes
    });

    let timeoutId: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      client.close();
    };

    timeoutId = setTimeout(() => {
      cleanup();
      logger?.warn(`[RADIUS] Timeout authenticating ${username} against ${server}:${port}`);
      resolve({
        success: false,
        error: 'RADIUS server timeout'
      });
    }, timeout);

    client.on('message', (msg, rinfo) => {
      cleanup();

      try {
        const response = radius.decode({
          packet: msg,
          secret
        });

        if (response.code === 'Access-Accept') {
          logger?.info(`[RADIUS] Access-Accept for ${username} from ${server}:${port}`);
          resolve({
            success: true,
            attributes: response.attributes || {}
          });
        } else if (response.code === 'Access-Reject') {
          logger?.warn(`[RADIUS] Access-Reject for ${username} from ${server}:${port}`);
          resolve({
            success: false,
            error: 'Access denied'
          });
        } else {
          logger?.warn(`[RADIUS] Unexpected response code: ${response.code}`);
          resolve({
            success: false,
            error: `Unexpected response: ${response.code}`
          });
        }
      } catch (error) {
        logger?.error(`[RADIUS] Error decoding response: ${error}`);
        resolve({
          success: false,
          error: 'Invalid RADIUS response'
        });
      }
    });

    client.on('error', (error) => {
      cleanup();
      logger?.error(`[RADIUS] UDP error: ${error.message}`);
      resolve({
        success: false,
        error: `Network error: ${error.message}`
      });
    });

    client.send(packet, port, server, (error) => {
      if (error) {
        cleanup();
        logger?.error(`[RADIUS] Send error: ${error.message}`);
        resolve({
          success: false,
          error: `Send error: ${error.message}`
        });
      }
    });
  });
}

