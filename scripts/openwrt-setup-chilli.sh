#!/bin/sh
#
# SpotFi OpenWRT CoovaChilli Setup Script
# 
# This script configures CoovaChilli for SpotFi captive portal with RADIUS authentication
# - CoovaChilli installation and configuration
# - Hotspot network and WiFi setup
# - Firewall rules for RADIUS
# - No WebSocket bridge (use openwrt-setup-cloud.sh for that)
#
# Usage: ./openwrt-setup-chilli.sh ROUTER_ID RADIUS_SECRET MAC_ADDRESS RADIUS_IP [PORTAL_URL]
#

set -e
set -o pipefail 2>/dev/null || true

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Safe timeout wrapper (supports BusyBox or GNU timeout; no-op if unavailable)
with_timeout() {
  local seconds="${1:-3}"
  shift
  if command -v timeout >/dev/null 2>&1; then
    # Detect BusyBox vs GNU timeout syntax
    if timeout --help 2>&1 | grep -qi busybox; then
      timeout -t "$seconds" "$@"
    else
      timeout "$seconds" "$@"
    fi
  else
    "$@"
  fi
}

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
  echo -e "${RED}Error: This script must be run as root${NC}"
  exit 1
fi

# Parse arguments
if [ "$#" -lt 4 ] || [ "$#" -gt 5 ]; then
    echo "Usage: $0 ROUTER_ID RADIUS_SECRET MAC_ADDRESS RADIUS_IP [PORTAL_URL]"
    echo ""
    echo "This script sets up CoovaChilli for SpotFi captive portal with RADIUS."
    echo "For WebSocket bridge (cloud monitoring), use: openwrt-setup-cloud.sh"
    echo ""
    echo "Arguments:"
    echo "  ROUTER_ID     - Router ID from SpotFi dashboard"
    echo "  RADIUS_SECRET - RADIUS secret from SpotFi dashboard"
    echo "  MAC_ADDRESS   - Router MAC address"
    echo "  RADIUS_IP     - RADIUS server IP address (required)"
    echo "  PORTAL_URL    - (Optional) Portal domain/URL (default: https://api.spotfi.com)"
    echo ""
    echo "Example:"
    echo "  $0 ROUTER_ID RADIUS_SECRET MAC_ADDRESS 192.168.1.100"
    echo "  $0 ROUTER_ID RADIUS_SECRET MAC_ADDRESS 192.168.1.100 https://server.example.com"
    echo ""
    exit 1
fi

ROUTER_ID="$1"
RADIUS_SECRET="$2"
MAC_ADDRESS="$3"
RADIUS_IP="$4"
PORTAL_URL="${5:-https://api.spotfi.com}"

# Validate RADIUS IP format and range
if ! echo "$RADIUS_IP" | grep -qE '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
    echo -e "${RED}Error: Invalid IP address format: $RADIUS_IP${NC}"
    echo -e "${RED}RADIUS requires a valid IPv4 address.${NC}"
    exit 1
fi

for octet in $(echo "$RADIUS_IP" | tr '.' ' '); do
    if [ "$octet" -lt 0 ] || [ "$octet" -gt 255 ]; then
        echo -e "${RED}Error: Invalid IP address range: $RADIUS_IP${NC}"
        echo -e "${RED}Each octet must be between 0 and 255.${NC}"
        exit 1
    fi
done

