declare module './terminal.js' {
  import { FastifyInstance } from 'fastify';
  export function terminalRoutes(fastify: FastifyInstance): Promise<void>;
}


