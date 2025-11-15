#!/bin/sh
#
# SpotFi OpenWRT Router Auto-Setup Script - Cloud Mode
# 
# This script configures an OpenWRT router for SpotFi cloud monitoring only
# WebSocket bridge for real-time monitoring and remote control
# No CoovaChilli/RADIUS/captive portal
#
# Usage: ./openwrt-setup-cloud.sh ROUTER_ID TOKEN MAC_ADDRESS [SERVER_DOMAIN]
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
if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
    echo "Usage: $0 ROUTER_ID TOKEN MAC_ADDRESS [SERVER_DOMAIN]"
    echo ""
    echo "This script sets up SpotFi WebSocket bridge only (cloud monitoring)."
    echo "For CoovaChilli setup, use: openwrt-setup-chilli.sh"
    echo ""
    echo "Arguments:"
    echo "  ROUTER_ID     - Router ID from SpotFi dashboard"
    echo "  TOKEN         - Router token from SpotFi dashboard"
    echo "  MAC_ADDRESS   - Router MAC address"
    echo "  SERVER_DOMAIN - (Optional) SpotFi server domain (default: wss://api.spotfi.com)"
    echo ""
    echo "Example:"
    echo "  $0 ROUTER_ID TOKEN MAC_ADDRESS"
    echo "  $0 ROUTER_ID TOKEN MAC_ADDRESS wss://server.example.com/ws"
    echo ""
    exit 1
fi

ROUTER_ID="$1"
TOKEN="$2"
MAC_ADDRESS="$3"
WS_URL="${4:-wss://api.spotfi.com/ws}"

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
echo ""

TOTAL_STEPS=5

# Step 1: Update package list
STEP_NUM=1
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Updating package list...${NC}"
opkg update

# Step 2: Install required packages
STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Installing required packages...${NC}"

# Check package availability before installation
check_package() {
    if opkg list | grep -q "^$1 "; then
        return 0
    else
        return 1
    fi
}

# Install Python
if check_package python3-light; then
    echo "  - Installing Python..."
    opkg install python3-light || {
        echo -e "${RED}Error: Failed to install python3-light${NC}"
        exit 1
    }
else
    echo -e "${RED}Error: python3-light not available in package repository${NC}"
    echo -e "${YELLOW}Please check your package repositories or install manually${NC}"
    exit 1
fi

# Check if python3 is available
if ! command -v python3 >/dev/null 2>&1; then
    echo -e "${RED}Error: python3 not found after installation${NC}"
    exit 1
fi

# Install WebSocket client
if check_package python3-websocket-client; then
    echo "  - Installing WebSocket support..."
    opkg install python3-websocket-client || {
        echo -e "${RED}Error: Failed to install python3-websocket-client${NC}"
        echo -e "${YELLOW}You may need to install it manually: pip3 install websocket-client${NC}"
        exit 1
    }
else
    echo -e "${YELLOW}Warning: python3-websocket-client not in repository${NC}"
    echo -e "${YELLOW}Trying alternative installation via pip3...${NC}"
    if command -v pip3 >/dev/null 2>&1; then
        pip3 install websocket-client || {
            echo -e "${RED}Error: Failed to install websocket-client via pip3${NC}"
            exit 1
        }
    else
        echo -e "${RED}Error: pip3 not available and python3-websocket-client not in repository${NC}"
        exit 1
    fi
fi

# Verify WebSocket module is importable
if ! python3 -c "import websocket" 2>/dev/null; then
    echo -e "${RED}Error: websocket module not available${NC}"
    exit 1
fi

# Install python-dotenv for environment variable loading
echo "  - Installing python-dotenv..."
if command -v pip3 >/dev/null 2>&1; then
    pip3 install python-dotenv 2>/dev/null || {
        echo -e "${YELLOW}Warning: Failed to install python-dotenv via pip3, will use fallback method${NC}"
    }
