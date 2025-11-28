import { WebSocket } from 'ws';
import { commandManager } from '../websocket/command-manager.js';
import {
  getLocalConnection,
  isRouterConnected,
  sendRpcCommand
} from './websocket-redis-adapter.js';

/**
 * Router RPC Service
 * Generic UBUS proxy service - The ONLY method you need!
 * All wrapper methods are one-liners that call rpcCall()
 * 
 * Now supports horizontal scaling via Redis Pub/Sub
 */
export class RouterRpcService {
  /**
   * Generic RPC Call - The ONLY method you effectively need
   * All other methods are just convenience wrappers
   * 
   * Supports cross-server routing via Redis Pub/Sub for horizontal scaling
   * 
   * @public - Exposed for advanced use cases (e.g., cron jobs, background tasks)
   */
  async rpcCall(
    routerId: string,
    path: string,
    method: string,
    args: any = {},
    timeout: number = 30000
  ): Promise<any> {
    // Check if router is connected (any server)
    const isOnline = await isRouterConnected(routerId);
    if (!isOnline) {
      throw new Error('Router is offline');
    }

    // Get local connection if available
    const socket = getLocalConnection(routerId);
    
    if (socket) {
      // Router is on this server - use direct WebSocket connection
      const response = await commandManager.sendCommand(routerId, socket, 'ubus_call', {
        path,
        method,
        args
      }, timeout);
      return response.result || response;
    } else {
      // Router is on another server - use Redis Pub/Sub with response routing
      const commandId = commandManager.generateCommandId();
      
      // Set up promise for response (command manager will resolve it)
      const responsePromise = new Promise<any>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          commandManager.handleResponse(commandId, { type: 'error', error: 'Timeout' });
          reject(new Error(`RPC timeout after ${timeout}ms`));
        }, timeout);

        // Store pending command in command manager
        const pendingCommand = {
          resolve: (value: any) => {
            clearTimeout(timeoutId);
            resolve(value);
          },
          reject: (error: any) => {
            clearTimeout(timeoutId);
            reject(error);
          },
          timeout: timeoutId,
          commandId
        };
        
        // Temporarily store in command manager's pending commands
        // The command manager will handle the response when it arrives via Pub/Sub
        (commandManager as any).pendingCommands.set(commandId, pendingCommand);
      });

      // Send RPC command via Redis Pub/Sub
      const message = {
        type: 'rpc',
        id: commandId,
        path,
        method,
        args
      };

      const sent = await sendRpcCommand(routerId, message);
      if (!sent) {
        (commandManager as any).pendingCommands.delete(commandId);
        throw new Error('Failed to send RPC command to router');
      }

      // Wait for response (will be routed back via Redis Pub/Sub and handled by command manager)
      const response = await responsePromise;
      return response.result || response;
    }
  }

  // Wrapper methods become one-liners - leveraging ubus native capabilities

  async getSystemInfo(routerId: string): Promise<any> {
    return this.rpcCall(routerId, 'system', 'info');
  }

  async getBoardInfo(routerId: string): Promise<any> {
    return this.rpcCall(routerId, 'system', 'board');
  }

  async reboot(routerId: string): Promise<any> {
    return this.rpcCall(routerId, 'system', 'reboot');
  }

  async getNetworkInterfaces(routerId: string, interfaceName?: string): Promise<any> {
    if (interfaceName) {
      return this.rpcCall(routerId, 'network.interface', 'status', { interface: interfaceName });
    }
    return this.rpcCall(routerId, 'network.interface', 'dump');
  }

  async getNetworkStats(routerId: string): Promise<any> {
    return this.rpcCall(routerId, 'network.device', 'status');
  }

  async getWirelessStatus(routerId: string, interfaceName: string = 'wlan0'): Promise<any> {
    return this.rpcCall(routerId, 'hostapd', `${interfaceName}/get_status`);
  }

  // Utilizing uspot's native client list (leveraging existing C-binary capabilities)
  async getLiveClients(routerId: string): Promise<any> {
    return this.rpcCall(routerId, 'uspot', 'client_list');
  }

  async getClientInfo(routerId: string, mac: string): Promise<any> {
    return this.rpcCall(routerId, 'uspot', 'client_get', { address: mac });
  }

  // Leveraging uspot's native kick functionality
  // Reference: files/usr/share/uspot/uspot.uc in your dump
  async kickClient(routerId: string, mac: string): Promise<any> {
    // "client_remove" is the native Uspot ubus method
    return this.rpcCall(routerId, 'uspot', 'client_remove', { 
      address: mac,
      interface: 'uspot' // Often required by uspot ubus definitions
    });
  }
}

export const routerRpcService = new RouterRpcService();

