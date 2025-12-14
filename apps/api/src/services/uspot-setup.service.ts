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

/**
 * uSpot Setup Service for Modern OpenWRT (22.03+ / 23.05+)
 * 
 * Requirements:
 * - OpenWRT 22.03 or newer (uses firewall4/nftables)
 * - uspot package (captive portal)
 * - uhttpd with ucode support
 * 
 * Features:
 * - Named UCI sections for uspot configuration
 * - firewall4 (nftables) based rules
 * - DSA switch support for port-based VLAN
 * - Automatic captive portal detection (CPD) handling
 */
export class UspotSetupService {
  // Required packages for modern OpenWRT with uspot
  // uspot-www contains the web templates (click.ut, header.ut, etc.)
  private readonly REQUIRED_PACKAGES = ['uspot', 'uspot-www', 'uhttpd', 'jsonfilter'];
  
  // Optional packages - try to install but don't fail if unavailable
  private readonly OPTIONAL_PACKAGES: Record<string, string[]> = {
    'ca-certificates': ['ca-certificates', 'ca-bundle'],
    'luci-uspot': ['luci-app-uspot'],  // LuCI web interface for uspot configuration
  };
  
  // Built-in components that should exist on modern OpenWRT
  // If missing, the router is not compatible
  private readonly REQUIRED_BINARIES: Record<string, string[]> = {
    'nftables': ['/usr/sbin/nft'],
    'firewall4': ['/usr/sbin/fw4', '/etc/init.d/firewall'],
    'ucode': ['/usr/bin/ucode'],
  };
  
  // Package binary detection (for packages that may be pre-installed)
  private readonly PACKAGE_BINARIES: Record<string, string[]> = {
    'uspot': ['/usr/bin/uspot', '/usr/sbin/uspot', '/usr/share/uspot/handler.uc'],
    'uhttpd': ['/usr/sbin/uhttpd'],
    'jsonfilter': ['/usr/bin/jsonfilter'],
  };
  
  // Network configuration
  private readonly HOTSPOT_IP = '10.1.30.1';
  private readonly HOTSPOT_NETMASK = '255.255.255.0';
  private readonly LAN_IP = '192.168.1.1';
  private readonly LAN_NETMASK = '255.255.255.0';
  private readonly DEFAULT_BRIDGE = 'br-lan';
  private readonly RADIUS_PORTS = [1812, 1813]; // Auth + Accounting
  private readonly TOTAL_STEPS = 13;

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
      
      // 1. Check OpenWRT version and required components
      reportProgress('version_check');
      const versionCheck = await this.checkOpenWrtVersion(routerId);
      steps.push(versionCheck);
      if (versionCheck.status === 'error') {
        return this.fail(steps, `Incompatible OpenWRT: ${versionCheck.message}`);
      }

      // 2. Check System Resources (Disk/RAM)
      reportProgress('resource_check');
      const resourceCheck = await this.checkResources(routerId);
      steps.push(resourceCheck);
      if (resourceCheck.status === 'error') {
        return this.fail(steps, `Resource check failed: ${resourceCheck.message}`);
      }

      // 3. Network & DNS Diagnostics
      reportProgress('connectivity_check');
      const netCheck = await this.ensureConnectivity(routerId);
      steps.push(netCheck);
      if (netCheck.status === 'error') {
        return this.fail(steps, `Network failure: ${netCheck.message}`);
      }

      // --- PHASE 2: PACKAGE INSTALLATION ---

      // 4. Update package lists
      reportProgress('package_update');
      const updateResult = await this.updatePackages(routerId);
      steps.push(updateResult);
      if (updateResult.status === 'error') {
        return this.fail(steps, `Package update failed. Check router logs.`);
      }

      // 5. Install required packages
      reportProgress('package_install');
      const installResult = await this.installPackages(routerId);
      steps.push(installResult);
      if (installResult.status === 'error') {
        return this.fail(steps, `Package install failed: ${installResult.message}`);
      }

      // --- PHASE 3: CONFIGURATION ---

      // 6. Wireless Setup
      reportProgress('wireless_config');
      steps.push(await this.configureWireless(routerId, options));

      // 7. Network Interfaces (DSA-aware)
      reportProgress('network_config');
      const netConfig = await this.configureNetwork(routerId);
      steps.push(netConfig);
      if (netConfig.status === 'error') return this.fail(steps, 'Network config failed');

      // 8. DHCP Configuration
      reportProgress('dhcp_config');
      const dhcpConfig = await this.configureDhcp(routerId);
      steps.push(dhcpConfig);
      if (dhcpConfig.status === 'error') return this.fail(steps, 'DHCP config failed');

      // 9. Firewall (firewall4/nftables)
      reportProgress('firewall_config');
      const fwConfig = await this.configureFirewall(routerId);
      steps.push(fwConfig);
      if (fwConfig.status === 'error') return this.fail(steps, 'Firewall config failed');

      // 10. uHTTPd for portal
      reportProgress('portal_config');
      const portalConfig = await this.configurePortal(routerId);
      steps.push(portalConfig);
      if (portalConfig.status === 'error') return this.fail(steps, 'Portal config failed');

      // 11. Configure uspot captive portal
      reportProgress('uspot_config');
      const uspotConfig = await this.configureUspot(routerId);
      steps.push(uspotConfig);
      if (uspotConfig.status === 'error') return this.fail(steps, 'uspot config failed');

      // 12. Final service restart
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

  // --- PRE-FLIGHT CHECKS ---