else
    echo -e "${YELLOW}Warning: pip3 not available, will use fallback method for loading env${NC}"
fi

echo -e "${GREEN}✓ Packages installed${NC}"

# Step 3: Install WebSocket bridge
STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Installing WebSocket bridge...${NC}"

mkdir -p /root/spotfi-bridge

cat > /root/spotfi-bridge/bridge.py << 'PYEOF'
#!/usr/bin/env python3
"""SpotFi WebSocket Bridge for OpenWRT"""

import websocket
import json
import time
import subprocess
import os
import sys

def load_config():
    """Load configuration from environment variables or /etc/spotfi.env file"""
    # Try environment variables first
    router_id = os.getenv('SPOTFI_ROUTER_ID')
    token = os.getenv('SPOTFI_TOKEN')
    mac = os.getenv('SPOTFI_MAC')
    ws_url = os.getenv('SPOTFI_WS_URL')
    
    # If not all variables are set, try loading from /etc/spotfi.env using dotenv
    if not all([router_id, token, mac, ws_url]):
        env_file = '/etc/spotfi.env'
        if os.path.exists(env_file):
            try:
                # Try using python-dotenv library
                try:
                    from dotenv import dotenv_values
                    config = dotenv_values(env_file)
                    if not router_id:
                        router_id = config.get('SPOTFI_ROUTER_ID') or os.getenv('SPOTFI_ROUTER_ID')
                    if not token:
                        token = config.get('SPOTFI_TOKEN') or os.getenv('SPOTFI_TOKEN')
                    if not mac:
                        mac = config.get('SPOTFI_MAC') or os.getenv('SPOTFI_MAC')
                    if not ws_url:
                        ws_url = config.get('SPOTFI_WS_URL') or os.getenv('SPOTFI_WS_URL')
                except ImportError:
                    # Fallback: manually parse the file
                    with open(env_file, 'r') as f:
                        for line in f:
                            line = line.strip()
                            if not line or line.startswith('#'):
                                continue
                            # Handle both export VAR="value" and VAR="value" formats
                            if line.startswith('export '):
                                line = line[7:].strip()  # Remove 'export '
                            if '=' in line:
                                key, value = line.split('=', 1)
                                key = key.strip()
                                # Remove quotes from value
                                value = value.strip().strip('"').strip("'")
                                if key == 'SPOTFI_ROUTER_ID' and not router_id:
                                    router_id = value
                                elif key == 'SPOTFI_TOKEN' and not token:
                                    token = value
                                elif key == 'SPOTFI_MAC' and not mac:
                                    mac = value
                                elif key == 'SPOTFI_WS_URL' and not ws_url:
                                    ws_url = value
            except Exception as e:
                print(f"Warning: Could not read {env_file}: {e}", file=sys.stderr)
    
    return router_id, token, mac, ws_url

ROUTER_ID, TOKEN, MAC, WS_URL = load_config()

# Validate required environment variables
def validate_environment():
    """Validate all required environment variables are set"""
    missing = []
    
    if not ROUTER_ID or ROUTER_ID.strip() == '':
        missing.append('SPOTFI_ROUTER_ID')
    if not TOKEN or TOKEN.strip() == '':
        missing.append('SPOTFI_TOKEN')
    if not MAC or MAC.strip() == '':
        missing.append('SPOTFI_MAC')
    if not WS_URL or WS_URL.strip() == '':
        missing.append('SPOTFI_WS_URL')
    
    if missing:
        print(f"Error: Missing required environment variables: {', '.join(missing)}", file=sys.stderr)
        print("Please ensure /etc/spotfi.env exists and is properly configured.", file=sys.stderr)
        print("Run the setup script again or check the configuration manually.", file=sys.stderr)
        sys.exit(1)
    
    # Validate WS_URL format
    if not WS_URL.startswith(('ws://', 'wss://')):
        print(f"Error: Invalid WebSocket URL format: {WS_URL}", file=sys.stderr)
        print("WebSocket URL must start with ws:// or wss://", file=sys.stderr)
        sys.exit(1)
    
    return True