# Extract portal domain (always uses HTTPS on port 443)
# Remove protocol, port, and path from URL
PORTAL_DOMAIN=$(echo "$PORTAL_URL" | sed 's|^https\?://||' | sed 's|:.*||' | sed 's|/.*||')

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}SpotFi CoovaChilli Setup${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Router ID: $ROUTER_ID"
echo "RADIUS Server: $RADIUS_IP"
echo "MAC Address: $MAC_ADDRESS"
echo "RADIUS Secret: $RADIUS_SECRET"
echo "Portal: https://$PORTAL_DOMAIN/portal"
echo ""

TOTAL_STEPS=7

# Step 1: Update package list
STEP_NUM=1
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Updating package list...${NC}"
opkg update

# Step 2: Install CoovaChilli
STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Installing CoovaChilli...${NC}"

# Check package availability
check_package() {
    if opkg list | grep -q "^$1 "; then
        return 0
    else
        return 1
    fi
}

# Install CoovaChilli
if check_package coova-chilli; then
    opkg install coova-chilli || {
        echo -e "${RED}Error: Failed to install coova-chilli${NC}"
        exit 1
    }
else
    echo -e "${RED}Error: coova-chilli not available in package repository${NC}"
    echo -e "${YELLOW}Please check your package repositories or install manually${NC}"
    exit 1
fi

# Verify installation
if ! command -v chilli >/dev/null 2>&1 && [ ! -f /usr/sbin/chilli ]; then
    echo -e "${RED}Error: chilli command not found after installation${NC}"
    exit 1
fi

# Check for openssl (needed for secret generation)
if ! command -v openssl >/dev/null 2>&1; then
    echo -e "${YELLOW}Warning: openssl not found, installing...${NC}"
    if check_package openssl-util; then
        opkg install openssl-util || {
            echo -e "${RED}Error: Failed to install openssl-util${NC}"
            exit 1
        }
    else
        echo -e "${RED}Error: openssl not available and required for secret generation${NC}"
        exit 1
    fi
fi

echo -e "${GREEN}✓ CoovaChilli installed${NC}"

# Step 3: Configure CoovaChilli
STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Configuring CoovaChilli...${NC}"

if [ -f /etc/chilli/config ]; then
    cp /etc/chilli/config /etc/chilli/config.backup.$(date +%Y%m%d_%H%M%S)
fi

# Function to list all available network interfaces
list_available_interfaces() {
    # Try /sys/class/net first (most reliable on OpenWRT)
    if [ -d /sys/class/net ]; then
        ls /sys/class/net 2>/dev/null | grep -v "^lo$" | grep -v "^lo:"
    # Fallback to ip link
    elif command -v ip >/dev/null 2>&1; then
        ip link show 2>/dev/null | awk -F': ' '/^[0-9]+:/ && $2 != "lo" {print $2}'
    # Fallback to ifconfig
    elif command -v ifconfig >/dev/null 2>&1; then
        ifconfig 2>/dev/null | awk '/^[a-z]/ && $1 != "lo:" {print $1}' | sed 's/:$//'
    fi
}

# Function to check if interface exists on system
interface_exists() {
    local iface="$1"
    if [ -z "$iface" ]; then
        return 1
    fi
    # Check if interface exists in /sys/class/net
    [ -d "/sys/class/net/$iface" ] || {
        # Fallback: check with ip link
        ip link show "$iface" >/dev/null 2>&1
    }
}

# Function to get first available physical interface
get_first_available_interface() {
    local interfaces
    interfaces=$(list_available_interfaces)
    if [ -n "$interfaces" ]; then
        # Filter out virtual interfaces (bridges, VLANs) and prefer eth* or enp* style
        for iface in $interfaces; do
            # Skip loopback, bridges starting with br-, and VLAN interfaces
            case "$iface" in
                lo|lo:*|br-*|br:*|veth*|docker*|*.@*)
                    continue
                    ;;
            esac
            # Prefer interfaces that match common physical interface patterns
            if echo "$iface" | grep -qE '^(eth|enp|ens|enx|wlan|wl)[0-9]'; then
                echo "$iface"
                return 0
            fi
        done
        # If no preferred interface found, return first non-virtual interface
        for iface in $interfaces; do
            case "$iface" in
                lo|lo:*|br-*|br:*|veth*|docker*|*.@*)
                    continue
                    ;;
                *)
                    echo "$iface"
                    return 0
                    ;;
            esac
        done
    fi
    return 1
}

