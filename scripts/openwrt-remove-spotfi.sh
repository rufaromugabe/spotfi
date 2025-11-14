#!/bin/bash
#
# SpotFi OpenWRT Complete Removal Script
# 
# This script removes all SpotFi components from an OpenWRT router:
# - SpotFi WebSocket bridge service and files
# - CoovaChilli configuration (if installed)
# - Network hotspot interface
# - Firewall hotspot zone and rules
# - Wireless SpotFi-Guest SSID
#
# Usage: ./openwrt-remove-spotfi.sh [--remove-chilli]
#
# Options:
#   --remove-chilli    Also remove CoovaChilli package (optional)

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

REMOVE_CHILLI=false
if [ "$1" = "--remove-chilli" ]; then
    REMOVE_CHILLI=true
fi

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}SpotFi Complete Removal${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# Step 1: Stop and disable SpotFi bridge service
echo -e "${YELLOW}[1/8] Stopping SpotFi bridge service...${NC}"
if [ -f /etc/init.d/spotfi-bridge ]; then
    /etc/init.d/spotfi-bridge stop 2>/dev/null || true
    /etc/init.d/spotfi-bridge disable 2>/dev/null || true
    echo -e "${GREEN}✓ SpotFi bridge service stopped and disabled${NC}"
else
    echo "  - SpotFi bridge service not found, skipping"
fi

# Kill any running bridge processes
if pgrep -f "bridge.py" >/dev/null 2>&1; then
    echo "  - Killing running bridge processes..."
    pkill -f "bridge.py" 2>/dev/null || true
    sleep 1
fi

# Step 2: Remove SpotFi bridge files
echo -e "${YELLOW}[2/8] Removing SpotFi bridge files...${NC}"
if [ -d /root/spotfi-bridge ]; then
    rm -rf /root/spotfi-bridge
    echo -e "${GREEN}✓ Bridge files removed${NC}"
else
    echo "  - Bridge directory not found, skipping"
fi

# Step 3: Remove SpotFi bridge init script
echo -e "${YELLOW}[3/8] Removing SpotFi bridge init script...${NC}"
if [ -f /etc/init.d/spotfi-bridge ]; then
    rm -f /etc/init.d/spotfi-bridge
    echo -e "${GREEN}✓ Init script removed${NC}"
else
    echo "  - Init script not found, skipping"
fi

# Step 4: Remove SpotFi environment file
echo -e "${YELLOW}[4/8] Removing SpotFi configuration...${NC}"
if [ -f /etc/spotfi.env ]; then
    rm -f /etc/spotfi.env
    echo -e "${GREEN}✓ Configuration file removed${NC}"
else
    echo "  - Configuration file not found, skipping"
fi

# Step 5: Stop and disable CoovaChilli (if installed)
echo -e "${YELLOW}[5/8] Stopping CoovaChilli service...${NC}"
if [ -f /etc/init.d/chilli ]; then
    /etc/init.d/chilli stop 2>/dev/null || true
    /etc/init.d/chilli disable 2>/dev/null || true
    echo -e "${GREEN}✓ CoovaChilli service stopped and disabled${NC}"
else
    echo "  - CoovaChilli service not found, skipping"
fi

# Step 6: Remove CoovaChilli configuration
if [ -f /etc/chilli/config ]; then
    echo "  - Removing CoovaChilli configuration..."
    # Backup existing config
    if [ -f /etc/chilli/config ]; then
        cp /etc/chilli/config /etc/chilli/config.backup.remove-$(date +%Y%m%d_%H%M%S) 2>/dev/null || true
    fi
    # Remove or reset config (keep file but clear it, or remove if you prefer)
    echo "# CoovaChilli configuration removed by SpotFi cleanup" > /etc/chilli/config
    echo -e "${GREEN}✓ CoovaChilli configuration cleared${NC}"
fi

# Step 7: Remove network hotspot interface
echo -e "${YELLOW}[6/8] Removing network hotspot interface...${NC}"
if uci show network.hotspot >/dev/null 2>&1; then
    uci delete network.hotspot
    uci commit network
    echo -e "${GREEN}✓ Network hotspot interface removed${NC}"
else
    echo "  - Network hotspot interface not found, skipping"
fi

# Step 8: Remove firewall hotspot zone and rules
echo -e "${YELLOW}[7/8] Removing firewall hotspot zone and rules...${NC}"

# Find and remove firewall zone
ZONE_INDEX=""
i=0
while true; do
    zone_name=$(uci get "firewall.@zone[$i].name" 2>/dev/null || echo "")
    if [ -z "$zone_name" ]; then
        break
    fi
    if [ "$zone_name" = "hotspot" ]; then
        ZONE_INDEX=$i
        break
    fi
    i=$((i + 1))
done

if [ -n "$ZONE_INDEX" ]; then
    uci delete "firewall.@zone[$ZONE_INDEX]"
    echo "  - Firewall hotspot zone removed"
fi

# Remove firewall forwarding rules (hotspot -> wan)
i=0
REMOVED_FORWARDING=0
while true; do
    src=$(uci get "firewall.@forwarding[$i].src" 2>/dev/null || echo "")
    dest=$(uci get "firewall.@forwarding[$i].dest" 2>/dev/null || echo "")
    if [ -z "$src" ]; then
        break
    fi
    if [ "$src" = "hotspot" ] && [ "$dest" = "wan" ]; then
        uci delete "firewall.@forwarding[$i]"
        REMOVED_FORWARDING=1
        echo "  - Firewall forwarding rule (hotspot -> wan) removed"
        # Don't increment i, as indices shift after deletion
        continue
    fi
    i=$((i + 1))
done

# Remove firewall rules (Allow-RADIUS-Auth and Allow-RADIUS-Acct)
i=0
REMOVED_RULES=0
while true; do
    rule_name=$(uci get "firewall.@rule[$i].name" 2>/dev/null || echo "")
    if [ -z "$rule_name" ]; then
        break
    fi
    if [ "$rule_name" = "Allow-RADIUS-Auth" ] || [ "$rule_name" = "Allow-RADIUS-Acct" ]; then
        uci delete "firewall.@rule[$i]"
        REMOVED_RULES=1
        echo "  - Firewall rule '$rule_name' removed"
        # Don't increment i, as indices shift after deletion
        continue
    fi
    i=$((i + 1))
done

if [ -n "$ZONE_INDEX" ] || [ "$REMOVED_FORWARDING" = "1" ] || [ "$REMOVED_RULES" = "1" ]; then
    uci commit firewall
    echo -e "${GREEN}✓ Firewall configuration updated${NC}"
else
    echo "  - No firewall rules found, skipping"
fi

# Step 9: Remove wireless SpotFi-Guest SSID
echo -e "${YELLOW}[8/8] Removing wireless SpotFi-Guest SSID...${NC}"
WIRELESS_MODIFIED=false

# Find and remove wireless interfaces with SpotFi-Guest SSID
RADIO=$(uci show wireless 2>/dev/null | grep "=wifi-device" | head -n1 | cut -d. -f2 | cut -d= -f1)

if [ -n "$RADIO" ]; then
    # Find interface with SSID "SpotFi-Guest"
    i=0
    while true; do
        ssid=$(uci get "wireless.@wifi-iface[$i].ssid" 2>/dev/null || echo "")
        iface_name=$(uci show wireless 2>/dev/null | grep -E "^wireless\.@wifi-iface\[$i\]" | head -n1 | cut -d. -f2 | cut -d= -f1)
        
        if [ -z "$ssid" ]; then
            break
        fi
        
        if [ "$ssid" = "SpotFi-Guest" ]; then
            uci delete "wireless.$iface_name"
            WIRELESS_MODIFIED=true
            echo "  - Wireless interface with SSID 'SpotFi-Guest' removed"
            break
        fi
        i=$((i + 1))
    done
    
    # Also check for interface names ending with "_spotfi"
    for iface in $(uci show wireless 2>/dev/null | grep -E "wireless\.\w+_spotfi=" | cut -d. -f2 | cut -d= -f1); do
        if [ -n "$iface" ]; then
            uci delete "wireless.$iface"
            WIRELESS_MODIFIED=true
            echo "  - Wireless interface '$iface' removed"
        fi
    done
    
    if [ "$WIRELESS_MODIFIED" = "true" ]; then
        uci commit wireless
        echo -e "${GREEN}✓ Wireless configuration updated${NC}"
    else
        echo "  - No SpotFi wireless interfaces found, skipping"
    fi
else
    echo "  - No wireless radios found, skipping"
fi

# Optional: Remove CoovaChilli package
if [ "$REMOVE_CHILLI" = "true" ]; then
    echo -e "${YELLOW}[9/9] Removing CoovaChilli package...${NC}"
    if opkg list-installed | grep -q "^coova-chilli "; then
        opkg remove coova-chilli
        echo -e "${GREEN}✓ CoovaChilli package removed${NC}"
    else
        echo "  - CoovaChilli package not installed, skipping"
    fi
fi

# Restart services
echo ""
echo -e "${YELLOW}Restarting services...${NC}"
/etc/init.d/network restart 2>/dev/null || true
sleep 2
/etc/init.d/firewall restart 2>/dev/null || true

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Removal Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Removed components:"
echo "  ✓ SpotFi WebSocket bridge service"
echo "  ✓ Bridge files and configuration"
echo "  ✓ CoovaChilli service (disabled)"
echo "  ✓ Network hotspot interface"
echo "  ✓ Firewall hotspot zone and rules"
echo "  ✓ Wireless SpotFi-Guest SSID"
if [ "$REMOVE_CHILLI" = "true" ]; then
    echo "  ✓ CoovaChilli package"
fi
echo ""
echo "Note: CoovaChilli configuration file was backed up before clearing."
echo "      To restore: /etc/chilli/config.backup.remove-*"
echo ""

