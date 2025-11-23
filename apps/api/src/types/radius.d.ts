/**
 * Type definitions for the 'radius' module
 * @see https://www.npmjs.com/package/radius
 */

declare module 'radius' {
  interface EncodeOptions {
    code: 'Access-Request' | 'Access-Accept' | 'Access-Reject' | 'Accounting-Request' | 'Accounting-Response';
    secret: string;
    identifier: number;
    attributes: Array<[string, string | number]>;
  }

  interface DecodeOptions {
    packet: Buffer;
    secret: string;
  }

  interface DecodedResponse {
    code: 'Access-Accept' | 'Access-Reject' | 'Accounting-Response';
    attributes?: Record<string, any>;
    [key: string]: any;
  }

  function encode(options: EncodeOptions): Buffer;
  function decode(options: DecodeOptions): DecodedResponse;

  const radius: {
    encode: typeof encode;
    decode: typeof decode;
  };

  export = radius;
}