  /**
   * Check OpenWRT version and required components for modern uspot
   * Requires OpenWRT 22.03+ with firewall4 (nftables) and ucode
   */
  private async checkOpenWrtVersion(routerId: string): Promise<SetupStepResult> {
    try {
      // Get OpenWRT version
      let version = '';
      let release = '';
      try {
        const osRelease = await this.exec(routerId, 'cat /etc/openwrt_release');
        const versionMatch = osRelease.match(/DISTRIB_RELEASE='([^']+)'/);
        const targetMatch = osRelease.match(/DISTRIB_TARGET='([^']+)'/);
        if (versionMatch) version = versionMatch[1];
        if (targetMatch) release = targetMatch[1];
      } catch {}

      // Parse version number (e.g., "23.05.0" -> 23.05)
      const versionNum = parseFloat(version.replace(/[^0-9.]/g, '')) || 0;
      const isSnapshot = version.toLowerCase().includes('snapshot');
      
      // Check minimum version (23.05 required for uspot per documentation)
      if (!isSnapshot && versionNum > 0 && versionNum < 23.05) {
        return {
          step: 'version_check',
          status: 'error',
          message: `OpenWRT ${version} is too old. Minimum required: 23.05 (for uspot). Please upgrade.`
        };
      }

      // Check required binaries
      const missing: string[] = [];
      for (const [name, paths] of Object.entries(this.REQUIRED_BINARIES)) {
        let found = false;
        for (const path of paths) {
          try {
            await this.exec(routerId, `test -e ${path}`);
            found = true;
            break;
          } catch {}
        }
        if (!found) missing.push(name);
      }

      if (missing.length > 0) {
        return {
          step: 'version_check',
          status: 'error',
          message: `Missing required components: ${missing.join(', ')}. Router needs firewall4 (nftables) and ucode.`
        };
      }

