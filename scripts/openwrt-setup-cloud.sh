#!/bin/sh
#
# SpotFi OpenWRT Router Auto-Setup Script - Cloud Mode
# 
# Cloudflare Tunnel-like setup: Just install and provide token
# All configuration (including uSpot setup) is done from the cloud
#
# Usage: ./openwrt-setup-cloud.sh TOKEN [SERVER_DOMAIN] [GITHUB_TOKEN]
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
if [ "$#" -lt 1 ] || [ "$#" -gt 3 ]; then
    echo "Usage: $0 TOKEN [SERVER_DOMAIN] [GITHUB_TOKEN]"
    echo ""
    echo "Cloudflare Tunnel-like setup: Just provide your router token."
    echo "All configuration (including uSpot setup) will be done from the cloud."
    echo ""
    echo "Arguments:"
    echo "  TOKEN         - Router token from SpotFi dashboard (required)"
    echo "  SERVER_DOMAIN - (Optional) SpotFi server domain (default: wss://api.spotfi.com/ws)"
    echo "  GITHUB_TOKEN  - (Optional) GitHub Personal Access Token for private repos"
    echo ""
    echo "Note: GitHub token can also be set via GITHUB_TOKEN environment variable"
    echo "      or stored in /etc/github_token file"
    echo ""
    echo "Example:"
    echo "  $0 your-router-token-here"
    echo ""
    exit 1
fi

TOKEN="$1"
WS_URL="${2:-wss://api.spotfi.com/ws}"
GITHUB_TOKEN_PARAM="${3:-}"

# Get GitHub token from multiple sources (priority: parameter > env var > file)
if [ -n "$GITHUB_TOKEN_PARAM" ]; then
    GITHUB_TOKEN="$GITHUB_TOKEN_PARAM"
elif [ -n "$GITHUB_TOKEN" ]; then
    # Already set from environment variable
    :
elif [ -f /etc/github_token ]; then
    GITHUB_TOKEN=$(cat /etc/github_token 2>/dev/null | tr -d '\n\r ')
fi

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
echo "Token: ${TOKEN:0:8}... (hidden)"
echo "WebSocket: $WS_URL"
echo ""
echo "This will install SpotFi bridge. All configuration will be done from the cloud."
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

# Configure default hostname (router name will be set from cloud)
HOSTNAME="SpotFi"
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
# Use GitHub Releases (supports both public and private repos with token)
GITHUB_REPO="rufaromugabe/spotfi"
BINARY_NAME="spotfi-bridge-$BINARY_ARCH"

# Build download URL - use token if available for private repos
if [ -n "$GITHUB_TOKEN" ]; then
    DOWNLOAD_URL="https://api.github.com/repos/${GITHUB_REPO}/releases/latest"
    echo -e "${GREEN}✓ Architecture detected: $ARCH_STRING → $BINARY_ARCH${NC}"
    echo "  - Using GitHub token for private repository access"
else
    DOWNLOAD_URL="https://github.com/${GITHUB_REPO}/releases/latest/download/spotfi-bridge-${BINARY_ARCH}"
    echo -e "${GREEN}✓ Architecture detected: $ARCH_STRING → $BINARY_ARCH${NC}"
    echo "  - Using public repository access"
fi

# Step 4: Install WebSocket bridge (Go binary)
STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Installing SpotFi Bridge (Go)...${NC}"

echo "  - Downloading binary for $ARCH_STRING..."

