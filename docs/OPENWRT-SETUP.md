# OpenWRT Router Setup for SpotFi

Complete guide to configure OpenWRT routers with SpotFi's real-time accounting system.

---

## 📋 Prerequisites

- OpenWRT-compatible router (or GL.iNet with OpenWRT pre-installed)
- Admin access to OpenWRT router
- Admin access to SpotFi dashboard
- Network connectivity between router and SpotFi server

---

## 🎯 Recommended Hardware

### Budget Option: **GL.iNet GL-MT300N-V2** ($20)
- CPU: 580MHz MediaTek
- RAM: 128MB
- OpenWRT: ✅ Pre-installed
- Perfect for: Low-traffic locations

### Recommended: **GL.iNet GL-AXT1800 (Slate AX)** ($90)
- CPU: 1.0GHz Quad-core
- RAM: 512MB
- WiFi 6, Gigabit Ethernet
- OpenWRT: ✅ Pre-installed
- Perfect for: Most deployments

### High Performance: **Linksys WRT3200ACM** ($150)
- CPU: 1.8GHz Dual-core
- RAM: 512MB
- Very powerful for high-traffic sites

---

## 🚀 Quick Setup (15 Minutes)

### Step 1: Create Router in SpotFi

**Via API:**
```bash
curl -X POST http://192.168.42.181:8080/api/routers \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Office Router",
    "hostId": "HOST_USER_ID",
    "macAddress": "AA:BB:CC:DD:EE:FF",
    "location": "Main Office - Floor 1"
  }'
```

**Response (Save these!):**
```json
{
  "router": {
    "id": "cmhujj1f6000112soujpo0noz",
    "token": "e26b8c19afa977503f6cf26f39f431e891e7398b0022a43347066b2270fcbf92",
    "radiusSecret": "5d62856936faa4919a8ab07671b04103"
  }
}
```

---

### Step 2: Install Required Packages

SSH into your OpenWRT router:

```bash
ssh root@192.168.56.10

# Update package list
opkg update

# Install CoovaChilli (Captive Portal)
opkg install coova-chilli

# Install Python and WebSocket support
opkg install python3-light python3-pip python3-asyncio
opkg install python3-websocket-client

# Optional: Web interface for CoovaChilli
opkg install luci-app-coova-chilli
```

---

### Step 3: Configure CoovaChilli

Create the main configuration file:

```bash
# Backup original config
cp /etc/chilli/config /etc/chilli/config.backup

# Create new configuration
cat > /etc/chilli/config << 'EOF'
# Network Configuration
HS_WANIF=eth1              # WAN interface (internet)
HS_LANIF=wlan0             # WiFi interface for hotspot
HS_NETWORK=10.1.0.0        # Hotspot network
HS_NETMASK=255.255.255.0
HS_UAMLISTEN=10.1.0.1      # Hotspot gateway IP
HS_UAMPORT=3990            # Captive portal port

# DNS Servers
HS_DNS1=8.8.8.8
HS_DNS2=8.8.4.4

# RADIUS Configuration
HS_RADIUS=192.168.42.181   # Your SpotFi server IP
HS_RADSECRET=5d62856936faa4919a8ab07671b04103  # Your radiusSecret from Step 1

# RADIUS Ports
HS_RADAUTH=1812            # Authentication port
HS_RADACCT=1813            # Accounting port

# NAS Identifier (CRITICAL - Your router ID from Step 1)
HS_NASID=cmhujj1f6000112soujpo0noz

# Portal Configuration
HS_UAMSERVER=http://192.168.42.181:8080/portal
HS_UAMHOMEPAGE=http://www.google.com
HS_UAMSECRET=ht2eb8ej6s4et3rg98gjhs

# Allowed domains/IPs (no authentication needed)
HS_UAMALLOW=192.168.42.181

# Session settings
HS_DEFIDLETIMEOUT=3600     # Idle timeout (1 hour)
HS_DEFSESSIONTIMEOUT=0     # No session timeout (RADIUS controls this)

# Logging
HS_REDIR=on
EOF
```

