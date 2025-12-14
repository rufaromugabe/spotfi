/**
 * Portal Whitelist Configuration Utilities
 * 
 * Best practices for whitelisting URLs for unauthenticated captive portal users:
 * 1. Portal login page and all paths
 * 2. RFC 8908 API endpoints
 * 3. OS-specific detection URLs (Apple, Google, Microsoft)
 * 4. DNS servers (critical for DNS resolution)
 * 5. NTP servers (critical for time sync and HTTPS certificate validation)
 * 6. CDN/static asset domains (if portal uses external resources)
 * 7. Router's own UAM listener IP:port
 */

import { isIP } from 'net';
import { promisify } from 'util';
import dns from 'dns';

const lookup = promisify(dns.lookup);

export interface WhitelistConfig {
  // Portal URLs - must be accessible without authentication
  portalUrls: string[];
  
  // Custom allowed domains (e.g. google.com, facebook.com)
  allowedDomains?: string[];

  // DNS servers - required for DNS resolution
  dnsServers?: string[];
  
  // NTP servers - required for time sync (critical for HTTPS cert validation)
  ntpServers?: string[];
  
  // Router's UAM listener IP (for local UAM communication)
  routerUamIp?: string;
  
  // Router's UAM listener port
  routerUamPort?: string;
}

/**
 * Default DNS servers (Google, Cloudflare, OpenDNS)
 * These are critical for DNS resolution
 */
const DEFAULT_DNS_SERVERS = [
  '8.8.8.8',           // Google DNS
  '8.8.4.4',           // Google DNS secondary
  '1.1.1.1',           // Cloudflare DNS
  '1.0.0.1',           // Cloudflare DNS secondary
  '208.67.222.222',    // OpenDNS
  '208.67.220.220'     // OpenDNS secondary
];

/**
 * Default NTP servers (for time synchronization)
 * Critical for HTTPS certificate validation
 */
const DEFAULT_NTP_SERVERS = [
  'pool.ntp.org',
  'time.google.com',
  'time.cloudflare.com',
  'time.apple.com'
];

/**
 * OS-specific captive portal detection URLs
 * These should be whitelisted so OS can detect captive portal
 */
const OS_DETECTION_URLS = [
  // Android
  'connectivitycheck.gstatic.com',
  'www.google.com',
  
  // iOS/macOS
  'captive.apple.com',
  'www.apple.com',
  
  // Windows
  'www.msftconnecttest.com',
  'www.msftncsi.com',
  
  // Linux (NetworkManager)
  'nmcheck.gnome.org',
  'detectportal.firefox.com'
];

/**
 * Extracts all domains and IPs that need to be whitelisted
 */
export async function extractWhitelistDomains(config: WhitelistConfig): Promise<{
  domains: string[];
  ips: string[];
}> {
  const domains = new Set<string>();
  const ips = new Set<string>();

  // Add portal URLs
  for (const url of config.portalUrls) {
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname;
      
      // If it's an IP, add to IPs
      if (isIP(hostname)) {
        ips.add(hostname);
      } else {
        domains.add(hostname);
      }
    } catch (error) {
      // Invalid URL, skip
      console.warn(`Invalid portal URL: ${url}`);
    }
  }

  // Add OS detection domains
  OS_DETECTION_URLS.forEach(domain => domains.add(domain));

  // Add DNS servers (IPs only)
  const dnsServers = config.dnsServers || DEFAULT_DNS_SERVERS;
  dnsServers.forEach(server => {
    if (isIP(server)) {
      ips.add(server);
    } else {
      domains.add(server);
    }
  });

  // Add NTP servers (resolve to IPs)
  const ntpServers = config.ntpServers || DEFAULT_NTP_SERVERS;
  for (const ntpServer of ntpServers) {
    if (isIP(ntpServer)) {
      ips.add(ntpServer);
    } else {
      domains.add(ntpServer);
      // Try to resolve NTP server to IP
      try {
        const result = await lookup(ntpServer).catch(() => null);
        if (result?.address) {
          ips.add(result.address);
        }
      } catch {
        // DNS resolution failed, will rely on domain whitelist
      }
    }
  }

  // Add router UAM IP if provided
  if (config.routerUamIp && isIP(config.routerUamIp)) {
    ips.add(config.routerUamIp);
  }

  return {
    domains: Array.from(domains),
    ips: Array.from(ips)
  };
}

/**
 * Generates OpenWRT firewall whitelist configuration script
 * Uses robust DNS-based IPSet whitelisting via dnsmasq
 */
