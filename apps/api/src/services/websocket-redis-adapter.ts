/**
 * Redis Pub/Sub Adapter for WebSocket Horizontal Scaling
 * 
 * Architecture:
 * - Tracks which API server (node) has which router connection
 * - Uses Redis Pub/Sub to route messages across API servers
 * - Enables horizontal scaling (100k+ routers across multiple servers)
 * 
 * Benefits:
 * - Decouples WebSocket state from single server
 * - Supports load balancing across multiple API instances
 * - Auto-cleanup of stale connections (TTL-based)
 */

import { WebSocket } from 'ws';
import { redis } from '../lib/redis.js';
import { FastifyBaseLogger } from 'fastify';
import { randomUUID } from 'crypto';
import { hostname } from 'os';

// Generate unique server ID for this API instance
const SERVER_ID = process.env.SERVER_ID || `${hostname()}-${process.pid}-${randomUUID().substring(0, 8)}`;

// Redis keys and channels
const ROUTER_CONNECTION_KEY_PREFIX = 'router:connection:';
const RPC_CHANNEL_PREFIX = 'router:rpc:';
const RPC_RESPONSE_CHANNEL_PREFIX = 'router:rpc:response:';
const X_TUNNEL_CHANNEL_PREFIX = 'router:x:';
const MESSAGE_CHANNEL_PREFIX = 'router:message:';
const CONNECTION_TTL_SECONDS = 60; // Auto-cleanup if server dies

// Local connection map (for routers connected to THIS server)
const localConnections = new Map<string, WebSocket>();

// Pub/Sub subscriber for receiving messages from other servers
let pubSubSubscriber: ReturnType<typeof redis.duplicate> | null = null;
let isSubscribed = false;

/**
 * Initialize Redis Pub/Sub subscriber
 */
export async function initializeRedisPubSub(
  onRpcMessage: (routerId: string, message: any) => void,
  onXTunnelMessage: (routerId: string, message: any) => void,
  logger?: FastifyBaseLogger
): Promise<void> {
  if (isSubscribed) {
    logger?.warn('⚠️  Redis Pub/Sub already initialized');
    return;
  }

  try {
    // Create dedicated connection for Pub/Sub (required by Redis)
    pubSubSubscriber = redis.duplicate();
    
    await pubSubSubscriber.connect();
    logger?.info(`✅ Redis Pub/Sub subscriber connected (Server ID: ${SERVER_ID})`);

    // Subscribe to pattern: router:rpc:*, router:x:*, router:rpc:response:*
    await pubSubSubscriber.psubscribe(
      `${RPC_CHANNEL_PREFIX}*`,
      `${X_TUNNEL_CHANNEL_PREFIX}*`,
      `${MESSAGE_CHANNEL_PREFIX}*`,
      `${RPC_RESPONSE_CHANNEL_PREFIX}*`
    );
    isSubscribed = true;
    logger?.info('✅ Subscribed to Redis Pub/Sub channels for router routing');

    // Handle incoming messages
    pubSubSubscriber.on('pmessage', (pattern, channel, message) => {
      try {
        const parsed = JSON.parse(message);
        
        // Handle RPC responses (routed back to requesting server)
        if (channel.startsWith(RPC_RESPONSE_CHANNEL_PREFIX)) {
          const targetServerId = channel.replace(RPC_RESPONSE_CHANNEL_PREFIX, '');
          if (targetServerId === SERVER_ID) {
            // This response is for us - handle it via command manager
            if (parsed.id && onRpcMessage) {
              onRpcMessage('', parsed); // routerId not needed for responses
            }
          }
          return;
        }

        const routerId = extractRouterIdFromChannel(channel);
        if (!routerId) {
          logger?.warn(`⚠️  Could not extract routerId from channel: ${channel}`);
          return;
        }

        // Only process if router is connected to THIS server
        if (localConnections.has(routerId)) {
          if (channel.startsWith(RPC_CHANNEL_PREFIX)) {
            onRpcMessage(routerId, parsed);
          } else if (channel.startsWith(X_TUNNEL_CHANNEL_PREFIX)) {
            onXTunnelMessage(routerId, parsed);
          }
        }
      } catch (error: any) {
        logger?.error(`❌ Failed to process Pub/Sub message: ${error.message}`);
      }
    });

    // Handle connection errors
    pubSubSubscriber.on('error', (err) => {
      logger?.error(`❌ Redis Pub/Sub subscriber error: ${err.message}`);
      isSubscribed = false;
      // Attempt to reconnect
      setTimeout(() => {
        if (!isSubscribed) {
          logger?.warn('🔄 Attempting to reconnect Redis Pub/Sub subscriber...');
          initializeRedisPubSub(onRpcMessage, onXTunnelMessage, logger).catch(() => {
            logger?.error('❌ Failed to reconnect Redis Pub/Sub subscriber');
          });
        }
      }, 5000);
    });

  } catch (error: any) {
    logger?.error(`❌ Failed to initialize Redis Pub/Sub: ${error.message}`);
    logger?.warn('⚠️  Falling back to local-only mode (no horizontal scaling)');
    isSubscribed = false;
  }
}