class SpotFiBridge:
    def __init__(self):
        self.ws = None
        self.running = True
        
    def get_router_metrics(self):
        """Get router metrics"""
        try:
            metrics = {}
            
            # CPU load
            with open('/proc/loadavg', 'r') as f:
                load = f.read().split()[0]
            metrics['cpuLoad'] = float(load) * 100
            
            # Memory
            with open('/proc/meminfo', 'r') as f:
                for line in f:
                    if line.startswith('MemTotal:'):
                        metrics['totalMemory'] = int(line.split()[1])
                    elif line.startswith('MemFree:'):
                        metrics['freeMemory'] = int(line.split()[1])
                    if 'totalMemory' in metrics and 'freeMemory' in metrics:
                        break
            
            # Uptime
            with open('/proc/uptime', 'r') as f:
                uptime_seconds = int(float(f.read().split()[0]))
            metrics['uptime'] = str(uptime_seconds)
            
            metrics['activeUsers'] = 0
            
            return metrics
        except Exception as e:
            print(f"Error getting metrics: {e}", file=sys.stderr)
            return {}
    
    def on_message(self, ws, message):
        try:
            data = json.loads(message)
            msg_type = data.get('type')
            print(f"Received: {msg_type}")
            
            if msg_type == 'command':
                self.handle_command(data.get('command'))
            elif msg_type == 'connected':
                print(f"✓ Registered: {data.get('routerId')}")
        except Exception as e:
            print(f"Error: {e}", file=sys.stderr)
    
    def handle_command(self, command):
        print(f"Executing: {command}")
        try:
            if command == 'reboot':
                subprocess.run(['reboot'])
            elif command == 'get-status':
                self.send_metrics()
            elif command == 'fetch-logs':
                logs = subprocess.check_output(['logread', '-l', '50']).decode()
                self.send_message({'type': 'logs', 'data': logs})
        except Exception as e:
            print(f"Command failed: {e}", file=sys.stderr)
    
    def on_error(self, ws, error):
        print(f"WebSocket error: {error}", file=sys.stderr)
    
    def on_close(self, ws, close_status_code, close_msg):
        print("WebSocket closed. Reconnecting in 5s...")
        time.sleep(5)
        if self.running:
            self.connect()
    
    def on_open(self, ws):
        print("✓ WebSocket connected")
        self.send_metrics()
    
    def send_message(self, data):
        if self.ws and self.ws.sock and self.ws.sock.connected:
            self.ws.send(json.dumps(data))
    
    def send_metrics(self):
        metrics = self.get_router_metrics()
        if metrics:
            self.send_message({'type': 'metrics', 'metrics': metrics})
    
    def connect(self):
        # Double-check environment variables before connecting
        if not ROUTER_ID or not TOKEN or not MAC or not WS_URL:
            print("Error: Environment variables not set. Cannot connect.", file=sys.stderr)
            sys.exit(1)
        
        url = f"{WS_URL}?id={ROUTER_ID}&token={TOKEN}&mac={MAC}"
        print(f"Connecting to {WS_URL}...")
        
        self.ws = websocket.WebSocketApp(
            url,
            on_message=self.on_message,
            on_error=self.on_error,
            on_close=self.on_close,
            on_open=self.on_open
        )
        self.ws.run_forever(ping_interval=60, ping_timeout=10)
    
    def start(self):
        print("SpotFi Bridge starting...")
        print(f"Router ID: {ROUTER_ID}")
        while self.running:
            try:
                self.connect()
            except KeyboardInterrupt:
                self.running = False
            except Exception as e:
                print(f"Error: {e}", file=sys.stderr)
                time.sleep(10)

