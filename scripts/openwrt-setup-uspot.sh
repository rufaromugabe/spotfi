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
set -o pipefail 2>/dev/null || true

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

with_timeout() {
  local seconds="${1:-3}"
  shift
  if command -v timeout >/dev/null 2>&1; then
    if timeout --help 2>&1 | grep -qi busybox; then
      timeout -t "$seconds" "$@"
      return $?
    else
      timeout "$seconds" "$@"
      return $?
    fi
  fi
  # Fallback: manual timeout using subshell and kill
  (
    "$@" &
    cmd_pid=$!
    (
      sleep "$seconds"
      kill -0 "$cmd_pid" 2>/dev/null && kill -TERM "$cmd_pid" 2>/dev/null
    ) &
    timer_pid=$!
    wait "$cmd_pid"
    status=$?
    kill "$timer_pid" 2>/dev/null || true
    exit $status
  )
}

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
echo "RADIUS Secret: $RADIUS_SECRET"
echo "Portal: https://$PORTAL_DOMAIN/portal"
echo ""

TOTAL_STEPS=6

STEP_NUM=1
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Updating package list...${NC}"
opkg update

STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Installing Uspot and dependencies...${NC}"
opkg install uspot uhttpd jsonfilter ca-bundle ca-certificates || {
  echo -e "${RED}Error: Failed to install uspot or deps${NC}"
  exit 1
}
command -v openssl >/dev/null 2>&1 || opkg install openssl-util >/dev/null 2>&1 || true

list_available_interfaces() {
  if [ -d /sys/class/net ]; then
    ls /sys/class/net 2>/dev/null | grep -v "^lo$" | grep -v "^lo:"
  elif command -v ip >/dev/null 2>&1; then
    ip link show 2>/dev/null | awk -F': ' '/^[0-9]+:/ && $2 != "lo" {print $2}'
  fi
}
interface_exists() {
  local iface="$1"
  [ -n "$iface" ] || return 1
  [ -d "/sys/class/net/$iface" ] || ip link show "$iface" >/dev/null 2>&1
}

echo -e "${YELLOW}Detecting network interfaces...${NC}"
# Allow override via environment variables: WAN_IF and WIFI_IF (validated below)
# If not provided, they will be detected.
WAN_IF="${WAN_IF:-}"
if [ -n "$WAN_IF" ]; then
  if ! interface_exists "$WAN_IF"; then
    echo -e "${RED}Error: Provided WAN_IF '$WAN_IF' does not exist${NC}"
    exit 1
  fi
else
  if command -v ubus >/dev/null 2>&1 && command -v jsonfilter >/dev/null 2>&1; then
  WAN_IF=$(with_timeout 2 ubus call network.interface.wan status 2>/dev/null \
    | with_timeout 1 jsonfilter -e '@.l3_device' -e '@.device' 2>/dev/null | head -n1 || echo "")
  [ -n "$WAN_IF" ] && interface_exists "$WAN_IF" || WAN_IF=""
fi
fi
if [ -z "$WAN_IF" ] && command -v ifstatus >/dev/null 2>&1 && command -v jsonfilter >/dev/null 2>&1; then
  WAN_IF=$(with_timeout 2 ifstatus wan 2>/dev/null \
    | with_timeout 1 jsonfilter -e '@.l3_device' -e '@.device' 2>/dev/null | head -n1 || echo "")
  [ -n "$WAN_IF" ] && interface_exists "$WAN_IF" || WAN_IF=""
fi
if [ -z "$WAN_IF" ]; then
  WAN_IF=$(with_timeout 1 ip -4 route show default 2>/dev/null | awk '/default/ {print $5; exit}')
  [ -n "$WAN_IF" ] && interface_exists "$WAN_IF" || WAN_IF=""
fi
if [ -z "$WAN_IF" ]; then
  echo -e "${RED}Error: Could not detect WAN interface${NC}"
  list_available_interfaces | sed 's/^/  - /'
  exit 1
fi

WIFI_IF="${WIFI_IF:-}"
HAS_WIRELESS=false
if [ -z "$WIFI_IF" ] && command -v iw >/dev/null 2>&1; then
  WIFI_IF=$(with_timeout 1 iw dev 2>/dev/null | awk '/Interface/ {print $2; exit}')
  if [ -n "$WIFI_IF" ] && interface_exists "$WIFI_IF"; then
    HAS_WIRELESS=true
  else
    WIFI_IF=""
  fi
fi
LAN_DEV=""
if [ -z "$WIFI_IF" ]; then
  LAN_DEV=$(with_timeout 1 uci get network.lan.device 2>/dev/null || echo "")
  [ -z "$LAN_DEV" ] && LAN_DEV=$(with_timeout 1 ip -br link show type bridge 2>/dev/null | awk '{print $1; exit}')
