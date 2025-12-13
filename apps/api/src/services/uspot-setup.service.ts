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
  // Core required packages
  private readonly REQUIRED_PACKAGES = ['uspot', 'uhttpd', 'jsonfilter'];
  
  // Packages with alternatives - if ANY alternative is installed, requirement is satisfied
  private readonly PACKAGE_ALTERNATIVES: Record<string, string[]> = {
    'ca-certificates': ['ca-certificates', 'ca-bundle'],
    'openssl-util': ['openssl-util', 'px5g-mbedtls', 'px5g-standalone'],
  };
  
  // Binary paths to check if packages are installed (even if opkg doesn't know)
  private readonly PACKAGE_BINARIES: Record<string, string[]> = {
    'uspot': ['/usr/bin/uspot', '/usr/sbin/uspot'],
    'uhttpd': ['/usr/sbin/uhttpd'],
    'jsonfilter': ['/usr/bin/jsonfilter'],
  };
  
  private readonly RADIUS_PORTS = [1812, 1813, 3799];
  private readonly HOTSPOT_IP = '10.1.30.1';
  private readonly HOTSPOT_NETMASK = '255.255.255.0';
  private readonly HOTSPOT_VLAN_ID = 10; // VLAN for guest/hotspot network
  private readonly LAN_IP = '192.168.3.10';
  private readonly LAN_NETMASK = '255.255.255.0';
  private readonly DEFAULT_BRIDGE = 'br-lan';
  private readonly TOTAL_STEPS = 13; // Updated for DHCP step

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

      // 4. Repair opkg database if needed (empty status file)
      reportProgress('opkg_repair');
      const opkgRepair = await this.repairOpkgDatabase(routerId);
      steps.push(opkgRepair);

      // 5. Repository Configuration Check + Protocol Downgrade (if needed)
      reportProgress('repo_check');
      const repoCheck = await this.prepareRepositories(routerId);
      steps.push(repoCheck);
      if (repoCheck.status === 'error') {
        return this.fail(steps, `Repo setup failed: ${repoCheck.message}`);
      }

      // --- PHASE 2: PACKAGE INSTALLATION ---

      // 6. Update Packages
      reportProgress('package_update');
      const updateResult = await this.updatePackages(routerId);
      steps.push(updateResult);
      if (updateResult.status === 'error') {
        return this.fail(steps, `Package update failed. Check router logs.`);
      }

      // 7. Install Packages (only those not already installed)
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

      // 9. DHCP Configuration for Hotspot
      reportProgress('dhcp_config');
      const dhcpConfig = await this.configureDhcp(routerId);
      steps.push(dhcpConfig);
      if (dhcpConfig.status === 'error') return this.fail(steps, 'DHCP config failed');

      // 10. Firewall
      reportProgress('firewall_config');
      const fwConfig = await this.configureFirewall(routerId);
      steps.push(fwConfig);
      if (fwConfig.status === 'error') return this.fail(steps, 'Firewall config failed');

      // 11. Portal & Certificates
      reportProgress('portal_config');
      const portalConfig = await this.configurePortal(routerId);
      steps.push(portalConfig);
      if (portalConfig.status === 'error') return this.fail(steps, 'Portal config failed');

      // 12. Final Restart
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
      // Get OpenWrt version info - DISTRIB_ARCH is the most reliable source
      let version = '';
      let release = '';
      let arch = '';
      
      try {
        const osRelease = await this.exec(routerId, 'cat /etc/openwrt_release');
        const versionMatch = osRelease.match(/DISTRIB_RELEASE='([^']+)'/);
        const targetMatch = osRelease.match(/DISTRIB_TARGET='([^']+)'/);
        const archMatch = osRelease.match(/DISTRIB_ARCH='([^']+)'/);
        if (versionMatch) version = versionMatch[1];
        if (targetMatch) release = targetMatch[1];
        if (archMatch) arch = archMatch[1];
      } catch {}

      // Fallback to opkg print-architecture if DISTRIB_ARCH not available
      if (!arch) {
        try {
          const archOutput = await this.exec(routerId, 'opkg print-architecture');
          const archLines = archOutput.split('\n');
          let maxPriority = 0;
          
          for (const line of archLines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 3 && parts[0] === 'arch') {
              const archName = parts[1];
              const priority = parseInt(parts[2]) || 0;
              if (archName !== 'all' && archName !== 'noarch' && priority > maxPriority) {
                arch = archName;
                maxPriority = priority;
              }
            }
          }
        } catch {}
      }
      
      if (!arch) {
        this.logger.warn('[Setup] Could not determine router architecture');
        return null;
      }

      this.logger.info(`[Setup] Router arch: ${arch}, version: ${version}, target: ${release}`);

      // Read current distfeeds
      const distfeeds = await this.exec(routerId, 'cat /etc/opkg/distfeeds.conf');
      
      // Check if distfeeds needs fixing:
      // 1. Empty or corrupted
      // 2. Contains /packages/noarch/ which is ALWAYS wrong for arch-specific packages
      // 3. Contains wrong architecture
      const isEmpty = distfeeds.trim().length < 50;
      const looksCorrupted = !distfeeds.includes('openwrt') && !distfeeds.includes('src/gz');
      const hasNoarch = distfeeds.includes('/packages/noarch/');
      const hasWrongArch = arch && !distfeeds.includes(`/packages/${arch}/`) && distfeeds.includes('/packages/');
      
      if ((isEmpty || looksCorrupted || hasNoarch || hasWrongArch) && release && version && arch) {
        const reason = hasNoarch ? 'has noarch URLs' : 
                       hasWrongArch ? 'has wrong architecture' :
                       isEmpty ? 'is empty' : 'is corrupted';
        this.logger.warn(`[Setup] distfeeds.conf ${reason}, rebuilding with ${arch}`);
        
        // Backup original first
        try {
          await this.exec(routerId, 'cp /etc/opkg/distfeeds.conf /etc/opkg/distfeeds.conf.bak');
        } catch {}
        
        // Determine base URL based on version
        const isSnapshot = version.includes('SNAPSHOT') || version.includes('snapshot');
        const baseUrl = isSnapshot 
          ? 'http://downloads.openwrt.org/snapshots'
          : `http://downloads.openwrt.org/releases/${version}`;
        
        // Build correct distfeeds with proper architecture
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
        
        // Clear opkg cache to force fresh download
        try {
          await this.exec(routerId, 'rm -rf /var/opkg-lists/*');
        } catch {}
        
        return `Fixed distfeeds.conf (${arch} instead of ${hasNoarch ? 'noarch' : 'wrong arch'})`;
      }

      this.logger.info(`[Setup] distfeeds.conf architecture looks correct (${arch})`);
      return null;
    } catch (e: any) {
      this.logger.warn(`[Setup] Architecture verification failed: ${e.message}`);
      return null;
    }
  }

  /**
   * Repair opkg database if status file is empty
   * This can happen after firmware flash or reset
   */
  private async repairOpkgDatabase(routerId: string): Promise<SetupStepResult> {
    try {
      // Check if opkg status file is empty
      let statusEmpty = false;
      try {
        const statusSize = await this.exec(routerId, 'wc -c < /usr/lib/opkg/status');
        statusEmpty = parseInt(statusSize.trim()) < 10;
      } catch {
        statusEmpty = true;
      }

      if (!statusEmpty) {
        return { step: 'opkg_repair', status: 'success', message: 'opkg database OK' };
      }

      this.logger.warn('[Setup] opkg status file is empty, rebuilding from .control files');

      // Check if control files exist
      let hasControlFiles = false;
      try {
        const controlCount = await this.exec(routerId, 'ls /usr/lib/opkg/info/*.control 2>/dev/null | wc -l');
        hasControlFiles = parseInt(controlCount.trim()) > 0;
      } catch {}

      if (!hasControlFiles) {
        return { 
          step: 'opkg_repair', 
          status: 'warning', 
          message: 'No control files found, cannot rebuild opkg database' 
        };
      }

      // Rebuild status file from control files
      const rebuildCmd = `
for control in /usr/lib/opkg/info/*.control; do
  cat "$control"
  echo "Status: install ok installed"
  echo ""
done > /usr/lib/opkg/status
`;
      await this.exec(routerId, rebuildCmd, 60000);

      // Verify rebuild worked
      let packageCount = 0;
      try {
        const countOutput = await this.exec(routerId, 'opkg list-installed 2>/dev/null | wc -l');
        packageCount = parseInt(countOutput.trim());
      } catch {}

      if (packageCount > 0) {
        return { 
          step: 'opkg_repair', 
          status: 'success', 
          message: `Rebuilt opkg database (${packageCount} packages)` 
        };
      } else {
        return { 
          step: 'opkg_repair', 
          status: 'warning', 
          message: 'Rebuilt opkg database but package count is 0' 
        };
      }
    } catch (e: any) {
      return { 
        step: 'opkg_repair', 
        status: 'warning', 
        message: `opkg repair failed: ${e.message}` 
      };
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

      // Try update with longer timeout
      await this.exec(routerId, 'opkg update', 120000);
      return { step: 'package_update', status: 'success' };
    } catch (e: any) {
      const firstError = e.message || '';
      
      // If update fails, try with no-check-certificate
      try {
        await this.exec(routerId, 'opkg update --no-check-certificate', 120000);
        return { step: 'package_update', status: 'warning', message: 'Update succeeded with --no-check-certificate' };
      } catch (e2: any) {
        // If we have a backup distfeeds, try restoring it
        try {
          const hasBackup = await this.exec(routerId, 'test -f /etc/opkg/distfeeds.conf.bak && echo yes || echo no');
          if (hasBackup.trim() === 'yes') {
            this.logger.warn('[Setup] opkg update failed, restoring original distfeeds.conf');
            await this.exec(routerId, 'cp /etc/opkg/distfeeds.conf.bak /etc/opkg/distfeeds.conf');
            await this.exec(routerId, 'sed -i "s/https:/http:/g" /etc/opkg/distfeeds.conf');
            
            // Try one more time with restored feeds
            try {
              await this.exec(routerId, 'opkg update', 120000);
              return { step: 'package_update', status: 'warning', message: 'Update succeeded after restoring original feeds' };
            } catch {}
          }
        } catch {}
        
        const msg = this.parseOpkgError(firstError || e2.message);
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

  /**
   * Check if a package requirement is satisfied
   * Checks: opkg database, alternative packages, and binary existence
   */
  private async isPackageSatisfied(routerId: string, pkg: string, installed: Set<string>): Promise<boolean> {
    // 1. Direct match in opkg database
    if (installed.has(pkg)) return true;
    
    // 2. Check alternatives
    const alternatives = this.PACKAGE_ALTERNATIVES[pkg];
    if (alternatives) {
      for (const alt of alternatives) {
        if (installed.has(alt)) return true;
      }
    }
    
    // 3. Check if binary exists (package might be installed but opkg doesn't know)
    const binaries = this.PACKAGE_BINARIES[pkg];
    if (binaries) {
      for (const bin of binaries) {
        try {
          await this.exec(routerId, `test -f ${bin}`);
          this.logger.info(`[Setup] Package ${pkg} detected via binary ${bin}`);
          return true;
        } catch {}
      }
    }
    
    return false;
  }

  private async installPackages(routerId: string): Promise<SetupStepResult> {
    try {
      // First, check which packages are already installed
      const installed = await this.getInstalledPackages(routerId);
      
      // Build complete list of requirements (core + alternatives)
      const allRequirements = [
        ...this.REQUIRED_PACKAGES,
        ...Object.keys(this.PACKAGE_ALTERNATIVES)
      ];
      
      // Check which packages need to be installed
      const toInstall: string[] = [];
      const alreadySatisfied: string[] = [];
      
      for (const pkg of allRequirements) {
        const satisfied = await this.isPackageSatisfied(routerId, pkg, installed);
        if (satisfied) {
          alreadySatisfied.push(pkg);
        } else {
          // For alternatives, prefer the first one in the list
          const alternatives = this.PACKAGE_ALTERNATIVES[pkg];
          if (alternatives) {
            toInstall.push(alternatives[0]);
          } else {
            toInstall.push(pkg);
          }
        }
      }
      
      // Remove duplicates
      const uniqueToInstall = [...new Set(toInstall)];

      if (uniqueToInstall.length === 0) {
        return { 
          step: 'package_install', 
          status: 'success', 
          message: `All ${alreadySatisfied.length} required packages already installed`,
          details: { alreadySatisfied, installed: [] }
        };
      }

      this.logger.info(`[Setup] Installing packages: ${uniqueToInstall.join(', ')} (already satisfied: ${alreadySatisfied.join(', ')})`);

      // Install packages one at a time to avoid timeout and handle individual failures
      const results: { pkg: string; status: 'success' | 'skipped' | 'error'; message?: string }[] = [];
      let hasError = false;

      for (const pkg of uniqueToInstall) {
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
          message: `Installed ${successCount}/${uniqueToInstall.length} packages (${errorCount} failed)`,
          details: results
        };
      }

      return { 
        step: 'package_install', 
        status: 'success',
        message: `Installed ${successCount} packages (${alreadySatisfied.length} already satisfied)`,
        details: { installed: results, alreadySatisfied }
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

      // Configure interfaces for hotspot network (captive portal)
      idx = 0;
      while(idx < 5) {
        try {
          // Use 'hotspot' network for captive portal - this is the network uspot monitors
          await this.exec(routerId, `uci set wireless.@wifi-iface[${idx}].network='hotspot'`);
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
      // For WiFi-only captive portal, hotspot network doesn't need a physical device
      // WiFi interfaces bound to 'hotspot' network will create br-hotspot automatically
      // For Ethernet guests, you would need VLANs or a dedicated port
      let lanBridge = this.DEFAULT_BRIDGE;
      try {
        const out = await this.exec(routerId, 'uci get network.lan.device');
        if (out && out.trim()) lanBridge = out.trim().split(' ')[0];
      } catch {}

      // ============================================================
      // VLAN-based Hotspot Network Setup (Best Practice)
      // ============================================================
      // This creates a proper isolated guest network that works for both
      // WiFi clients AND Ethernet clients tagged with VLAN 10
      
      // Step 1: Create the hotspot bridge device (br-hotspot)
      await this.exec(routerId, 'uci set network.br_hotspot=device');
      await this.exec(routerId, 'uci set network.br_hotspot.type="bridge"');
      await this.exec(routerId, 'uci set network.br_hotspot.name="br-hotspot"');
      // Enable STP to prevent loops if multiple ports are added
      await this.exec(routerId, 'uci set network.br_hotspot.stp="1"');
      // Isolate bridge ports - prevents guest-to-guest traffic at L2
      await this.exec(routerId, 'uci set network.br_hotspot.isolate="1"');
      
      // Step 2: Create VLAN 10 device for Ethernet guests
      // This allows tagging physical ports for guest access
      // Find the base switch device (usually eth0 or wan/lan device)
      let baseDevice = 'eth0';
      try {
        // Try to get the underlying device from br-lan
        const brPorts = await this.exec(routerId, 'uci get network.br_lan.ports 2>/dev/null || echo ""');
        if (brPorts && brPorts.trim()) {
          // Get first port as base device reference
          const ports = brPorts.trim().split(/\s+/);
          if (ports.length > 0) {
            // Extract base device (e.g., 'lan1' -> use parent, or 'eth0.1' -> 'eth0')
            const firstPort = ports[0];
            if (firstPort.includes('.')) {
              baseDevice = firstPort.split('.')[0];
            }
          }
        }
      } catch {}
      
      // Try DSA-style detection (OpenWrt 21.02+)
      try {
        const dsaCheck = await this.exec(routerId, 'ls /sys/class/net/lan1 2>/dev/null && echo "dsa" || echo "swconfig"');
        if (dsaCheck.trim() === 'dsa') {
          // DSA switch - create VLAN on each port that should be guest
          // For now, we'll create a tagged VLAN interface
          this.logger.info('[Setup] DSA switch detected - configuring VLAN tagging');
          
          // Create VLAN 10 bridge member for DSA
          await this.exec(routerId, `uci set network.hotspot_vlan=device`);
          await this.exec(routerId, `uci set network.hotspot_vlan.type="8021q"`);
          await this.exec(routerId, `uci set network.hotspot_vlan.ifname="${lanBridge}"`);
          await this.exec(routerId, `uci set network.hotspot_vlan.vid="${this.HOTSPOT_VLAN_ID}"`);
          await this.exec(routerId, `uci set network.hotspot_vlan.name="${lanBridge}.${this.HOTSPOT_VLAN_ID}"`);
          
          // Add VLAN interface to hotspot bridge
          try {
            await this.exec(routerId, `uci add_list network.br_hotspot.ports="${lanBridge}.${this.HOTSPOT_VLAN_ID}"`);
          } catch {}
        }
      } catch {
        this.logger.info('[Setup] Using standard bridge configuration (non-DSA)');
      }

      // Step 3: Configure hotspot interface with the bridge
      await this.exec(routerId, 'uci set network.hotspot=interface');
      await this.exec(routerId, 'uci set network.hotspot.proto="static"');
      await this.exec(routerId, `uci set network.hotspot.ipaddr="${this.HOTSPOT_IP}"`);
      await this.exec(routerId, `uci set network.hotspot.netmask="${this.HOTSPOT_NETMASK}"`);
      await this.exec(routerId, 'uci set network.hotspot.device="br-hotspot"');
      // Force interface up even without clients
      await this.exec(routerId, 'uci set network.hotspot.force_link="1"');
      
      // Step 4: Configure client isolation and security at network level
      // Prevent hotspot clients from accessing LAN subnet
      await this.exec(routerId, 'uci set network.hotspot.delegate="0"'); // No IPv6 prefix delegation
      
      this.logger.info(`[Setup] Configured hotspot network with VLAN ${this.HOTSPOT_VLAN_ID} for Ethernet guests`);
      await this.exec(routerId, 'uci commit network');
      return { step: 'network_config', status: 'success' };
    } catch (e: any) {
      return { step: 'network_config', status: 'error', message: e.message };
    }
  }

  /**
   * Configure DHCP for hotspot network
   * This provides IP addresses to both WiFi and Ethernet guests
   */
  private async configureDhcp(routerId: string): Promise<SetupStepResult> {
    try {
      // Check if hotspot DHCP pool already exists
      let hotspotDhcpExists = false;
      try {
        const dhcpConfig = await routerRpcService.rpcCall(routerId, 'uci', 'get', { config: 'dhcp' });
        const dhcpStr = JSON.stringify(dhcpConfig);
        hotspotDhcpExists = dhcpStr.includes('"interface":"hotspot"') || dhcpStr.includes("interface='hotspot'");
      } catch {}

      if (!hotspotDhcpExists) {
        // Create DHCP pool for hotspot network
        await this.exec(routerId, 'uci set dhcp.hotspot=dhcp');
        await this.exec(routerId, 'uci set dhcp.hotspot.interface="hotspot"');
        await this.exec(routerId, 'uci set dhcp.hotspot.start="100"');  // 10.1.30.100
        await this.exec(routerId, 'uci set dhcp.hotspot.limit="150"');  // 150 clients max
        await this.exec(routerId, 'uci set dhcp.hotspot.leasetime="2h"'); // Short lease for guests
        await this.exec(routerId, 'uci set dhcp.hotspot.force="1"'); // Force DHCP even if no interface
        
        // DNS settings - use router as DNS (for captive portal detection)
        await this.exec(routerId, `uci add_list dhcp.hotspot.dhcp_option="6,${this.HOTSPOT_IP}"`); // DNS server
        
        // Captive Portal Detection - DHCP Option 114 (RFC 8910)
        // Clients use this URL to detect captive portal
        await this.exec(routerId, 'uci add_list dhcp.hotspot.dhcp_option="114,http://detectportal.firefox.com/success.txt"');
        
        this.logger.info('[Setup] Created DHCP pool for hotspot network');
      } else {
        this.logger.info('[Setup] Hotspot DHCP pool already exists, skipping');
      }

      // Configure captive portal DHCP section for uspot compatibility
      try {
        await this.exec(routerId, 'uci set dhcp.captive=dhcp');
        await this.exec(routerId, 'uci set dhcp.captive.interface="hotspot"');
        // Will be updated with actual portal URL during UAM config
      } catch {}

      await this.exec(routerId, 'uci commit dhcp');
      
      // Restart dnsmasq to apply DHCP changes
      try {
        await this.exec(routerId, '/etc/init.d/dnsmasq restart');
      } catch {
        // dnsmasq might not be running yet
      }

      return { step: 'dhcp_config', status: 'success', message: 'DHCP pool configured for hotspot (10.1.30.100-249)' };
    } catch (e: any) {
      return { step: 'dhcp_config', status: 'error', message: e.message };
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
        // Enable MSS clamping for proper MTU handling
        await this.exec(routerId, 'uci set firewall.@zone[-1].mtu_fix="1"');
      }

      // Check if forwarding exists (hotspot -> wan for internet access)
      const hotspotForwardExists = zonesStr.includes('"src":"hotspot"') && zonesStr.includes('"dest":"wan"');
      if (!hotspotForwardExists) {
        await this.exec(routerId, 'uci add firewall forwarding');
        await this.exec(routerId, 'uci set firewall.@forwarding[-1].src="hotspot"');
        await this.exec(routerId, 'uci set firewall.@forwarding[-1].dest="wan"');
      }

      // ============================================================
      // Security Rules: Isolate Hotspot from LAN (Best Practice)
      // ============================================================
      
      // Rule 1: Block hotspot -> LAN traffic (prevent guest access to private network)
      const blockLanRuleName = 'Block-Hotspot-to-LAN';
      if (!zonesStr.includes(blockLanRuleName)) {
        await this.exec(routerId, 'uci add firewall rule');
        await this.exec(routerId, `uci set firewall.@rule[-1].name="${blockLanRuleName}"`);
        await this.exec(routerId, 'uci set firewall.@rule[-1].src="hotspot"');
        await this.exec(routerId, 'uci set firewall.@rule[-1].dest="lan"');
        await this.exec(routerId, 'uci set firewall.@rule[-1].proto="all"');
        await this.exec(routerId, 'uci set firewall.@rule[-1].target="REJECT"');
      }
      
      // Rule 2: Block RFC1918 private ranges from hotspot (extra protection)
      const blockPrivateRuleName = 'Block-Hotspot-Private-Ranges';
      if (!zonesStr.includes(blockPrivateRuleName)) {
        await this.exec(routerId, 'uci add firewall rule');
        await this.exec(routerId, `uci set firewall.@rule[-1].name="${blockPrivateRuleName}"`);
        await this.exec(routerId, 'uci set firewall.@rule[-1].src="hotspot"');
        await this.exec(routerId, 'uci set firewall.@rule[-1].dest="*"'); // Any destination
        await this.exec(routerId, 'uci set firewall.@rule[-1].proto="all"');
        // Block common private ranges (except hotspot's own subnet)
        await this.exec(routerId, 'uci add_list firewall.@rule[-1].dest_ip="192.168.0.0/16"');
        await this.exec(routerId, 'uci add_list firewall.@rule[-1].dest_ip="172.16.0.0/12"');
        // Note: 10.0.0.0/8 partially allowed for hotspot subnet (10.1.30.0/24)
        await this.exec(routerId, 'uci add_list firewall.@rule[-1].dest_ip="10.0.0.0/8"');
        await this.exec(routerId, 'uci set firewall.@rule[-1].target="REJECT"');
        // Exclude hotspot's own subnet from this rule
        await this.exec(routerId, `uci set firewall.@rule[-1].src_ip="!${this.HOTSPOT_IP.replace(/\.\d+$/, '.0')}/24"`);
      }
      
      // Rule 3: Allow DHCP/DNS from hotspot clients to router (required for captive portal)
      const allowDhcpRuleName = 'Allow-Hotspot-DHCP-DNS';
      if (!zonesStr.includes(allowDhcpRuleName)) {
        await this.exec(routerId, 'uci add firewall rule');
        await this.exec(routerId, `uci set firewall.@rule[-1].name="${allowDhcpRuleName}"`);
        await this.exec(routerId, 'uci set firewall.@rule[-1].src="hotspot"');
        await this.exec(routerId, 'uci set firewall.@rule[-1].dest_port="53 67 68"');
        await this.exec(routerId, 'uci set firewall.@rule[-1].proto="udp"');
        await this.exec(routerId, 'uci set firewall.@rule[-1].target="ACCEPT"');
      }
      
      // Rule 4: Allow captive portal HTTP/HTTPS from hotspot to router
      const allowPortalRuleName = 'Allow-Hotspot-Portal';
      if (!zonesStr.includes(allowPortalRuleName)) {
        await this.exec(routerId, 'uci add firewall rule');
        await this.exec(routerId, `uci set firewall.@rule[-1].name="${allowPortalRuleName}"`);
        await this.exec(routerId, 'uci set firewall.@rule[-1].src="hotspot"');
        await this.exec(routerId, 'uci set firewall.@rule[-1].dest_port="80 443 3990"'); // 3990 = uspot portal
        await this.exec(routerId, 'uci set firewall.@rule[-1].proto="tcp"');
        await this.exec(routerId, 'uci set firewall.@rule[-1].target="ACCEPT"');
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
      this.logger.info('[Setup] Firewall configured with hotspot isolation rules');
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