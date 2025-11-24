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

# Step 2: Install required packages
STEP_NUM=$((STEP_NUM + 1))
echo -e "${YELLOW}[${STEP_NUM}/${TOTAL_STEPS}] Installing required packages...${NC}"

echo "  - Installing Python..."
opkg install python3-light

echo "  - Installing python3-ubus (native ubus bindings)..."
opkg install python3-ubus || {
    echo -e "${YELLOW}Warning: python3-ubus not available via opkg, will use subprocess fallback${NC}"
}

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
    router_name = config.get('SPOTFI_ROUTER_NAME', '')
    
    return router_id, token, mac, ws_url, router_name

ROUTER_ID, TOKEN, MAC, WS_URL, ROUTER_NAME = load_config()

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
        self.x_sessions = {}  # sessionId -> {'master_fd': int, 'process': subprocess.Popen, 'thread': threading.Thread}
        self.ubus = None
        self.ubus_available = False
        
        # Try to import native ubus (faster)
        try:
            import ubus
            self.ubus = ubus.connect()
            self.ubus_available = True
            print("✓ Using native python3-ubus (fast)")
        except ImportError:
            print("⚠ python3-ubus not available, using subprocess fallback")
            self.ubus_available = False
        
    def _ubus_call(self, path, method, args={}):
        """Generic ubus call - uses native binding if available, else subprocess"""
        if self.ubus_available and self.ubus:
            try:
                return self.ubus.call(path, method, args)
            except Exception as e:
                print(f"Native ubus call failed: {e}, falling back to subprocess", file=sys.stderr)
                # Fall through to subprocess
        
        # Fallback to subprocess
        args_json = json.dumps(args) if args else '{}'
        result = subprocess.run(
            ['ubus', 'call', path, method, args_json],
            capture_output=True,
            text=True,
            timeout=10
        )
        if result.returncode == 0:
            return json.loads(result.stdout) if result.stdout else {}
        else:
            raise Exception(f"ubus call failed: {result.stderr}")
        
    def get_router_metrics(self):
        """Get router metrics using ubus (native)"""
        # Get system info via ubus
        sys_info = self._ubus_call("system", "info", {})
        
        # Get uspot client count via ubus
        try:
            clients = self._ubus_call("uspot", "client_list", {})
            # Calculate active users (count keys in all interfaces)
            active_users = sum(len(v) if isinstance(v, dict) else 1 for v in clients.values()) if clients else 0
        except:
            active_users = 0
        
        # Extract metrics from ubus system.info response
        metrics = {
            'uptime': str(sys_info.get('uptime', 0)),
            'cpuLoad': (sys_info.get('load', [0])[0] / 65535.0 * 100) if isinstance(sys_info.get('load'), list) and len(sys_info.get('load', [])) > 0 else 0,
            'totalMemory': sys_info.get('memory', {}).get('total', 0),
            'freeMemory': sys_info.get('memory', {}).get('free', 0),
            'activeUsers': active_users
        }
        return metrics
    
    def on_message(self, ws, message):
        data = json.loads(message)
        msg_type = data.get('type')
        print(f"Received: {msg_type}")
        
        if msg_type == 'rpc':
            # Generic UBUS RPC Proxy - The ONLY command handler needed!
            # Backend sends: { "type": "rpc", "id": "req1", "path": "system", "method": "info", "args": {} }
            self.handle_rpc(data)
        elif msg_type == 'connected':
            print(f"✓ Registered: {data.get('routerId')}")
            # Send router name update if configured
            if ROUTER_NAME and ROUTER_NAME.strip():
                self.send_message({
                    'type': 'update-router-name',
                    'name': ROUTER_NAME.strip()
                })
                print(f"✓ Router name update sent: {ROUTER_NAME.strip()}")
        elif msg_type == 'x-start':
            self.handle_x_start(data)
        elif msg_type == 'x-data':
            self.handle_x_data(data)
        elif msg_type == 'x-stop':
            self.handle_x_stop(data)
    
    def handle_rpc(self, data):
        """Generic UBUS RPC Proxy - The ONLY method needed!
        This replaces all hardcoded command handlers (reboot, network-stats, etc.)
        Everything goes through ubus - the router doesn't need to know what it's executing.
        """
        req_id = data.get('id')
        path = data.get('path')
        method = data.get('method')
        args = data.get('args', {})
        
        if not path or not method:
            error_msg = "Missing path or method for RPC call"
            self.send_message({'type': 'rpc-result', 'id': req_id, 'status': 'error', 'error': error_msg})
            return
        
        try:
            # Use native ubus binding if available (much faster)
            result = self._ubus_call(path, method, args)
            response = {
                'type': 'rpc-result',
                'id': req_id,
                'status': 'success',
                'result': result
            }
        except Exception as e:
            response = {
                'type': 'rpc-result',
                'id': req_id,
                'status': 'error',
                'error': str(e)
            }
        
        self.send_message(response)
    
    def handle_x_start(self, data):
        """Start a new x session with PTY"""
        session_id = data.get('sessionId')
        if not session_id:
            print("Error: Missing sessionId in x-start", file=sys.stderr)
            return
        
        if session_id in self.x_sessions:
            print(f"Warning: x session {session_id} already exists, cleaning up first", file=sys.stderr)
            self._cleanup_x_session(session_id)
        
        master_fd = None
        slave_fd = None
        process = None
        read_thread = None
        
        try:
            # Check if PTY is available
            try:
                import pty
            except ImportError:
                print(f"Error: PTY module not available. Install python3-full: opkg install python3-full", file=sys.stderr)
                self.send_message({
                    'type': 'x-error',
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
            
            # Set environment variables to ensure shell outputs prompt
            shell_env = os.environ.copy()
            shell_env['TERM'] = 'xterm-256color'  # Standard terminal type
            shell_env['HOME'] = '/root'  # Ensure HOME is set
            shell_env['USER'] = 'root'  # Ensure USER is set
            shell_env['SHELL'] = shell  # Ensure SHELL is set
            # Disable job control to suppress "can't access tty; job control turned off" warning
            # This is normal for PTY-based shells on OpenWrt/BusyBox
            shell_env['set'] = '+m'  # Disable job control via environment (if shell respects it)
            
            # Start shell with job control disabled (+m flag for BusyBox ash)
            # This suppresses the "can't access tty; job control turned off" warning
            # BusyBox ash supports the +m flag to disable job control at startup
            shell_cmd = [shell]
            # Try to use +m flag if shell is ash/sh (BusyBox ash supports this)
            if 'ash' in shell or 'sh' in shell:
                # Start shell with job control disabled
                # +m disables job control (monitor mode off)
                shell_cmd = [shell, '+m']
            
            # CRITICAL: Don't use preexec_fn on OpenWrt/BusyBox - it causes "Exception occurred in preexec_fn" error
            # This is because BusyBox's limited shell doesn't support all POSIX features
            # start_new_session=True is sufficient for creating a new process group on OpenWrt
            process = subprocess.Popen(
                shell_cmd,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                start_new_session=True,
                env=shell_env
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
                print(f"Terminal size set to 80x24 for session {session_id}")
            except Exception as e:
                print(f"Warning: Could not set terminal size: {e}", file=sys.stderr)
                # Continue anyway - basic PTY should still work
            
            # Start thread to read from PTY and send to WebSocket
            read_thread = threading.Thread(
                target=self._x_read_pty,
                args=(session_id, master_fd),
                daemon=True
            )
            read_thread.start()
            
            # Verify process started successfully
            if process.poll() is not None:
                # Process already died
                raise Exception(f"Shell process died immediately with exit code {process.returncode}")
            
            # Store session BEFORE sending confirmation (important!)
            import time
            self.x_sessions[session_id] = {
                'master_fd': master_fd,
                'process': process,
                'thread': read_thread,
                'start_time': time.time()  # Track when session started for timeout detection
            }
            
            print(f"x session started: {session_id}, PID: {process.pid}, Shell: {shell}")
            print(f"x session stored successfully. Total active sessions: {len(self.x_sessions)}")
            print(f"Session details: master_fd={master_fd}, process_alive={process.poll() is None}")
            
            # Send confirmation to server
            self.send_message({
                'type': 'x-started',
                'sessionId': session_id,
                'status': 'ready'
            })
        except Exception as e:
            print(f"Error starting x session: {e}", file=sys.stderr)
            import traceback
            print(f"Traceback: {traceback.format_exc()}", file=sys.stderr)
            
            # Cleanup on error
            if master_fd is not None:
                try:
                    os.close(master_fd)
                except:
                    pass
            if slave_fd is not None:
                try:
                    os.close(slave_fd)
                except:
                    pass
            if process is not None:
                try:
                    process.terminate()
                except:
                    pass
            
            # Send error to server
            self.send_message({
                'type': 'x-error',
                'sessionId': session_id,
                'error': str(e)
            })
    
    def _x_read_pty(self, session_id, master_fd):
        """Read from PTY and send to WebSocket"""
        print(f"x read thread started for session {session_id}, master_fd={master_fd}")
        try:
            # Force initial shell prompt by sending a command to trigger output
            # This helps ensure the terminal is ready and outputs the prompt
            import time
            time.sleep(0.2)  # Give shell time to initialize
            
            # Read any initial output (shell prompt, welcome message, etc.)
            read_count = 0
            while session_id in self.x_sessions:
                # Check if process is still alive
                if session_id not in self.x_sessions:
                    print(f"Session {session_id} removed, exiting read thread")
                    break
                
                session = self.x_sessions.get(session_id)
                if not session:
                    print(f"Session {session_id} not found in sessions dict")
                    break
                    
                if session['process'].poll() is not None:
                    # Process ended
                    print(f"Shell process for session {session_id} ended with code {session['process'].returncode}")
                    break
                
                # Use select to check if data is available (non-blocking)
                try:
                    ready_fds, _, _ = select.select([master_fd], [], [], 0.1)
                    if ready_fds:
                        data = os.read(master_fd, 1024)
                        if data:
                            read_count += 1
                            # Send data to server (base64 encoded as backend expects)
                            import base64
                            encoded_data = base64.b64encode(data).decode('ascii')
                            
                            # Debug: log first few reads to help diagnose
                            if read_count <= 3:
                                print(f"[Session {session_id}] Read #{read_count}: {len(data)} bytes, first 50 chars: {repr(data[:50])}")
                            
                            self.send_message({
                                'type': 'x-data',
                                'sessionId': session_id,
                                'data': encoded_data
                            })
                            print(f"[Session {session_id}] Sent {len(data)} bytes to server (total reads: {read_count})")
                        else:
                            # No data available
                            if read_count == 0:
                                # If we've been waiting and no data, shell might not have output prompt
                                # This is normal - wait for user input or first command
                                pass
                    else:
                        # No data ready, continue loop
                        # Periodically check if we should exit
                        if read_count == 0 and time.time() - session.get('start_time', time.time()) > 5:
                            # After 5 seconds with no output, log it but continue
                            print(f"[Session {session_id}] No initial output after 5s - shell may be waiting for input")
                            session['start_time'] = time.time()  # Reset timer
                        
                except OSError as e:
                    # PTY closed or error
                    print(f"OSError reading from PTY for session {session_id}: {e}", file=sys.stderr)
                    break
                except Exception as e:
                    print(f"Error reading from PTY for session {session_id}: {e}", file=sys.stderr)
                    import traceback
                    print(f"Traceback: {traceback.format_exc()}", file=sys.stderr)
                    break
        except Exception as e:
            print(f"Error in x read thread for session {session_id}: {e}", file=sys.stderr)
            import traceback
            print(f"Traceback: {traceback.format_exc()}", file=sys.stderr)
        finally:
            print(f"x read thread exiting for session {session_id}")
            # Cleanup session
            if session_id in self.x_sessions:
                self._cleanup_x_session(session_id)
    
    def handle_x_data(self, data):
        """Handle incoming x data from client"""
        session_id = data.get('sessionId')
        x_data = data.get('data')
        
        if not session_id or x_data is None:
            print("Error: Missing sessionId or data in x-data", file=sys.stderr)
            return
        
        if session_id not in self.x_sessions:
            print(f"Warning: x session {session_id} not found. Active sessions: {list(self.x_sessions.keys())}", file=sys.stderr)
            # Try to list what sessions exist for debugging
            if len(self.x_sessions) > 0:
                print(f"Available sessions: {', '.join(self.x_sessions.keys())}", file=sys.stderr)
            return
        
        try:
            session = self.x_sessions[session_id]
            master_fd = session['master_fd']
            
            # Decode base64 data (backend always sends base64)
            import base64
            try:
                binary_data = base64.b64decode(x_data)
                print(f"Received {len(binary_data)} bytes for session {session_id}")
            except Exception as e:
                print(f"Error decoding base64 x data: {e}", file=sys.stderr)
                return
            
            # Write to PTY
            written = os.write(master_fd, binary_data)
            print(f"Wrote {written} bytes to PTY for session {session_id}")
        except Exception as e:
            print(f"Error writing to x session: {e}", file=sys.stderr)
            self._cleanup_x_session(session_id)
    
    def handle_x_stop(self, data):
        """Stop x session"""
        session_id = data.get('sessionId')
        if not session_id:
            return
        
        if session_id in self.x_sessions:
            self._cleanup_x_session(session_id)
            print(f"x session stopped: {session_id}")
    
    def _cleanup_x_session(self, session_id):
        """Clean up x session resources"""
        if session_id not in self.x_sessions:
            return
        
        session = self.x_sessions[session_id]
        
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
        del self.x_sessions[session_id]
    
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
        # Cleanup all x sessions on disconnect
        for session_id in list(self.x_sessions.keys()):
            self._cleanup_x_session(session_id)
        if self.running:
            print(f"WebSocket closed (code: {close_status_code}). Will reconnect...")
    
    def on_open(self, ws):
        print("✓ WebSocket connected")
        self.connected = True
        self.send_metrics()
        # Start heartbeat thread for periodic metrics
        self.start_heartbeat()
    
    def start_heartbeat(self):
        """Send metrics every 30s using UBUS instead of parsing /proc files"""
        def heartbeat_loop():
            while self.running and self.ws and self.connected:
                try:
                    # Get system info natively
                    sys_info = self._ubus_call("system", "info", {})
                    # Get uspot client count natively
                    try:
                        clients = self._ubus_call("uspot", "client_list", {})
                        active_users = sum(len(v) if isinstance(v, dict) else 1 for v in clients.values()) if clients else 0
                    except:
                        active_users = 0
                    
                    metrics = {
                        'type': 'metrics',
                        'metrics': {
                            'uptime': str(sys_info.get('uptime', 0)),
                            'cpuLoad': (sys_info.get('load', [0])[0] / 65535.0 * 100) if isinstance(sys_info.get('load'), list) and len(sys_info.get('load', [])) > 0 else 0,
                            'totalMemory': sys_info.get('memory', {}).get('total', 0),
                            'freeMemory': sys_info.get('memory', {}).get('free', 0),
                            'activeUsers': active_users
                        }
                    }
                    self.send_message(metrics)
                    time.sleep(30)
                except Exception as e:
                    print(f"Heartbeat Error: {e}", file=sys.stderr)
                    time.sleep(5)
        
        heartbeat_thread = threading.Thread(target=heartbeat_loop, daemon=True)
        heartbeat_thread.start()
    
    def send_message(self, data):
        if self.ws and self.connected:
            try:
                self.ws.send(json.dumps(data))
            except Exception as e:
                # Connection lost, will be handled by on_close
                print(f"Failed to send message: {e}", file=sys.stderr)
                pass
    
    def send_metrics(self):
        metrics = self.get_router_metrics()
        if metrics:
            self.send_message({'type': 'metrics', 'metrics': metrics})
    
    def connect(self):
        if not all([ROUTER_ID, TOKEN, MAC, WS_URL]):
            raise Exception("Environment variables not set")
        
        from urllib.parse import quote
        url = f"{WS_URL}?id={ROUTER_ID}&token={TOKEN}&mac={MAC}"
        if ROUTER_NAME and ROUTER_NAME.strip():
            url += f"&name={quote(ROUTER_NAME.strip())}"
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
    if ROUTER_NAME and ROUTER_NAME.strip():
        print(f"  Router Name: {ROUTER_NAME.strip()}")
    
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
if [ -n "$ROUTER_NAME" ]; then
    echo "  - Router Name: $ROUTER_NAME"
fi
echo ""
echo "Verification:"
echo "  1. Check WebSocket: ps | grep bridge.py"
echo "  2. View logs: logread -f"
echo "  3. Check SpotFi dashboard - router should show ONLINE"
echo ""
echo -e "${YELLOW}Note: It may take 30-60 seconds for the router to appear as ONLINE${NC}"
echo ""