# Detect network interfaces with multiple fallbacks and validation
echo -e "${YELLOW}Detecting network interfaces...${NC}"

# WAN interface detection with validation
WAN_IF=""
# Method 1: DSA-aware via ubus/ifstatus + jsonfilter
if [ -z "$WAN_IF" ] && command -v ubus >/dev/null 2>&1 && command -v jsonfilter >/dev/null 2>&1; then
    WAN_IF=$(with_timeout 3 ubus call network.interface.wan status 2>/dev/null \
        | with_timeout 2 jsonfilter -e '@.l3_device' -e '@.device' 2>/dev/null | head -n1 || echo "")
    if [ -n "$WAN_IF" ] && ! interface_exists "$WAN_IF"; then
        WAN_IF=""
    fi
fi

# Method 2: ifstatus + jsonfilter
if [ -z "$WAN_IF" ] && command -v ifstatus >/dev/null 2>&1 && command -v jsonfilter >/dev/null 2>&1; then
    WAN_IF=$(with_timeout 3 ifstatus wan 2>/dev/null \
        | with_timeout 2 jsonfilter -e '@.l3_device' -e '@.device' 2>/dev/null | head -n1 || echo "")
    if [ -n "$WAN_IF" ] && ! interface_exists "$WAN_IF"; then
        WAN_IF=""
    fi
fi

# Method 3: Default route interface (reliable)
if [ -z "$WAN_IF" ]; then
    WAN_IF=$(with_timeout 2 ip -4 route show default 2>/dev/null | awk '/default/ {print $5; exit}')
    if [ -n "$WAN_IF" ] && ! interface_exists "$WAN_IF"; then
        WAN_IF=""
    fi
fi

# Final check
if [ -z "$WAN_IF" ]; then
    echo -e "${RED}Error: Could not detect WAN interface via ubus/ifstatus/ip${NC}"
    echo -e "${YELLOW}Available interfaces:${NC}"
    list_available_interfaces | while read -r iface; do
        echo "    - $iface"
    done
    exit 1
fi

# Validate WAN interface exists
if ! interface_exists "$WAN_IF"; then
    echo -e "${RED}Error: Detected WAN interface '$WAN_IF' does not exist on this system${NC}"
    echo -e "${YELLOW}Available interfaces:${NC}"
    list_available_interfaces | while read -r iface; do
        echo "    - $iface"
    done
    exit 1
fi

# LAN/WiFi interface detection (for VMs without WiFi, will use LAN bridge)
WIFI_IF=""
HAS_WIRELESS=false

# Method 1: Try iw first (for wireless interfaces)
if command -v iw >/dev/null 2>&1; then
    # Guard against buggy/slow drivers by timing out quickly
    WIFI_IF=$(with_timeout 2 iw dev 2>/dev/null | awk '/Interface/ {print $2; exit}')
    if [ -n "$WIFI_IF" ] && interface_exists "$WIFI_IF"; then
        HAS_WIRELESS=true
    else
        WIFI_IF=""
    fi
fi

# Method 2: DSA-aware LAN device then bridges
LAN_DEV=""
if [ -z "$WIFI_IF" ]; then
    # Prefer DSA device
    LAN_DEV=$(with_timeout 2 uci get network.lan.device 2>/dev/null || echo "")
    if [ -z "$LAN_DEV" ]; then
        # Any bridge device available
        LAN_DEV=$(with_timeout 2 ip -br link show type bridge 2>/dev/null | awk '{print $1; exit}')
    fi
fi

# Method 3: Try UCI wireless config for explicit ifname (legacy)
if [ -z "$WIFI_IF" ]; then
    WIFI_IF=$(with_timeout 2 uci show wireless 2>/dev/null | grep -m1 "\.ifname=" | cut -d= -f2 | tr -d "'\"" || echo "")
    if [ -n "$WIFI_IF" ] && interface_exists "$WIFI_IF"; then
        HAS_WIRELESS=true
    else
        WIFI_IF=""
    fi
