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
# Use GitHub Releases only (latest release)
GITHUB_REPO="rufaromugabe/spotfi"
DOWNLOAD_URL="https://github.com/${GITHUB_REPO}/releases/latest/download/spotfi-bridge-${BINARY_ARCH}"
BINARY_NAME="spotfi-bridge-$BINARY_ARCH"

echo -e "${GREEN}✓ Architecture detected: $ARCH_STRING → $BINARY_ARCH${NC}"

# Step 3: Install WebSocket bridge (Go binary)
STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Installing SpotFi Bridge (Go)...${NC}"

echo "  - Downloading binary for $ARCH_STRING..."
echo "  - URL: $DOWNLOAD_URL"

# Download binary from GitHub Releases (show progress and errors)
if ! wget -O /tmp/spotfi-bridge "$DOWNLOAD_URL" 2>&1; then
    echo -e "${RED}Error: Failed to download binary from GitHub Releases${NC}"
    echo ""
    echo "URL: $DOWNLOAD_URL"
    echo ""
    echo "Please ensure:"
    echo "  1. A GitHub release exists with binaries attached"
    echo "  2. The binary for your architecture ($BINARY_ARCH) is included in the release"
    echo "  3. Your router has internet connectivity"
    echo "  4. The release is not a draft or pre-release (use latest release)"
    echo ""
    echo "To create a release:"
    echo "  1. Go to: https://github.com/${GITHUB_REPO}/actions"
    echo "  2. Run the 'Build and Release Binaries' workflow"
    echo "  3. Or push a version tag: git tag v1.0.0 && git push origin v1.0.0"
    exit 1
fi

# Verify download was successful
if [ ! -f /tmp/spotfi-bridge ]; then
    echo -e "${RED}Error: Download file not found${NC}"
    exit 1
fi

# Check file size (should be > 0)
FILE_SIZE=$(stat -c%s /tmp/spotfi-bridge 2>/dev/null || wc -c < /tmp/spotfi-bridge 2>/dev/null || echo "0")
if [ "$FILE_SIZE" -eq 0 ]; then
    echo -e "${RED}Error: Downloaded file is empty${NC}"
    echo "This usually means the release asset doesn't exist or the URL is incorrect"
    rm -f /tmp/spotfi-bridge
    exit 1
fi

# Move to final location
mv /tmp/spotfi-bridge /usr/bin/spotfi-bridge
if [ $? -ne 0 ]; then
    echo -e "${RED}Error: Failed to install binary to /usr/bin/spotfi-bridge${NC}"
    exit 1
fi

# Make executable and verify
chmod +x /usr/bin/spotfi-bridge

# Verify the file is actually there and executable
if [ ! -f /usr/bin/spotfi-bridge ]; then
    echo -e "${RED}Error: Binary file not found after installation${NC}"
    exit 1
fi

# Check if it's actually executable
if [ ! -x /usr/bin/spotfi-bridge ]; then
    echo -e "${YELLOW}Warning: Binary is not executable, attempting to fix...${NC}"
    chmod 755 /usr/bin/spotfi-bridge
fi

# Verify file permissions
echo "  - File permissions: $(ls -l /usr/bin/spotfi-bridge | awk '{print $1, $3, $4}')"

# Verify binary
if [ ! -f /usr/bin/spotfi-bridge ]; then
    echo -e "${RED}Error: Binary not found at /usr/bin/spotfi-bridge${NC}"
    exit 1
fi

# Verify binary is actually executable for this architecture
if command -v file >/dev/null 2>&1; then
    BINARY_TYPE=$(file /usr/bin/spotfi-bridge 2>/dev/null || echo "unknown")
    echo "  - Binary type: $BINARY_TYPE"
else
    echo "  - Binary type: ELF executable (file command not available)"
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

# Test binary with --test flag (tests configuration without connecting)
echo "  - Testing binary and configuration..."

# First, verify binary details
echo "  - Binary info:"
if command -v file >/dev/null 2>&1; then
    file /usr/bin/spotfi-bridge 2>/dev/null || echo "    ⚠ Could not determine file type"
else
    echo "    ⚠ file command not available (normal on minimal OpenWRT)"
