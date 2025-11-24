#!/bin/sh
#
# SpotFi OpenWRT Uspot Setup Script
# 
# This script configures Uspot captive portal with RADIUS authentication
# - Uspot installation and configuration
# - Hotspot network and WiFi setup
# - Firewall4 rules for portal and RADIUS
#
# Usage: ./openwrt-setup-uspot.sh ROUTER_ID RADIUS_SECRET MAC_ADDRESS RADIUS_IP [PORTAL_URL]
#

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ "$EUID" -ne 0 ]; then 
  echo -e "${RED}Error: This script must be run as root${NC}"
  exit 1
fi

if [ "$#" -lt 4 ] || [ "$#" -gt 5 ]; then
    echo "Usage: $0 ROUTER_ID RADIUS_SECRET MAC_ADDRESS RADIUS_IP [PORTAL_URL]"
    exit 1
fi

ROUTER_ID="$1"
RADIUS_SECRET="$2"
MAC_ADDRESS="$3"
RADIUS_IP="$4"
PORTAL_URL="${5:-https://api.spotfi.com}"

if ! echo "$RADIUS_IP" | grep -qE '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
    echo -e "${RED}Error: Invalid IP address format: $RADIUS_IP${NC}"
    exit 1
fi
for octet in $(echo "$RADIUS_IP" | tr '.' ' '); do
    if [ "$octet" -lt 0 ] || [ "$octet" -gt 255 ]; then
        echo -e "${RED}Error: Invalid IP address range: $RADIUS_IP${NC}"
        exit 1
    fi
done

