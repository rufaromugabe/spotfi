import radius from 'radius';
import dgram from 'dgram';
import { FastifyBaseLogger } from 'fastify';

interface AuthOptions {
  username: string;
  password: string;
  nasIp: string;
  nasIdentifier: string;
  clientIp: string;
  radiusSecret: string;
  radiusServer: string;
  radiusPort: number;
}

export class RadiusAuthService {
  constructor(private logger: FastifyBaseLogger) {}

  async authenticate(opts: AuthOptions): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const client = dgram.createSocket('udp4');
      
      const packet = radius.encode({
        code: 'Access-Request',
        secret: opts.radiusSecret,
        identifier: Math.floor(Math.random() * 256),
        attributes: [
          ['NAS-IP-Address', opts.nasIp],
          ['NAS-Identifier', opts.nasIdentifier],
          ['User-Name', opts.username],
          ['User-Password', opts.password],
          ['Calling-Station-Id', opts.clientIp], // The end-user IP/MAC
          ['NAS-Port-Type', 'Wireless-802.11'],
          ['Service-Type', 'Framed-User']
        ]
      });

      let responded = false;
      const timeout = setTimeout(() => {
        if (!responded) {
          client.close();
          this.logger.warn(`RADIUS timeout for user ${opts.username}`);
          resolve(false); // Fail closed
        }
      }, 2500);

      client.on('message', (msg) => {
        responded = true;
        clearTimeout(timeout);
        client.close();

        try {
          const response = radius.decode({ packet: msg, secret: opts.radiusSecret });
          const isValid = response.code === 'Access-Accept';
          
          if (!isValid) {
            this.logger.info(`RADIUS Reject for ${opts.username}`);
          }
          
          resolve(isValid);
        } catch (e) {
          this.logger.error(`RADIUS decode error: ${e}`);
          resolve(false);
        }
      });

      client.send(packet, 0, packet.length, opts.radiusPort, opts.radiusServer, (err) => {
        if (err) {
          this.logger.error(`Socket send error: ${err}`);
          resolve(false);
        }
      });
    });
  }
}

