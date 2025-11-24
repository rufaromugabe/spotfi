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

TOTAL_STEPS=6

# Step 1: Update package list
STEP_NUM=1
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Updating package list...${NC}"
opkg update

# Step 2: Configure timezone to Harare (CAT, UTC+2)
STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Configuring timezone to Harare (CAT, UTC+2)...${NC}"
uci set system.@system[0].timezone='CAT-2'
uci commit system
# Apply timezone immediately
[ -f /etc/TZ ] && echo 'CAT-2' > /etc/TZ || true
export TZ='CAT-2'
echo -e "${GREEN}✓ Timezone configured to Harare (CAT, UTC+2)${NC}"

# Configure hostname from router name, or use default
if [ -n "$ROUTER_NAME" ]; then
    # Sanitize router name for hostname (lowercase, replace spaces/special chars with hyphens, limit length)
    HOSTNAME=$(echo "$ROUTER_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | sed 's/--*/-/g' | sed 's/^-\|-$//g' | cut -c1-63)
    # Ensure hostname is not empty after sanitization
    if [ -z "$HOSTNAME" ]; then
        HOSTNAME="spotfi-router"
    fi
else
    HOSTNAME="spotfi-router"
fi
echo "  - Setting hostname to: $HOSTNAME"
uci set system.@system[0].hostname="$HOSTNAME"
uci commit system
# Apply hostname immediately
echo "$HOSTNAME" > /proc/sys/kernel/hostname 2>/dev/null || true
echo -e "${GREEN}✓ Hostname configured to: $HOSTNAME${NC}"

# Step 3: Detect architecture and prepare for binary download
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
# Use GitHub Releases only (latest release)
GITHUB_REPO="rufaromugabe/spotfi"
DOWNLOAD_URL="https://github.com/${GITHUB_REPO}/releases/latest/download/spotfi-bridge-${BINARY_ARCH}"
BINARY_NAME="spotfi-bridge-$BINARY_ARCH"

echo -e "${GREEN}✓ Architecture detected: $ARCH_STRING → $BINARY_ARCH${NC}"

# Step 4: Install WebSocket bridge (Go binary)
STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Installing SpotFi Bridge (Go)...${NC}"

echo "  - Downloading binary for $ARCH_STRING..."

# Download binary from GitHub Releases
if ! wget -q -O /tmp/spotfi-bridge "$DOWNLOAD_URL" 2>/dev/null; then
    echo -e "${RED}Error: Failed to download binary${NC}"
    echo "Please ensure a GitHub release exists with the binary for architecture: $BINARY_ARCH"
    exit 1
fi

# Verify and install binary
if [ ! -f /tmp/spotfi-bridge ] || [ ! -s /tmp/spotfi-bridge ]; then
    echo -e "${RED}Error: Binary download failed${NC}"
    exit 1
fi

mv /tmp/spotfi-bridge /usr/bin/spotfi-bridge || {
    echo -e "${RED}Error: Failed to install binary${NC}"
    exit 1
}

# Make executable
chmod +x /usr/bin/spotfi-bridge

# Verify binary
if [ ! -f /usr/bin/spotfi-bridge ] || [ ! -x /usr/bin/spotfi-bridge ]; then
    echo -e "${RED}Error: Binary installation failed${NC}"
    exit 1
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

# Test binary configuration
if ! /usr/bin/spotfi-bridge --test >/dev/null 2>&1; then
    echo -e "${RED}Error: Binary test failed - check /etc/spotfi.env configuration${NC}"
    exit 1
fi

echo -e "${GREEN}✓ WebSocket bridge installed${NC}"

# Step 5: Create init scripts
STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Creating init scripts...${NC}"

cat > /etc/init.d/spotfi-bridge << 'INITEOF'
#!/bin/sh /etc/rc.common

START=99
STOP=10

USE_PROCD=1
PROG=/usr/bin/spotfi-bridge

start_service() {
    [ ! -f /etc/spotfi.env ] || [ ! -r /etc/spotfi.env ] || [ ! -x "$PROG" ] && {
        logger -t spotfi-bridge "Error: Missing configuration or binary"
        exit 1
    }
    
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

# Step 6: Enable and start services
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
echo "  1. Check process: ps | grep spotfi-bridge"
echo "  2. Check service: /etc/init.d/spotfi-bridge status"
echo "  3. View logs: logread | grep spotfi-bridge"
echo "  4. Test binary manually: /usr/bin/spotfi-bridge"
echo "  5. Check SpotFi dashboard - router should show ONLINE"
echo ""
echo "Troubleshooting:"
echo "  - If service crashes, check: cat /etc/spotfi.env"
echo "  - View detailed logs: logread -f | grep spotfi"
echo "  - Test binary: /usr/bin/spotfi-bridge (should try to connect)"
echo "  - Restart service: /etc/init.d/spotfi-bridge restart"
echo ""
echo -e "${YELLOW}Note: It may take 30-60 seconds for the router to appear as ONLINE${NC}"
echo ""
