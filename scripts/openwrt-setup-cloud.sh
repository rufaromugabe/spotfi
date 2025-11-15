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
import pty
import select
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
        self.connected = False
        self.connection_start_time = 0
        self.ssh_sessions = {}  # sessionId -> {'master_fd': int, 'process': subprocess.Popen, 'thread': threading.Thread}
        
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
            command = data.get('command')
            params = data.get('params', {})
            self.handle_command(command, params)
        elif msg_type == 'connected':
            print(f"✓ Registered: {data.get('routerId')}")
        elif msg_type == 'ssh-start':
            self.handle_ssh_start(data)
        elif msg_type == 'ssh-data':
            self.handle_ssh_data(data)
        elif msg_type == 'ssh-stop':
            self.handle_ssh_stop(data)
    
    def handle_command(self, command, params=None):
        if params is None:
            params = {}
        print(f"Executing: {command}")
        if command == 'reboot':
            subprocess.run(['reboot'])
        elif command == 'get-status':
            self.send_metrics()
        elif command == 'fetch-logs':
            logs = subprocess.check_output(['logread', '-l', '50']).decode()
            self.send_message({'type': 'logs', 'data': logs})
        elif command == 'setup-chilli':
            self.setup_chilli(params)
    
    def setup_chilli(self, params):
        """Download and execute chilli setup script with provided parameters"""
        try:
            router_id = params.get('routerId')
            radius_secret = params.get('radiusSecret')
            mac_address = params.get('macAddress')
            radius_ip = params.get('radiusIp')
            portal_url = params.get('portalUrl', 'https://api.spotfi.com')
            
            if not all([router_id, radius_secret, mac_address, radius_ip]):
                error_msg = "Missing required parameters for chilli setup"
                print(f"Error: {error_msg}", file=sys.stderr)
                self.send_message({'type': 'command-result', 'command': 'setup-chilli', 'status': 'error', 'message': error_msg})
                return
            
            print(f"Setting up CoovaChilli...")
            print(f"  Router ID: {router_id}")
            print(f"  RADIUS IP: {radius_ip}")
            print(f"  Portal URL: {portal_url}")
            
            # Download chilli setup script
            script_url = "https://raw.githubusercontent.com/rufaromugabe/spotfi/main/scripts/openwrt-setup-chilli.sh"
            script_path = "/tmp/openwrt-setup-chilli.sh"
            
            print(f"Downloading chilli setup script...")
            result = subprocess.run(
                ['wget', '-O', script_path, script_url],
                capture_output=True,
                text=True,
                timeout=30
            )
            
            if result.returncode != 0:
                error_msg = f"Failed to download script: {result.stderr}"
                print(f"Error: {error_msg}", file=sys.stderr)
                self.send_message({'type': 'command-result', 'command': 'setup-chilli', 'status': 'error', 'message': error_msg})
                return
            
            # Fix line endings and make executable
            with open(script_path, 'rb') as f:
                content = f.read().replace(b'\r\n', b'\n').replace(b'\r', b'\n')
            with open(script_path, 'wb') as f:
                f.write(content)
            subprocess.run(['chmod', '+x', script_path], check=True)
            
            # Execute chilli setup script
            print(f"Executing chilli setup script...")
            process = subprocess.Popen(
                ['sh', script_path, router_id, radius_secret, mac_address, radius_ip, portal_url],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                universal_newlines=True
            )
            
            # Stream output
            output_lines = []
            for line in process.stdout:
                line = line.strip()
                if line:
                    print(line)
                    output_lines.append(line)
                    # Send progress updates
                    if any(keyword in line.lower() for keyword in ['installing', 'configuring', 'complete', 'error']):
                        self.send_message({
                            'type': 'command-progress',
                            'command': 'setup-chilli',
                            'message': line
                        })
            
            process.wait()
            
            if process.returncode == 0:
                success_msg = "CoovaChilli setup completed successfully"
                print(f"✓ {success_msg}")
                self.send_message({
                    'type': 'command-result',
                    'command': 'setup-chilli',
                    'status': 'success',
                    'message': success_msg,
                    'output': '\n'.join(output_lines[-20:])  # Last 20 lines
                })
            else:
                error_msg = f"Chilli setup failed with exit code {process.returncode}"
                print(f"Error: {error_msg}", file=sys.stderr)
                self.send_message({
                    'type': 'command-result',
                    'command': 'setup-chilli',
                    'status': 'error',
                    'message': error_msg,
                    'output': '\n'.join(output_lines[-20:])
                })
        except subprocess.TimeoutExpired:
            error_msg = "Chilli setup timed out"
            print(f"Error: {error_msg}", file=sys.stderr)
            self.send_message({'type': 'command-result', 'command': 'setup-chilli', 'status': 'error', 'message': error_msg})
        except Exception as e:
            error_msg = f"Chilli setup error: {str(e)}"
            print(f"Error: {error_msg}", file=sys.stderr)
            self.send_message({'type': 'command-result', 'command': 'setup-chilli', 'status': 'error', 'message': error_msg})
    
    def handle_ssh_start(self, data):
        """Start a new SSH session with PTY"""
        session_id = data.get('sessionId')
        if not session_id:
            print("Error: Missing sessionId in ssh-start", file=sys.stderr)
            return
        
        if session_id in self.ssh_sessions:
            print(f"Warning: SSH session {session_id} already exists", file=sys.stderr)
            self.handle_ssh_stop(data)
        
        try:
            # Check if PTY is available
            try:
                import pty
            except ImportError:
                print(f"Error: PTY module not available. Install python3-full: opkg install python3-full", file=sys.stderr)
                self.send_message({
                    'type': 'ssh-error',
                    'sessionId': session_id,
                    'error': 'PTY module not available. Install python3-full package.'
                })
                return
            
            # Create PTY (pseudo-terminal)
            master_fd, slave_fd = pty.openpty()
            print(f"PTY created for session {session_id}: master={master_fd}, slave={slave_fd}")
            
            # Spawn shell process attached to slave PTY
            # Use /bin/sh as it's available on all OpenWrt systems
            shell = os.environ.get('SHELL', '/bin/sh')
            process = subprocess.Popen(
                [shell],
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                start_new_session=True,
                preexec_fn=os.setsid
            )
            
            # Close slave_fd in parent (we use master_fd)
            os.close(slave_fd)
            
            # Set terminal size (80x24 default)
            import struct
            import fcntl
            import termios
            try:
                winsize = struct.pack('HHHH', 24, 80, 0, 0)
                fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)
            except:
                pass  # Ignore if termios not available
            
            # Start thread to read from PTY and send to WebSocket
            read_thread = threading.Thread(
                target=self._ssh_read_pty,
                args=(session_id, master_fd),
                daemon=True
            )
            read_thread.start()
            
            # Store session
            self.ssh_sessions[session_id] = {
                'master_fd': master_fd,
                'process': process,
                'thread': read_thread
            }
            
            print(f"SSH session started: {session_id}, PID: {process.pid}, Shell: {shell}")
            
            # Send confirmation to server
            self.send_message({
                'type': 'ssh-started',
                'sessionId': session_id,
                'status': 'ready'
            })
        except Exception as e:
            print(f"Error starting SSH session: {e}", file=sys.stderr)
            if 'master_fd' in locals():
                try:
                    os.close(master_fd)
                except:
                    pass
    
    def _ssh_read_pty(self, session_id, master_fd):
        """Read from PTY and send to WebSocket"""
        try:
            while session_id in self.ssh_sessions:
                # Check if process is still alive
                if session_id not in self.ssh_sessions:
                    break
                
                session = self.ssh_sessions[session_id]
                if session['process'].poll() is not None:
                    # Process ended
                    break
                
                # Use select to check if data is available (non-blocking)
                try:
                    if select.select([master_fd], [], [], 0.1)[0]:
                        data = os.read(master_fd, 1024)
                        if data:
                            # Send data to server (base64 encoded as backend expects)
                            import base64
                            encoded_data = base64.b64encode(data).decode('ascii')
                            self.send_message({
                                'type': 'ssh-data',
                                'sessionId': session_id,
                                'data': encoded_data
                            })
                            print(f"Sent {len(data)} bytes from PTY for session {session_id}")
                except OSError:
                    # PTY closed
                    break
                except Exception as e:
                    print(f"Error reading from PTY: {e}", file=sys.stderr)
                    break
        except Exception as e:
            print(f"Error in SSH read thread: {e}", file=sys.stderr)
        finally:
            # Cleanup session
            if session_id in self.ssh_sessions:
                self._cleanup_ssh_session(session_id)
    
    def handle_ssh_data(self, data):
        """Handle incoming SSH data from client"""
        session_id = data.get('sessionId')
        ssh_data = data.get('data')
        
        if not session_id or ssh_data is None:
            print("Error: Missing sessionId or data in ssh-data", file=sys.stderr)
            return
        
        if session_id not in self.ssh_sessions:
            print(f"Warning: SSH session {session_id} not found", file=sys.stderr)
            return
        
        try:
            session = self.ssh_sessions[session_id]
            master_fd = session['master_fd']
            
            # Decode base64 data (backend always sends base64)
            import base64
            try:
                binary_data = base64.b64decode(ssh_data)
                print(f"Received {len(binary_data)} bytes for session {session_id}")
            except Exception as e:
                print(f"Error decoding base64 SSH data: {e}", file=sys.stderr)
                return
            
            # Write to PTY
            written = os.write(master_fd, binary_data)
            print(f"Wrote {written} bytes to PTY for session {session_id}")
        except Exception as e:
            print(f"Error writing to SSH session: {e}", file=sys.stderr)
            self._cleanup_ssh_session(session_id)
    
    def handle_ssh_stop(self, data):
        """Stop SSH session"""
        session_id = data.get('sessionId')
        if not session_id:
            return
        
        if session_id in self.ssh_sessions:
            self._cleanup_ssh_session(session_id)
            print(f"SSH session stopped: {session_id}")
    
    def _cleanup_ssh_session(self, session_id):
        """Clean up SSH session resources"""
        if session_id not in self.ssh_sessions:
            return
        
        session = self.ssh_sessions[session_id]
        
        try:
            # Close master FD
            if 'master_fd' in session:
                os.close(session['master_fd'])
        except:
            pass
        
        try:
            # Terminate process
            if 'process' in session:
                process = session['process']
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=2)
                    except:
                        process.kill()
        except:
            pass
        
        # Remove from sessions
        del self.ssh_sessions[session_id]
    
    def on_error(self, ws, error):
        print(f"WebSocket error: {error}", file=sys.stderr)
        # If we've been trying to connect for more than 30 seconds without success, force reconnection
        if not self.connected and time.time() - self.connection_start_time > 30:
            print("Connection timeout, forcing reconnection...", file=sys.stderr)
            try:
                if self.ws:
                    self.ws.close()
            except:
                pass
    
    def on_close(self, ws, close_status_code, close_msg):
        self.connected = False
        # Cleanup all SSH sessions on disconnect
        for session_id in list(self.ssh_sessions.keys()):
            self._cleanup_ssh_session(session_id)
        if self.running:
            print(f"WebSocket closed (code: {close_status_code}). Will reconnect...")
    
    def on_open(self, ws):
        print("✓ WebSocket connected")
        self.connected = True
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
        
        self.connected = False
        self.connection_start_time = time.time()
        self.ws = websocket.WebSocketApp(
            url,
            on_message=self.on_message,
            on_error=self.on_error,
            on_close=self.on_close,
            on_open=self.on_open
        )
        
        try:
            self.ws.run_forever(ping_interval=30, ping_timeout=10)
        except Exception as e:
            print(f"run_forever exception: {e}", file=sys.stderr)
        
        # If we never connected, raise to trigger reconnection
        if not self.connected:
            raise Exception("Connection failed, reconnecting...")
    
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
