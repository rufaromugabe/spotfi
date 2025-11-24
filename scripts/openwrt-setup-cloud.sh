#!/bin/sh
#
# SpotFi OpenWRT Router Auto-Setup Script - Cloud Mode
# 
# This script configures an OpenWRT router for SpotFi cloud monitoring only
# WebSocket bridge for real-time monitoring and remote control
#
# Usage: ./openwrt-setup-cloud.sh ROUTER_ID TOKEN MAC_ADDRESS [SERVER_DOMAIN] [ROUTER_NAME]
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
if [ "$#" -lt 3 ] || [ "$#" -gt 5 ]; then
    echo "Usage: $0 ROUTER_ID TOKEN MAC_ADDRESS [SERVER_DOMAIN] [ROUTER_NAME]"
    echo ""
    echo "This script sets up SpotFi WebSocket bridge only (cloud monitoring)."
    echo "For CoovaChilli setup, use: openwrt-setup-chilli.sh"
    echo ""
    echo "Arguments:"
    echo "  ROUTER_ID     - Router ID from SpotFi dashboard"
    echo "  TOKEN         - Router token from SpotFi dashboard"
    echo "  MAC_ADDRESS   - Router MAC address"
    echo "  SERVER_DOMAIN - (Optional) SpotFi server domain (default: wss://api.spotfi.com/ws)"
    echo "  ROUTER_NAME   - (Optional) Router name to set in SpotFi dashboard"
    echo ""
    exit 1
fi

ROUTER_ID="$1"
TOKEN="$2"
MAC_ADDRESS="$3"
WS_URL="${4:-wss://api.spotfi.com/ws}"
ROUTER_NAME="${5:-}"

# Normalize WebSocket URL: add protocol if missing, ensure /ws path
if echo "$WS_URL" | grep -qv "://"; then
    WS_URL="wss://${WS_URL}"
fi
if echo "$WS_URL" | grep -qv "/ws"; then
    WS_URL="${WS_URL%/}/ws"
