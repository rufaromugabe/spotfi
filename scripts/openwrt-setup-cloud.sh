#!/bin/sh
#
# SpotFi OpenWRT Router Auto-Setup Script - Cloud Mode
# 
# This script configures an OpenWRT router for SpotFi cloud monitoring only
# WebSocket bridge for real-time monitoring and remote control
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
    echo "  SERVER_DOMAIN - (Optional) SpotFi server domain (default: wss://api.spotfi.com/ws)"
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

echo "  - Installing Python..."
opkg install python3-light

echo "  - Installing WebSocket support..."
if opkg list | grep -q "^python3-websocket-client "; then
    opkg install python3-websocket-client
else
    pip3 install websocket-client
fi

echo "  - Installing python-dotenv..."
pip3 install python-dotenv

# Verify packages
python3 -c "import websocket, dotenv" || {
    echo -e "${RED}Error: Required Python packages not available${NC}"
    exit 1
}

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
import threading
from dotenv import dotenv_values

def load_config():
    """Load configuration from /etc/spotfi.env file"""
    env_file = '/etc/spotfi.env'
    if not os.path.exists(env_file):
        print(f"Error: {env_file} not found", file=sys.stderr)
        sys.exit(1)
    
    config = dotenv_values(env_file)
    router_id = config.get('SPOTFI_ROUTER_ID')
    token = config.get('SPOTFI_TOKEN')
    mac = config.get('SPOTFI_MAC')
    ws_url = config.get('SPOTFI_WS_URL')
    
    return router_id, token, mac, ws_url

ROUTER_ID, TOKEN, MAC, WS_URL = load_config()

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
        sys.exit(1)
    
    if not WS_URL.startswith(('ws://', 'wss://')):
        print(f"Error: Invalid WebSocket URL format: {WS_URL}", file=sys.stderr)
        print("WebSocket URL must start with ws:// or wss://", file=sys.stderr)
        sys.exit(1)