fi

# Method 4: Look for wlan* interfaces
if [ -z "$WIFI_IF" ]; then
    for iface in $(list_available_interfaces); do
        if echo "$iface" | grep -qE '^wlan[0-9]'; then
            if interface_exists "$iface"; then
                WIFI_IF="$iface"
                HAS_WIRELESS=true
                break
            fi
        fi
    done
fi

# Method 5: Use LAN bridge/device if no WiFi (VM scenario)
if [ -z "$WIFI_IF" ]; then
    # If DSA LAN device/bridge was found and exists, use that
    if [ -n "$LAN_DEV" ] && interface_exists "$LAN_DEV"; then
        WIFI_IF="$LAN_DEV"
    else
        echo -e "${RED}Error: Could not detect LAN/WiFi interface for CoovaChilli${NC}"
        echo -e "${YELLOW}Available interfaces:${NC}"
        list_available_interfaces | while read -r iface; do
            echo "    - $iface"
        done
        exit 1
    fi

    if [ "$HAS_WIRELESS" != "true" ]; then
        echo -e "${YELLOW}  Note: No WiFi detected (VM detected), using LAN bridge: $WIFI_IF${NC}"
    fi
fi

# Validate LAN/WiFi interface exists
if ! interface_exists "$WIFI_IF"; then
    echo -e "${RED}Error: Detected LAN/WiFi interface '$WIFI_IF' does not exist on this system${NC}"
    echo -e "${YELLOW}Available interfaces:${NC}"
    list_available_interfaces | while read -r iface; do
        echo "    - $iface"
    done
    exit 1
fi

echo "  - Detected WAN interface: $WAN_IF"
echo "  - Detected LAN/WiFi interface: $WIFI_IF"

# Validate configuration before writing
if [ -z "$RADIUS_IP" ] || [ -z "$RADIUS_SECRET" ] || [ -z "$ROUTER_ID" ]; then
    echo -e "${RED}Error: Missing required configuration values${NC}"
    exit 1
fi

cat > /etc/chilli/config << EOF
# SpotFi CoovaChilli Configuration

# Network Configuration
HS_WANIF=$WAN_IF
HS_LANIF=$WIFI_IF
HS_NETWORK=10.1.0.0
HS_NETMASK=255.255.255.0
HS_UAMLISTEN=10.1.0.1
HS_UAMPORT=3990

# DNS Servers
HS_DNS1=8.8.8.8
HS_DNS2=8.8.4.4

# RADIUS Configuration
HS_RADIUS=$RADIUS_IP
HS_RADSECRET=$RADIUS_SECRET
HS_RADAUTH=1812
HS_RADACCT=1813

# NAS Identifier
HS_NASID=$ROUTER_ID
HS_NASMAC=$MAC_ADDRESS

# Portal Configuration
HS_UAMSERVER=https://$PORTAL_DOMAIN/portal
HS_UAMHOMEPAGE=http://www.google.com
HS_UAMSECRET=$(openssl rand -hex 16 2>/dev/null || echo "changeme123456789012345678901234567890")

# Allowed domains/IPs
HS_UAMALLOW=$PORTAL_DOMAIN

# Session settings
HS_DEFIDLETIMEOUT=3600
HS_DEFSESSIONTIMEOUT=0

# Logging
HS_REDIR=on
HS_DEBUG=1
EOF

# Validate config file was created
if [ ! -f /etc/chilli/config ]; then
    echo -e "${RED}Error: Failed to create /etc/chilli/config${NC}"
    exit 1
fi

echo -e "${GREEN}✓ CoovaChilli configured${NC}"

# Step 4: Configure network
STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Configuring network interfaces...${NC}"