**Important:** Replace the following with your actual values:
- `HS_RADIUS` - Your SpotFi server IP
- `HS_RADSECRET` - radiusSecret from Step 1
- `HS_NASID` - Router ID from Step 1

---

### Step 4: Configure Network Interfaces

Edit network configuration:

```bash
cat > /etc/config/network << 'EOF'
config interface 'loopback'
    option ifname 'lo'
    option proto 'static'
    option ipaddr '127.0.0.1'
    option netmask '255.0.0.0'

config interface 'wan'
    option ifname 'eth1'
    option proto 'dhcp'

config interface 'lan'
    option ifname 'eth0'
    option proto 'static'
    option ipaddr '192.168.1.1'
    option netmask '255.255.255.0'

config interface 'hotspot'
    option ifname 'wlan0'
    option proto 'static'
    option ipaddr '10.1.0.1'
    option netmask '255.255.255.0'
EOF
```

---

### Step 5: Configure WiFi

```bash
cat > /etc/config/wireless << 'EOF'
config wifi-device 'radio0'
    option type 'mac80211'
    option channel '6'
    option hwmode '11g'
    option htmode 'HT20'
    option disabled '0'

config wifi-iface 'default_radio0'
    option device 'radio0'
    option network 'hotspot'
    option mode 'ap'
    option ssid 'SpotFi-Guest'
    option encryption 'none'
EOF
```

---

### Step 6: Configure Firewall

```bash
cat >> /etc/config/firewall << 'EOF'

config zone
    option name 'hotspot'
    option input 'REJECT'
    option output 'ACCEPT'
    option forward 'REJECT'
    option network 'hotspot'

config forwarding
    option src 'hotspot'
    option dest 'wan'

config rule
    option name 'Allow-RADIUS-Auth'
    option src 'wan'
    option dest_port '1812'
    option proto 'udp'
    option target 'ACCEPT'

config rule
    option name 'Allow-RADIUS-Acct'
    option src 'wan'
    option dest_port '1813'
    option proto 'udp'
    option target 'ACCEPT'

config rule
    option name 'Allow-Chilli-Portal'
    option src 'hotspot'
    option dest_port '3990'
    option proto 'tcp'
    option target 'ACCEPT'
EOF
```

---

### Step 7: Install WebSocket Bridge

Create the bridge directory:

```bash
mkdir -p /root/spotfi-bridge
cd /root/spotfi-bridge
```

Create the Python WebSocket bridge:

```bash
cat > /root/spotfi-bridge/bridge.py << 'PYEOF'
#!/usr/bin/env python3
"""
SpotFi WebSocket Bridge for OpenWRT
Connects OpenWRT router to SpotFi backend for real-time monitoring
"""

import websocket
import json
import time
import subprocess
import os
import sys

# Configuration from environment or defaults
ROUTER_ID = os.getenv('SPOTFI_ROUTER_ID', 'cmhujj1f6000112soujpo0noz')
TOKEN = os.getenv('SPOTFI_TOKEN', 'e26b8c19afa977503f6cf26f39f431e891e7398b0022a43347066b2270fcbf92')
MAC = os.getenv('SPOTFI_MAC', '08:00:27:BA:FE:8D')
WS_URL = os.getenv('SPOTFI_WS_URL', 'ws://192.168.42.181:8080/ws')

class SpotFiBridge:
    def __init__(self):
        self.ws = None
        self.running = True
        self.last_metrics_time = 0
        
    def get_router_metrics(self):
        """Get router metrics using OpenWRT commands"""
        try:
            metrics = {}
            
            # CPU load
            try:
                with open('/proc/loadavg', 'r') as f:
                    load = f.read().split()[0]
                metrics['cpuLoad'] = float(load) * 100  # Convert to percentage
            except:
                metrics['cpuLoad'] = 0
            
            # Memory
            try:
                with open('/proc/meminfo', 'r') as f:
                    meminfo = f.read()
                    total = int([x for x in meminfo.split('\n') if 'MemTotal' in x][0].split()[1])
                    free = int([x for x in meminfo.split('\n') if 'MemFree' in x][0].split()[1])
                metrics['freeMemory'] = free
                metrics['totalMemory'] = total
            except:
                metrics['freeMemory'] = 0
                metrics['totalMemory'] = 0
            
            # Uptime
            try:
                with open('/proc/uptime', 'r') as f:
                    uptime_seconds = int(float(f.read().split()[0]))
                metrics['uptime'] = str(uptime_seconds)
            except:
                metrics['uptime'] = '0'
            
            # Active users from CoovaChilli
            try:
                result = subprocess.check_output(['chilli_query', 'list'], stderr=subprocess.DEVNULL)
                # Count non-header lines
                lines = result.decode().strip().split('\n')
                active_users = max(0, len(lines) - 1)  # Subtract header
                metrics['activeUsers'] = active_users
            except:
                metrics['activeUsers'] = 0
            
            return metrics
        except Exception as e:
            print(f"Error getting metrics: {e}", file=sys.stderr)
            return {}
    
    def on_message(self, ws, message):
        """Handle incoming WebSocket messages"""
        try:
            data = json.loads(message)
            msg_type = data.get('type')
            
            print(f"Received: {msg_type}")
            
            if msg_type == 'pong':
                pass  # Heartbeat acknowledged
            elif msg_type == 'command':
                self.handle_command(data.get('command'))
            elif msg_type == 'connected':
                print(f"✓ Registered with server: {data.get('routerId')}")
                
        except Exception as e:
            print(f"Error handling message: {e}", file=sys.stderr)
    
    def handle_command(self, command):
        """Execute commands from server"""
        print(f"Executing: {command}")
        
        try:
            if command == 'reboot':
                subprocess.run(['reboot'])
            elif command == 'get-status':
                self.send_metrics()
            elif command == 'fetch-logs':
                try:
                    logs = subprocess.check_output(['logread', '-l', '50']).decode()
                    self.send_message({'type': 'logs', 'data': logs})
                except Exception as e:
                    print(f"Error fetching logs: {e}", file=sys.stderr)
            elif command == 'restart-chilli':
                subprocess.run(['/etc/init.d/chilli', 'restart'])
            else:
                print(f"Unknown command: {command}")
        except Exception as e:
            print(f"Command execution failed: {e}", file=sys.stderr)
    
    def on_error(self, ws, error):
        print(f"WebSocket error: {error}", file=sys.stderr)
    
    def on_close(self, ws, close_status_code, close_msg):
        print("WebSocket closed. Reconnecting in 5s...")
        time.sleep(5)
        if self.running:
            self.connect()
    
    def on_open(self, ws):
        print("✓ WebSocket connected")
        # Send initial metrics
        self.send_metrics()
    
    def send_message(self, data):
        """Send message to server"""
        if self.ws and self.ws.sock and self.ws.sock.connected:
            try:
                self.ws.send(json.dumps(data))
            except Exception as e:
                print(f"Error sending message: {e}", file=sys.stderr)
    
    def send_metrics(self):
        """Send router metrics to server"""
        metrics = self.get_router_metrics()
        if metrics:
            self.send_message({
                'type': 'metrics',
                'metrics': metrics
            })
            self.last_metrics_time = time.time()
    
    def send_ping(self):
        """Send periodic ping"""
        self.send_message({'type': 'ping'})
    
    def connect(self):
        """Connect to WebSocket server"""
        url = f"{WS_URL}?id={ROUTER_ID}&token={TOKEN}&mac={MAC}"
        print(f"Connecting to {WS_URL}...")
        
        try:
            self.ws = websocket.WebSocketApp(
                url,
                on_message=self.on_message,
                on_error=self.on_error,
                on_close=self.on_close,
                on_open=self.on_open
            )
            
            # Run with ping/pong
            self.ws.run_forever(ping_interval=60, ping_timeout=10)
        except Exception as e:
            print(f"Connection error: {e}", file=sys.stderr)
            raise
    
    def start(self):
        """Start the bridge"""
        print("SpotFi Bridge starting...")
        print(f"Router ID: {ROUTER_ID}")
        print(f"Server: {WS_URL}")
        
        while self.running:
            try:
                self.connect()
            except KeyboardInterrupt:
                print("\nShutting down...")
                self.running = False
            except Exception as e:
                print(f"Connection error: {e}", file=sys.stderr)
                print("Retrying in 10s...")
                time.sleep(10)

if __name__ == '__main__':
    bridge = SpotFiBridge()
    bridge.start()
PYEOF

chmod +x /root/spotfi-bridge/bridge.py
```

