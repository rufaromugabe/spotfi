import { WebSocket } from 'ws';
import { commandManager } from '../websocket/command-manager.js';
// Removed: import { activeConnections } from '../websocket/server.js'; 

/**
 * Router RPC Service
 * Generic UBUS proxy service - The ONLY method you need!
 * All wrapper methods are one-liners that call rpcCall()
 */
export class RouterRpcService {
  /**
   * Generic RPC Call - The ONLY method you effectively need
   * All other methods are just convenience wrappers
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
    // Removed: socket lookup and check. MQTT is decoupled.
    // If router is offline, the command will timeout (or queue if QoS > 0)
    // We can rely on Redis "Online" status check here if we want to fail fast,
    // but for now let's attempt to send.

    // Send as 'rpc' type (bridge.py handles this generically)
    try {
      // Pass routerId directly to commandManager (MQTT-based)
      const response = await commandManager.sendCommand(routerId, 'ubus_call', {
        path,
        method,
        args
      }, timeout);

      // Extract result from response (bridge.py sends 'result' field)
      return response.result || response;
    } catch (error: any) {
      // Log the error before re-throwing so we can see what we're getting
      console.error(`[RouterRPC] Error in rpcCall ${path}.${method}:`, {
        message: error?.message,
        hasResponse: !!error?.response,
        hasResult: !!error?.result,
        hasStderr: !!error?.stderr,
        errorKeys: Object.keys(error || {})
      });
      throw error;
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
