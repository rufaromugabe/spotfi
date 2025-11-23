import { WebSocket } from 'ws';
import { commandManager } from '../websocket/command-manager.js';
import { activeConnections } from '../websocket/server.js';

/**
 * Router RPC Service
 * Generic UBUS proxy service that leverages OpenWrt's native ubus system
 * This replaces hardcoded commands with generic ubus calls
 */
export class RouterRpcService {
  /**
   * Generic UBUS Call
   * This replaces 90% of hardcoded commands (reboot, info, network stats, etc)
   */
  async callUbus(
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

    // Send as ubus_call command type with path, method, args in params
    return commandManager.sendCommand(routerId, socket, 'ubus_call', {
      path,
      method,
      args
    }, timeout);
  }

  /**
   * Get native uspot client list directly from the router kernel/bpf maps
   */
  async getLiveClients(routerId: string): Promise<any> {
    // uspot exposes 'client_list' via ubus
    return this.callUbus(routerId, 'uspot', 'client_list', {});
  }

  /**
   * Get specific client info from uspot
   */
  async getClientInfo(routerId: string, mac: string): Promise<any> {
    return this.callUbus(routerId, 'uspot', 'client_get', { address: mac });
  }

  /**
   * Kick a user directly via uspot (bypassing RADIUS CoM if needed, or for sync)
   */
  async kickClient(routerId: string, mac: string): Promise<any> {
    return this.callUbus(routerId, 'uspot', 'client_remove', { address: mac });
  }

  /**
   * Get detailed interface stats directly from netifd
   */
  async getNetworkStats(routerId: string): Promise<any> {
    return this.callUbus(routerId, 'network.device', 'status', {});
  }

  /**
   * Get system information (uptime, memory, load)
   */
  async getSystemInfo(routerId: string): Promise<any> {
    return this.callUbus(routerId, 'system', 'info', {});
  }

  /**
   * Get board information
   */
  async getBoardInfo(routerId: string): Promise<any> {
    return this.callUbus(routerId, 'system', 'board', {});
  }

  /**
   * Get network interface status
   */
  async getNetworkInterfaces(routerId: string, interfaceName?: string): Promise<any> {
    if (interfaceName) {
      return this.callUbus(routerId, 'network.interface', 'status', { interface: interfaceName });
    }
    return this.callUbus(routerId, 'network.interface', 'dump', {});
  }

  /**
   * Get wireless status via hostapd
   */
  async getWirelessStatus(routerId: string, interfaceName: string = 'wlan0'): Promise<any> {
    try {
      return await this.callUbus(routerId, 'hostapd', `${interfaceName}/get_status`, {});
    } catch (error) {
      // Fallback to iwinfo if hostapd ubus not available
      throw new Error(`Wireless status not available: ${error}`);
    }
  }
}

export const routerRpcService = new RouterRpcService();

