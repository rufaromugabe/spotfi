import radius from 'radius';
import dgram from 'dgram';
import { FastifyBaseLogger } from 'fastify';
import { prisma } from '../lib/prisma.js';

interface CoAOptions {
  nasIp: string;
  nasId?: string;
  secret: string;
  username: string;
  userIp?: string;
  calledStationId?: string;
  callingStationId?: string;
  acctSessionId?: string;
  logger?: FastifyBaseLogger;
}

interface CoAResult {
  success: boolean;
  error?: string;
}

export async function sendCoARequest(options: CoAOptions): Promise<CoAResult> {
  const {
    nasIp,
    nasId,
    secret,
    username,
    userIp,
    calledStationId,
    callingStationId,
    acctSessionId,
    logger
  } = options;

  const coaPort = 3799;

  return new Promise((resolve) => {
    const client = dgram.createSocket('udp4');
    const identifier = Math.floor(Math.random() * 256);
    const timeout = 5000; // 5 second timeout

    // Build CoA-Request packet (CoA-Request uses same format as Access-Request)
    const attributes: Array<[string, string | number]> = [
      ['User-Name', username],
    ];

    if (nasId) {
      attributes.push(['NAS-Identifier', nasId]);
    }

    if (userIp) {
      attributes.push(['Framed-IP-Address', userIp]);
    }

    if (calledStationId) {
      attributes.push(['Called-Station-Id', calledStationId]);
    }

    if (callingStationId) {
      attributes.push(['Calling-Station-Id', callingStationId]);
    }

    if (acctSessionId) {
      attributes.push(['Acct-Session-Id', acctSessionId]);
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
      logger?.warn(`[CoA] Timeout sending CoA-Request to ${nasIp}:${coaPort} for ${username}`);
      resolve({
        success: false,
        error: 'CoA server timeout'
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
          logger?.info(`[CoA] CoA-ACK received from ${nasIp}:${coaPort} for ${username}`);
          resolve({
            success: true
          });
        } else {
          logger?.warn(`[CoA] CoA-NAK received (code: ${response.code}) from ${nasIp}:${coaPort} for ${username}`);
          resolve({
            success: false,
            error: `CoA-NAK: ${response.code}`
          });
        }
      } catch (error) {
        logger?.error(`[CoA] Error decoding response: ${error}`);
        resolve({
          success: false,
          error: 'Invalid CoA response'
        });
      }
    });

    client.on('error', (error) => {
      cleanup();
      logger?.error(`[CoA] UDP error: ${error.message}`);
      resolve({
        success: false,
        error: `Network error: ${error.message}`
      });
    });

    client.send(packet, coaPort, nasIp, (error) => {
      if (error) {
        cleanup();
        logger?.error(`[CoA] Send error: ${error.message}`);
        resolve({
          success: false,
          error: `Send error: ${error.message}`
        });
      }
    });
  });
}

export async function getRouterConfig(nasId?: string, nasIp?: string): Promise<{
  id: string;
  nasipaddress: string | null;
  radiusSecret: string;
} | null> {
  if (nasId) {
    const router = await prisma.router.findUnique({
      where: { id: nasId },
      select: {
        id: true,
        nasipaddress: true,
        radiusSecret: true
      }
    });
    if (router && router.radiusSecret) {
      return { ...router, radiusSecret: router.radiusSecret };
    }
    return null;
  }

  if (nasIp) {
    const router = await prisma.router.findFirst({
      where: { nasipaddress: nasIp },
      select: {
        id: true,
        nasipaddress: true,
        radiusSecret: true
      }
    });
    if (router && router.radiusSecret) {
      return { ...router, radiusSecret: router.radiusSecret };
    }
    return null;
  }

  return null;
}

