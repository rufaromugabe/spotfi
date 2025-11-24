import { WebSocket } from 'ws';
import { commandManager } from '../websocket/command-manager.js';
import { activeConnections } from '../websocket/server.js';

/**
 * Router RPC Service
 * Generic UBUS proxy service - The ONLY method you need!
 * All wrapper methods are one-liners that call rpcCall()
 */
export class RouterRpcService {
  /**
   * Generic RPC Call - The ONLY method you effectively need
   * All other methods are just convenience wrappers
   */
  private async rpcCall(
    routerId: string,
    path: string,
    method: string,
    args: any = {},
    timeout: number = 30000
  ): Promise<any> {
    const socket = activeConnections.get(routerId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Router is offline');
    }

    // Send as 'rpc' type (bridge.py handles this generically)
    const response = await commandManager.sendCommand(routerId, socket, 'ubus_call', {
      path,
      method,
      args
    }, timeout);

    // Extract result from response (bridge.py sends 'result' field)
    return response.result || response;
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
  async kickClient(routerId: string, mac: string): Promise<any> {
    return this.rpcCall(routerId, 'uspot', 'client_remove', { address: mac });
  }
}

export const routerRpcService = new RouterRpcService();

