import { routerRpcService } from './router-rpc.service.js';
import { FastifyBaseLogger } from 'fastify';

/**
 * Enhanced Setup Result Interface
 */
export interface SetupStepResult {
  step: string;
  status: 'success' | 'warning' | 'error' | 'skipped';
  message?: string;
  details?: any;
}

export interface SetupResult {
  steps: SetupStepResult[];
  success: boolean;
  message: string;
  results?: any;
}

interface UciConfig {
  config: string;
  section: string;
  option: string;
  value: string;
}

/**
 * Robust uSpot Setup Service
 * Implements "Verify -> Remediate -> Execute" pattern
 */
export class UspotSetupService {
  private readonly REQUIRED_PACKAGES = ['uspot', 'uhttpd', 'jsonfilter', 'ca-bundle', 'ca-certificates', 'openssl-util'];
  private readonly RADIUS_PORTS = [1812, 1813, 3799];
  private readonly HOTSPOT_IP = '10.1.30.1';
  private readonly HOTSPOT_NETMASK = '255.255.255.0';
  private readonly LAN_IP = '192.168.56.10';
  private readonly LAN_NETMASK = '255.255.255.0';
  private readonly DEFAULT_BRIDGE = 'br-lan';

  constructor(private logger: FastifyBaseLogger) {}

