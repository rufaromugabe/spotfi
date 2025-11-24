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

# Detect architecture - try multiple methods
ARCH_STRING=""
BINARY_ARCH=""

# Method 1: Try opkg print-architecture (most reliable for OpenWrt)
OPKG_ARCH=$(opkg print-architecture 2>/dev/null | grep -vE '^(arch|arch all|arch noarch)' | awk '{print $2}' | head -n 1)

# Method 2: Fallback to uname -m
UNAME_ARCH=$(uname -m 2>/dev/null || echo "")

# Determine architecture and map to binary
if [ -n "$OPKG_ARCH" ]; then
    ARCH_STRING="$OPKG_ARCH"
    echo "  - Detected from opkg: $ARCH_STRING"
    
    # Map opkg architecture strings to binary names
    if [ "$ARCH_STRING" = "mips_24kc" ] || echo "$ARCH_STRING" | grep -qE "^mips_[0-9]"; then
        BINARY_ARCH="mips"
    elif [ "$ARCH_STRING" = "mipsel_24kc" ] || echo "$ARCH_STRING" | grep -qE "^mipsel_[0-9]"; then
        BINARY_ARCH="mipsle"
    elif echo "$ARCH_STRING" | grep -qE "^mips64"; then
        # 64-bit MIPS - check endianness
        if echo "$ARCH_STRING" | grep -qE "mips64el|mips64le"; then
            BINARY_ARCH="mips64le"
        else
            BINARY_ARCH="mips64"
        fi
    elif echo "$ARCH_STRING" | grep -qE "aarch64|arm64"; then
        BINARY_ARCH="arm64"
    elif echo "$ARCH_STRING" | grep -qE "^arm_cortex|^arm_arm"; then
        # 32-bit ARM (cortex-a5, cortex-a7, cortex-a8, cortex-a9, cortex-a15, etc.)
        BINARY_ARCH="arm"
    elif [ "$ARCH_STRING" = "x86_64" ] || [ "$ARCH_STRING" = "amd64" ]; then
        BINARY_ARCH="amd64"
    elif echo "$ARCH_STRING" | grep -qE "^i386|^i686|^x86$"; then
        # 32-bit x86
        BINARY_ARCH="386"
    elif echo "$ARCH_STRING" | grep -qE "riscv64"; then
        BINARY_ARCH="riscv64"
    fi
elif [ -n "$UNAME_ARCH" ]; then
    ARCH_STRING="$UNAME_ARCH"
    echo "  - Detected from uname: $ARCH_STRING"
    
    # Map uname architecture to binary names
    if echo "$UNAME_ARCH" | grep -qE "^mips64"; then
        # 64-bit MIPS
        if echo "$UNAME_ARCH" | grep -qE "mips64el|mips64le"; then
            BINARY_ARCH="mips64le"
        else
            BINARY_ARCH="mips64"
        fi
    elif echo "$UNAME_ARCH" | grep -qE "^mips"; then
        BINARY_ARCH="mips"
    elif echo "$UNAME_ARCH" | grep -qE "^mipsel|^mipsle"; then
        BINARY_ARCH="mipsle"
    elif echo "$UNAME_ARCH" | grep -qE "aarch64|arm64|armv8"; then
        BINARY_ARCH="arm64"
    elif echo "$UNAME_ARCH" | grep -qE "^armv[0-9]|^arm$"; then
        # 32-bit ARM (armv5, armv6, armv7, etc.)
        BINARY_ARCH="arm"
    elif echo "$UNAME_ARCH" | grep -qE "x86_64|amd64"; then
        BINARY_ARCH="amd64"
    elif echo "$UNAME_ARCH" | grep -qE "^i386|^i686|^x86$"; then
        # 32-bit x86
        BINARY_ARCH="386"
    elif echo "$UNAME_ARCH" | grep -qE "riscv64"; then
        BINARY_ARCH="riscv64"
    fi
fi

# Check if we successfully detected architecture
if [ -z "$BINARY_ARCH" ]; then
    echo -e "${RED}Error: Could not detect router architecture${NC}"
    echo ""
    echo "Detected values:"
    if [ -n "$OPKG_ARCH" ]; then
        echo "  opkg: $OPKG_ARCH"
    fi
    if [ -n "$UNAME_ARCH" ]; then
        echo "  uname: $UNAME_ARCH"
    fi
    echo ""
    echo "Please run these commands and report the output:"
    echo "  opkg print-architecture"
    echo "  uname -m"
    exit 1
fi

echo "  - Mapped to binary: spotfi-bridge-$BINARY_ARCH"

# Set download URL and binary name
DOWNLOAD_URL="https://your-server.com/bin/spotfi-bridge-$BINARY_ARCH"
BINARY_NAME="spotfi-bridge-$BINARY_ARCH"

echo -e "${GREEN}✓ Architecture detected: $ARCH_STRING → $BINARY_ARCH${NC}"

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