class SpotFiBridge:
    def __init__(self):
        self.ws = None
        self.running = True
        self.connection_error = False
        self.error_count = 0
        self.last_error_time = 0
        
    def get_router_metrics(self):
        """Get router metrics"""
        metrics = {}
        
        with open('/proc/loadavg', 'r') as f:
            load = f.read().split()[0]
        metrics['cpuLoad'] = float(load) * 100
        
        with open('/proc/meminfo', 'r') as f:
            for line in f:
                if line.startswith('MemTotal:'):
                    metrics['totalMemory'] = int(line.split()[1])
                elif line.startswith('MemFree:'):
                    metrics['freeMemory'] = int(line.split()[1])
                if 'totalMemory' in metrics and 'freeMemory' in metrics:
                    break
        
        with open('/proc/uptime', 'r') as f:
            uptime_seconds = int(float(f.read().split()[0]))
        metrics['uptime'] = str(uptime_seconds)
        
        metrics['activeUsers'] = 0
        return metrics
    
    def on_message(self, ws, message):
        data = json.loads(message)
        msg_type = data.get('type')
        print(f"Received: {msg_type}")
        
        if msg_type == 'command':
            self.handle_command(data.get('command'))
        elif msg_type == 'connected':
            print(f"✓ Registered: {data.get('routerId')}")
    
    def handle_command(self, command):
        print(f"Executing: {command}")
        if command == 'reboot':
            subprocess.run(['reboot'])
        elif command == 'get-status':
            self.send_metrics()
        elif command == 'fetch-logs':
            logs = subprocess.check_output(['logread', '-l', '50']).decode()
            self.send_message({'type': 'logs', 'data': logs})
    
    def on_error(self, ws, error):
        print(f"WebSocket error: {error}", file=sys.stderr)
        self.connection_error = True
        self.error_count += 1
        current_time = time.time()
        
        # If we get multiple errors quickly (connection failing repeatedly), force close
        if self.error_count >= 3 and (current_time - self.last_error_time) < 10:
            print("Multiple connection errors detected, forcing reconnection...", file=sys.stderr)
            try:
                if self.ws:
                    self.ws.close()
            except:
                pass
        
        self.last_error_time = current_time
    
    def on_close(self, ws, close_status_code, close_msg):
        if self.running:
            print(f"WebSocket closed (code: {close_status_code}). Will reconnect...")
            self.connection_error = False
            self.error_count = 0
    
    def on_open(self, ws):
        print("✓ WebSocket connected")
        self.connection_error = False
        self.error_count = 0
        self.send_metrics()
    
    def send_message(self, data):
        if self.ws and self.ws.sock and self.ws.sock.connected:
            self.ws.send(json.dumps(data))
    
    def send_metrics(self):
        metrics = self.get_router_metrics()
        if metrics:
            self.send_message({'type': 'metrics', 'metrics': metrics})
    
    def connect(self):
        if not all([ROUTER_ID, TOKEN, MAC, WS_URL]):
            raise Exception("Environment variables not set")
        
        url = f"{WS_URL}?id={ROUTER_ID}&token={TOKEN}&mac={MAC}"
        print(f"Connecting to {WS_URL}...")
        
        self.connection_error = False
        self.error_count = 0
        self.ws = websocket.WebSocketApp(
            url,
            on_message=self.on_message,
            on_error=self.on_error,
            on_close=self.on_close,
            on_open=self.on_open
        )
        
        # Run with timeout to allow reconnection on persistent errors
        # Use a thread to monitor for persistent connection failures
        def monitor_connection():
            time.sleep(15)  # Wait 15 seconds
            if self.error_count >= 3 and not (self.ws and self.ws.sock and self.ws.sock.connected):
                print("Connection failed after multiple attempts, forcing reconnection...", file=sys.stderr)
                self.connection_error = True
                try:
                    if self.ws:
                        self.ws.close()
                except:
                    pass
        
        monitor_thread = threading.Thread(target=monitor_connection, daemon=True)
        monitor_thread.start()
        
        try:
            self.ws.run_forever(ping_interval=30, ping_timeout=10)
        except Exception as e:
            print(f"run_forever exception: {e}", file=sys.stderr)
            self.connection_error = True
        
        # If connection error occurred or too many errors, raise to trigger reconnection
        if self.connection_error or self.error_count >= 3:
            raise Exception("Connection error detected, reconnecting...")
    
    def start(self):
        print("SpotFi Bridge starting...")
        print(f"Router ID: {ROUTER_ID}")
        reconnect_delay = 5
        max_reconnect_delay = 60
        
        while self.running:
            try:
                self.connect()
                reconnect_delay = 5
            except KeyboardInterrupt:
                self.running = False
                break
            except Exception as e:
                print(f"Connection failed: {e}", file=sys.stderr)
                print(f"Reconnecting in {reconnect_delay}s...")
                time.sleep(reconnect_delay)
                reconnect_delay = min(int(reconnect_delay * 1.5), max_reconnect_delay)

if __name__ == '__main__':
    validate_environment()
    
    print(f"Starting SpotFi Bridge...")
    print(f"  Router ID: {ROUTER_ID}")
    print(f"  WebSocket: {WS_URL}")
    
    bridge = SpotFiBridge()
    bridge.start()
PYEOF

chmod +x /root/spotfi-bridge/bridge.py

# Create environment file
cat > /etc/spotfi.env << EOF
SPOTFI_ROUTER_ID="$ROUTER_ID"
SPOTFI_TOKEN="$TOKEN"
SPOTFI_MAC="$MAC_ADDRESS"
SPOTFI_WS_URL="$WS_URL"
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
PROG=/root/spotfi-bridge/bridge.py

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
    procd_set_param command /usr/bin/python3 $PROG
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
echo ""
echo "Verification:"
echo "  1. Check WebSocket: ps | grep bridge.py"
echo "  2. View logs: logread -f"
echo "  3. Check SpotFi dashboard - router should show ONLINE"
echo ""
echo -e "${YELLOW}Note: It may take 30-60 seconds for the router to appear as ONLINE${NC}"
echo ""