# Download binary from GitHub Releases
if [ -n "$GITHUB_TOKEN" ]; then
    # Private repo: Use GitHub API to get release assets
    # First, get the latest release info
    RELEASE_JSON=$(wget --header="Authorization: token ${GITHUB_TOKEN}" \
                        --header="Accept: application/vnd.github.v3+json" \
                        -q -O - "$DOWNLOAD_URL" 2>/dev/null)
    
    if [ $? -ne 0 ] || [ -z "$RELEASE_JSON" ]; then
        echo -e "${RED}Error: Failed to fetch release info (check token permissions)${NC}"
        exit 1
    fi
    
    # Extract download URL for the specific binary asset
    # Try multiple patterns to handle different JSON formatting
    ASSET_URL=$(echo "$RELEASE_JSON" | grep -o "\"browser_download_url\"[[:space:]]*:[[:space:]]*\"[^\"]*spotfi-bridge-${BINARY_ARCH}[^\"]*\"" | sed 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
    
    # Fallback: try simpler pattern
    if [ -z "$ASSET_URL" ]; then
        ASSET_URL=$(echo "$RELEASE_JSON" | grep -o "https://[^\"]*spotfi-bridge-${BINARY_ARCH}[^\"]*" | head -n 1)
    fi
    
    if [ -z "$ASSET_URL" ]; then
        echo -e "${RED}Error: Binary asset 'spotfi-bridge-${BINARY_ARCH}' not found in latest release${NC}"
        echo "Available assets in release:"
        echo "$RELEASE_JSON" | grep -o "\"name\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -n 5 || echo "Could not parse asset names"
        exit 1
    fi
    
    # Download the binary asset with authentication
    if ! wget --header="Authorization: token ${GITHUB_TOKEN}" \
              --header="Accept: application/octet-stream" \
              -q -O /tmp/spotfi-bridge "$ASSET_URL" 2>/dev/null; then
        echo -e "${RED}Error: Failed to download binary (check token permissions)${NC}"
        exit 1
    fi
else
    # Public repo: Direct download from releases
    if ! wget -q -O /tmp/spotfi-bridge "$DOWNLOAD_URL" 2>/dev/null; then
        echo -e "${RED}Error: Failed to download binary${NC}"
        echo "Please ensure a GitHub release exists with the binary for architecture: $BINARY_ARCH"
        echo "Or provide a GitHub token for private repository access"
        exit 1
    fi
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

# Auto-detect MAC address from router's primary interface
# Try to get MAC from br-lan (most common), or first non-loopback interface
MAC_ADDRESS=""
if [ -d /sys/class/net/br-lan ]; then
    MAC_ADDRESS=$(cat /sys/class/net/br-lan/address 2>/dev/null || echo "")
fi

# Fallback: get first non-loopback interface MAC
if [ -z "$MAC_ADDRESS" ]; then
    for iface in /sys/class/net/*; do
        ifname=$(basename "$iface")
        if [ "$ifname" != "lo" ] && [ -f "$iface/address" ]; then
            MAC_ADDRESS=$(cat "$iface/address" 2>/dev/null || echo "")
            if [ -n "$MAC_ADDRESS" ]; then
                break
            fi
        fi
    done
fi

if [ -z "$MAC_ADDRESS" ]; then
    echo -e "${YELLOW}Warning: Could not auto-detect MAC address${NC}"
    echo "  The router will connect with token-only authentication"
    MAC_ADDRESS=""
fi

# Create environment file (token-only mode)
cat > /etc/spotfi.env << EOF
SPOTFI_TOKEN="$TOKEN"
SPOTFI_WS_URL="$WS_URL"
EOF

# Add MAC if detected (optional, cloud can detect it)
if [ -n "$MAC_ADDRESS" ]; then
    echo "SPOTFI_MAC=\"$MAC_ADDRESS\"" >> /etc/spotfi.env
fi

chmod 600 /etc/spotfi.env

# Test binary configuration (token is minimum requirement)
if ! /usr/bin/spotfi-bridge --test >/dev/null 2>&1; then
    echo -e "${YELLOW}Warning: Binary test failed, but continuing...${NC}"
    echo "  The bridge will connect with token-only authentication"
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
echo "  - Mode: Cloud (token-only authentication)"
echo "  - Token: ${TOKEN:0:8}... (hidden)"
echo "  - WebSocket: $WS_URL"
if [ -n "$MAC_ADDRESS" ]; then
    echo "  - MAC Address: $MAC_ADDRESS (auto-detected)"
fi
echo ""
echo "Next Steps:"
echo "  1. Router will connect to cloud automatically"
echo "  2. Go to SpotFi dashboard to configure router"
echo "  3. All setup (including uSpot) can be done from the cloud"
echo ""
echo "Verification:"
echo "  1. Check process: ps | grep spotfi-bridge"
echo "  2. Check service: /etc/init.d/spotfi-bridge status"
echo "  3. View logs: logread | grep spotfi-bridge"
echo "  4. Check SpotFi dashboard - router should show ONLINE"
echo ""
echo "Troubleshooting:"
echo "  - If service crashes, check: cat /etc/spotfi.env"
echo "  - View detailed logs: logread -f | grep spotfi"
echo "  - Test binary: /usr/bin/spotfi-bridge (should try to connect)"
echo "  - Restart service: /etc/init.d/spotfi-bridge restart"
echo ""
echo -e "${YELLOW}Note: It may take 30-60 seconds for the router to appear as ONLINE${NC}"
echo -e "${YELLOW}      Once online, configure router from the SpotFi dashboard${NC}"
echo ""
