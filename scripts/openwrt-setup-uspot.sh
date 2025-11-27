#!/bin/sh
#
# SpotFi OpenWRT Uspot Installation Script
# 
# Installs packages and sets up basic network infrastructure
# UAM/RADIUS configuration is done via API after router connects
#
# Usage: ./openwrt-setup-uspot.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ "$EUID" -ne 0 ]; then 
  echo -e "${RED}Error: This script must be run as root${NC}"
  exit 1
fi

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}SpotFi Uspot Installation${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "This script installs packages and sets up basic infrastructure."
echo "UAM/RADIUS configuration will be done via API after router connects."
echo ""

TOTAL_STEPS=7
STEP_NUM=1

echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Updating package list...${NC}"
opkg update || {
  echo -e "${YELLOW}Warning: Package update failed, continuing anyway...${NC}"
}

STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Installing packages...${NC}"
opkg install uspot uhttpd jsonfilter ca-bundle ca-certificates || {
  echo -e "${RED}Error: Failed to install packages${NC}"
  exit 1
}
command -v openssl >/dev/null 2>&1 || opkg install openssl-util >/dev/null 2>&1 || true
echo -e "${GREEN}✓ Packages installed${NC}"

STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Configuring wireless...${NC}"
if uci show wireless >/dev/null 2>&1; then
  DEVICE_INDEX=0
  while uci get "wireless.@wifi-device[$DEVICE_INDEX]" >/dev/null 2>&1; do
    uci set "wireless.@wifi-device[$DEVICE_INDEX].disabled=0" 2>/dev/null || true
    DEVICE_INDEX=$((DEVICE_INDEX + 1))
  done

  IFACE_INDEX=0
  while uci get "wireless.@wifi-iface[$IFACE_INDEX]" >/dev/null 2>&1; do
    uci set "wireless.@wifi-iface[$IFACE_INDEX].network=lan" 2>/dev/null || true
    uci set "wireless.@wifi-iface[$IFACE_INDEX].mode=ap" 2>/dev/null || true
    IFACE_INDEX=$((IFACE_INDEX + 1))
  done

  uci commit wireless 2>/dev/null || true
  echo -e "${GREEN}✓ Wireless configured${NC}"
else
  echo -e "${YELLOW}No wireless configuration found (wired-only router)${NC}"
fi

STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Configuring network...${NC}"

if ! uci show network.lan >/dev/null 2>&1; then
  uci set network.lan=interface
fi
uci set network.lan.proto='static'
uci -q set network.lan.type='bridge' || true
uci -q set network.lan.ipaddr='192.168.1.1' || true
uci -q set network.lan.netmask='255.255.255.0' || true

BRIDGE_NAME=$(uci get network.lan.ifname 2>/dev/null | head -n1 | cut -d' ' -f1 || echo "br-lan")
if [ -z "$BRIDGE_NAME" ] || [ "$BRIDGE_NAME" = "br-lan" ]; then
  BRIDGE_NAME="br-lan"
fi

if ! uci show network.hotspot >/dev/null 2>&1; then
  uci set network.hotspot=interface
fi
uci set network.hotspot.proto='static'
uci set network.hotspot.ipaddr='10.1.30.1'
uci set network.hotspot.netmask='255.255.255.0'
uci set network.hotspot.device="$BRIDGE_NAME"

uci commit network
echo -e "${GREEN}✓ Network configured${NC}"

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

for port in 1812 1813 3799; do
  if ! uci show firewall 2>/dev/null | grep -q "name='Allow-RADIUS-$port'"; then
    uci add firewall rule
    uci set firewall.@rule[-1].name="Allow-RADIUS-$port"
    uci set firewall.@rule[-1].src='wan'
    uci set firewall.@rule[-1].dest_port="$port"
    uci set firewall.@rule[-1].proto='udp'
    uci set firewall.@rule[-1].target='ACCEPT'
  fi
done

uci commit firewall
echo -e "${GREEN}✓ Firewall configured${NC}"

STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Configuring HTTPS portal...${NC}"
if [ ! -f /etc/uhttpd.crt ] || [ ! -f /etc/uhttpd.key ]; then
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout /etc/uhttpd.key \
    -out /etc/uhttpd.crt \
    -subj "/C=US/ST=State/L=City/O=SpotFi/CN=router" 2>/dev/null || {
    echo -e "${YELLOW}Warning: Could not generate certificate${NC}"
  }
fi

uci -q set uhttpd.main.listen_https='443' || true
uci -q set uhttpd.main.cert='/etc/uhttpd.crt' || true
uci -q set uhttpd.main.key='/etc/uhttpd.key' || true
uci -q set uhttpd.main.redirect_https='0' || true
uci -q set uhttpd.main.listen_http="10.1.30.1:80" || true
uci commit uhttpd 2>/dev/null || true
echo -e "${GREEN}✓ HTTPS portal configured${NC}"

STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Starting services...${NC}"
/etc/init.d/network restart || true
sleep 2
/etc/init.d/firewall restart || true
sleep 2
[ -f /etc/init.d/wireless ] && /etc/init.d/wireless restart 2>/dev/null || true
/etc/init.d/uhttpd enable 2>/dev/null || true
/etc/init.d/uhttpd restart 2>/dev/null || true
echo -e "${GREEN}✓ Services started${NC}"

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Installation Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Next steps:"
echo "  1. Ensure router is connected to management backend via WebSocket bridge"
echo "  2. Configure UAM/RADIUS via API:"
echo "     POST /api/routers/:id/uam/configure"
echo ""
echo "Gateway: 10.1.30.1 (standard captive portal range)"
echo ""