fi
if [ -z "$WIFI_IF" ]; then
  if [ -n "$LAN_DEV" ] && interface_exists "$LAN_DEV"; then
    WIFI_IF="$LAN_DEV"
  else
    echo -e "${RED}Error: Could not detect LAN/WiFi interface for Uspot${NC}"
    list_available_interfaces | sed 's/^/  - /'
    exit 1
  fi
fi
if [ -n "$WIFI_IF" ] && ! interface_exists "$WIFI_IF"; then
  echo -e "${RED}Error: Provided WIFI_IF '$WIFI_IF' does not exist${NC}"
  exit 1
fi
echo "  - Detected WAN interface: $WAN_IF"
echo "  - Detected LAN/WiFi interface: $WIFI_IF"

STEP_NUM=$((STEP_NUM + 1)); echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Configuring network interfaces...${NC}"
if ! uci show network.hotspot >/dev/null 2>&1; then
  uci set network.hotspot=interface
  uci set network.hotspot.proto='static'
  uci set network.hotspot.ipaddr='10.1.0.1'
  uci set network.hotspot.netmask='255.255.255.0'
  uci commit network
fi
echo -e "${GREEN}✓ Network configured${NC}"

STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Configuring Uspot...${NC}"
if [ -f /etc/config/uspot ]; then
  cp /etc/config/uspot /etc/config/uspot.backup.$(date +%Y%m%d_%H%M%S)
fi

# Global toggles (if supported)
uci -q set uspot.main=uspot
uci -q set uspot.main.enabled='1'

# Instance configuration – required keys: setname, interface, auth_mode
# Create/update a single instance named 'spotfi'
if ! uci show uspot 2>/dev/null | grep -q "=instance"; then
  uci -q add uspot instance >/dev/null
fi
uci -q set uspot.@instance[0].setname='spotfi'
uci -q set uspot.@instance[0].enabled='1'
uci -q set uspot.@instance[0].interface="$WIFI_IF"
uci -q set uspot.@instance[0].auth_mode='radius'
# Radius settings
uci -q set uspot.@instance[0].radius_auth_server="$RADIUS_IP"
uci -q set uspot.@instance[0].radius_acct_server="$RADIUS_IP"
uci -q set uspot.@instance[0].radius_secret="$RADIUS_SECRET"
uci -q set uspot.@instance[0].nas_id="$ROUTER_ID"
uci -q set uspot.@instance[0].mac_address="$MAC_ADDRESS"
# Portal
uci -q set uspot.@instance[0].portal_url="https://$PORTAL_DOMAIN/portal"
# Network hints (if supported)
uci -q set uspot.@instance[0].wan_if="$WAN_IF"
uci -q set uspot.@instance[0].lan_if="$WIFI_IF"
# Accounting interval (if supported)
uci -q set uspot.@instance[0].interim_update='300'
uci commit uspot || true
echo -e "${GREEN}✓ Uspot configured${NC}"

STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Configuring firewall...${NC}"
# hotspot zone and forwarding
if ! uci show firewall 2>/dev/null | grep -q "name='hotspot'"; then
  uci add firewall zone
  uci set firewall.@zone[-1].name='hotspot'
  uci set firewall.@zone[-1].input='REJECT'
  uci set firewall.@zone[-1].output='ACCEPT'
  uci set firewall.@zone[-1].forward='REJECT'
  uci set firewall.@zone[-1].network='hotspot'
fi
if ! uci show firewall 2>/dev/null | grep -q "@forwarding\\[.*\\].*src='hotspot'.*dest='wan'"; then
  uci add firewall forwarding
  uci set firewall.@forwarding[-1].src='hotspot'
  uci set firewall.@forwarding[-1].dest='wan'
fi
# Allow RADIUS auth/accounting outbound (explicit accept)
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
uci commit firewall
echo -e "${GREEN}✓ Firewall configured${NC}"

echo -e "${YELLOW}[${TOTAL_STEPS}/${TOTAL_STEPS}] Starting services...${NC}"
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
if [ "$HAS_WIRELESS" = "true" ]; then
  echo "  - WiFi SSID: SpotFi-Guest (if created elsewhere)"
else
  echo "  - WiFi: Not available (using LAN bridge)"
fi
echo "  - Gateway: 10.1.0.1"
echo ""
echo "Verification:"
echo "  1. Check Uspot: /etc/init.d/uspot status"
echo "  2. View logs: logread -f | grep -E 'uspot|radius'"
echo ""