if __name__ == '__main__':
    # Validate environment variables before starting
    validate_environment()
    
    print(f"Starting SpotFi Bridge...")
    print(f"  Router ID: {ROUTER_ID}")
    print(f"  WebSocket: {WS_URL}")
    
    bridge = SpotFiBridge()
    bridge.start()
PYEOF

chmod +x /root/spotfi-bridge/bridge.py

# Create environment file (standard .env format, compatible with dotenv)
cat > /etc/spotfi.env << EOF
SPOTFI_ROUTER_ID="$ROUTER_ID"
SPOTFI_TOKEN="$TOKEN"
SPOTFI_MAC="$MAC_ADDRESS"
SPOTFI_WS_URL="$WS_URL"
EOF

chmod 600 /etc/spotfi.env

# Configure Google DNS for better DNS resolution
echo -e "${YELLOW}Configuring DNS servers...${NC}"
# Add Google DNS to resolv.conf (temporary)
if ! grep -q "8.8.8.8" /etc/resolv.conf 2>/dev/null; then
    echo "nameserver 8.8.8.8" >> /etc/resolv.conf
    echo "nameserver 8.8.4.4" >> /etc/resolv.conf
fi

# Configure DNS via UCI (persistent across reboots)
if command -v uci >/dev/null 2>&1; then
    # Get current DNS
    CURRENT_DNS=$(uci get network.lan.dns 2>/dev/null || echo "")
    
    # Add Google DNS if not already present
    if ! echo "$CURRENT_DNS" | grep -q "8.8.8.8"; then
        if [ -z "$CURRENT_DNS" ]; then
            uci set network.lan.dns="8.8.8.8 8.8.4.4"
        else
            uci set network.lan.dns="$CURRENT_DNS 8.8.8.8 8.8.4.4"
        fi
        uci commit network
        echo -e "${GREEN}✓ DNS servers configured (8.8.8.8, 8.8.4.4)${NC}"
    else
        echo -e "${GREEN}✓ DNS servers already configured${NC}"
    fi
else
    echo -e "${YELLOW}Warning: uci not available, DNS configured in /etc/resolv.conf only${NC}"
fi