Create environment configuration:

```bash
cat > /etc/spotfi.env << 'EOF'
export SPOTFI_ROUTER_ID="cmhujj1f6000112soujpo0noz"
export SPOTFI_TOKEN="e26b8c19afa977503f6cf26f39f431e891e7398b0022a43347066b2270fcbf92"
export SPOTFI_MAC="08:00:27:BA:FE:8D"
export SPOTFI_WS_URL="ws://192.168.42.181:8080/ws"
EOF
```

**Important:** Replace with your actual values from Step 1!

---

### Step 8: Create Init Scripts

Create startup script for WebSocket bridge:

```bash
cat > /etc/init.d/spotfi-bridge << 'EOF'
#!/bin/sh /etc/rc.common

START=99
STOP=10

USE_PROCD=1
PROG=/root/spotfi-bridge/bridge.py

start_service() {
    # Load environment variables
    . /etc/spotfi.env
    
    procd_open_instance
    procd_set_param command /usr/bin/python3 $PROG
    procd_set_param respawn ${respawn_threshold:-3600} ${respawn_timeout:-5} ${respawn_retry:-5}
    procd_set_param stdout 1
    procd_set_param stderr 1
    procd_set_param env SPOTFI_ROUTER_ID="$SPOTFI_ROUTER_ID"
    procd_set_param env SPOTFI_TOKEN="$SPOTFI_TOKEN"
    procd_set_param env SPOTFI_MAC="$SPOTFI_MAC"
    procd_set_param env SPOTFI_WS_URL="$SPOTFI_WS_URL"
    procd_close_instance
}

stop_service() {
    killall python3 2>/dev/null
}
EOF

chmod +x /etc/init.d/spotfi-bridge
```

---

### Step 9: Enable and Start Services

```bash
# Enable CoovaChilli
/etc/init.d/chilli enable
/etc/init.d/chilli start

# Enable WebSocket bridge
/etc/init.d/spotfi-bridge enable
/etc/init.d/spotfi-bridge start

# Restart network to apply changes
/etc/init.d/network restart

# Restart firewall
/etc/init.d/firewall restart
```

---

### Step 10: Verify Setup

Check that services are running:

```bash
# Check CoovaChilli status
/etc/init.d/chilli status

# Check WebSocket bridge
ps | grep bridge.py

# Check logs
logread | grep -i chilli
logread | grep -i spotfi

# Test RADIUS connectivity
chilli_query list
```

Check in SpotFi dashboard:
- Router should show as **ONLINE**
- Status should update within 60 seconds

---

## 🔧 Advanced Configuration

### Custom Captive Portal Page

You can customize the login page by modifying CoovaChilli's web interface:

```bash
# Install web files
opkg install coova-chilli-www

# Edit portal page
vi /etc/chilli/www/index.html
```

Or redirect to your own portal server:

```bash
# In /etc/chilli/config
HS_UAMSERVER=http://your-portal.com/login
```

---

### Bandwidth Limits via RADIUS

SpotFi can send bandwidth limits through RADIUS attributes. CoovaChilli automatically applies them:

- **WISPr-Bandwidth-Max-Down**: Download speed limit (bps)
- **WISPr-Bandwidth-Max-Up**: Upload speed limit (bps)

These are configured in your SpotFi RADIUS user settings.

---

### Session Timeout

Control session duration via RADIUS:

```bash
# RADIUS sends Session-Timeout attribute
# CoovaChilli automatically disconnects user after timeout
```

View active sessions:

```bash
chilli_query list
```

Disconnect a user:

```bash
chilli_query logout <MAC_ADDRESS>
```

---

## 🔍 Troubleshooting

### Problem: "Router shows OFFLINE"

**Check:**
```bash
# Check if bridge is running
ps | grep bridge.py

# Check bridge logs
logread | grep spotfi

# Test network connectivity
ping 192.168.42.181

# Manually test WebSocket bridge
/root/spotfi-bridge/bridge.py
```