PORTAL_DOMAIN=$(echo "$PORTAL_URL" | sed 's|^https\?://||' | sed 's|:.*||' | sed 's|/.*||')

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}SpotFi Uspot Setup${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Router ID: $ROUTER_ID"
echo "RADIUS Server: $RADIUS_IP"
echo "MAC Address: $MAC_ADDRESS"
echo "RADIUS Secret: (hidden)"
echo "Portal: https://$PORTAL_DOMAIN/portal"
echo ""

TOTAL_STEPS=9
STEP_NUM=1

echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Updating package list...${NC}"
opkg update

STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Installing Uspot and dependencies...${NC}"
opkg install uspot uhttpd jsonfilter ca-bundle ca-certificates || {
  echo -e "${RED}Error: Failed to install uspot or deps${NC}"
  exit 1
}
command -v openssl >/dev/null 2>&1 || opkg install openssl-util >/dev/null 2>&1

# Use br-lan bridge which includes all LAN interfaces (WiFi + Ethernet)
LAN_BRIDGE="br-lan"

STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Configuring network interfaces...${NC}"
HOTSPOT_NET_IF="hotspot"
if ! uci show network.hotspot >/dev/null 2>&1; then
  uci set network.hotspot=interface
  uci set network.hotspot.proto='static'
  uci set network.hotspot.ipaddr='192.168.56.10'
  uci set network.hotspot.netmask='255.255.255.0'
  uci set network.hotspot.device="$LAN_BRIDGE"
  uci commit network
fi
echo -e "${GREEN}✓ Network configured${NC}"

STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Configuring Uspot...${NC}"
if [ -f /etc/config/uspot ]; then
  cp /etc/config/uspot /etc/config/uspot.backup.$(date +%Y%m%d_%H%M%S)
fi

# Global settings
uci -q set uspot.main=uspot
uci -q set uspot.main.enabled='1'
uci -q set uspot.main.setname='spotfi'
uci -q set uspot.main.interface="$HOTSPOT_NET_IF"
uci -q set uspot.main.auth_mode='radius'
uci -q set uspot.main.auth_server="$RADIUS_IP"
uci -q set uspot.main.auth_secret="$RADIUS_SECRET"
uci -q set uspot.main.nasid="$ROUTER_ID"
uci -q set uspot.main.nasmac="$MAC_ADDRESS"

# Instance configuration
if ! uci show uspot 2>/dev/null | grep -q "=instance"; then
  uci -q add uspot instance >/dev/null
fi
uci -q set uspot.@instance[0].setname='spotfi'
uci -q set uspot.@instance[0].name='spotfi'
uci -q set uspot.@instance[0].enabled='1'
uci -q set uspot.@instance[0].interface="$HOTSPOT_NET_IF"
uci -q set uspot.@instance[0].ifname="$LAN_BRIDGE"
uci -q set uspot.@instance[0].auth_mode='radius'
uci -q set uspot.@instance[0].auth='radius'
uci -q set uspot.@instance[0].radius_auth_server="$RADIUS_IP"
uci -q set uspot.@instance[0].radius_acct_server="$RADIUS_IP"
uci -q set uspot.@instance[0].radius_secret="$RADIUS_SECRET"
uci -q set uspot.@instance[0].nas_id="$ROUTER_ID"
uci -q set uspot.@instance[0].mac_address="$MAC_ADDRESS"
uci -q set uspot.@instance[0].portal_url="https://$PORTAL_DOMAIN/portal"
uci -q set uspot.@instance[0].lan_if="$LAN_BRIDGE"
uci -q set uspot.@instance[0].interim_update='300'
# Session and idle timeouts (handled by RADIUS Session-Timeout attribute)
# These are defaults if RADIUS doesn't provide them
uci -q set uspot.@instance[0].session_timeout='7200'  # 2 hours default
uci -q set uspot.@instance[0].idle_timeout='600'       # 10 minutes idle timeout
uci commit uspot
echo -e "${GREEN}✓ Uspot configured${NC}"

STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Configuring firewall...${NC}"
if ! uci show firewall 2>/dev/null | grep -q "name='hotspot'"; then
  uci add firewall zone
  uci set firewall.@zone[-1].name='hotspot'
  uci set firewall.@zone[-1].input='REJECT'
  uci set firewall.@zone[-1].output='ACCEPT'
  uci set firewall.@zone[-1].forward='REJECT'
  uci set firewall.@zone[-1].network='hotspot'
fi

if ! uci show firewall 2>/dev/null | grep -q "src='hotspot'.*dest='wan'"; then
  uci add firewall forwarding
  uci set firewall.@forwarding[-1].src='hotspot'
  uci set firewall.@forwarding[-1].dest='wan'
fi

if ! uci show firewall 2>/dev/null | grep -q "name='Allow-RADIUS-Auth'"; then
  uci add firewall rule
  uci set firewall.@rule[-1].name='Allow-RADIUS-Auth'
  uci set firewall.@rule[-1].src='wan'
  uci set firewall.@rule[-1].dest_port='1812'
  uci set firewall.@rule[-1].proto='udp'
  uci set firewall.@rule[-1].target='ACCEPT'
fi
if ! uci show firewall 2>/dev/null | grep -q "name='Allow-RADIUS-Acct'"; then
  uci add firewall rule
  uci set firewall.@rule[-1].name='Allow-RADIUS-Acct'
  uci set firewall.@rule[-1].src='wan'
  uci set firewall.@rule[-1].dest_port='1813'
  uci set firewall.@rule[-1].proto='udp'
  uci set firewall.@rule[-1].target='ACCEPT'
fi
# RFC5176 DAE (Dynamic Authorization Extensions) - port 3799
if ! uci show firewall 2>/dev/null | grep -q "name='Allow-RADIUS-DAE'"; then
  uci add firewall rule
  uci set firewall.@rule[-1].name='Allow-RADIUS-DAE'
  uci set firewall.@rule[-1].src='wan'
  uci set firewall.@rule[-1].dest_port='3799'
  uci set firewall.@rule[-1].proto='udp'
  uci set firewall.@rule[-1].target='ACCEPT'
fi
uci commit firewall
echo -e "${GREEN}✓ Firewall configured${NC}"

STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Configuring DHCP for RFC8908 Captive Portal API...${NC}"
# Configure DHCP Option 114 for RFC8908 Captive Portal API support
# This allows modern devices (iOS, Android, Windows) to automatically detect the captive portal
if ! uci show dhcp 2>/dev/null | grep -q "name='captive'"; then
  uci set dhcp.captive=dhcp
  uci set dhcp.captive.interface='hotspot'
  uci set dhcp.captive.start='100'
  uci set dhcp.captive.limit='150'
  uci set dhcp.captive.leasetime='12h'
fi
# Add DHCP Option 114 (RFC8908 Captive Portal API URL)
# Remove existing option 114 if present
uci del_list dhcp.captive.dhcp_option="114,*" 2>/dev/null || true
uci add_list dhcp.captive.dhcp_option="114,https://$PORTAL_DOMAIN/api"
uci commit dhcp
echo -e "${GREEN}✓ DHCP configured with RFC8908 support${NC}"

STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Configuring HTTPS portal with TLS...${NC}"
# Configure uhttpd for HTTPS portal
# Generate self-signed certificate if not present
if [ ! -f /etc/uhttpd.crt ] || [ ! -f /etc/uhttpd.key ]; then
  echo "Generating self-signed certificate for HTTPS portal..."
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout /etc/uhttpd.key \
    -out /etc/uhttpd.crt \
    -subj "/C=US/ST=State/L=City/O=SpotFi/CN=$PORTAL_DOMAIN" 2>/dev/null || {
    echo -e "${YELLOW}Warning: Could not generate certificate. Install openssl-util if needed.${NC}"
  }
fi

# Configure uhttpd for HTTPS
uci -q set uhttpd.main.listen_https='443'
uci -q set uhttpd.main.cert='/etc/uhttpd.crt'
uci -q set uhttpd.main.key='/etc/uhttpd.key'
uci -q set uhttpd.main.redirect_https='0'  # Don't force redirect (uspot handles portal)

# Ensure uhttpd doesn't conflict on port 80 if uspot needs it
# Ensure 'uspot' uhttpd instance binds ONLY to the hotspot interface IP to prevent conflicts
# Add this optimization:
uci -q set uhttpd.main.listen_http="192.168.56.10:80"  # Bind strictly to gateway IP

uci commit uhttpd
echo -e "${GREEN}✓ HTTPS portal configured${NC}"

STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Configuring bandwidth control (ratelimit)...${NC}"
# Install ratelimit package for bandwidth control
opkg install ratelimit 2>/dev/null || {
  echo -e "${YELLOW}Note: ratelimit package not available. Bandwidth control via RADIUS attributes only.${NC}"
}

# Configure uspot to use bandwidth limits from RADIUS
# uspot reads WISPr-Bandwidth-Max-Up/Down or ChilliSpot-Max-Input-Octets/Output-Octets
# These are set via RADIUS Reply attributes in the database
uci -q set uspot.@instance[0].ratelimit='1'  # Enable rate limiting
uci commit uspot
echo -e "${GREEN}✓ Bandwidth control configured${NC}"

STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Starting services...${NC}"
/etc/init.d/network restart || true
sleep 2
/etc/init.d/firewall restart || true
sleep 2
/etc/init.d/uhttpd enable 2>/dev/null || true
/etc/init.d/uhttpd restart 2>/dev/null || true
/etc/init.d/uspot enable 2>/dev/null || true
/etc/init.d/uspot restart 2>/dev/null || true
echo -e "${GREEN}✓ Services started${NC}"

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Setup Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Uspot Status:"
echo "  - Router ID: $ROUTER_ID"
echo "  - RADIUS Server: $RADIUS_IP"
echo "  - Portal: https://$PORTAL_DOMAIN/portal"
echo "  - LAN Bridge: $LAN_BRIDGE (includes all LAN interfaces)"
echo "  - Gateway: 192.168.56.10"
echo ""
echo "Verification:"
echo "  1. Check Uspot: /etc/init.d/uspot status"
echo "  2. View logs: logread -f | grep -E 'uspot|radius'"
echo ""