# Extract hostname from WebSocket URL and check DNS resolution
WS_HOST=$(echo "$WS_URL" | sed -E 's|^[^/]*//([^:/]+).*|\1|')
if [ -n "$WS_HOST" ] && [ "$WS_HOST" != "api.spotfi.com" ]; then
    echo -e "${YELLOW}Checking DNS resolution for $WS_HOST...${NC}"
    
    # Try to resolve the hostname
    if ! nslookup "$WS_HOST" >/dev/null 2>&1; then
        echo -e "${YELLOW}DNS resolution failed. Attempting to resolve via ping...${NC}"
        
        # Try to ping and extract IP (if hostname contains IP pattern)
        if echo "$WS_HOST" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+'; then
            WS_IP=$(echo "$WS_HOST" | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+')
        else
            # Try to extract IP from hostname (e.g., subdomain.IP format)
            WS_IP=$(echo "$WS_HOST" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | tail -1)
        fi
        
        if [ -n "$WS_IP" ]; then
            echo -e "${YELLOW}Adding hosts entry: $WS_IP $WS_HOST${NC}"
            # Remove existing entry if present
            sed -i "/[[:space:]]$WS_HOST$/d" /etc/hosts 2>/dev/null
            # Add new entry
            echo "$WS_IP $WS_HOST" >> /etc/hosts
            echo -e "${GREEN}✓ Hosts entry added${NC}"
        else
            echo -e "${YELLOW}Warning: Could not determine IP address for $WS_HOST${NC}"
            echo -e "${YELLOW}You may need to manually add it to /etc/hosts${NC}"
        fi
    else
        echo -e "${GREEN}✓ DNS resolution OK${NC}"
    fi
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
PROG=/root/spotfi-bridge/bridge.py

start_service() {
    if [ ! -f /etc/spotfi.env ]; then
        echo "Error: /etc/spotfi.env not found"
        echo "Please run the setup script to create the configuration file."
        exit 1
    fi
    
    # Read environment variables directly from file (more reliable than sourcing)
    # Handle both export VAR="value" and VAR="value" formats
    SPOTFI_ROUTER_ID=$(grep -E "^export SPOTFI_ROUTER_ID=|^SPOTFI_ROUTER_ID=" /etc/spotfi.env | sed -E 's/^(export )?SPOTFI_ROUTER_ID="?([^"]+)"?/\2/' | head -1)
    SPOTFI_TOKEN=$(grep -E "^export SPOTFI_TOKEN=|^SPOTFI_TOKEN=" /etc/spotfi.env | sed -E 's/^(export )?SPOTFI_TOKEN="?([^"]+)"?/\2/' | head -1)
    SPOTFI_MAC=$(grep -E "^export SPOTFI_MAC=|^SPOTFI_MAC=" /etc/spotfi.env | sed -E 's/^(export )?SPOTFI_MAC="?([^"]+)"?/\2/' | head -1)
    SPOTFI_WS_URL=$(grep -E "^export SPOTFI_WS_URL=|^SPOTFI_WS_URL=" /etc/spotfi.env | sed -E 's/^(export )?SPOTFI_WS_URL="?([^"]+)"?/\2/' | head -1)
    
    # Validate all required environment variables
    MISSING_VARS=""
    [ -z "$SPOTFI_ROUTER_ID" ] && MISSING_VARS="${MISSING_VARS} SPOTFI_ROUTER_ID"
    [ -z "$SPOTFI_TOKEN" ] && MISSING_VARS="${MISSING_VARS} SPOTFI_TOKEN"
    [ -z "$SPOTFI_MAC" ] && MISSING_VARS="${MISSING_VARS} SPOTFI_MAC"
    [ -z "$SPOTFI_WS_URL" ] && MISSING_VARS="${MISSING_VARS} SPOTFI_WS_URL"
    
    if [ -n "$MISSING_VARS" ]; then
        echo "Error: Missing required environment variables:$MISSING_VARS"
        echo "Please check /etc/spotfi.env and ensure all variables are set."
        echo "Run the setup script again to regenerate the configuration."
        exit 1
    fi
    
    # Validate WebSocket URL format
    if ! echo "$SPOTFI_WS_URL" | grep -qE '^(ws|wss)://'; then
        echo "Error: Invalid WebSocket URL format: $SPOTFI_WS_URL"
        echo "WebSocket URL must start with ws:// or wss://"
        exit 1
    fi
    
    if [ ! -x "$PROG" ]; then
        echo "Error: $PROG not found or not executable"
        exit 1
    fi
    
    procd_open_instance
    procd_set_param command /usr/bin/python3 $PROG
    procd_set_param respawn 3600 5 5
    procd_set_param stdout 1
    procd_set_param stderr 1
    procd_set_param env SPOTFI_ROUTER_ID="$SPOTFI_ROUTER_ID"
    procd_set_param env SPOTFI_TOKEN="$SPOTFI_TOKEN"
    procd_set_param env SPOTFI_MAC="$SPOTFI_MAC"
    procd_set_param env SPOTFI_WS_URL="$SPOTFI_WS_URL"
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

# Final status check
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Setup Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Router Status:"
echo "  - Mode: Cloud (WebSocket bridge only)"
echo "  - Router ID: $ROUTER_ID"
echo "  - WebSocket: $WS_URL"
echo ""
echo "Verification:"
echo "  1. Check WebSocket: ps | grep bridge.py"
echo "  2. View logs: logread -f"
echo "  3. Check SpotFi dashboard - router should show ONLINE"
echo ""
echo -e "${YELLOW}Note: It may take 30-60 seconds for the router to appear as ONLINE${NC}"
echo ""
