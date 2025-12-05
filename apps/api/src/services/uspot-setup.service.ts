import { routerRpcService } from './router-rpc.service.js';
import { FastifyBaseLogger } from 'fastify';

/**
 * Setup step result
 */
export interface SetupStepResult {
  step: string;
  status: 'success' | 'warning' | 'error' | 'skipped';
  message?: string;
}

/**
 * Complete setup result
 */
export interface SetupResult {
  steps: SetupStepResult[];
  success: boolean;
  message: string;
}

/**
 * UCI configuration helper
 */
interface UciConfig {
  config: string;
  section: string;
  option: string;
  value: string;
}

/**
 * uSpot Setup Service
 * Handles complete uSpot installation and configuration remotely
 */
export class UspotSetupService {
  private readonly REQUIRED_PACKAGES = ['uspot', 'uhttpd', 'jsonfilter', 'ca-bundle', 'ca-certificates'];
  private readonly RADIUS_PORTS = [1812, 1813, 3799];
  private readonly HOTSPOT_IP = '10.1.30.1';
  private readonly HOTSPOT_NETMASK = '255.255.255.0';
  private readonly LAN_IP = '192.168.1.1';
  private readonly LAN_NETMASK = '255.255.255.0';
  private readonly DEFAULT_BRIDGE = 'br-lan';

  constructor(private logger: FastifyBaseLogger) {}

  /**
   * Execute complete uSpot setup
   */
  async setup(routerId: string): Promise<SetupResult> {
    const steps: SetupStepResult[] = [];

    try {
      // Step 1: Update packages
      steps.push(await this.updatePackages(routerId));

      // Step 2: Install packages
      const installResult = await this.installPackages(routerId);
      steps.push(installResult);
      if (installResult.status === 'error') {
        return { steps, success: false, message: 'Package installation failed' };
      }

      // Step 3: Configure wireless (optional)
      steps.push(await this.configureWireless(routerId));

      // Step 4: Configure network
      const networkResult = await this.configureNetwork(routerId);
      steps.push(networkResult);
      if (networkResult.status === 'error') {
        return { steps, success: false, message: 'Network configuration failed' };
      }

      // Step 5: Configure firewall
      const firewallResult = await this.configureFirewall(routerId);
      steps.push(firewallResult);
      if (firewallResult.status === 'error') {
        return { steps, success: false, message: 'Firewall configuration failed' };
      }

      // Step 6: Configure portal
      const portalResult = await this.configurePortal(routerId);
      steps.push(portalResult);
      if (portalResult.status === 'error') {
        return { steps, success: false, message: 'Portal configuration failed' };
      }

      // Step 7: Restart services
      steps.push(await this.restartServices(routerId));

      return {
        steps,
        success: true,
        message: 'uSpot setup completed successfully'
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`[uSpot Setup] Fatal error: ${errorMessage}`);
      return {
        steps,
        success: false,
        message: errorMessage
      };
    }
  }

  /**
   * Update package list
   */
  private async updatePackages(routerId: string): Promise<SetupStepResult> {
    try {
      await routerRpcService.rpcCall(routerId, 'system', 'exec', {
        command: 'opkg update'
      }, 60000);
      return { step: 'package_update', status: 'success' };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(`[uSpot Setup] Package update warning: ${message}`);
      return { step: 'package_update', status: 'warning', message };
    }
  }