/**
 * Register router connection in Redis
 */
export async function registerRouterConnection(
  routerId: string,
  socket: WebSocket,
  logger?: FastifyBaseLogger
): Promise<void> {
  // Store locally
  localConnections.set(routerId, socket);

  // Register in Redis (with TTL for auto-cleanup)
  const key = `${ROUTER_CONNECTION_KEY_PREFIX}${routerId}`;
  const connectionInfo = {
    serverId: SERVER_ID,
    timestamp: Date.now(),
    routerId
  };

  await redis.setex(key, CONNECTION_TTL_SECONDS, JSON.stringify(connectionInfo));
  
  // Refresh TTL periodically (every 30 seconds) while connection is alive
  const refreshInterval = setInterval(async () => {
    if (localConnections.has(routerId) && socket.readyState === WebSocket.OPEN) {
      await redis.setex(key, CONNECTION_TTL_SECONDS, JSON.stringify(connectionInfo));
    } else {
      clearInterval(refreshInterval);
      await unregisterRouterConnection(routerId);
    }
  }, 30000);

  // Clean up interval on disconnect
  socket.on('close', () => {
    clearInterval(refreshInterval);
  });

  logger?.debug(`📡 Registered router ${routerId} on server ${SERVER_ID}`);
}

/**
 * Unregister router connection from Redis
 */
export async function unregisterRouterConnection(routerId: string): Promise<void> {
  localConnections.delete(routerId);
  
  const key = `${ROUTER_CONNECTION_KEY_PREFIX}${routerId}`;
  await redis.del(key);
}

/**
 * Check if router is connected to THIS server
 */
export function isRouterLocal(routerId: string): boolean {
  const socket = localConnections.get(routerId);
  return socket !== undefined && socket.readyState === WebSocket.OPEN;
}

/**
 * Get local WebSocket connection (if router is on this server)
 */
export function getLocalConnection(routerId: string): WebSocket | undefined {
  const socket = localConnections.get(routerId);
  if (socket && socket.readyState === WebSocket.OPEN) {
    return socket;
  }
  return undefined;
}

/**
 * Get which server has the router connection
 */
export async function getRouterConnectionServer(routerId: string): Promise<string | null> {
  const key = `${ROUTER_CONNECTION_KEY_PREFIX}${routerId}`;
  const data = await redis.get(key);
  
  if (!data) {
    return null;
  }

  try {
    const info = JSON.parse(data);
    return info.serverId;
  } catch {
    return null;
  }
}

/**
 * Send RPC command to router (routes via Redis Pub/Sub if not local)
 * Returns a promise that resolves when the command is sent (not when response is received)
 */
export async function sendRpcCommand(
  routerId: string,
  command: any,
  logger?: FastifyBaseLogger
): Promise<boolean> {
  // Check if router is local
  const localSocket = getLocalConnection(routerId);
  if (localSocket) {
    // Send directly to local WebSocket
    try {
      localSocket.send(JSON.stringify(command));
      return true;
    } catch (error: any) {
      logger?.error(`❌ Failed to send RPC to local router ${routerId}: ${error.message}`);
      return false;
    }
  }

  // Router is on another server - publish to Redis Pub/Sub
  // Include response channel so the receiving server can send response back
  const channel = `${RPC_CHANNEL_PREFIX}${routerId}`;
  try {
    await redis.publish(channel, JSON.stringify({
      ...command,
      _serverId: SERVER_ID, // Track which server sent it
      _responseChannel: `${RPC_RESPONSE_CHANNEL_PREFIX}${SERVER_ID}`, // Where to send response
      _timestamp: Date.now()
    }));
    logger?.debug(`📤 Published RPC command to router ${routerId} via Redis Pub/Sub (response to ${SERVER_ID})`);
    return true;
  } catch (error: any) {
    logger?.error(`❌ Failed to publish RPC command via Redis: ${error.message}`);
    return false;
  }
}