# Add hotspot interface if it doesn't exist
if ! uci show network.hotspot >/dev/null 2>&1; then
    uci set network.hotspot=interface
    uci set network.hotspot.proto='static'
    uci set network.hotspot.ipaddr='10.1.0.1'
    uci set network.hotspot.netmask='255.255.255.0'
    
    # Commit network configuration with validation
    if uci commit network; then
        # Validate commit succeeded by checking if hotspot interface exists
        if uci show network.hotspot >/dev/null 2>&1; then
            echo "  - Network configuration committed successfully"
        else
            echo -e "${RED}Error: Network configuration committed but not saved correctly${NC}"
            echo -e "${YELLOW}Attempting to revert changes...${NC}"
            uci revert network 2>/dev/null || true
            exit 1
        fi
    else
        echo -e "${RED}Error: Failed to commit network configuration${NC}"
        echo -e "${YELLOW}Attempting to revert changes...${NC}"
        uci revert network 2>/dev/null || true
        exit 1
    fi
else
    echo "  - Hotspot interface already exists, skipping creation"
fi

echo -e "${GREEN}✓ Network configured${NC}"

# Step 5: Configure WiFi (skipped in VMs without WiFi)
STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Configuring WiFi...${NC}"

RADIO=$(uci show wireless 2>/dev/null | grep "=wifi-device" | head -n1 | cut -d. -f2 | cut -d= -f1)

if [ -n "$RADIO" ]; then
    # Check if interface already exists to avoid duplicates
    IFACE="${RADIO}_spotfi"
    if uci show wireless.$IFACE >/dev/null 2>&1; then
        echo "  - WiFi interface already exists, updating..."
    else
        uci set wireless.$IFACE=wifi-iface
    fi
    
    uci set wireless.$RADIO.disabled='0'
    uci set wireless.$RADIO.channel='6'
    uci set wireless.$IFACE.device="$RADIO"
    uci set wireless.$IFACE.network='hotspot'
    uci set wireless.$IFACE.mode='ap'
    uci set wireless.$IFACE.ssid='SpotFi-Guest'
    uci set wireless.$IFACE.encryption='none'
    
    # Commit wireless configuration with validation
    if uci commit wireless; then
        # Validate commit succeeded by checking if configuration exists
        if uci show wireless.$IFACE >/dev/null 2>&1; then
            echo -e "${GREEN}✓ WiFi configured (SSID: SpotFi-Guest)${NC}"
        else
            echo -e "${YELLOW}Warning: Wireless configuration committed but may not be saved correctly${NC}"
        fi
    else
        echo -e "${YELLOW}Warning: Failed to commit wireless configuration${NC}"
        echo -e "${YELLOW}  WiFi may not work, but CoovaChilli will use LAN bridge instead${NC}"
        # Don't exit - WiFi is optional, especially in VMs
    fi
else
    echo -e "${YELLOW}⚠ Could not find WiFi radio, skipping WiFi configuration${NC}"
    echo -e "${YELLOW}  Note: If running in VM, this is normal. CoovaChilli will use LAN bridge.${NC}"
fi

# Step 6: Configure firewall
STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Configuring firewall...${NC}"

# Function to check if firewall zone exists
check_firewall_zone_exists() {
    local zone_name="$1"
    
    # Method 1: Use UCI to get all zones and check names
    local zones
    zones=$(uci show firewall 2>/dev/null | grep -E "^firewall\.@zone\[[0-9]+\]\.name=" | cut -d= -f2 | tr -d "'\"")
    
    if echo "$zones" | grep -qx "$zone_name"; then
        return 0  # Zone exists
    fi
    
    # Method 2: Try to get zone by name directly
    local zone_id
    zone_id=$(uci get firewall.@zone[0] 2>/dev/null | grep -E "\.name\s*=\s*['\"]?$zone_name['\"]?" 2>/dev/null)
    if [ -n "$zone_id" ]; then
        return 0
    fi
    
    # Method 3: Iterate through all zone indices (more reliable)
    local i=0
    while true; do
        local zone_name_check
        zone_name_check=$(uci get "firewall.@zone[$i].name" 2>/dev/null || echo "")
        if [ -z "$zone_name_check" ]; then
            break  # No more zones
        fi
        if [ "$zone_name_check" = "$zone_name" ]; then
            return 0  # Zone found
        fi
        i=$((i + 1))
    done
    
    return 1  # Zone does not exist
}

