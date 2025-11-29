import radius from 'radius';
import dgram from 'dgram';
import crypto from 'crypto';
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

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

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

  const coaPort = parseInt(process.env.COA_PORT || '3799', 10);

  // Build CoA-Request packet
  const attributes: Array<[string, string | number]> = [
    ['User-Name', username],
  ];

  if (nasId) attributes.push(['NAS-Identifier', nasId]);
  if (userIp) attributes.push(['Framed-IP-Address', userIp]);
  if (calledStationId) attributes.push(['Called-Station-Id', calledStationId]);
  if (callingStationId) attributes.push(['Calling-Station-Id', callingStationId]);
  if (acctSessionId) attributes.push(['Acct-Session-Id', acctSessionId]);

  let attempt = 0;
  let lastError = '';

  while (attempt < MAX_RETRIES) {
    attempt++;
    try {
      const result = await sendSingleCoARequest(nasIp, coaPort, secret, attributes, logger);
      if (result.success) {
        return result;
      }
      lastError = result.error || 'Unknown error';
    } catch (error: any) {
      lastError = error.message;
    }

    if (attempt < MAX_RETRIES) {
      logger?.warn(`[CoA] Attempt ${attempt} failed for ${username} at ${nasIp}. Retrying in ${RETRY_DELAY_MS}ms...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }

  logger?.error(`[CoA] All ${MAX_RETRIES} attempts failed for ${username} at ${nasIp}. Last error: ${lastError}`);
  return { success: false, error: lastError };
}

function sendSingleCoARequest(
  nasIp: string,
  port: number,
  secret: string,
  attributes: Array<[string, string | number]>,
  logger?: FastifyBaseLogger
): Promise<CoAResult> {
  return new Promise((resolve) => {
    const client = dgram.createSocket('udp4');
    const identifier = crypto.randomBytes(1)[0]; // Secure random identifier
    const timeout = 5000;

    const packet = radius.encode({
      code: 'CoA-Request' as any, // Cast to any as @types/radius might miss this
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
      resolve({ success: false, error: 'CoA server timeout' });
    }, timeout);

    client.on('message', (msg) => {
      cleanup();
      try {
        const response = radius.decode({ packet: msg, secret });
        if ((response as any).code === 'CoA-ACK') {
          logger?.info(`[CoA] CoA-ACK received from ${nasIp}:${port}`);
          resolve({ success: true });
        } else {
          logger?.warn(`[CoA] CoA-NAK received (code: ${response.code}) from ${nasIp}:${port}`);
          resolve({ success: false, error: `CoA-NAK: ${response.code}` });
        }
      } catch (error) {
        resolve({ success: false, error: 'Invalid CoA response' });
      }
    });

    client.on('error', (error) => {
      cleanup();
      resolve({ success: false, error: `Network error: ${error.message}` });
    });

    client.send(packet, port, nasIp, (error) => {
      if (error) {
        cleanup();
        resolve({ success: false, error: `Send error: ${error.message}` });
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