fi
ls -lh /usr/bin/spotfi-bridge 2>/dev/null | awk '{print "    Size: " $5}' || echo "    Size: $(stat -c%s /usr/bin/spotfi-bridge 2>/dev/null || echo 'unknown')"

# Try to run with explicit error capture
echo "  - Running binary test..."

# Verify file exists and is readable
if [ ! -f /usr/bin/spotfi-bridge ]; then
    echo -e "${RED}✗ Binary not found at /usr/bin/spotfi-bridge${NC}"
    exit 1
fi

# Check if we can read the file
if [ ! -r /usr/bin/spotfi-bridge ]; then
    echo -e "${RED}✗ Binary is not readable${NC}"
    exit 1
fi

# Try to check ELF header for architecture (if hexdump/od available)
if command -v hexdump >/dev/null 2>&1; then
    ELF_MAGIC=$(hexdump -n 4 -e '4/1 "%02x"' /usr/bin/spotfi-bridge 2>/dev/null)
    if [ "$ELF_MAGIC" = "7f454c46" ]; then
        echo "  - ELF binary detected (magic: $ELF_MAGIC)"
        # Check architecture byte (offset 18)
        ARCH_BYTE=$(hexdump -n 1 -s 18 -e '1/1 "%02x"' /usr/bin/spotfi-bridge 2>/dev/null)
        case "$ARCH_BYTE" in
            3e) echo "    Architecture: x86-64 (amd64)" ;;
            03) echo "    Architecture: i386 (32-bit)" ;;
            *) echo "    Architecture byte: $ARCH_BYTE (unknown)" ;;
        esac
    fi
fi

# Try to execute the binary
TEST_OUTPUT=$(/usr/bin/spotfi-bridge --test 2>&1)
EXIT_CODE=$?
if [ $EXIT_CODE -eq 0 ] && [ -n "$TEST_OUTPUT" ]; then
    echo "$TEST_OUTPUT"
    echo -e "${GREEN}✓ Binary test passed - configuration is valid${NC}"
elif [ -n "$TEST_OUTPUT" ]; then
    echo -e "${RED}✗ Binary test failed:${NC}"
    echo "$TEST_OUTPUT"
    echo ""
    echo "Please check /etc/spotfi.env configuration"
    exit 1
else
    # Binary exits with no output - likely architecture or UPX issue
    echo -e "${RED}✗ Binary exits silently - possible issues:${NC}"
    echo "    1. Architecture mismatch (binary for wrong CPU)"
    echo "    2. UPX compression issue"
    echo "    3. Missing system libraries"
    echo "    4. Binary corruption"
    echo ""
    echo "  - Attempting to diagnose..."
    
    # Check if it's a UPX-compressed binary
    if strings /usr/bin/spotfi-bridge 2>/dev/null | head -n 1 | grep -q "UPX"; then
        echo "    ⚠ Binary is UPX-compressed - may not work on this system"
        echo "    Try downloading uncompressed binary or rebuild without UPX"
    fi
    
    # Try to see if binary can at least be executed
    if ! /usr/bin/spotfi-bridge 2>&1 >/dev/null; then
        echo "    ⚠ Binary cannot execute - check architecture compatibility"
    fi
    
    echo -e "${YELLOW}⚠ Continuing anyway - service may not start${NC}"
fi

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
        logger -t spotfi-bridge "Error: /etc/spotfi.env not found"
        echo "Error: /etc/spotfi.env not found"
        exit 1
    fi
    
    if [ ! -x "$PROG" ]; then
        logger -t spotfi-bridge "Error: $PROG not found or not executable"
        echo "Error: $PROG not found or not executable"
        exit 1
    fi
    
    # Verify env file is readable
    if [ ! -r /etc/spotfi.env ]; then
        logger -t spotfi-bridge "Error: /etc/spotfi.env is not readable"
        echo "Error: /etc/spotfi.env is not readable"
        exit 1
    fi
    
    # Create log directory if it doesn't exist
    mkdir -p /var/log
    
    procd_open_instance
    procd_set_param command $PROG
    procd_set_param respawn 3600 5 5
    # Redirect stdout and stderr to syslog with tag
    procd_set_param stdout 1
    procd_set_param stderr 1
    procd_set_param env "SPOTFI_LOG=1"
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