# Function to check if firewall rule exists
check_firewall_rule_exists() {
    local rule_name="$1"
    
    # Get all rule names
    local rules
    rules=$(uci show firewall 2>/dev/null | grep -E "^firewall\.@rule\[[0-9]+\]\.name=" | cut -d= -f2 | tr -d "'\"")
    
    if echo "$rules" | grep -qx "$rule_name"; then
        return 0  # Rule exists
    fi
    
    # Check by iterating through all rule indices
    local i=0
    while true; do
        local rule_name_check
        rule_name_check=$(uci get "firewall.@rule[$i].name" 2>/dev/null || echo "")
        if [ -z "$rule_name_check" ]; then
            break  # No more rules
        fi
        if [ "$rule_name_check" = "$rule_name" ]; then
            return 0  # Rule found
        fi
        i=$((i + 1))
    done
    
    return 1  # Rule does not exist
}

# Check if firewall zone exists
FIREWALL_ZONE_EXISTS=false
if check_firewall_zone_exists "hotspot"; then
    FIREWALL_ZONE_EXISTS=true
    echo "  - Firewall hotspot zone already exists"
fi

# Check if firewall forwarding rule exists
FIREWALL_FORWARDING_EXISTS=false
FORWARDING_COUNT=$(uci show firewall 2>/dev/null | grep -E "^firewall\.@forwarding\[[0-9]+\]\.src=" | wc -l)
if [ "$FORWARDING_COUNT" -gt 0 ]; then
    # Check if hotspot->wan forwarding exists
    i=0
    while true; do
        src=$(uci get "firewall.@forwarding[$i].src" 2>/dev/null || echo "")
        dest=$(uci get "firewall.@forwarding[$i].dest" 2>/dev/null || echo "")
        if [ -z "$src" ]; then
            break
        fi
        if [ "$src" = "hotspot" ] && [ "$dest" = "wan" ]; then
            FIREWALL_FORWARDING_EXISTS=true
            break
        fi
        i=$((i + 1))
    done
fi

if [ "$FIREWALL_ZONE_EXISTS" = "false" ]; then
    echo "  - Creating firewall hotspot zone..."
    uci add firewall zone
    uci set firewall.@zone[-1].name='hotspot'
    uci set firewall.@zone[-1].input='REJECT'
    uci set firewall.@zone[-1].output='ACCEPT'
    uci set firewall.@zone[-1].forward='REJECT'
    uci set firewall.@zone[-1].network='hotspot'
fi

# Add forwarding rule if it doesn't exist
if [ "$FIREWALL_FORWARDING_EXISTS" = "false" ]; then
    echo "  - Creating firewall forwarding rule (hotspot -> wan)..."
    uci add firewall forwarding
    uci set firewall.@forwarding[-1].src='hotspot'
    uci set firewall.@forwarding[-1].dest='wan'
fi

# Add RADIUS authentication rule if it doesn't exist
if ! check_firewall_rule_exists "Allow-RADIUS-Auth"; then
    echo "  - Creating firewall rule for RADIUS authentication (port 1812)..."
    uci add firewall rule
    uci set firewall.@rule[-1].name='Allow-RADIUS-Auth'
    uci set firewall.@rule[-1].src='wan'
    uci set firewall.@rule[-1].dest_port='1812'
    uci set firewall.@rule[-1].proto='udp'
    uci set firewall.@rule[-1].target='ACCEPT'