  /**
   * Execute complete setup with diagnostics and auto-remediation
   */
  async setup(routerId: string): Promise<SetupResult> {
    const steps: SetupStepResult[] = [];

    try {
      // --- PHASE 1: PRE-FLIGHT VALIDATION ---
      
      // 1. Check System Resources (Disk/RAM)
      const resourceCheck = await this.checkResources(routerId);
      steps.push(resourceCheck);
      if (resourceCheck.status === 'error') {
        return this.fail(steps, `Resource check failed: ${resourceCheck.message}`);
      }

      // 2. Check & Fix System Time (Crucial for SSL)
      steps.push(await this.ensureSystemTime(routerId));

      // 3. Network & DNS Diagnostics + Remediation
      const netCheck = await this.ensureConnectivity(routerId);
      steps.push(netCheck);
      if (netCheck.status === 'error') {
        return this.fail(steps, `Network failure: ${netCheck.message}`);
      }

      // 4. Repository Configuration Check + Protocol Downgrade (if needed)
      const repoCheck = await this.prepareRepositories(routerId);
      steps.push(repoCheck);
      if (repoCheck.status === 'error') {
        return this.fail(steps, `Repo setup failed: ${repoCheck.message}`);
      }

      // --- PHASE 2: PACKAGE INSTALLATION ---

      // 5. Update Packages
      const updateResult = await this.updatePackages(routerId);
      steps.push(updateResult);
      if (updateResult.status === 'error') {
        return this.fail(steps, `Package update failed. Check router logs.`);
      }

      // 6. Install Packages
      const installResult = await this.installPackages(routerId);
      steps.push(installResult);
      if (installResult.status === 'error') {
        return this.fail(steps, `Package install failed: ${installResult.message}`);
      }

      // --- PHASE 3: CONFIGURATION ---

      // 7. Wireless Setup
      steps.push(await this.configureWireless(routerId));

      // 8. Network Interfaces
      const netConfig = await this.configureNetwork(routerId);
      steps.push(netConfig);
      if (netConfig.status === 'error') return this.fail(steps, 'Network config failed');

      // 9. Firewall
      const fwConfig = await this.configureFirewall(routerId);
      steps.push(fwConfig);
      if (fwConfig.status === 'error') return this.fail(steps, 'Firewall config failed');

      // 10. Portal & Certificates
      const portalConfig = await this.configurePortal(routerId);
      steps.push(portalConfig);
      if (portalConfig.status === 'error') return this.fail(steps, 'Portal config failed');

      // 11. Final Restart
      steps.push(await this.restartServices(routerId));

      return {
        steps,
        success: true,
        message: 'uSpot setup completed successfully'
      };

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`[uSpot Setup] Fatal error: ${errorMessage}`);
      return this.fail(steps, `Fatal error: ${errorMessage}`);
    }
  }

  private fail(steps: SetupStepResult[], message: string): SetupResult {
    return { steps, success: false, message };
  }

  // --- DIAGNOSTIC & REMEDIATION METHODS ---

  /**
   * Check Disk Space and Memory
   * Prevents installing on full routers which causes corruption
   */
  private async checkResources(routerId: string): Promise<SetupStepResult> {
    try {
      // Check Overlay Space (where packages go)
      const df = await this.exec(routerId, 'df -k /overlay | tail -1 | awk \'{print $4}\'');
      const freeSpaceKb = parseInt(df.trim());

      if (isNaN(freeSpaceKb) || freeSpaceKb < 2048) { // Require 2MB
        return { 
          step: 'resource_check', 
          status: 'error', 
          message: `Insufficient disk space. Free: ${Math.round(freeSpaceKb/1024)}MB. Required: 2MB.` 
        };
      }

      return { step: 'resource_check', status: 'success', message: `Disk OK (${Math.round(freeSpaceKb/1024)}MB free)` };
    } catch (e: any) {
      // If /overlay doesn't exist (x86 or unusual setup), try root
      return { step: 'resource_check', status: 'warning', message: 'Could not verify disk space, proceeding anyway.' };
    }
  }

  /**
   * Ensure Connectivity & Fix DNS
   * Verifies network connectivity and fixes DNS if needed
   */
  private async ensureConnectivity(routerId: string): Promise<SetupStepResult> {
    try {
      // 1. Check WAN IP (Google DNS Ping)
      // We use 'ping -c 1 -W 2' to timeout quickly
      try {
        await this.exec(routerId, 'ping -c 1 -W 2 8.8.8.8');
      } catch (e) {
        return { step: 'connectivity_check', status: 'error', message: 'No Internet Access. Router cannot ping 8.8.8.8.' };
      }

      // 2. Check DNS Resolution
      let dnsWorks = false;
      try {
        await this.exec(routerId, 'nslookup downloads.openwrt.org');
        dnsWorks = true;
      } catch (e) {
        this.logger.warn(`[Setup] DNS check failed, attempting auto-fix...`);
      }

      // 3. Auto-Remediate DNS if needed
      if (!dnsWorks) {
        try {
          // Force Google DNS
          await this.exec(routerId, 'echo "nameserver 8.8.8.8" > /tmp/resolv.conf.auto');
          await this.exec(routerId, 'cp /tmp/resolv.conf.auto /etc/resolv.conf');
          
          // Verify fix
          await this.exec(routerId, 'nslookup google.com');
          return { step: 'connectivity_check', status: 'warning', message: 'DNS was broken, applied Google DNS fix (8.8.8.8)' };
        } catch (e) {
          return { step: 'connectivity_check', status: 'error', message: 'DNS Resolution failed and auto-fix failed.' };
        }
      }

      return { step: 'connectivity_check', status: 'success', message: 'Network OK' };
    } catch (e: any) {
      return { step: 'connectivity_check', status: 'error', message: `Network check error: ${e.message}` };
    }
  }

  /**
   * Prepare Repositories
   * Handles "HTTPS not supported" bootstrap problem
   */
  private async prepareRepositories(routerId: string): Promise<SetupStepResult> {
    try {
      // Check if ca-certificates is installed
      let hasSsl = false;
      try {
        await this.exec(routerId, 'opkg list-installed | grep ca-certificates');
        hasSsl = true;
      } catch {}

      if (!hasSsl) {
        // Downgrade repos to HTTP to bootstrap installation
        // This fixes SSL certificate issues on fresh installs
        await this.exec(routerId, 'sed -i "s/https:/http:/g" /etc/opkg/distfeeds.conf');
        return { step: 'repo_check', status: 'warning', message: 'Downgraded repos to HTTP to bootstrap SSL support' };
      }

      return { step: 'repo_check', status: 'success' };
    } catch (e: any) {
      return { step: 'repo_check', status: 'warning', message: `Repo check skipped: ${e.message}` };
    }
  }

  /**
   * Time Sync
   * Fixes SSL validation errors
   */
  private async ensureSystemTime(routerId: string): Promise<SetupStepResult> {
    try {
      const dateOut = await this.exec(routerId, 'date +%Y');
      const year = parseInt(dateOut.trim());
      
      if (year < 2023) {
        this.logger.info(`[Setup] Time sync triggered (Year: ${year})`);
        await this.exec(routerId, 'ntpd -q -n -p pool.ntp.org');
        return { step: 'time_sync', status: 'warning', message: 'System time corrected via NTP' };
      }
      return { step: 'time_sync', status: 'success' };
    } catch {
      return { step: 'time_sync', status: 'skipped' };
    }
  }

  // --- PACKAGE MANAGEMENT ---

  private async updatePackages(routerId: string): Promise<SetupStepResult> {
    try {
      // Try update
      await this.exec(routerId, 'opkg update');
      return { step: 'package_update', status: 'success' };
    } catch (e: any) {
      // If update fails, try one more time with no-check-certificate
      try {
        await this.exec(routerId, 'opkg update --no-check-certificate');
        return { step: 'package_update', status: 'warning', message: 'Update succeeded with --no-check-certificate' };
      } catch (e2: any) {
        const msg = this.parseOpkgError(e.message || e2.message);
        return { step: 'package_update', status: 'error', message: msg };
      }
    }
  }

  private async installPackages(routerId: string): Promise<SetupStepResult> {
    try {
      const cmd = `opkg install ${this.REQUIRED_PACKAGES.join(' ')}`;
      await this.exec(routerId, cmd);
      return { step: 'package_install', status: 'success' };
    } catch (e: any) {
      // Retry with no-check-certificate
      try {
        const cmdRetry = `opkg install ${this.REQUIRED_PACKAGES.join(' ')} --no-check-certificate`;
        await this.exec(routerId, cmdRetry);
        return { step: 'package_install', status: 'warning', message: 'Installed with --no-check-certificate' };
      } catch (e2: any) {
        return { step: 'package_install', status: 'error', message: this.parseOpkgError(e2.message) };
      }
    }
  }

  // --- CONFIGURATION HELPERS ---

  private async configureWireless(routerId: string): Promise<SetupStepResult> {
    try {
      // Check if wireless config exists
      try { await this.exec(routerId, 'uci get wireless'); } catch {
        return { step: 'wireless_config', status: 'skipped', message: 'No wireless radio found' };
      }

      // Enable devices
      let idx = 0;
      while(idx < 5) {
        try {
          await this.exec(routerId, `uci set wireless.@wifi-device[${idx}].disabled='0'`);
          idx++;
        } catch { break; }
      }

      // Configure interfaces
      idx = 0;
      while(idx < 5) {
        try {
          await this.exec(routerId, `uci set wireless.@wifi-iface[${idx}].network='lan'`);
          await this.exec(routerId, `uci set wireless.@wifi-iface[${idx}].mode='ap'`);
          idx++;
        } catch { break; }
      }

      await this.exec(routerId, 'uci commit wireless');
      return { step: 'wireless_config', status: 'success' };
    } catch (e: any) {
      return { step: 'wireless_config', status: 'warning', message: e.message };
    }
  }

  private async configureNetwork(routerId: string): Promise<SetupStepResult> {
    try {
      // LAN
      // CRITICAL FIX: Preserve existing LAN IP to prevent locking out the controller
      let currentLanIp = '';
      let currentNetmask = '';

      try {
        currentLanIp = (await this.exec(routerId, 'uci get network.lan.ipaddr')).trim();
      } catch {}

      try {
        currentNetmask = (await this.exec(routerId, 'uci get network.lan.netmask')).trim();
      } catch {}

      await this.exec(routerId, 'uci set network.lan=interface');
      await this.exec(routerId, 'uci set network.lan.proto="static"');

      if (currentLanIp && currentLanIp.length > 0) {
        this.logger.info(`[Setup] Preserving existing LAN IP: ${currentLanIp}`);
        await this.exec(routerId, `uci set network.lan.ipaddr="${currentLanIp}"`);
      } else {
        await this.exec(routerId, `uci set network.lan.ipaddr="${this.LAN_IP}"`);
      }

      if (currentNetmask && currentNetmask.length > 0) {
        await this.exec(routerId, `uci set network.lan.netmask="${currentNetmask}"`);
      } else {
        await this.exec(routerId, `uci set network.lan.netmask="${this.LAN_NETMASK}"`);
      }

      // Get device for hotspot (OpenWrt 23+)
      let bridge = this.DEFAULT_BRIDGE;
      try {
        const out = await this.exec(routerId, 'uci get network.lan.device');
        if (out && out.trim()) bridge = out.trim().split(' ')[0];
      } catch {}

      // Hotspot
      await this.exec(routerId, 'uci set network.hotspot=interface');
      await this.exec(routerId, 'uci set network.hotspot.proto="static"');
      await this.exec(routerId, `uci set network.hotspot.ipaddr="${this.HOTSPOT_IP}"`);
      await this.exec(routerId, `uci set network.hotspot.netmask="${this.HOTSPOT_NETMASK}"`);
      await this.exec(routerId, `uci set network.hotspot.device="${bridge}"`);

      await this.exec(routerId, 'uci commit network');
      return { step: 'network_config', status: 'success' };
    } catch (e: any) {
      return { step: 'network_config', status: 'error', message: e.message };
    }
  }

  private async configureFirewall(routerId: string): Promise<SetupStepResult> {
    try {
      // Check if hotspot zone exists by trying to find it in config
      const zones = await routerRpcService.rpcCall(routerId, 'uci', 'get', { config: 'firewall' });
      const zonesStr = JSON.stringify(zones);
      const hotspotZoneExists = zonesStr.includes('"name":"hotspot"') || zonesStr.includes("name='hotspot'");

      if (!hotspotZoneExists) {
        await this.exec(routerId, 'uci add firewall zone');
        await this.exec(routerId, 'uci set firewall.@zone[-1].name="hotspot"');
        await this.exec(routerId, 'uci set firewall.@zone[-1].input="REJECT"');
        await this.exec(routerId, 'uci set firewall.@zone[-1].output="ACCEPT"');
        await this.exec(routerId, 'uci set firewall.@zone[-1].forward="REJECT"');
        await this.exec(routerId, 'uci set firewall.@zone[-1].network="hotspot"');
      }

      // Check if forwarding exists
      const hotspotForwardExists = zonesStr.includes('"src":"hotspot"') && zonesStr.includes('"dest":"wan"');
      if (!hotspotForwardExists) {
        await this.exec(routerId, 'uci add firewall forwarding');
        await this.exec(routerId, 'uci set firewall.@forwarding[-1].src="hotspot"');
        await this.exec(routerId, 'uci set firewall.@forwarding[-1].dest="wan"');
      }

      // Add RADIUS rules to allow hotspot clients to reach external RADIUS server
      for (const port of this.RADIUS_PORTS) {
        const ruleName = `Allow-RADIUS-Out-${port}`;
        if (!zonesStr.includes(ruleName)) {
          await this.exec(routerId, 'uci add firewall rule');
          await this.exec(routerId, `uci set firewall.@rule[-1].name="${ruleName}"`);
          await this.exec(routerId, 'uci set firewall.@rule[-1].src="hotspot"');
          await this.exec(routerId, 'uci set firewall.@rule[-1].dest="wan"');
          await this.exec(routerId, `uci set firewall.@rule[-1].dest_port="${port}"`);
          await this.exec(routerId, 'uci set firewall.@rule[-1].proto="udp"');
          await this.exec(routerId, 'uci set firewall.@rule[-1].target="ACCEPT"');
        }
      }

      await this.exec(routerId, 'uci commit firewall');
      return { step: 'firewall_config', status: 'success' };
    } catch (e: any) {
      return { step: 'firewall_config', status: 'error', message: e.message };
    }
  }

  private async configurePortal(routerId: string): Promise<SetupStepResult> {
    try {
      // Certs
      try {
        await this.exec(routerId, 'openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout /etc/uhttpd.key -out /etc/uhttpd.crt -subj "/CN=router" 2>/dev/null');
      } catch {}

      // uHTTPd - Listen on both LAN and Hotspot networks
      // Get current LAN IP for LuCI access
      let lanIp = this.LAN_IP;
      try {
        const currentLan = (await this.exec(routerId, 'uci get network.lan.ipaddr')).trim();
        if (currentLan) lanIp = currentLan;
      } catch {}

      await this.exec(routerId, `uci set uhttpd.main.listen_https="${lanIp}:443"`);
      await this.exec(routerId, 'uci set uhttpd.main.cert="/etc/uhttpd.crt"');
      await this.exec(routerId, 'uci set uhttpd.main.key="/etc/uhttpd.key"');
      await this.exec(routerId, 'uci set uhttpd.main.redirect_https="0"');
      // Listen only on LAN for LuCI management (not on hotspot)
      await this.exec(routerId, `uci set uhttpd.main.listen_http="${lanIp}:80"`);
      
      await this.exec(routerId, 'uci commit uhttpd');
      return { step: 'portal_config', status: 'success' };
    } catch (e: any) {
      return { step: 'portal_config', status: 'error', message: e.message };
    }
  }

  private async restartServices(routerId: string): Promise<SetupStepResult> {
    try {
      await this.exec(routerId, '/etc/init.d/network restart');
      await this.sleep(3000);
      await this.exec(routerId, '/etc/init.d/firewall restart');
      try { await this.exec(routerId, '/etc/init.d/wireless restart'); } catch {}
      await this.exec(routerId, '/etc/init.d/uhttpd enable');
      await this.exec(routerId, '/etc/init.d/uhttpd restart');
      return { step: 'services_restart', status: 'success' };
    } catch (e: any) {
      return { step: 'services_restart', status: 'warning', message: e.message };
    }
  }

  // --- UTILS ---


  private async exec(routerId: string, command: string, timeout = 30000): Promise<string> {
    // Check if command contains shell operators (pipes, redirects, etc.)
    // If so, wrap in sh -c
    const hasShellOps = /[|&;<>`$(){}[\]"'\\]/.test(command);
    
    let execCmd: string;
    let execParams: string[];
    
    if (hasShellOps || command.includes(' ') && !command.startsWith('opkg') && !command.startsWith('uci')) {
      // Shell command - wrap in sh -c
      execCmd = 'sh';
      execParams = ['-c', command];
    } else {
      // Simple command - parse into command and params
      const parts = command.split(/\s+/);
      execCmd = parts[0];
      execParams = parts.slice(1);
    }
    
    // Execute via file.exec (standard OpenWrt method)
    // routerRpcService returns response.result || response, so result is the direct file.exec response
    const result = await routerRpcService.rpcCall(routerId, 'file', 'exec', { 
      command: execCmd, 
      params: execParams 
    }, timeout);
    
    // Result object from ubus file.exec is { code: int, stdout: string }
    const code = result.code ?? result.result?.code ?? 0;
    const stdout = result.stdout ?? result.result?.stdout ?? '';
    const stderr = result.stderr ?? result.result?.stderr ?? '';

    if (code !== 0) {
      const errParts: string[] = [];
      errParts.push(`Code ${code}`);
      if (stderr) errParts.push(stderr.trim());
      if (stdout) errParts.push(stdout.trim()); // Sometimes error is in stdout
      
      throw new Error(errParts.join(': ') || `Command failed: ${command}`);
    }

    return stdout;
  }

  private parseOpkgError(msg: string): string {
    if (msg.includes('Download failed') || msg.includes('wget returned')) return 'Download failed (Check DNS/Internet)';
    if (msg.includes('No space')) return 'Disk full';
    if (msg.includes('lock')) return 'Package manager locked';
    if (msg.includes('Cannot find package')) return 'Package not found in repositories';
    return msg.substring(0, 100);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}