      this.logger.info(`[Setup] OpenWRT ${version} (${release}) - compatible`);
      return {
        step: 'version_check',
        status: 'success',
        message: `OpenWRT ${version || 'SNAPSHOT'} with firewall4/nftables`
      };
    } catch (e: any) {
      return { step: 'version_check', status: 'warning', message: `Could not verify version: ${e.message}` };
    }
  }

  /**
   * Check Disk Space
   */
  private async checkResources(routerId: string): Promise<SetupStepResult> {
    try {
      const df = await this.exec(routerId, 'df -k /overlay | tail -1 | awk \'{print $4}\'');
      const freeSpaceKb = parseInt(df.trim());

      if (isNaN(freeSpaceKb) || freeSpaceKb < 2048) {
        return { 
          step: 'resource_check', 
          status: 'error', 
          message: `Insufficient disk space. Free: ${Math.round(freeSpaceKb/1024)}MB. Required: 2MB.` 
        };
      }

      return { step: 'resource_check', status: 'success', message: `${Math.round(freeSpaceKb/1024)}MB free` };
    } catch {
      return { step: 'resource_check', status: 'warning', message: 'Could not verify disk space' };
    }
  }

  /**
   * Check network connectivity and DNS
   */
  private async ensureConnectivity(routerId: string): Promise<SetupStepResult> {
    try {
      // Check internet connectivity
      try {
        await this.exec(routerId, 'ping -c 1 -W 2 8.8.8.8');
      } catch {
        return { step: 'connectivity_check', status: 'error', message: 'No internet access' };
      }

      // Check DNS
      try {
        await this.exec(routerId, 'nslookup downloads.openwrt.org');
      } catch {
        // Try to fix DNS
        try {
          await this.exec(routerId, 'echo "nameserver 8.8.8.8" > /tmp/resolv.conf.auto');
          await this.exec(routerId, 'nslookup google.com');
          return { step: 'connectivity_check', status: 'warning', message: 'DNS fixed (using 8.8.8.8)' };
        } catch {
          return { step: 'connectivity_check', status: 'error', message: 'DNS resolution failed' };
        }
      }

      return { step: 'connectivity_check', status: 'success', message: 'Network OK' };
    } catch (e: any) {
      return { step: 'connectivity_check', status: 'error', message: e.message };
    }
  }

  // --- PACKAGE MANAGEMENT ---

  private async updatePackages(routerId: string): Promise<SetupStepResult> {
    try {
      await this.exec(routerId, 'opkg update', 120000);
      return { step: 'package_update', status: 'success' };
    } catch (e: any) {
      // Try with HTTP if HTTPS fails
      try {
        await this.exec(routerId, 'sed -i "s/https:/http:/g" /etc/opkg/distfeeds.conf');
        await this.exec(routerId, 'opkg update', 120000);
        return { step: 'package_update', status: 'warning', message: 'Used HTTP (HTTPS failed)' };
      } catch {
        return { step: 'package_update', status: 'error', message: this.parseOpkgError(e.message) };
      }
    }
  }

  private async installPackages(routerId: string): Promise<SetupStepResult> {
    try {
      const results: { pkg: string; status: 'success' | 'skipped' | 'error'; message?: string }[] = [];
      
      // Check and install required packages
      for (const pkg of this.REQUIRED_PACKAGES) {
        // Check if already installed via binary
        const binaries = this.PACKAGE_BINARIES[pkg];
        let hasPackage = false;
        
        if (binaries) {
          for (const bin of binaries) {
            try {
              await this.exec(routerId, `test -e ${bin}`);
              hasPackage = true;
              break;
            } catch {}
          }
        }
        
        if (hasPackage) {
          results.push({ pkg, status: 'skipped', message: 'Already installed' });
          continue;
        }
        
        // Install package
        try {
          await this.exec(routerId, `opkg install ${pkg}`, 120000);
          results.push({ pkg, status: 'success' });
        } catch (e: any) {
          results.push({ pkg, status: 'error', message: this.parseOpkgError(e.message) });
        }
      }
      
      // Try optional packages (don't fail if unavailable)
      for (const [name, alternatives] of Object.entries(this.OPTIONAL_PACKAGES)) {
        let installed = false;
        for (const alt of alternatives) {
          try {
            await this.exec(routerId, `opkg install ${alt}`, 60000);
            results.push({ pkg: alt, status: 'success', message: `(optional: ${name})` });
            installed = true;
            break;
          } catch {}
        }
        if (!installed) {
          results.push({ pkg: name, status: 'skipped', message: 'Optional package unavailable' });
        }
      }
      
      const errors = results.filter(r => r.status === 'error');
      const criticalErrors = errors.filter(r => ['uspot', 'uhttpd'].includes(r.pkg));
      
      if (criticalErrors.length > 0) {
        return {
          step: 'package_install',
          status: 'error',
          message: `Failed to install: ${criticalErrors.map(e => e.pkg).join(', ')}`,
          details: results
        };
      }
      
      if (errors.length > 0) {
        return {
          step: 'package_install',
          status: 'warning',
          message: `Some packages failed: ${errors.map(e => e.pkg).join(', ')}`,
          details: results
        };
      }
      
      const installed = results.filter(r => r.status === 'success').length;
      const skipped = results.filter(r => r.status === 'skipped').length;
      
      // Create radcli dictionary for uspot RADIUS authentication
      // uspot uses radcli library which requires specific type names:
      //   - 'ipaddr' for IPv4 (not 'ipv4addr')
      //   - 'integer' for numbers
      //   - 'string' for text
      try {
        await this.exec(routerId, 'mkdir -p /etc/radcli');
        await this.exec(routerId, 'rm -f /etc/radcli/dictionary 2>/dev/null || true');
        await this.exec(routerId, `cat > /etc/radcli/dictionary << 'DICTEOF'
#
# RADIUS Dictionary for radcli/uspot - SpotFi Setup
# Based on RFC 2865/2866 with radcli-compatible type names
# See: https://github.com/f00b4r0/uspot - radcli dictionary format
#
ATTRIBUTE	User-Name		1	string
ATTRIBUTE	Password		2	string
ATTRIBUTE	CHAP-Password		3	string
ATTRIBUTE	NAS-IP-Address		4	ipaddr
ATTRIBUTE	NAS-Port		5	integer
ATTRIBUTE	Service-Type		6	integer
ATTRIBUTE	Framed-Protocol		7	integer
ATTRIBUTE	Framed-IP-Address	8	ipaddr
ATTRIBUTE	Framed-IP-Netmask	9	ipaddr
ATTRIBUTE	Framed-Routing		10	integer
ATTRIBUTE	Filter-Id		11	string
ATTRIBUTE	Framed-MTU		12	integer
ATTRIBUTE	Framed-Compression	13	integer
ATTRIBUTE	Login-IP-Host		14	ipaddr
ATTRIBUTE	Login-Service		15	integer
ATTRIBUTE	Login-TCP-Port		16	integer
ATTRIBUTE	Reply-Message		18	string
ATTRIBUTE	Callback-Number		19	string
ATTRIBUTE	Callback-Id		20	string
ATTRIBUTE	Expiration		21	date
ATTRIBUTE	Framed-Route		22	string
ATTRIBUTE	Framed-IPX-Network	23	integer
ATTRIBUTE	State			24	string
ATTRIBUTE	Class			25	string
ATTRIBUTE	Vendor-Specific		26	string
ATTRIBUTE	Session-Timeout		27	integer
ATTRIBUTE	Idle-Timeout		28	integer
ATTRIBUTE	Termination-Action	29	integer
ATTRIBUTE	Called-Station-Id	30	string
ATTRIBUTE	Calling-Station-Id	31	string
ATTRIBUTE	NAS-Identifier		32	string
ATTRIBUTE	Proxy-State		33	string
ATTRIBUTE	Login-LAT-Service	34	string
ATTRIBUTE	Login-LAT-Node		35	string
ATTRIBUTE	Login-LAT-Group		36	string
ATTRIBUTE	Framed-AppleTalk-Link	37	integer
ATTRIBUTE	Framed-AppleTalk-Network	38	integer
ATTRIBUTE	Framed-AppleTalk-Zone	39	string
ATTRIBUTE	Acct-Status-Type	40	integer
ATTRIBUTE	Acct-Delay-Time		41	integer
ATTRIBUTE	Acct-Input-Octets	42	integer
ATTRIBUTE	Acct-Output-Octets	43	integer
ATTRIBUTE	Acct-Session-Id		44	string
ATTRIBUTE	Acct-Authentic		45	integer
ATTRIBUTE	Acct-Session-Time	46	integer
ATTRIBUTE	Acct-Input-Packets	47	integer
ATTRIBUTE	Acct-Output-Packets	48	integer
ATTRIBUTE	Acct-Terminate-Cause	49	integer
ATTRIBUTE	Acct-Multi-Session-Id	50	string
ATTRIBUTE	Acct-Link-Count		51	integer
ATTRIBUTE	Acct-Input-Gigawords	52	integer
ATTRIBUTE	Acct-Output-Gigawords	53	integer
ATTRIBUTE	Event-Timestamp		55	date
ATTRIBUTE	Egress-VLANID		56	string
ATTRIBUTE	Ingress-Filters		57	integer
ATTRIBUTE	Egress-VLAN-Name	58	string
ATTRIBUTE	User-Priority-Table	59	string
ATTRIBUTE	CHAP-Challenge		60	string
ATTRIBUTE	NAS-Port-Type		61	integer
ATTRIBUTE	Port-Limit		62	integer
ATTRIBUTE	Login-LAT-Port		63	integer
ATTRIBUTE	Tunnel-Type		64	integer
ATTRIBUTE	Tunnel-Medium-Type	65	integer
ATTRIBUTE	Tunnel-Client-Endpoint	66	string
ATTRIBUTE	Tunnel-Server-Endpoint	67	string
ATTRIBUTE	Acct-Tunnel-Connection	68	string
ATTRIBUTE	Tunnel-Password		69	string
ATTRIBUTE	ARAP-Password		70	string
ATTRIBUTE	ARAP-Features		71	string
ATTRIBUTE	ARAP-Zone-Access	72	integer
ATTRIBUTE	ARAP-Security		73	integer
ATTRIBUTE	ARAP-Security-Data	74	string
ATTRIBUTE	Password-Retry		75	integer
ATTRIBUTE	Prompt			76	integer
ATTRIBUTE	Connect-Info		77	string
ATTRIBUTE	Configuration-Token	78	string
ATTRIBUTE	EAP-Message		79	string
ATTRIBUTE	Message-Authenticator	80	string
ATTRIBUTE	Tunnel-Private-Group-ID	81	string
ATTRIBUTE	Tunnel-Assignment-ID	82	string
ATTRIBUTE	Tunnel-Preference	83	integer
ATTRIBUTE	ARAP-Challenge-Response	84	string
ATTRIBUTE	Acct-Interim-Interval	85	integer
ATTRIBUTE	Acct-Tunnel-Packets-Lost	86	integer
ATTRIBUTE	NAS-Port-Id		87	string
ATTRIBUTE	Framed-Pool		88	string
ATTRIBUTE	Chargeable-User-Identity	89	string
ATTRIBUTE	Tunnel-Client-Auth-ID	90	string
ATTRIBUTE	Tunnel-Server-Auth-ID	91	string
ATTRIBUTE	NAS-Filter-Rule		92	string
ATTRIBUTE	Originating-Line-Info	94	string
ATTRIBUTE	NAS-IPv6-Address	95	string
ATTRIBUTE	Framed-Interface-Id	96	string
ATTRIBUTE	Framed-IPv6-Prefix	97	string
ATTRIBUTE	Login-IPv6-Host		98	string
ATTRIBUTE	Framed-IPv6-Route	99	string
ATTRIBUTE	Framed-IPv6-Pool	100	string
ATTRIBUTE	Error-Cause		101	integer
ATTRIBUTE	EAP-Key-Name		102	string
ATTRIBUTE	Delegated-IPv6-Prefix	123	string
ATTRIBUTE	Framed-IPv6-Address	168	string
ATTRIBUTE	DNS-Server-IPv6-Address	169	string
ATTRIBUTE	Route-IPv6-Information	170	string
ATTRIBUTE	Auth-Type		1000	integer
VALUE	Service-Type	Login-User	1
VALUE	Service-Type	Framed-User	2
VALUE	Service-Type	Callback-Login-User	3
VALUE	Service-Type	Callback-Framed-User	4
VALUE	Service-Type	Outbound-User	5
VALUE	Service-Type	Administrative-User	6
VALUE	Service-Type	NAS-Prompt-User	7
VALUE	Service-Type	Authenticate-Only	8
VALUE	Framed-Protocol	PPP	1
VALUE	Framed-Protocol	SLIP	2
VALUE	Framed-Protocol	ARAP	3
VALUE	Framed-Routing	None	0
VALUE	Framed-Routing	Broadcast	1
VALUE	Framed-Routing	Listen	2
VALUE	Framed-Routing	Broadcast-Listen	3
VALUE	Framed-Compression	None	0
VALUE	Framed-Compression	Van-Jacobson-TCP-IP	1
VALUE	Framed-Compression	IPX-Header	2
VALUE	Framed-Compression	Stac-LZS	3
VALUE	Login-Service	Telnet	0
VALUE	Login-Service	Rlogin	1
VALUE	Login-Service	TCP-Clear	2
VALUE	Login-Service	PortMaster	3
VALUE	Login-Service	LAT	4
VALUE	Acct-Status-Type	Start	1
VALUE	Acct-Status-Type	Stop	2
VALUE	Acct-Status-Type	Alive	3
VALUE	Acct-Status-Type	Accounting-On	7
VALUE	Acct-Status-Type	Accounting-Off	8
VALUE	Acct-Authentic	RADIUS	1
VALUE	Acct-Authentic	Local	2
VALUE	Acct-Authentic	Remote	3
VALUE	Termination-Action	Default	0
VALUE	Termination-Action	RADIUS-Request	1
VALUE	NAS-Port-Type	Async	0
VALUE	NAS-Port-Type	Sync	1
VALUE	NAS-Port-Type	ISDN	2
VALUE	NAS-Port-Type	ISDN-V120	3
VALUE	NAS-Port-Type	ISDN-V110	4
VALUE	NAS-Port-Type	Virtual	5
VALUE	NAS-Port-Type	Ethernet	15
VALUE	Acct-Terminate-Cause	User-Request	1
VALUE	Acct-Terminate-Cause	Lost-Carrier	2
VALUE	Acct-Terminate-Cause	Lost-Service	3
VALUE	Acct-Terminate-Cause	Idle-Timeout	4
VALUE	Acct-Terminate-Cause	Session-Timeout	5
VALUE	Acct-Terminate-Cause	Admin-Reset	6
VALUE	Acct-Terminate-Cause	Admin-Reboot	7
VALUE	Acct-Terminate-Cause	Port-Error	8
VALUE	Acct-Terminate-Cause	NAS-Error	9
VALUE	Acct-Terminate-Cause	NAS-Request	10
VALUE	Acct-Terminate-Cause	NAS-Reboot	11
VALUE	Auth-Type	Local	0
VALUE	Auth-Type	System	1
VALUE	Auth-Type	Reject	4
VALUE	Auth-Type	Accept	254
DICTEOF`);
        
        // Verify the dictionary was created successfully
        const verifyResult = await this.exec(routerId, 'test -f /etc/radcli/dictionary && wc -l < /etc/radcli/dictionary');
        const lineCount = parseInt(verifyResult.trim()) || 0;
        if (lineCount < 50) {
          throw new Error(`Dictionary file incomplete: only ${lineCount} lines`);
        }
        
        // Set proper permissions
        await this.exec(routerId, 'chmod 644 /etc/radcli/dictionary');
        
        this.logger.info(`[Setup] radcli dictionary created (${lineCount} lines)`);
        
        // Restart uspot to reload dictionary (uspot-radius caches dictionary at startup)
        // This ensures the new dictionary with correct types is loaded
        try {
          await this.exec(routerId, '/etc/init.d/uspot restart 2>/dev/null || true');
          this.logger.info('[Setup] Restarted uspot to reload dictionary');
        } catch (restartErr: any) {
          // uspot might not be running yet, that's okay - it will load on next start
          this.logger.debug(`[Setup] Could not restart uspot (may not be running yet): ${restartErr.message}`);
        }

      } catch (radcliErr: any) {
        this.logger.warn(`[Setup] Could not configure radcli dictionary: ${radcliErr.message}`);
      }
      
      return {
        step: 'package_install',
        status: 'success',
        message: `${installed} installed, ${skipped} skipped`,
        details: results
      };
    } catch (e: any) {
      return { step: 'package_install', status: 'error', message: e.message };
    }
  }

  // --- CONFIGURATION HELPERS ---

  /**
   * Configure wireless networks with dual SSID setup:
   * 1. Guest SSID (on 'hotspot' network) - for captive portal
   * 2. Management SSID (on 'lan' network, hidden) - for admin access
   */
  public async configureWireless(
    routerId: string, 
    options: { 
      combinedSSID?: boolean;
      ssid?: string;
      password?: string;
    }
  ): Promise<SetupStepResult> {
    const guestSSID = options.ssid || 'SpotFi';
    const guestPassword = options.password || '';
    const mgmtSSID = `${guestSSID}-Admin`;
    // Admin password must be at least 8 characters for WPA2
    let mgmtPassword = guestPassword && guestPassword.length >= 8 ? guestPassword : 'spotfi-admin123';
    
    // Ensure admin password meets WPA2 requirements (8+ chars)
    if (mgmtPassword.length < 8) {
      mgmtPassword = 'spotfi-admin123';
    }

    try {
      // Step 1: Check if wireless exists
      try { 
        await this.exec(routerId, 'uci get wireless'); 
      } catch {
        return { step: 'wireless_config', status: 'skipped', message: 'No wireless radio found' };
      }

      // Step 2: Get list of radio devices
      const radiosOutput = await this.exec(routerId, 
        "uci show wireless | grep '=wifi-device' | cut -d'.' -f2 | cut -d'=' -f1"
      );
      const radios = radiosOutput.trim().split('\n').filter(r => r && r.length > 0);

      if (radios.length === 0) {
        return { step: 'wireless_config', status: 'warning', message: 'No wireless radios detected' };
      }

      this.logger.info(`[Setup] Found ${radios.length} wireless radio(s): ${radios.join(', ')}`);

      // Step 3: Delete ALL existing wifi-iface sections (clean slate)
      // First, count how many exist
      let ifaceCount = 0;
      try {
        const countOutput = await this.exec(routerId, "uci show wireless | grep -c '=wifi-iface' || echo '0'");
        ifaceCount = parseInt(countOutput.trim()) || 0;
      } catch {}
      
      // Delete all wifi-iface sections (always delete index 0 as they shift down)
      for (let i = 0; i < ifaceCount + 5; i++) { // +5 buffer for safety
        try {
          await this.exec(routerId, 'uci delete wireless.@wifi-iface[0]');
        } catch { 
          break; // No more interfaces to delete
        }
      }
      this.logger.info(`[Setup] Removed all existing wifi-iface sections`);

      // Step 4: Configure each radio with dual SSIDs
      for (const radio of radios) {
        // Enable the radio
        await this.exec(routerId, `uci set wireless.${radio}.disabled='0'`);

        // Get band info for logging
        let bandInfo = '';
        try {
          const band = (await this.exec(routerId, `uci -q get wireless.${radio}.band || echo ""`)).trim();
          const channel = (await this.exec(routerId, `uci -q get wireless.${radio}.channel || echo "auto"`)).trim();
          bandInfo = band || (parseInt(channel) > 14 ? '5GHz' : '2.4GHz');
        } catch {}

        // 4a. Create Guest SSID (hotspot network - captive portal)
        await this.exec(routerId, `uci add wireless wifi-iface`);
        await this.exec(routerId, `uci set wireless.@wifi-iface[-1].device='${radio}'`);
        await this.exec(routerId, `uci set wireless.@wifi-iface[-1].mode='ap'`);
        await this.exec(routerId, `uci set wireless.@wifi-iface[-1].ssid='${guestSSID}'`);
        await this.exec(routerId, `uci set wireless.@wifi-iface[-1].network='hotspot'`);
        await this.exec(routerId, `uci set wireless.@wifi-iface[-1].isolate='1'`); // Client isolation
        
        if (guestPassword && guestPassword !== 'none' && guestPassword.length >= 8) {
          await this.exec(routerId, `uci set wireless.@wifi-iface[-1].encryption='psk2'`);
          await this.exec(routerId, `uci set wireless.@wifi-iface[-1].key='${guestPassword}'`);
        } else {
          await this.exec(routerId, `uci set wireless.@wifi-iface[-1].encryption='none'`);
        }

        // 4b. Create Management SSID (lan network - hidden, for admin)
        await this.exec(routerId, `uci add wireless wifi-iface`);
        await this.exec(routerId, `uci set wireless.@wifi-iface[-1].device='${radio}'`);
        await this.exec(routerId, `uci set wireless.@wifi-iface[-1].mode='ap'`);
        await this.exec(routerId, `uci set wireless.@wifi-iface[-1].ssid='${mgmtSSID}'`);
        await this.exec(routerId, `uci set wireless.@wifi-iface[-1].network='lan'`);
        await this.exec(routerId, `uci set wireless.@wifi-iface[-1].hidden='1'`); // Hidden SSID
        // Use WPA2-only (psk2) for proper security on admin network
        await this.exec(routerId, `uci set wireless.@wifi-iface[-1].encryption='psk2'`);
        // Properly escape password for shell command
        const escapedMgmtPassword = mgmtPassword.replace(/'/g, "'\"'\"'");
        await this.exec(routerId, `uci set wireless.@wifi-iface[-1].key='${escapedMgmtPassword}'`);

        this.logger.info(`[Setup] Configured ${radio} (${bandInfo}): Guest='${guestSSID}', Admin='${mgmtSSID}' (hidden)`);
      }

      // Step 5: Commit wireless config
      await this.exec(routerId, 'uci commit wireless');

      return { 
        step: 'wireless_config', 
        status: 'success', 
        message: `Created ${radios.length * 2} SSIDs: '${guestSSID}' (guest) + '${mgmtSSID}' (admin, hidden)`
      };
    } catch (e: any) {
      return { step: 'wireless_config', status: 'error', message: e.message };
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
      // DSA Port-Based VLAN Configuration (Best Practice)
      // ============================================================
      // Modern OpenWrt (21.02+) uses DSA for switch configuration
      // We configure: First port = Admin, remaining ports = Guest (hotspot)
      
      // Detect DSA switch and available ports
      let isDSA = false;
      let lanPorts: string[] = [];
      
      try {
        // Method 1: Check for DSA-style ports (lan1, lan2, lan3, lan4)
        const dsaCheck1 = await this.exec(routerId, 
          'for i in 1 2 3 4 5 6; do [ -d /sys/class/net/lan$i ] && echo lan$i; done 2>/dev/null || true'
        );
        if (dsaCheck1.trim()) {
          lanPorts = dsaCheck1.trim().split('\n').filter(p => p.startsWith('lan'));
        }
        
        // Method 2: Check br-lan ports from UCI config
        if (lanPorts.length === 0) {
          try {
            const brPorts = await this.exec(routerId, "uci -q get network.br_lan.ports 2>/dev/null || uci -q get network.@device[0].ports 2>/dev/null || echo ''");
            if (brPorts.trim()) {
              lanPorts = brPorts.trim().split(/\s+/).filter(p => p && !p.includes('wan'));
              this.logger.info(`[Setup] Found ports from br-lan config: ${lanPorts.join(', ')}`);
            }
          } catch {}
        }
        
        // Method 3: List all ethernet interfaces that look like switch ports
        if (lanPorts.length === 0) {
          try {
            const allIfaces = await this.exec(routerId, 
              "ls /sys/class/net/ | grep -E '^(lan|eth[0-9]+$|port[0-9])' | head -6"
            );
            if (allIfaces.trim()) {
              lanPorts = allIfaces.trim().split('\n').filter(p => p && !p.includes('wan'));
            }
          } catch {}
        }

        isDSA = lanPorts.length > 0;
        this.logger.info(`[Setup] Port detection result - isDSA: ${isDSA}, ports: [${lanPorts.join(', ')}]`);
      } catch (e: any) {
        this.logger.warn(`[Setup] DSA detection failed: ${e.message}`);
      }

      if (isDSA && lanPorts.length > 1) {
        this.logger.info(`[Setup] Multiple LAN ports detected: ${lanPorts.join(', ')}`);
        
        // ============================================================
        // Port Assignment: First port = Admin, Rest = Guest
        // ============================================================
        const adminPort = lanPorts[0]; // First port for admin
        const guestPorts = lanPorts.slice(1); // Remaining ports for guests
        
        this.logger.info(`[Setup] Admin port: ${adminPort}, Guest ports: ${guestPorts.join(', ')}`);

        // Step 1: Update br-lan to only include admin port
        try {
          await this.exec(routerId, 'uci set network.br_lan=device');
          await this.exec(routerId, 'uci set network.br_lan.type="bridge"');
          await this.exec(routerId, 'uci set network.br_lan.name="br-lan"');
          // Clear existing ports and set only admin port
          try { await this.exec(routerId, 'uci delete network.br_lan.ports'); } catch {}
          await this.exec(routerId, `uci add_list network.br_lan.ports="${adminPort}"`);
        } catch (e: any) {
          this.logger.warn(`[Setup] Could not configure br-lan ports: ${e.message}`);
        }

        // Step 2: Create br-hotspot with guest ports
        await this.exec(routerId, 'uci set network.br_hotspot=device');
        await this.exec(routerId, 'uci set network.br_hotspot.type="bridge"');
        await this.exec(routerId, 'uci set network.br_hotspot.name="br-hotspot"');
        await this.exec(routerId, 'uci set network.br_hotspot.stp="1"');
        await this.exec(routerId, 'uci set network.br_hotspot.isolate="1"'); // Client isolation
        
        // Clear existing ports and add guest ports
        try { await this.exec(routerId, 'uci delete network.br_hotspot.ports'); } catch {}
        for (const port of guestPorts) {
          await this.exec(routerId, `uci add_list network.br_hotspot.ports="${port}"`);
        }
        
        this.logger.info(`[Setup] Configured br-hotspot with ports: ${guestPorts.join(', ')}`);

      } else {
        // Non-DSA or single port: Create br-hotspot for WiFi only
        this.logger.info('[Setup] Non-DSA switch or single port - WiFi-only hotspot');
        
        await this.exec(routerId, 'uci set network.br_hotspot=device');
        await this.exec(routerId, 'uci set network.br_hotspot.type="bridge"');
        await this.exec(routerId, 'uci set network.br_hotspot.name="br-hotspot"');
        await this.exec(routerId, 'uci set network.br_hotspot.stp="1"');
        await this.exec(routerId, 'uci set network.br_hotspot.isolate="1"');
        // No physical ports - WiFi interfaces will auto-join when network='hotspot'
      }

      // Step 3: Configure hotspot interface
      await this.exec(routerId, 'uci set network.hotspot=interface');
      await this.exec(routerId, 'uci set network.hotspot.proto="static"');
      await this.exec(routerId, `uci set network.hotspot.ipaddr="${this.HOTSPOT_IP}"`);
      await this.exec(routerId, `uci set network.hotspot.netmask="${this.HOTSPOT_NETMASK}"`);
      await this.exec(routerId, 'uci set network.hotspot.device="br-hotspot"');
      await this.exec(routerId, 'uci set network.hotspot.force_link="1"');
      await this.exec(routerId, 'uci set network.hotspot.delegate="0"'); // No IPv6 delegation
      
      const portMsg = isDSA && lanPorts.length > 1 
        ? `Admin: ${lanPorts[0]}, Guest: ${lanPorts.slice(1).join(', ')}`
        : 'WiFi-only (no DSA ports)';
      this.logger.info(`[Setup] Network configured - ${portMsg}`);
      
      await this.exec(routerId, 'uci commit network');
      return { step: 'network_config', status: 'success', message: portMsg };
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

  /**
   * Configure uspot captive portal service
   * This is the core configuration that enables captive portal redirect
   * 
   * Based on uspot documentation (https://github.com/f00b4r0/uspot):
   * - uspot uses NAMED sections: `config uspot 'sectionname'`
   * - Each captive portal interface needs its own named uspot section
   * - The section name should match the interface name for clarity
   * - Required options: interface, setname (for firewall ipset)
   * 
   * Also requires:
   * - Firewall zone, rules, and ipset configuration
   * - uhttpd configuration for web interface
   * - DHCP configuration for captive clients
   */
  private async configureUspot(routerId: string): Promise<SetupStepResult> {
    try {
      const hotspotIp = this.HOTSPOT_IP;
      const sectionName = 'hotspot'; // Named section for the hotspot interface
      const setName = 'uspot_hotspot'; // Firewall ipset name for authenticated clients
      
      // Create the /www-uspot directory for uhttpd portal pages
      // This is required by uhttpd even if we use ucode handlers
      await this.exec(routerId, 'mkdir -p /www-uspot');
      
      // Create a minimal index page for the portal
      await this.exec(routerId, `cat > /www-uspot/index.html << 'PORTALEOF'
<!DOCTYPE html>
<html>
<head><meta http-equiv="refresh" content="0;url=/hotspot"></head>
<body>Redirecting to portal...</body>
</html>
PORTALEOF`);
      
      // Create the uspot configuration file with proper named section structure
      // This follows the official uspot configuration format
      // Valid auth_mode values: click-to-continue, credentials, radius, uam
      // Default to 'click-to-continue' - UAM mode is configured via /uam/configure endpoint
      await this.exec(routerId, `cat > /etc/config/uspot << 'USPOTEOF'
# uspot captive portal configuration
# Generated by SpotFi Setup
# Documentation: https://github.com/f00b4r0/uspot

config uspot '${sectionName}'
	option enabled '1'
	option interface '${sectionName}'
	option setname '${setName}'
	option auth_mode 'click-to-continue'
	option idle_timeout '600'
	option session_timeout '0'
	option debug '0'
USPOTEOF`);

      // Create the firewall ipset for authenticated clients
      // This is required for uspot to track authenticated MACs
      try {
        // Check if ipset already exists
        const existingIpset = await this.exec(routerId, `uci show firewall | grep "name='${setName}'" || echo ""`);
        if (!existingIpset.includes(setName)) {
          await this.exec(routerId, `uci add firewall ipset`);
          await this.exec(routerId, `uci set firewall.@ipset[-1].name='${setName}'`);
          await this.exec(routerId, `uci add_list firewall.@ipset[-1].match='src_mac'`);
          await this.exec(routerId, `uci commit firewall`);
        }
      } catch (ipsetErr: any) {
        this.logger.warn(`[Setup] Could not create firewall ipset: ${ipsetErr.message}`);
      }

      // Configure uhttpd for uspot web interface
      // uspot requires uhttpd with specific ucode handlers
      try {
        // Check if uspot uhttpd instance exists
        const existingUhttpd = await this.exec(routerId, `uci show uhttpd | grep "uhttpd.uspot" || echo ""`);
        if (!existingUhttpd.includes('uhttpd.uspot')) {
          // Create dedicated uhttpd instance for captive portal
          await this.exec(routerId, `uci set uhttpd.uspot=uhttpd`);
          await this.exec(routerId, `uci set uhttpd.uspot.listen_http='${hotspotIp}:80'`);
          await this.exec(routerId, `uci set uhttpd.uspot.redirect_https='0'`);
          await this.exec(routerId, `uci set uhttpd.uspot.max_requests='5'`);
          await this.exec(routerId, `uci set uhttpd.uspot.no_dirlists='1'`);
          await this.exec(routerId, `uci set uhttpd.uspot.home='/www-uspot'`);
          await this.exec(routerId, `uci add_list uhttpd.uspot.ucode_prefix='/hotspot=/usr/share/uspot/handler.uc'`);
          await this.exec(routerId, `uci add_list uhttpd.uspot.ucode_prefix='/cpd=/usr/share/uspot/handler-cpd.uc'`);
          await this.exec(routerId, `uci set uhttpd.uspot.error_page='/cpd'`);
          await this.exec(routerId, `uci commit uhttpd`);
        }
      } catch (uhttpdErr: any) {
        this.logger.warn(`[Setup] Could not configure uhttpd for uspot: ${uhttpdErr.message}`);
      }

      // Add firewall redirect rule for CPD (Captive Portal Detection) hijacking
      // This redirects HTTP traffic from unauthenticated clients to the portal
      try {
        const existingRedirect = await this.exec(routerId, `uci show firewall | grep "Redirect-unauth-captive" || echo ""`);
        if (!existingRedirect.includes('Redirect-unauth-captive')) {
          await this.exec(routerId, `uci add firewall redirect`);
          await this.exec(routerId, `uci set firewall.@redirect[-1].name='Redirect-unauth-captive-CPD'`);
          await this.exec(routerId, `uci set firewall.@redirect[-1].src='hotspot'`);
          await this.exec(routerId, `uci set firewall.@redirect[-1].src_dport='80'`);
          await this.exec(routerId, `uci set firewall.@redirect[-1].proto='tcp'`);
          await this.exec(routerId, `uci set firewall.@redirect[-1].target='DNAT'`);
          await this.exec(routerId, `uci set firewall.@redirect[-1].reflection='0'`);
          await this.exec(routerId, `uci set firewall.@redirect[-1].ipset='!${setName}'`); // Only redirect unauthenticated
          await this.exec(routerId, `uci commit firewall`);
        }
      } catch (redirectErr: any) {
        this.logger.warn(`[Setup] Could not create CPD redirect rule: ${redirectErr.message}`);
      }

      // Add firewall rule to allow forwarding for authenticated clients only
      try {
        const existingForward = await this.exec(routerId, `uci show firewall | grep "Forward-auth-captive" || echo ""`);
        if (!existingForward.includes('Forward-auth-captive')) {
          await this.exec(routerId, `uci add firewall rule`);
          await this.exec(routerId, `uci set firewall.@rule[-1].name='Forward-auth-captive'`);
          await this.exec(routerId, `uci set firewall.@rule[-1].src='hotspot'`);
          await this.exec(routerId, `uci set firewall.@rule[-1].dest='wan'`);
          await this.exec(routerId, `uci set firewall.@rule[-1].proto='any'`);
          await this.exec(routerId, `uci set firewall.@rule[-1].target='ACCEPT'`);
          await this.exec(routerId, `uci set firewall.@rule[-1].ipset='${setName}'`); // Only authenticated MACs
          await this.exec(routerId, `uci commit firewall`);
        }
      } catch (forwardErr: any) {
        this.logger.warn(`[Setup] Could not create forward rule: ${forwardErr.message}`);
      }

      // Enable uspot service
      await this.exec(routerId, '/etc/init.d/uspot enable 2>/dev/null || true');
      
      this.logger.info('[Setup] uspot captive portal configured with named section structure');
      return { 
        step: 'uspot_config', 
        status: 'success', 
        message: `Captive portal '${sectionName}' enabled with ipset '${setName}'` 
      };
    } catch (e: any) {
      return { step: 'uspot_config', status: 'error', message: e.message };
    }
  }

  private async restartServices(routerId: string): Promise<SetupStepResult> {
    try {
      // Restart network first
      await this.exec(routerId, '/etc/init.d/network restart');
      await this.sleep(3000);
      
      // Restart firewall
      await this.exec(routerId, '/etc/init.d/firewall restart');
      await this.sleep(1000);
      
      // Restart wireless
      try { await this.exec(routerId, '/etc/init.d/wireless restart'); } catch {}
      await this.sleep(2000);
      
      // Restart dnsmasq (DHCP)
      try { await this.exec(routerId, '/etc/init.d/dnsmasq restart'); } catch {}
      
      // Start uhttpd
      await this.exec(routerId, '/etc/init.d/uhttpd enable');
      await this.exec(routerId, '/etc/init.d/uhttpd restart');
      
      // Start uspot captive portal - THIS IS CRITICAL
      try {
        await this.exec(routerId, '/etc/init.d/uspot enable');
        await this.exec(routerId, '/etc/init.d/uspot restart');
        this.logger.info('[Setup] uspot service started');
      } catch (e: any) {
        this.logger.warn(`[Setup] Could not start uspot: ${e.message}`);
      }
      
      return { step: 'services_restart', status: 'success', message: 'All services restarted including uspot' };
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