else
    echo "  - Firewall rule 'Allow-RADIUS-Auth' already exists, skipping"
fi

# Add RADIUS accounting rule if it doesn't exist
if ! check_firewall_rule_exists "Allow-RADIUS-Acct"; then
    echo "  - Creating firewall rule for RADIUS accounting (port 1813)..."
    uci add firewall rule
    uci set firewall.@rule[-1].name='Allow-RADIUS-Acct'
    uci set firewall.@rule[-1].src='wan'
    uci set firewall.@rule[-1].dest_port='1813'
    uci set firewall.@rule[-1].proto='udp'
    uci set firewall.@rule[-1].target='ACCEPT'
else
    echo "  - Firewall rule 'Allow-RADIUS-Acct' already exists, skipping"
fi

# Commit firewall configuration with validation (only if changes were made)
if [ "$FIREWALL_ZONE_EXISTS" = "false" ] || [ "$FIREWALL_FORWARDING_EXISTS" = "false" ] || \
   ! check_firewall_rule_exists "Allow-RADIUS-Auth" || ! check_firewall_rule_exists "Allow-RADIUS-Acct"; then
    # Commit firewall configuration with validation
    if uci commit firewall; then
        # Validate commit succeeded by checking if hotspot zone exists
        if check_firewall_zone_exists "hotspot"; then
            echo "  - Firewall configuration committed successfully"
        else
            echo -e "${YELLOW}Warning: Firewall configuration committed but may not be saved correctly${NC}"
            echo -e "${YELLOW}  Attempting rollback and retry...${NC}"
            # Try to rollback and retry
            uci revert firewall 2>/dev/null || true
            echo -e "${RED}Error: Failed to commit firewall configuration${NC}"
            echo -e "${YELLOW}You may need to configure firewall manually${NC}"
            exit 1
        fi
    else
        echo -e "${RED}Error: Failed to commit firewall configuration${NC}"
        echo -e "${YELLOW}Attempting to revert changes...${NC}"
        uci revert firewall 2>/dev/null || true
        echo -e "${RED}Firewall configuration failed. Please check UCI configuration manually${NC}"
        exit 1
    fi
else
    echo "  - All firewall rules already configured, no changes needed"
fi

echo -e "${GREEN}✓ Firewall configured${NC}"

# Step 7: Enable and start services
STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Starting services...${NC}"

# Validate chilli init script exists
if [ ! -f /etc/init.d/chilli ]; then
    echo -e "${RED}Error: /etc/init.d/chilli not found${NC}"
    exit 1
fi

/etc/init.d/chilli enable

# Restart network and firewall with error handling
/etc/init.d/network restart || {
    echo -e "${YELLOW}Warning: Network restart may have failed${NC}"
}
sleep 3

/etc/init.d/firewall restart || {
    echo -e "${YELLOW}Warning: Firewall restart may have failed${NC}"
}
sleep 2

/etc/init.d/chilli restart || {
    echo -e "${RED}Error: Failed to start chilli service${NC}"
    echo -e "${YELLOW}Check logs with: logread | grep chilli${NC}"
    exit 1
}

echo -e "${GREEN}✓ Services started${NC}"

# Final status check
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Setup Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "CoovaChilli Status:"
echo "  - Router ID: $ROUTER_ID"
echo "  - RADIUS Server: $RADIUS_IP"
echo "  - Portal: https://$PORTAL_DOMAIN/portal"
if [ "$HAS_WIRELESS" = "true" ]; then
    echo "  - WiFi SSID: SpotFi-Guest"
else
    echo "  - WiFi: Not available (VM detected, using LAN bridge)"
fi
echo "  - Gateway: 10.1.0.1"
echo ""
echo "Verification:"
echo "  1. Check CoovaChilli: /etc/init.d/chilli status"
echo "  2. Check active users: chilli_query list"
echo "  3. View logs: logread -f"
echo ""