/**
 * Send RPC response back to requesting server via Redis Pub/Sub
 */
export async function sendRpcResponse(
  responseChannel: string,
  response: any,
  logger?: FastifyBaseLogger
): Promise<void> {
  try {
    await redis.publish(responseChannel, JSON.stringify(response));
    logger?.debug(`📤 Sent RPC response to ${responseChannel}`);
  } catch (error: any) {
    logger?.error(`❌ Failed to send RPC response via Redis: ${error.message}`);
  }
}

/**
 * Send x tunnel data to router (routes via Redis Pub/Sub if not local)
 */
export async function sendXTunnelData(
  routerId: string,
  sessionId: string,
  data: Buffer,
  logger?: FastifyBaseLogger
): Promise<boolean> {
  // Check if router is local
  const localSocket = getLocalConnection(routerId);
  if (localSocket) {
    // Send directly to local WebSocket
    try {
      const message = {
        type: 'x-data',
        sessionId,
        data: data.toString('base64')
      };
      localSocket.send(JSON.stringify(message));
      return true;
    } catch (error: any) {
      logger?.error(`❌ Failed to send x data to local router ${routerId}: ${error.message}`);
      return false;
    }
  }

  // Router is on another server - publish to Redis Pub/Sub
  const channel = `${X_TUNNEL_CHANNEL_PREFIX}${routerId}`;
  try {
    await redis.publish(channel, JSON.stringify({
      type: 'x-data',
      sessionId,
      data: data.toString('base64'),
      _serverId: SERVER_ID,
      _timestamp: Date.now()
    }));
    logger?.debug(`📤 Published x tunnel data to router ${routerId} via Redis Pub/Sub`);
    return true;
  } catch (error: any) {
    logger?.error(`❌ Failed to publish x tunnel data via Redis: ${error.message}`);
    return false;
  }
}

/**
 * Check if router is connected (any server)
 */
export async function isRouterConnected(routerId: string): Promise<boolean> {
  // First check local
  if (isRouterLocal(routerId)) {
    return true;
  }

  // Check Redis for connection on other servers
  const key = `${ROUTER_CONNECTION_KEY_PREFIX}${routerId}`;
  const exists = await redis.exists(key);
  return exists === 1;
}

/**
 * Get all locally connected router IDs
 */
export function getLocalRouterIds(): string[] {
  return Array.from(localConnections.keys()).filter(id => {
    const socket = localConnections.get(id);
    return socket && socket.readyState === WebSocket.OPEN;
  });
}

/**
 * Get total connected routers (across all servers)
 */
export async function getTotalConnectedRouters(): Promise<number> {
  const pattern = `${ROUTER_CONNECTION_KEY_PREFIX}*`;
  const keys = await redis.keys(pattern);
  return keys.length;
}

/**
 * Extract router ID from Redis channel name
 */
function extractRouterIdFromChannel(channel: string): string | null {
  if (channel.startsWith(RPC_CHANNEL_PREFIX)) {
    return channel.replace(RPC_CHANNEL_PREFIX, '');
  }
  if (channel.startsWith(X_TUNNEL_CHANNEL_PREFIX)) {
    return channel.replace(X_TUNNEL_CHANNEL_PREFIX, '');
  }
  if (channel.startsWith(MESSAGE_CHANNEL_PREFIX)) {
    return channel.replace(MESSAGE_CHANNEL_PREFIX, '');
  }
  return null;
}

/**
 * Cleanup on shutdown
 */
export async function cleanup(): Promise<void> {
  // Unregister all local connections
  for (const routerId of localConnections.keys()) {
    await unregisterRouterConnection(routerId);
  }

  // Unsubscribe from Pub/Sub
  if (pubSubSubscriber && isSubscribed) {
    await pubSubSubscriber.punsubscribe(`${RPC_CHANNEL_PREFIX}*`, `${X_TUNNEL_CHANNEL_PREFIX}*`, `${MESSAGE_CHANNEL_PREFIX}*`);
    await pubSubSubscriber.quit();
    pubSubSubscriber = null;
    isSubscribed = false;
  }
}

/**
 * Get server ID
 */
export function getServerId(): string {
  return SERVER_ID;
}

