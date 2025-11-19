/**
 * Simple RADIUS client for authentication
 * This is a basic implementation for uspot portal authentication
 */

import dgram from 'dgram';
import crypto from 'crypto';

interface RadClientOptions {
  host: string;
  secret: string;
  port?: number;
  timeout?: number;
}

interface AuthRequest {
  username: string;
  password: string;
  attributes?: Record<string, string>;
}

interface AuthResult {
  accept: boolean;
  attributes?: Record<string, string>;
  message?: string;
}

/**
 * Simple RADIUS client
 * Note: This is a minimal implementation. For production, consider using a library like 'radius' npm package
 */
export class RadClient {
  private host: string;
  private secret: string;
  private port: number;
  private timeout: number;

  constructor(options: RadClientOptions) {
    this.host = options.host;
    this.secret = options.secret;
    this.port = options.port || 1812;
    this.timeout = options.timeout || 5000;
  }

  /**
   * Authenticate user via RADIUS
   */
  async authenticate(username: string, password: string, attributes: Record<string, string> = {}): Promise<AuthResult> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      let timeoutId: NodeJS.Timeout;

      const cleanup = () => {
        clearTimeout(timeoutId);
        socket.close();
      };

      // Set timeout
      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error('RADIUS authentication timeout'));
      }, this.timeout);

      // Listen for response
      socket.on('message', (msg) => {
        cleanup();
        
        if (msg.length < 20) {
          resolve({ accept: false, message: 'Invalid RADIUS response' });
          return;
        }

        const code = msg[0];
        
        // RADIUS Access-Accept (2) or Access-Reject (3)
        if (code === 2) {
          resolve({ accept: true });
        } else if (code === 3) {
          resolve({ accept: false, message: 'Authentication rejected' });
        } else {
          resolve({ accept: false, message: 'Unknown RADIUS response code' });
        }
      });

      socket.on('error', (err) => {
        cleanup();
        reject(err);
      });

      // Build RADIUS Access-Request packet
      try {
        const packet = this.buildAccessRequest(username, password, attributes);
        socket.send(packet, 0, packet.length, this.port, this.host, (err) => {
          if (err) {
            cleanup();
            reject(err);
          }
        });
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  }

  /**
   * Build RADIUS Access-Request packet
   */
  private buildAccessRequest(username: string, password: string, attributes: Record<string, string>): Buffer {
    // Generate authenticator
    const authenticator = crypto.randomBytes(16);
    
    // Code: Access-Request (1)
    const code = 1;
    
    // Identifier (random)
    const identifier = Math.floor(Math.random() * 256);
    
    // Build attribute list
    const attributesList: Buffer[] = [];
    
    // User-Name attribute (1)
    attributesList.push(this.buildAttribute(1, Buffer.from(username, 'utf8')));
    
    // User-Password attribute (2) - encrypted with MD5
    attributesList.push(this.buildPasswordAttribute(password, authenticator));
    
    // Add other attributes
    for (const [key, value] of Object.entries(attributes)) {
      // Map common attribute names to RADIUS codes
      const attrCode = this.getAttributeCode(key);
      if (attrCode) {
        // Handle numeric attributes (Service-Type, NAS-Port-Type, etc.)
        let attrValue: Buffer;
        if (this.isNumericAttribute(attrCode)) {
          const numValue = parseInt(value, 10);
          if (!isNaN(numValue)) {
            attrValue = Buffer.alloc(4);
            attrValue.writeUInt32BE(numValue, 0);
          } else {
            // Try to map string to number for common attributes
            const mappedValue = this.mapStringToNumeric(attrCode, value);
            attrValue = Buffer.alloc(4);
            attrValue.writeUInt32BE(mappedValue, 0);
          }
        } else {
          attrValue = Buffer.from(value, 'utf8');
        }
        attributesList.push(this.buildAttribute(attrCode, attrValue));
      }
    }
    
    const attributesBuffer = Buffer.concat(attributesList);
    const length = 20 + attributesBuffer.length; // Header (20) + attributes
    
    // Build packet
    const packet = Buffer.alloc(length);
    packet[0] = code;
    packet[1] = identifier;
    packet.writeUInt16BE(length, 2);
    authenticator.copy(packet, 4);
    attributesBuffer.copy(packet, 20);
    
    // Calculate Request Authenticator (MD5 hash)
    const requestAuth = this.calculateRequestAuthenticator(packet, length);
    requestAuth.copy(packet, 4);
    
    return packet;
  }

  /**
   * Build RADIUS attribute
   */
  private buildAttribute(type: number, value: Buffer): Buffer {
    const length = value.length + 2; // Type (1) + Length (1) + Value
    const attr = Buffer.alloc(length);
    attr[0] = type;
    attr[1] = length;
    value.copy(attr, 2);
    return attr;
  }

  /**
   * Build User-Password attribute with encryption
   */
  private buildPasswordAttribute(password: string, authenticator: Buffer): Buffer {
    // RADIUS User-Password encryption (RFC 2865)
    const passwordBytes = Buffer.from(password, 'utf8');
    const paddedLength = Math.ceil(passwordBytes.length / 16) * 16;
    const padded = Buffer.alloc(paddedLength);
    passwordBytes.copy(padded);
    
    const encrypted = Buffer.alloc(paddedLength);
    let lastBlock = authenticator;
    
    for (let i = 0; i < paddedLength; i += 16) {
      const block = padded.slice(i, i + 16);
      const hash = crypto.createHash('md5');
      hash.update(this.secret);
      hash.update(lastBlock);
      const key = hash.digest();
      
      for (let j = 0; j < 16; j++) {
        encrypted[i + j] = block[j] ^ key[j];
      }
      
      lastBlock = encrypted.slice(i, i + 16);
    }
    
    // Build attribute (type 2, User-Password)
    const attr = Buffer.alloc(2 + encrypted.length);
    attr[0] = 2; // User-Password
    attr[1] = 2 + encrypted.length;
    encrypted.copy(attr, 2);
    
    return attr;
  }

  /**
   * Calculate Request Authenticator (MD5 hash)
   */
  private calculateRequestAuthenticator(packet: Buffer, length: number): Buffer {
    const hash = crypto.createHash('md5');
    hash.update(packet.slice(0, 4)); // Code, Identifier, Length
    hash.update(Buffer.alloc(16, 0)); // Zero authenticator
    hash.update(packet.slice(20, length)); // Attributes
    hash.update(this.secret);
    return hash.digest();
  }

  /**
   * Get RADIUS attribute code from name
   */
  private getAttributeCode(name: string): number | null {
    const attrMap: Record<string, number> = {
      'NAS-IP-Address': 4,
      'NAS-Port': 5,
      'Service-Type': 6,
      'Framed-Protocol': 7,
      'Framed-IP-Address': 8,
      'Framed-IP-Netmask': 9,
      'Framed-Routing': 10,
      'Filter-Id': 11,
      'Framed-MTU': 12,
      'Framed-Compression': 13,
      'Login-IP-Host': 14,
      'Login-Service': 15,
      'Login-TCP-Port': 16,
      'Reply-Message': 18,
      'Callback-Number': 19,
      'Callback-Id': 20,
      'Framed-Route': 22,
      'Framed-IPX-Network': 23,
      'State': 24,
      'Class': 25,
      'Vendor-Specific': 26,
      'Session-Timeout': 27,
      'Idle-Timeout': 28,
      'Termination-Action': 29,
      'Called-Station-Id': 30,
      'Calling-Station-Id': 31,
      'NAS-Identifier': 32,
      'Proxy-State': 33,
      'Login-LAT-Service': 34,
      'Login-LAT-Node': 35,
      'Login-LAT-Group': 36,
      'Framed-AppleTalk-Link': 37,
      'Framed-AppleTalk-Network': 38,
      'Framed-AppleTalk-Zone': 39,
      'Acct-Status-Type': 40,
      'Acct-Delay-Time': 41,
      'Acct-Input-Octets': 42,
      'Acct-Output-Octets': 43,
      'Acct-Session-Id': 44,
      'Acct-Authentic': 45,
      'Acct-Session-Time': 46,
      'Acct-Input-Packets': 47,
      'Acct-Output-Packets': 48,
      'Acct-Terminate-Cause': 49,
      'Acct-Multi-Session-Id': 50,
      'Acct-Link-Count': 51,
    };
    
    return attrMap[name] || null;
  }

  /**
   * Check if attribute is numeric (4-byte integer)
   */
  private isNumericAttribute(code: number): boolean {
    // These RADIUS attributes are 4-byte integers
    const numericAttributes = [
      5,   // NAS-Port
      6,   // Service-Type
      7,   // Framed-Protocol
      8,   // Framed-IP-Address
      9,   // Framed-IP-Netmask
      10,  // Framed-Routing
      12,  // Framed-MTU
      13,  // Framed-Compression
      14,  // Login-IP-Host
      15,  // Login-Service
      16,  // Login-TCP-Port
      27,  // Session-Timeout
      28,  // Idle-Timeout
      29,  // Termination-Action
    ];
    return numericAttributes.includes(code);
  }

  /**
   * Map string values to numeric codes for common attributes
   */
  private mapStringToNumeric(code: number, value: string): number {
    if (code === 6) { // Service-Type
      const serviceTypes: Record<string, number> = {
        'Framed-User': 2,
        'Callback-Login': 3,
        'Callback-Framed': 4,
        'Outbound': 5,
        'Administrative': 6,
        'NAS-Prompt': 7,
        'Authenticate-Only': 8,
        'Callback-NAS-Prompt': 9,
        'Call-Check': 10,
        'Callback-Administrative': 11,
      };
      return serviceTypes[value] || 2; // Default to Framed-User
    }
    if (code === 19) { // NAS-Port-Type (vendor-specific, but common values)
      const portTypes: Record<string, number> = {
        'Async': 0,
        'Sync': 1,
        'ISDN-Sync': 2,
        'ISDN-Async-V.120': 3,
        'ISDN-Async-V.110': 4,
        'Virtual': 5,
        'PIAFS': 6,
        'HDLC-Clear-Channel': 7,
        'X.25': 8,
        'X.75': 9,
        'G.3-Fax': 10,
        'SDSL': 11,
        'ADSL-CAP': 12,
        'ADSL-DMT': 13,
        'IDSL': 14,
        'Ethernet': 15,
        'xDSL': 16,
        'Cable': 17,
        'Wireless-Other': 18,
        'Wireless-802.11': 19,
      };
      return portTypes[value] || 19; // Default to Wireless-802.11
    }
    return 0;
  }
}