**Fix:**
```bash
# Restart bridge
/etc/init.d/spotfi-bridge restart

# Check environment variables
cat /etc/spotfi.env
```

---

### Problem: "Users can't authenticate"

**Check:**
```bash
# Check CoovaChilli status
/etc/init.d/chilli status

# Check RADIUS connectivity
chilli_query list

# Check logs
logread | grep -E "chilli|radius"

# Test RADIUS manually
echo "User-Name=testuser,User-Password=testpass" | radclient 192.168.42.181:1812 auth YOUR_RADIUS_SECRET
```

**Fix:**
```bash
# Verify RADIUS settings in /etc/chilli/config
cat /etc/chilli/config | grep RADIUS

# Restart CoovaChilli
/etc/init.d/chilli restart
```

---

### Problem: "No internet after login"

**Check:**
```bash
# Check firewall rules
iptables -L -n -v

# Check NAT
iptables -t nat -L -n -v

# Check routing
ip route show
```

**Fix:**
```bash
# Restart network
/etc/init.d/network restart

# Restart firewall
/etc/init.d/firewall restart

# Restart CoovaChilli
/etc/init.d/chilli restart
```

---

### Problem: "High CPU usage"

**Check:**
```bash
# Check processes
top

# Check memory
free

# Check CoovaChilli connections
chilli_query list
```

**Fix:**
```bash
# Reduce logging
# In /etc/chilli/config, set:
HS_DEBUG=0

# Limit sessions if needed
# Add to /etc/chilli/config:
HS_MAXCLIENTS=50
```

---

## 📊 Monitoring Commands

```bash
# View active hotspot users
chilli_query list

# View system resources
top
free
df -h

# View logs
logread
logread -f  # Follow logs in real-time

# View network statistics
ifconfig
cat /proc/net/dev

# View firewall stats
iptables -L -n -v
```

---

## 🔐 Security Best Practices

### 1. Change Default Password

```bash
passwd root
```

### 2. Use SSH Keys

```bash
# On your computer, generate key
ssh-keygen -t ed25519

# Copy to router
ssh-copy-id root@192.168.1.1

# Disable password login
vi /etc/config/dropbear
# Set: option PasswordAuth 'off'
/etc/init.d/dropbear restart
```

### 3. Enable Firewall

```bash
# Firewall is enabled by default
# But verify:
/etc/init.d/firewall status

# Block SSH from WAN
uci set firewall.@rule[-1].enabled='0'
uci commit firewall
/etc/init.d/firewall restart
```

### 4. Secure RADIUS Secret

```bash
# Use strong random secret (from SpotFi)
# Never share or commit to version control
# Store securely in /etc/spotfi.env
chmod 600 /etc/spotfi.env
```

---

## 🆘 Support Commands

### Get Router Info

```bash
# System info
ubus call system board

# Network info
ubus call network.interface dump

# WiFi info
iw dev

# Package list
opkg list-installed

# Export config for support
sysupgrade -b /tmp/backup.tar.gz
```

---

## ✅ Setup Checklist

- [ ] Router created in SpotFi (got ID, token, secret)
- [ ] OpenWRT packages installed (CoovaChilli, Python)
- [ ] CoovaChilli configured with correct RADIUS settings
- [ ] Network interfaces configured
- [ ] WiFi configured
- [ ] Firewall configured
- [ ] WebSocket bridge installed
- [ ] Services enabled and started
- [ ] Test authentication successful
- [ ] Router shows ONLINE in SpotFi dashboard
- [ ] Test user can connect and browse internet
- [ ] Sessions appear in SpotFi dashboard

---

## 📚 Additional Resources

- [OpenWRT Documentation](https://openwrt.org/docs/start)
- [CoovaChilli Documentation](http://coova.github.io/CoovaChilli/)
- [SpotFi API Documentation](../README.md)

---

**Your OpenWRT router is now integrated with SpotFi!** 🎉

Users can connect to your hotspot, and sessions will appear in your dashboard instantly with real-time accounting data.