  /**
   * Install required packages
   */
  private async installPackages(routerId: string): Promise<SetupStepResult> {
    try {
      // Install main packages
      await routerRpcService.rpcCall(routerId, 'system', 'exec', {
        command: `opkg install ${this.REQUIRED_PACKAGES.join(' ')}`
      }, 120000);

      // Install openssl-util if not present
      try {
        await routerRpcService.rpcCall(routerId, 'system', 'exec', {
          command: 'command -v openssl >/dev/null 2>&1 || opkg install openssl-util'
        }, 60000);
      } catch {
        // Ignore if already installed
      }

      return { step: 'package_install', status: 'success' };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`[uSpot Setup] Package installation failed: ${message}`);
      return { step: 'package_install', status: 'error', message };
    }
  }

  /**
   * Configure wireless interfaces
   */
  private async configureWireless(routerId: string): Promise<SetupStepResult> {
    try {
      const wirelessConfig = await routerRpcService.rpcCall(routerId, 'uci', 'get', { config: 'wireless' });
      if (!wirelessConfig) {
        return { step: 'wireless_config', status: 'skipped', message: 'No wireless configuration found' };
      }

      // Enable all wireless devices
      await this.configureWirelessDevices(routerId);

      // Configure all wireless interfaces
      await this.configureWirelessInterfaces(routerId);

      await routerRpcService.rpcCall(routerId, 'uci', 'commit', { config: 'wireless' });
      return { step: 'wireless_config', status: 'success' };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(`[uSpot Setup] Wireless config warning: ${message}`);
      return { step: 'wireless_config', status: 'skipped', message };
    }
  }

  /**
   * Enable all wireless devices
   */
  private async configureWirelessDevices(routerId: string): Promise<void> {
    let deviceIndex = 0;
    while (true) {
      try {
        const device = await routerRpcService.rpcCall(routerId, 'uci', 'get', {
          config: 'wireless',
          section: `@wifi-device[${deviceIndex}]`
        });
        if (!device) break;

        await this.setUciOption(routerId, {
          config: 'wireless',
          section: `@wifi-device[${deviceIndex}]`,
          option: 'disabled',
          value: '0'
        });
        deviceIndex++;
      } catch {
        break;
      }
    }
  }

  /**
   * Configure all wireless interfaces
   */
  private async configureWirelessInterfaces(routerId: string): Promise<void> {
    let ifaceIndex = 0;
    while (true) {
      try {
        const iface = await routerRpcService.rpcCall(routerId, 'uci', 'get', {
          config: 'wireless',
          section: `@wifi-iface[${ifaceIndex}]`
        });
        if (!iface) break;

        await this.setUciOption(routerId, {
          config: 'wireless',
          section: `@wifi-iface[${ifaceIndex}]`,
          option: 'network',
          value: 'lan'
        });
        await this.setUciOption(routerId, {
          config: 'wireless',
          section: `@wifi-iface[${ifaceIndex}]`,
          option: 'mode',
          value: 'ap'
        });
        ifaceIndex++;
      } catch {
        break;
      }
    }
  }

  /**
   * Configure network interfaces
   */
  private async configureNetwork(routerId: string): Promise<SetupStepResult> {
    try {
      // Ensure LAN interface exists
      await this.ensureUciSection(routerId, 'network', 'lan', 'interface');

      // Configure LAN interface
      await this.setUciOptions(routerId, 'network', 'lan', [
        { option: 'proto', value: 'static' },
        { option: 'type', value: 'bridge' },
        { option: 'ipaddr', value: this.LAN_IP },
        { option: 'netmask', value: this.LAN_NETMASK }
      ]);

      // Get bridge name
      const bridgeName = await this.getBridgeName(routerId);

      // Ensure hotspot interface exists
      await this.ensureUciSection(routerId, 'network', 'hotspot', 'interface');

      // Configure hotspot interface
      await this.setUciOptions(routerId, 'network', 'hotspot', [
        { option: 'proto', value: 'static' },
        { option: 'ipaddr', value: this.HOTSPOT_IP },
        { option: 'netmask', value: this.HOTSPOT_NETMASK },
        { option: 'device', value: bridgeName }
      ]);

      await routerRpcService.rpcCall(routerId, 'uci', 'commit', { config: 'network' });
      return { step: 'network_config', status: 'success' };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`[uSpot Setup] Network config failed: ${message}`);
      return { step: 'network_config', status: 'error', message };
    }
  }

  /**
   * Get bridge name from LAN interface
   */
  private async getBridgeName(routerId: string): Promise<string> {
    try {
      const ifname = await routerRpcService.rpcCall(routerId, 'uci', 'get', {
        config: 'network',
        section: 'lan',
        option: 'ifname'
      });
      if (ifname && typeof ifname === 'string') {
        return ifname.split(' ')[0] || this.DEFAULT_BRIDGE;
      }
    } catch {
      // Use default
    }
    return this.DEFAULT_BRIDGE;
  }

  /**
   * Configure firewall rules
   */
  private async configureFirewall(routerId: string): Promise<SetupStepResult> {
    try {
      // Create hotspot zone if it doesn't exist
      if (!(await this.firewallZoneExists(routerId, 'hotspot'))) {
        await this.createFirewallZone(routerId, 'hotspot');
      }

      // Create forwarding rule if it doesn't exist
      if (!(await this.firewallForwardingExists(routerId, 'hotspot', 'wan'))) {
        await this.createFirewallForwarding(routerId, 'hotspot', 'wan');
      }

      // Add RADIUS firewall rules
      for (const port of this.RADIUS_PORTS) {
        if (!(await this.firewallRuleExists(routerId, `Allow-RADIUS-${port}`))) {
          await this.createFirewallRule(routerId, {
            name: `Allow-RADIUS-${port}`,
            src: 'wan',
            dest_port: port,
            proto: 'udp',
            target: 'ACCEPT'
          });
        }
      }

      await routerRpcService.rpcCall(routerId, 'uci', 'commit', { config: 'firewall' });
      return { step: 'firewall_config', status: 'success' };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`[uSpot Setup] Firewall config failed: ${message}`);
      return { step: 'firewall_config', status: 'error', message };
    }
  }

  /**
   * Check if firewall zone exists
   */
  private async firewallZoneExists(routerId: string, zoneName: string): Promise<boolean> {
    try {
      const zones = await routerRpcService.rpcCall(routerId, 'uci', 'get', { config: 'firewall' });
      if (zones) {
        const zonesStr = JSON.stringify(zones);
        return zonesStr.includes(`name='${zoneName}'`) || zonesStr.includes(`"name":"${zoneName}"`);
      }
    } catch {
      // Continue to create zone
    }
    return false;
  }

  /**
   * Create firewall zone
   */
  private async createFirewallZone(routerId: string, zoneName: string): Promise<void> {
    await routerRpcService.rpcCall(routerId, 'uci', 'add', { config: 'firewall', section: 'zone' });
    await this.setUciOptions(routerId, 'firewall', '@zone[-1]', [
      { option: 'name', value: zoneName },
      { option: 'input', value: 'REJECT' },
      { option: 'output', value: 'ACCEPT' },
      { option: 'forward', value: 'REJECT' },
      { option: 'network', value: zoneName }
    ]);
  }

  /**
   * Check if firewall forwarding exists
   */
  private async firewallForwardingExists(routerId: string, src: string, dest: string): Promise<boolean> {
    try {
      const forwardings = await routerRpcService.rpcCall(routerId, 'uci', 'get', { config: 'firewall' });
      if (forwardings) {
        const forwardingsStr = JSON.stringify(forwardings);
        return forwardingsStr.includes(`src='${src}'`) && forwardingsStr.includes(`dest='${dest}'`);
      }
    } catch {
      // Continue to create forwarding
    }
    return false;
  }

  /**
   * Create firewall forwarding rule
   */
  private async createFirewallForwarding(routerId: string, src: string, dest: string): Promise<void> {
    await routerRpcService.rpcCall(routerId, 'uci', 'add', { config: 'firewall', section: 'forwarding' });
    await this.setUciOptions(routerId, 'firewall', '@forwarding[-1]', [
      { option: 'src', value: src },
      { option: 'dest', value: dest }
    ]);
  }

  /**
   * Check if firewall rule exists
   */
  private async firewallRuleExists(routerId: string, ruleName: string): Promise<boolean> {
    try {
      const rules = await routerRpcService.rpcCall(routerId, 'uci', 'get', { config: 'firewall' });
      if (rules) {
        const rulesStr = JSON.stringify(rules);
        return rulesStr.includes(ruleName);
      }
    } catch {
      // Continue to create rule
    }
    return false;
  }

  /**
   * Create firewall rule
   */
  private async createFirewallRule(
    routerId: string,
    rule: { name: string; src: string; dest_port: number; proto: string; target: string }
  ): Promise<void> {
    await routerRpcService.rpcCall(routerId, 'uci', 'add', { config: 'firewall', section: 'rule' });
    await this.setUciOptions(routerId, 'firewall', '@rule[-1]', [
      { option: 'name', value: rule.name },
      { option: 'src', value: rule.src },
      { option: 'dest_port', value: rule.dest_port.toString() },
      { option: 'proto', value: rule.proto },
      { option: 'target', value: rule.target }
    ]);
  }

  /**
   * Configure HTTPS portal
   */
  private async configurePortal(routerId: string): Promise<SetupStepResult> {
    try {
      // Generate certificate if it doesn't exist
      try {
        await routerRpcService.rpcCall(routerId, 'system', 'exec', {
          command: 'openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout /etc/uhttpd.key -out /etc/uhttpd.crt -subj "/C=US/ST=State/L=City/O=SpotFi/CN=router" 2>/dev/null || true'
        }, 30000);
      } catch {
        // Certificate may already exist, continue
      }

      // Configure uhttpd
      await this.setUciOptions(routerId, 'uhttpd', 'main', [
        { option: 'listen_https', value: '443' },
        { option: 'cert', value: '/etc/uhttpd.crt' },
        { option: 'key', value: '/etc/uhttpd.key' },
        { option: 'redirect_https', value: '0' },
        { option: 'listen_http', value: `${this.HOTSPOT_IP}:80` }
      ]);

      await routerRpcService.rpcCall(routerId, 'uci', 'commit', { config: 'uhttpd' });
      return { step: 'portal_config', status: 'success' };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`[uSpot Setup] Portal config failed: ${message}`);
      return { step: 'portal_config', status: 'error', message };
    }
  }

  /**
   * Restart required services
   */
  private async restartServices(routerId: string): Promise<SetupStepResult> {
    try {
      await routerRpcService.rpcCall(routerId, 'service', 'restart', { name: 'network' });
      await this.sleep(2000);

      await routerRpcService.rpcCall(routerId, 'service', 'restart', { name: 'firewall' });
      await this.sleep(2000);

      // Wireless service may not exist on wired-only routers
      try {
        await routerRpcService.rpcCall(routerId, 'service', 'restart', { name: 'wireless' });
      } catch {
        // Ignore
      }

      await routerRpcService.rpcCall(routerId, 'service', 'enable', { name: 'uhttpd' });
      await routerRpcService.rpcCall(routerId, 'service', 'restart', { name: 'uhttpd' });

      return { step: 'services_restart', status: 'success' };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(`[uSpot Setup] Service restart warning: ${message}`);
      return { step: 'services_restart', status: 'warning', message };
    }
  }

  /**
   * Helper: Ensure UCI section exists
   */
  private async ensureUciSection(routerId: string, config: string, section: string, type: string): Promise<void> {
    try {
      await routerRpcService.rpcCall(routerId, 'uci', 'get', { config, section });
    } catch {
      await routerRpcService.rpcCall(routerId, 'uci', 'set', {
        config,
        section,
        option: type,
        value: ''
      });
    }
  }

  /**
   * Helper: Set single UCI option
   */
  private async setUciOption(routerId: string, uci: UciConfig): Promise<void> {
    await routerRpcService.rpcCall(routerId, 'uci', 'set', uci);
  }

  /**
   * Helper: Set multiple UCI options
   */
  private async setUciOptions(
    routerId: string,
    config: string,
    section: string,
    options: Array<{ option: string; value: string }>
  ): Promise<void> {
    for (const opt of options) {
      await this.setUciOption(routerId, { config, section, option: opt.option, value: opt.value });
    }
  }

  /**
   * Helper: Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