fi

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}SpotFi OpenWRT Router Setup - Cloud Mode${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Router ID: $ROUTER_ID"
echo "MAC Address: $MAC_ADDRESS"
echo "WebSocket: $WS_URL"
if [ -n "$ROUTER_NAME" ]; then
    echo "Router Name: $ROUTER_NAME"
fi
echo ""

TOTAL_STEPS=5

# Step 1: Update package list
STEP_NUM=1
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Updating package list...${NC}"
opkg update

# Step 2: Detect architecture and prepare for binary download
STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Detecting router architecture...${NC}"

# Detect architecture
ARCH_STRING=$(opkg print-architecture | grep -E 'mips_24kc|mipsel_24kc|aarch64_cortex-a53|aarch64_cortex-a72|aarch64_generic' | head -n 1 | awk '{print $2}')

if [ -z "$ARCH_STRING" ]; then
    echo -e "${RED}Error: Could not detect router architecture${NC}"
    echo "Please run 'opkg print-architecture' and report the architecture"
    exit 1
fi

echo "  - Detected architecture: $ARCH_STRING"

# Map architecture to binary name
DOWNLOAD_URL=""
BINARY_NAME=""

if [ "$ARCH_STRING" = "mips_24kc" ]; then
    DOWNLOAD_URL="https://your-server.com/bin/spotfi-bridge-mips"
    BINARY_NAME="spotfi-bridge-mips"
elif [ "$ARCH_STRING" = "mipsel_24kc" ]; then
    DOWNLOAD_URL="https://your-server.com/bin/spotfi-bridge-mipsle"
    BINARY_NAME="spotfi-bridge-mipsle"
elif echo "$ARCH_STRING" | grep -q "aarch64"; then
    DOWNLOAD_URL="https://your-server.com/bin/spotfi-bridge-arm64"
    BINARY_NAME="spotfi-bridge-arm64"
else
    echo -e "${RED}Error: Unsupported architecture: $ARCH_STRING${NC}"
    echo "Supported architectures: mips_24kc, mipsel_24kc, aarch64_*"
    exit 1
fi

echo -e "${GREEN}✓ Architecture detected${NC}"

# Step 3: Install WebSocket bridge (Go binary)
STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Installing SpotFi Bridge (Go)...${NC}"

echo "  - Downloading binary for $ARCH_STRING..."
echo "  - URL: $DOWNLOAD_URL"

# Download binary
if ! wget -O /usr/bin/spotfi-bridge "$DOWNLOAD_URL" 2>/dev/null; then
    echo -e "${RED}Error: Failed to download binary from $DOWNLOAD_URL${NC}"
    echo "Please ensure:"
    echo "  1. The binary URL is correct and accessible"
    echo "  2. Your router has internet connectivity"
    echo "  3. The binary has been compiled and uploaded for your architecture"
    exit 1
fi

# Make executable
chmod +x /usr/bin/spotfi-bridge

# Verify binary
if [ ! -f /usr/bin/spotfi-bridge ]; then
    echo -e "${RED}Error: Binary not found at /usr/bin/spotfi-bridge${NC}"
    exit 1
fi

# Test binary (should show help or version, or just exit gracefully)
if ! /usr/bin/spotfi-bridge 2>&1 | head -n 1 > /dev/null; then
    echo -e "${YELLOW}Warning: Binary may not be compatible with this architecture${NC}"
    echo "Continuing anyway..."
fi

echo -e "${GREEN}✓ SpotFi Bridge binary installed${NC}"

# Create environment file
cat > /etc/spotfi.env << EOF
SPOTFI_ROUTER_ID="$ROUTER_ID"
SPOTFI_TOKEN="$TOKEN"
SPOTFI_MAC="$MAC_ADDRESS"
SPOTFI_WS_URL="$WS_URL"
SPOTFI_ROUTER_NAME="$ROUTER_NAME"
EOF

chmod 600 /etc/spotfi.env

echo -e "${GREEN}✓ WebSocket bridge installed${NC}"

# Step 4: Create init scripts
STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Creating init scripts...${NC}"

cat > /etc/init.d/spotfi-bridge << 'INITEOF'
#!/bin/sh /etc/rc.common

START=99
STOP=10

USE_PROCD=1
PROG=/usr/bin/spotfi-bridge

start_service() {
    if [ ! -f /etc/spotfi.env ]; then
        echo "Error: /etc/spotfi.env not found"
        exit 1
    fi
    
    if [ ! -x "$PROG" ]; then
        echo "Error: $PROG not found or not executable"
        exit 1
    fi
    
    procd_open_instance
    procd_set_param command $PROG
    procd_set_param respawn 3600 5 5
    procd_set_param stdout 1
    procd_set_param stderr 1
    procd_close_instance
}
INITEOF

chmod +x /etc/init.d/spotfi-bridge

echo -e "${GREEN}✓ Init scripts created${NC}"

# Step 5: Enable and start services
STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Starting services...${NC}"

/etc/init.d/spotfi-bridge enable
/etc/init.d/spotfi-bridge start

echo -e "${GREEN}✓ Services started${NC}"

# Final status
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Setup Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Router Status:"
echo "  - Mode: Cloud (WebSocket bridge only)"
echo "  - Router ID: $ROUTER_ID"
echo "  - WebSocket: $WS_URL"
if [ -n "$ROUTER_NAME" ]; then
    echo "  - Router Name: $ROUTER_NAME"
fi
echo ""
echo "Verification:"
echo "  1. Check WebSocket: ps | grep spotfi-bridge"
echo "  2. View logs: logread -f"
echo "  3. Check SpotFi dashboard - router should show ONLINE"
echo ""
echo -e "${YELLOW}Note: It may take 30-60 seconds for the router to appear as ONLINE${NC}"
echo ""