export function generateWhitelistScript(config: WhitelistConfig): string {
  const portalUrls = config.portalUrls || [];
  const allowedDomains = config.allowedDomains || [];
  const dnsServers = config.dnsServers || DEFAULT_DNS_SERVERS;
  const ntpServers = config.ntpServers || DEFAULT_NTP_SERVERS;
  
  // Extract domains and IPs
  const domains: string[] = [];
  const ips: string[] = [];
  
  // Extract domains from portal URLs
  portalUrls.forEach(url => {
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname;
      if (isIP(hostname)) {
        ips.push(hostname);
      } else {
        domains.push(hostname);
      }
    } catch {
      // Skip invalid URLs
    }
  });
  
  // Add custom allowed domains
  allowedDomains.forEach(d => domains.push(d));

  // Add OS detection domains
  OS_DETECTION_URLS.forEach(d => domains.push(d));
  
  // Add DNS servers
  dnsServers.forEach(server => {
    if (isIP(server)) {
      ips.push(server);
    } else {
      domains.push(server);
    }
  });
  
  // Add NTP servers (as domains, will be resolved dynamically)
  ntpServers.forEach(server => {
    if (!isIP(server)) {
      domains.push(server);
    } else {
      ips.push(server);
    }
  });
  
  // Add router UAM IP
  if (config.routerUamIp && isIP(config.routerUamIp)) {
    ips.push(config.routerUamIp);
  }
  
  // Remove duplicates
  const uniqueDomains = [...new Set(domains)];
  const uniqueIps = [...new Set(ips)];
  
  return `
#!/bin/sh
echo "=== Configuring Captive Portal Whitelist (DNS-Based) ==="
echo "Domains to whitelist: ${uniqueDomains.length}"
echo "IPs to whitelist: ${uniqueIps.length}"

# ============================================================
# STEP 1: Ensure firewall ipset exists
# ============================================================
idx=0
found=""
while uci get firewall.@ipset[$idx] >/dev/null 2>&1; do
  name=$(uci get firewall.@ipset[$idx].name 2>/dev/null)
  if [ "$name" = "uspot_wlist" ]; then
    found=$idx
    break
  fi
  idx=$((idx + 1))
done

if [ -z "$found" ]; then
  echo "Creating firewall ipset 'uspot_wlist'..."
  uci add firewall ipset
  uci set firewall.@ipset[-1].name='uspot_wlist'
  uci set firewall.@ipset[-1].match='ip'
  uci set firewall.@ipset[-1].enabled='1'
  found=$(($(uci show firewall | grep -c 'firewall.@ipset') - 1))
fi

# ============================================================
# STEP 2: Configure dnsmasq for Dynamic Whitelisting
# Use 'ipset' option to add resolved IPs to uspot_wlist automatically
# ============================================================
echo "Configuring dnsmasq dynamic ipset..."

# First, remove any existing ipset entries to ensure clean state
# (Only remove uspot_wlist entries to avoid breaking other configs)
idx=0
while uci get dhcp.@ipset[$idx] >/dev/null 2>&1; do
  names=$(uci get dhcp.@ipset[$idx].name 2>/dev/null)
  if echo "$names" | grep -q "uspot_wlist"; then
    uci delete dhcp.@ipset[$idx] 2>/dev/null || true
    # Decrement index since we removed an entry
    idx=$((idx - 1))
  fi
  idx=$((idx + 1))
done

# Create new dnsmasq ipset entry
# This tells dnsmasq: "When resolving these domains, add IPs to 'uspot_wlist' ipset"
uci add dhcp ipset
uci add_list dhcp.@ipset[-1].name='uspot_wlist'
${uniqueDomains.map(domain => `uci add_list dhcp.@ipset[-1].domain='${domain}'`).join('\n')}

# ============================================================
# STEP 3: Add Static IPs directly to Firewall IPSet
# ============================================================
echo "Adding static IPs to firewall ipset..."
uci delete firewall.@ipset[$found].entry 2>/dev/null || true
${uniqueIps.map(ip => `uci add_list firewall.@ipset[$found].entry='${ip}'`).join('\n')}

# ============================================================
# STEP 4: Ensure Firewall Rule Exists
# ============================================================
# Check if firewall rule exists
rule_idx=0
rule_found=""
while uci get firewall.@rule[$rule_idx] >/dev/null 2>&1; do
  src=$(uci get firewall.@rule[$rule_idx].src 2>/dev/null)
  ipset=$(uci get firewall.@rule[$rule_idx].ipset 2>/dev/null)
  if [ "$src" = "hotspot" ] && [ "$ipset" = "uspot_wlist" ]; then
    rule_found=$rule_idx
    break
  fi
  rule_idx=$((rule_idx + 1))
done

if [ -z "$rule_found" ]; then
  echo "Creating firewall rule for whitelist..."
  uci add firewall rule
  uci set firewall.@rule[-1].name='Allow-Whitelist-hotspot'
  uci set firewall.@rule[-1].src='hotspot'
  uci set firewall.@rule[-1].dest='wan'
  uci set firewall.@rule[-1].ipset='uspot_wlist'
  uci set firewall.@rule[-1].target='ACCEPT'
  uci set firewall.@rule[-1].enabled='1'
fi

# ============================================================
# STEP 5: Commit and Restart
# ============================================================
uci commit firewall
uci commit dhcp

echo "Restarting services..."
/etc/init.d/firewall restart
/etc/init.d/dnsmasq restart

echo "=== Whitelist Configured Successfully ==="
echo "Access allowed to:"
${uniqueDomains.map(d => `echo "  - *.${d} (and subdomains)"`).join('\n')}
${uniqueIps.map(ip => `echo "  - ${ip}"`).join('\n')}
`;
}

/**
 * Validates whitelist configuration
 */
export function validateWhitelistConfig(config: WhitelistConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!config.portalUrls || config.portalUrls.length === 0) {
    errors.push('At least one portal URL is required');
  }

  // Validate portal URLs
  config.portalUrls?.forEach((url, index) => {
    try {
      new URL(url);
    } catch {
      errors.push(`Invalid portal URL at index ${index}: ${url}`);
    }
  });

  // Validate DNS servers
  config.dnsServers?.forEach((server, index) => {
    if (!isIP(server) && !/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(server)) {
      errors.push(`Invalid DNS server at index ${index}: ${server}`);
    }
  });

  // Validate NTP servers
  config.ntpServers?.forEach((server, index) => {
    if (!isIP(server) && !/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(server)) {
      errors.push(`Invalid NTP server at index ${index}: ${server}`);
    }
  });

  // Validate router UAM IP
  if (config.routerUamIp && !isIP(config.routerUamIp)) {
    errors.push(`Invalid router UAM IP: ${config.routerUamIp}`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

