#!/bin/bash
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

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

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

# Detect network interfaces with multiple fallbacks
# WAN interface detection
WAN_IF=$(uci get network.wan.ifname 2>/dev/null || \
    uci get network.wan.device 2>/dev/null || \
    ip route show default 2>/dev/null | awk '/default/ {print $5; exit}' || \
    ip -4 route show default 2>/dev/null | head -n1 | awk '{print $5}' || \
    echo "eth1")

# LAN/WiFi interface detection
WIFI_IF=""
# Try iw first (for wireless interfaces)
if command -v iw >/dev/null 2>&1; then
    WIFI_IF=$(iw dev 2>/dev/null | awk '/Interface/ {print $2; exit}')
fi

# If no wireless interface found, try UCI wireless config
if [ -z "$WIFI_IF" ]; then
    WIFI_IF=$(uci show wireless 2>/dev/null | grep -m1 "\.ifname=" | cut -d= -f2 | tr -d "'\"")
fi

# If still not found, try LAN bridge
if [ -z "$WIFI_IF" ]; then
    WIFI_IF=$(uci get network.lan.ifname 2>/dev/null || echo "br-lan")
fi

# Final fallback
if [ -z "$WIFI_IF" ]; then
    WIFI_IF="wlan0"
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
    uci commit network || {
        echo -e "${RED}Error: Failed to commit network configuration${NC}"
        exit 1
    }
else
    echo "  - Hotspot interface already exists, skipping creation"
fi

echo -e "${GREEN}✓ Network configured${NC}"

# Step 5: Configure WiFi
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
    
    uci commit wireless || {
        echo -e "${YELLOW}Warning: Failed to commit wireless configuration${NC}"
    }
    echo -e "${GREEN}✓ WiFi configured (SSID: SpotFi-Guest)${NC}"
else
    echo -e "${YELLOW}⚠ Could not find WiFi radio, skipping WiFi configuration${NC}"
fi

# Step 6: Configure firewall
STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Configuring firewall...${NC}"

# Check if firewall zone exists (multiple ways to check)
FIREWALL_ZONE_EXISTS=false
if uci show firewall | grep -q "name='hotspot'"; then
    FIREWALL_ZONE_EXISTS=true
elif uci show firewall 2>/dev/null | grep -q "\.name='hotspot'"; then
    FIREWALL_ZONE_EXISTS=true
elif uci get firewall.@zone[0].name 2>/dev/null | grep -q hotspot; then
    FIREWALL_ZONE_EXISTS=true
fi

if [ "$FIREWALL_ZONE_EXISTS" = "false" ]; then
    uci add firewall zone
    uci set firewall.@zone[-1].name='hotspot'
    uci set firewall.@zone[-1].input='REJECT'
    uci set firewall.@zone[-1].output='ACCEPT'
    uci set firewall.@zone[-1].forward='REJECT'
    uci set firewall.@zone[-1].network='hotspot'
    
    uci add firewall forwarding
    uci set firewall.@forwarding[-1].src='hotspot'
    uci set firewall.@forwarding[-1].dest='wan'
    
    uci add firewall rule
    uci set firewall.@rule[-1].name='Allow-RADIUS-Auth'
    uci set firewall.@rule[-1].src='wan'
    uci set firewall.@rule[-1].dest_port='1812'
    uci set firewall.@rule[-1].proto='udp'
    uci set firewall.@rule[-1].target='ACCEPT'
    
    uci add firewall rule
    uci set firewall.@rule[-1].name='Allow-RADIUS-Acct'
    uci set firewall.@rule[-1].src='wan'
    uci set firewall.@rule[-1].dest_port='1813'
    uci set firewall.@rule[-1].proto='udp'
    uci set firewall.@rule[-1].target='ACCEPT'
    
    uci commit firewall || {
        echo -e "${YELLOW}Warning: Failed to commit firewall configuration${NC}"
    }
else
    echo "  - Firewall hotspot zone already exists, skipping creation"
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
echo "  - WiFi SSID: SpotFi-Guest"
echo "  - Gateway: 10.1.0.1"
echo ""
echo "Verification:"
echo "  1. Check CoovaChilli: /etc/init.d/chilli status"
echo "  2. Check active users: chilli_query list"
echo "  3. View logs: logread -f"
echo ""

