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

/**
 * Async Setup Job Status
 */
export type SetupJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface SetupJob {
  jobId: string;
  routerId: string;
  status: SetupJobStatus;
  startedAt: Date;
  completedAt?: Date;
  currentStep?: string;
  progress: number; // 0-100
  result?: SetupResult;
  error?: string;
}

// In-memory job store (could be replaced with Redis for production)
const setupJobs = new Map<string, SetupJob>();

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
  private readonly LAN_IP = '192.168.3.10';
  private readonly LAN_NETMASK = '255.255.255.0';
  private readonly DEFAULT_BRIDGE = 'br-lan';
  private readonly TOTAL_STEPS = 11;

  constructor(private logger: FastifyBaseLogger) {}

  /**
   * Get setup job status by job ID
   */
  static getJobStatus(jobId: string): SetupJob | null {
    return setupJobs.get(jobId) || null;
  }

  /**
   * Get setup job status by router ID
   */
  static getJobByRouterId(routerId: string): SetupJob | null {
    for (const job of setupJobs.values()) {
      if (job.routerId === routerId) {
        return job;
      }
    }
    return null;
  }

  /**
   * Clean up old completed/failed jobs (call periodically)
   */
  static cleanupOldJobs(maxAgeMs: number = 3600000): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [jobId, job] of setupJobs.entries()) {
      if (job.status === 'completed' || job.status === 'failed') {
        const jobAge = now - job.startedAt.getTime();
        if (jobAge > maxAgeMs) {
          setupJobs.delete(jobId);
          cleaned++;
        }
      }
    }
    return cleaned;
  }

  /**
   * Start async setup - returns job ID immediately
   */
  async setupAsync(routerId: string, options: { combinedSSID?: boolean, ssid?: string, password?: string } = {}): Promise<{ jobId: string }> {
    // Check if there's already a running job for this router
    const existingJob = UspotSetupService.getJobByRouterId(routerId);
    if (existingJob && (existingJob.status === 'pending' || existingJob.status === 'running')) {
      return { jobId: existingJob.jobId };
    }

    const jobId = `setup_${routerId}_${Date.now()}`;
    const job: SetupJob = {
      jobId,
      routerId,
      status: 'pending',
      startedAt: new Date(),
      progress: 0,
    };
    setupJobs.set(jobId, job);

    // Run setup in background (don't await)
    this.runSetupJob(jobId, routerId, options).catch(err => {
      this.logger.error(`[uSpot Setup] Background job ${jobId} failed: ${err.message}`);
    });

    return { jobId };
  }

  /**
   * Run the setup job in the background
   */
  private async runSetupJob(jobId: string, routerId: string, options: { combinedSSID?: boolean, ssid?: string, password?: string } = {}): Promise<void> {
    const job = setupJobs.get(jobId);
    if (!job) return;

    job.status = 'running';
    setupJobs.set(jobId, job);

    try {
      const result = await this.setup(routerId, options, (step: string, stepNum: number) => {
        // Progress callback
        job.currentStep = step;
        job.progress = Math.round((stepNum / this.TOTAL_STEPS) * 100);
        setupJobs.set(jobId, job);
      });

      job.status = result.success ? 'completed' : 'failed';
      job.completedAt = new Date();
      job.result = result;
      job.progress = 100;
      if (!result.success) {
        job.error = result.message;
      }
      setupJobs.set(jobId, job);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      job.status = 'failed';
      job.completedAt = new Date();
      job.error = errorMessage;
      setupJobs.set(jobId, job);
    }
  }

  /**
   * Execute complete setup with diagnostics and auto-remediation
   * @param progressCallback - Optional callback to report progress (step name, step number)
   */
  async setup(
    routerId: string, 
    options: { combinedSSID?: boolean, ssid?: string, password?: string } = {},
    progressCallback?: (step: string, stepNum: number) => void
  ): Promise<SetupResult> {
    const steps: SetupStepResult[] = [];
    let stepNum = 0;

    const reportProgress = (stepName: string) => {
      stepNum++;
      if (progressCallback) progressCallback(stepName, stepNum);
    };

    try {
      // --- PHASE 1: PRE-FLIGHT VALIDATION ---
      
      // 1. Check System Resources (Disk/RAM)
      reportProgress('resource_check');
      const resourceCheck = await this.checkResources(routerId);
      steps.push(resourceCheck);
      if (resourceCheck.status === 'error') {
        return this.fail(steps, `Resource check failed: ${resourceCheck.message}`);
      }

      // 2. Check & Fix System Time (Crucial for SSL)
      reportProgress('time_sync');
      steps.push(await this.ensureSystemTime(routerId));

      // 3. Network & DNS Diagnostics + Remediation
      reportProgress('connectivity_check');
      const netCheck = await this.ensureConnectivity(routerId);
      steps.push(netCheck);
      if (netCheck.status === 'error') {
        return this.fail(steps, `Network failure: ${netCheck.message}`);
      }

      // 4. Repository Configuration Check + Protocol Downgrade (if needed)
      reportProgress('repo_check');
      const repoCheck = await this.prepareRepositories(routerId);
      steps.push(repoCheck);
      if (repoCheck.status === 'error') {
        return this.fail(steps, `Repo setup failed: ${repoCheck.message}`);
      }

      // --- PHASE 2: PACKAGE INSTALLATION ---

      // 5. Update Packages
      reportProgress('package_update');
      const updateResult = await this.updatePackages(routerId);
      steps.push(updateResult);
      if (updateResult.status === 'error') {
        return this.fail(steps, `Package update failed. Check router logs.`);
      }

      // 6. Install Packages (only those not already installed)
      reportProgress('package_install');
      const installResult = await this.installPackages(routerId);
      steps.push(installResult);
      if (installResult.status === 'error') {
        return this.fail(steps, `Package install failed: ${installResult.message}`);
      }

      // --- PHASE 3: CONFIGURATION ---

      // 7. Wireless Setup
      reportProgress('wireless_config');
      steps.push(await this.configureWireless(routerId, options));

      // 8. Network Interfaces
      reportProgress('network_config');
      const netConfig = await this.configureNetwork(routerId);
      steps.push(netConfig);
      if (netConfig.status === 'error') return this.fail(steps, 'Network config failed');

      // 9. Firewall
      reportProgress('firewall_config');
      const fwConfig = await this.configureFirewall(routerId);
      steps.push(fwConfig);
      if (fwConfig.status === 'error') return this.fail(steps, 'Firewall config failed');

      // 10. Portal & Certificates
      reportProgress('portal_config');
      const portalConfig = await this.configurePortal(routerId);
      steps.push(portalConfig);
      if (portalConfig.status === 'error') return this.fail(steps, 'Portal config failed');

      // 11. Final Restart
      reportProgress('services_restart');
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
   * Handles "HTTPS not supported" bootstrap problem and architecture mismatch
   */
  private async prepareRepositories(routerId: string): Promise<SetupStepResult> {
    try {
      // 1. Verify and fix architecture in distfeeds.conf
      const archFixResult = await this.verifyAndFixArchitecture(routerId);
      
      // 2. Check if ca-certificates is installed
      let hasSsl = false;
      try {
        await this.exec(routerId, 'opkg list-installed | grep ca-certificates');
        hasSsl = true;
      } catch {}

      if (!hasSsl) {
        // Downgrade repos to HTTP to bootstrap installation
        // This fixes SSL certificate issues on fresh installs
        await this.exec(routerId, 'sed -i "s/https:/http:/g" /etc/opkg/distfeeds.conf');
        
        // Force opkg update after changing repos
        try {
          await this.exec(routerId, 'opkg update', 60000);
        } catch {}
        
        const msg = archFixResult 
          ? `${archFixResult}. Downgraded repos to HTTP.`
          : 'Downgraded repos to HTTP to bootstrap SSL support';
        return { step: 'repo_check', status: 'warning', message: msg };
      }

      if (archFixResult) {
        return { step: 'repo_check', status: 'warning', message: archFixResult };
      }

      return { step: 'repo_check', status: 'success' };
    } catch (e: any) {
      return { step: 'repo_check', status: 'warning', message: `Repo check skipped: ${e.message}` };
    }
  }

  /**
   * Verify architecture in distfeeds.conf matches actual router architecture
   * This fixes "cannot find dependency libc" errors caused by architecture mismatch
   */
  private async verifyAndFixArchitecture(routerId: string): Promise<string | null> {
    try {
      // Get actual router architecture
      const arch = (await this.exec(routerId, 'opkg print-architecture | grep -v all | head -1 | awk \'{print $2}\'')).trim();
      if (!arch) {
        this.logger.warn('[Setup] Could not determine router architecture');
        return null;
      }

      // Get OpenWrt version info for proper repo URLs
      let version = '';
      let release = '';
      try {
        const osRelease = await this.exec(routerId, 'cat /etc/openwrt_release');
        const versionMatch = osRelease.match(/DISTRIB_RELEASE='([^']+)'/);
        const targetMatch = osRelease.match(/DISTRIB_TARGET='([^']+)'/);
        if (versionMatch) version = versionMatch[1];
        if (targetMatch) release = targetMatch[1];
      } catch {}

      this.logger.info(`[Setup] Router arch: ${arch}, version: ${version}, target: ${release}`);

      // Read current distfeeds
      const distfeeds = await this.exec(routerId, 'cat /etc/opkg/distfeeds.conf');
      
      // Check if distfeeds contains the wrong architecture or is corrupted
      const hasArchMismatch = !distfeeds.includes(arch) && !distfeeds.includes('SNAPSHOT');
      
      if (hasArchMismatch && release && version) {
        this.logger.warn(`[Setup] Architecture mismatch detected, rebuilding distfeeds.conf`);
        
        // Determine base URL based on version
        const isSnapshot = version.includes('SNAPSHOT') || version.includes('snapshot');
        const baseUrl = isSnapshot 
          ? 'http://downloads.openwrt.org/snapshots'
          : `http://downloads.openwrt.org/releases/${version}`;
        
        // Build correct distfeeds
        const newFeeds = [
          `src/gz openwrt_core ${baseUrl}/targets/${release}/packages`,
          `src/gz openwrt_base ${baseUrl}/packages/${arch}/base`,
          `src/gz openwrt_packages ${baseUrl}/packages/${arch}/packages`,
          `src/gz openwrt_luci ${baseUrl}/packages/${arch}/luci`,
          `src/gz openwrt_routing ${baseUrl}/packages/${arch}/routing`,
          `src/gz openwrt_telephony ${baseUrl}/packages/${arch}/telephony`
        ].join('\n');
        
        // Write new distfeeds
        await this.exec(routerId, `cat > /etc/opkg/distfeeds.conf << 'EOF'\n${newFeeds}\nEOF`);
        
        return `Fixed architecture mismatch (${arch})`;
      }

      return null;
    } catch (e: any) {
      this.logger.warn(`[Setup] Architecture verification failed: ${e.message}`);
      return null;
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
      // Clear opkg lists cache first to ensure fresh download
      try {
        await this.exec(routerId, 'rm -rf /var/opkg-lists/*', 30000);
      } catch {}

      // Try update
      await this.exec(routerId, 'opkg update', 90000);
      return { step: 'package_update', status: 'success' };
    } catch (e: any) {
      // If update fails, try one more time with no-check-certificate
      try {
        await this.exec(routerId, 'opkg update --no-check-certificate', 90000);
        return { step: 'package_update', status: 'warning', message: 'Update succeeded with --no-check-certificate' };
      } catch (e2: any) {
        const msg = this.parseOpkgError(e.message || e2.message);
        return { step: 'package_update', status: 'error', message: msg };
      }
    }
  }

  /**
   * Check which packages are already installed
   */
  private async getInstalledPackages(routerId: string): Promise<Set<string>> {
    const installed = new Set<string>();
    try {
      const output = await this.exec(routerId, 'opkg list-installed', 60000);
      // Format: "package_name - version"
      const lines = output.split('\n');
      for (const line of lines) {
        const pkgName = line.split(' - ')[0]?.trim();
        if (pkgName) {
          installed.add(pkgName);
        }
      }
    } catch (e: any) {
      this.logger.warn(`[Setup] Could not list installed packages: ${e.message}`);
    }
    return installed;
  }

  private async installPackages(routerId: string): Promise<SetupStepResult> {
    try {
      // First, check which packages are already installed
      const installed = await this.getInstalledPackages(routerId);
      const toInstall = this.REQUIRED_PACKAGES.filter(pkg => !installed.has(pkg));

      if (toInstall.length === 0) {
        return { 
          step: 'package_install', 
          status: 'success', 
          message: 'All packages already installed',
          details: { skipped: this.REQUIRED_PACKAGES, installed: [] }
        };
      }

      this.logger.info(`[Setup] Installing packages: ${toInstall.join(', ')} (skipping already installed: ${this.REQUIRED_PACKAGES.filter(pkg => installed.has(pkg)).join(', ')})`);

      // Install packages one at a time to avoid timeout and handle individual failures
      const results: { pkg: string; status: 'success' | 'skipped' | 'error'; message?: string }[] = [];
      let hasError = false;

      for (const pkg of toInstall) {
        try {
          // Use longer timeout for package installation (120 seconds per package)
          await this.exec(routerId, `opkg install ${pkg}`, 120000);
          results.push({ pkg, status: 'success' });
        } catch (e: any) {
          // Retry with no-check-certificate
          try {
            await this.exec(routerId, `opkg install ${pkg} --no-check-certificate`, 120000);
            results.push({ pkg, status: 'success', message: 'Installed with --no-check-certificate' });
          } catch (e2: any) {
            const errMsg = this.parseOpkgError(e2.message);
            results.push({ pkg, status: 'error', message: errMsg });
            hasError = true;
            // Continue with other packages even if one fails
          }
        }
      }

      const successCount = results.filter(r => r.status === 'success').length;
      const errorCount = results.filter(r => r.status === 'error').length;

      if (hasError && successCount === 0) {
        return { 
          step: 'package_install', 
          status: 'error', 
          message: `All package installations failed`,
          details: results
        };
      } else if (hasError) {
        return { 
          step: 'package_install', 
          status: 'warning', 
          message: `Installed ${successCount}/${toInstall.length} packages (${errorCount} failed)`,
          details: results
        };
      }

      return { 
        step: 'package_install', 
        status: 'success',
        message: toInstall.length < this.REQUIRED_PACKAGES.length 
          ? `Installed ${toInstall.length} packages (${this.REQUIRED_PACKAGES.length - toInstall.length} already present)`
          : undefined,
        details: results
      };
    } catch (e: any) {
      return { step: 'package_install', status: 'error', message: this.parseOpkgError(e.message) };
    }
  }

  // --- CONFIGURATION HELPERS ---

  private async detectRadios(routerId: string): Promise<{ ghz24: string | null; ghz5: string | null }> {
    try {
      const wirelessConfig = await routerRpcService.rpcCall(routerId, 'uci', 'get', { config: 'wireless' });
      const values = wirelessConfig?.values || wirelessConfig || {};
      
      let ghz24 = null;
      let ghz5 = null;
      
      for (const key of Object.keys(values)) {
        if (values[key]['.type'] === 'wifi-device' || values[key]['type'] === 'wifi-device') {
          const channel = values[key].channel;
          const chNum = parseInt(channel);
          
          if (!isNaN(chNum)) {
            if (chNum <= 14) ghz24 = key;
            else ghz5 = key;
          } else {
            // Fallback for 'auto' or other values
            const hwmode = values[key].hwmode;
            if (hwmode === '11a' || hwmode === '11ac' || hwmode === '11ax') ghz5 = key;
            else ghz24 = key; // Default to 2.4 for 11b/g/n
          }
        }
      }
      return { ghz24, ghz5 };
    } catch (e) {
      return { ghz24: null, ghz5: null };
    }
  }

  public async configureWireless(routerId: string, options: { combinedSSID?: boolean, ssid?: string, password?: string }): Promise<SetupStepResult> {
    try {
      // Check if wireless config exists
      try { await this.exec(routerId, 'uci get wireless'); } catch {
        return { step: 'wireless_config', status: 'skipped', message: 'No wireless radio found' };
      }

      if (options.combinedSSID) {
        const radios = await this.detectRadios(routerId);
        if (!radios.ghz24 || !radios.ghz5) {
          this.logger.warn('[Setup] Dual-band wireless not detected, falling back to standard config');
        } else {
          const ssid = options.ssid || 'Spotfi';
          const password = options.password || 'Spotfi123'; // Default password if not provided

          // Helper to configure a radio
          const configureRadio = async (radio: string) => {
            try {
              await this.exec(routerId, `uci set wireless.${radio}.disabled='0'`);
              
              // Find or create interface for this radio
              // We need to find an interface that points to this device
              // Since UCI is tricky to query by value via exec, we'll iterate
              let ifaceIndex = -1;
              for (let i = 0; i < 5; i++) {
                try {
                  const dev = (await this.exec(routerId, `uci get wireless.@wifi-iface[${i}].device`)).trim();
                  if (dev === radio) {
                    ifaceIndex = i;
                    break;
                  }
                } catch {}
              }

              if (ifaceIndex === -1) {
                // Create new interface
                await this.exec(routerId, 'uci add wireless wifi-iface');
                ifaceIndex = -1; // We need to find the index of the new one, usually last. 
                // But simpler to just add and set properties on the new section if we knew the ID.
                // Let's assume we can just set properties on the last added one if we use named sections or just append.
                // Actually, `uci add` returns the section ID.
                // But `exec` returns stdout.
                // Let's try to just use the loop again or assume standard OpenWrt config has interfaces.
                // If not found, we might skip or try to add.
                // For robustness, let's just try to set the first interface found for that radio if exists, 
                // or create one.
                // Simplified approach: Just use the standard loop below but apply SSID settings.
              }
            } catch (e: any) {
              this.logger.warn(`[Setup] Failed to enable wireless device ${radio}: ${e.message}`);
            }
          };
          
          // We will use the standard loop but apply specific settings if combinedSSID is true
        }
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
          
          if (options.combinedSSID && options.ssid) {
             await this.exec(routerId, `uci set wireless.@wifi-iface[${idx}].ssid='${options.ssid}'`);
             if (options.password && options.password !== 'none') {
               await this.exec(routerId, `uci set wireless.@wifi-iface[${idx}].encryption='psk2+ccmp'`);
               await this.exec(routerId, `uci set wireless.@wifi-iface[${idx}].key='${options.password}'`);
             } else {
               await this.exec(routerId, `uci set wireless.@wifi-iface[${idx}].encryption='none'`);
               try { await this.exec(routerId, `uci delete wireless.@wifi-iface[${idx}].key`); } catch {}
             }
          }
          
          idx++;
        } catch { break; }
      }

      await this.exec(routerId, 'uci commit wireless');
      return { step: 'wireless_config', status: 'success', message: options.combinedSSID ? `Configured combined wireless network '${options.ssid}'` : undefined };
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
    if (msg.includes('cannot find dependency libc') || msg.includes('pkg_hash_check_unresolved')) {
      return 'Architecture mismatch - package feeds do not match router. Run opkg update.';
    }
    if (msg.includes('Signature check failed')) return 'Package signature verification failed';
    if (msg.includes('satisfy_dependencies')) return 'Dependency resolution failed';
    return msg.substring(0, 150);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}