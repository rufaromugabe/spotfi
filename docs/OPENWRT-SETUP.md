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

## 🚀 Quick Setup (5 Minutes)

### Step 1: Create Router in SpotFi Dashboard

**Option A: Create via Dashboard (Recommended)**

1. Log in to SpotFi dashboard as Admin
2. Navigate to **Routers** → **Add Router**
3. Fill in router details:
   - **Name**: e.g., "Main Office Router"
   - **Host**: Select the host user
   - **MAC Address**: Router's MAC address (auto-detected if router connects first)
   - **Location**: Optional location description
4. Click **Create Router**
5. **Copy the Router Token** - you'll need this for Step 2

**Option B: Create via API:**

```bash
curl -X POST http://192.168.56.1:8080/api/routers \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Main Office Router",
    "hostId": "HOST_USER_ID",
    "macAddress": "00:11:22:33:44:55",
    "location": "Main Office - Floor 1"
  }'
```

**Example Response:**

```json
{
  "router": {
    "id": "cmichrwmz0003zijqm53zfpdr",
    "name": "Main Office Router",
    "token": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
    "status": "OFFLINE",
    "macAddress": "00:11:22:33:44:55"
  }
}
```

**Important:** Save the `token` value - this is all you need for setup!

**Note:** When a router is created, SpotFi automatically generates two unique secrets:
- **UAM Secret**: For portal CHAP authentication (challenge transformation)
- **RADIUS Secret**: For RADIUS server communication (authentication/accounting)

These secrets are stored securely in the database and used automatically - you don't need to manage them manually.

---

### Step 2: Install SpotFi Bridge on Router

SSH into your OpenWRT router:

```bash
ssh root@192.168.1.1
```

**📦 Download Setup Script**

**For Public Repository:**

```bash
wget -O /tmp/openwrt-setup-cloud.sh https://raw.githubusercontent.com/rufaromugabe/spotfi/main/scripts/openwrt-setup-cloud.sh
chmod +x /tmp/openwrt-setup-cloud.sh
```

**For Private Repository (with GitHub Token):**

> **Note:** BusyBox `wget` on OpenWRT doesn't support `--header`. Use `curl` instead, or install full `wget`.

Create a GitHub Personal Access Token:

1. Go to GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Generate new token with `repo` scope
3. Copy the token (starts with `ghp_`)

**Option 1: Using curl (Recommended - works with BusyBox):**

```bash
# Store token securely
echo "ghp_your_token_here" > /etc/github_token
chmod 600 /etc/github_token

# Download script using curl
curl -H "Authorization: token $(cat /etc/github_token)" \
     -H "Accept: application/vnd.github.v3.raw" \
     -o /tmp/openwrt-setup-cloud.sh \
     "https://api.github.com/repos/rufaromugabe/spotfi/contents/scripts/openwrt-setup-cloud.sh"
chmod +x /tmp/openwrt-setup-cloud.sh
```

**Option 2: Install full wget (if curl not available):**

```bash
# Install full wget package
opkg update
opkg install wget

# Then use wget with headers
echo "ghp_your_token_here" > /etc/github_token
chmod 600 /etc/github_token

wget --header="Authorization: token $(cat /etc/github_token)" \
     --header="Accept: application/vnd.github.v3.raw" \
     -O /tmp/openwrt-setup-cloud.sh \
     "https://api.github.com/repos/rufaromugabe/spotfi/contents/scripts/openwrt-setup-cloud.sh"
chmod +x /tmp/openwrt-setup-cloud.sh
```

**Option 3: Manual download (if both fail):**

1. Download the script on your computer from: `https://github.com/rufaromugabe/spotfi/blob/main/scripts/openwrt-setup-cloud.sh`
2. Copy to router via SCP:
   ```bash
   # From your computer
   scp openwrt-setup-cloud.sh root@192.168.1.1:/tmp/
   ```
3. On router:
   ```bash
   chmod +x /tmp/openwrt-setup-cloud.sh
   ```

---

### Step 3: Run Setup Script (Token-Only)

**Cloudflare Tunnel-like Setup - Just provide your token!**

```bash
# Basic usage (uses default MQTT broker: ssl://mqtt.spotfi.cloud:8883)
sh /tmp/openwrt-setup-cloud.sh YOUR_ROUTER_TOKEN

# With custom MQTT broker (for self-hosting)
# Format: sh script.sh TOKEN MQTT_BROKER GITHUB_TOKEN
# IMPORTANT: MQTT broker URL must be: ssl://host:port or tcp://host:port (no trailing slash!)
sh /tmp/openwrt-setup-cloud.sh YOUR_ROUTER_TOKEN ssl://mqtt.example.com:8883



# With GitHub token (if not stored in /etc/github_token)
sh /tmp/openwrt-setup-cloud.sh YOUR_ROUTER_TOKEN ssl://mqtt.example.com:8883 ghp_your_token_here
```

**Note:** 
- The SpotFi bridge uses **MQTT only** - no WebSocket connections. All communication flows through the MQTT broker.
- **MQTT Broker URL Format:** Must be `ssl://host:port` or `tcp://host:port` (no trailing slash, no path, no query parameters)
  - ✅ Correct: `ssl://mqtt.example.com:8883`
  - ❌ Wrong: `ssl://mqtt.example.com/:8883` (trailing slash before port)
  - ❌ Wrong: `ssl://mqtt.example.com:8883/ws` (path)
  - ❌ Wrong: `ssl://mqtt.example.com:8883?token=xxx` (query params)

**Example:**

```bash
# Using token from Step 1
sh /tmp/openwrt-setup-cloud.sh test-router-token-123
```

**What the script does:**

- ✅ Detects router architecture automatically
- ✅ Downloads and installs SpotFi bridge binary (MQTT-only)
- ✅ Auto-detects MAC address
- ✅ Creates minimal config with just token
- ✅ Sets up init scripts and starts service

**Environment Variables Created:**

The script creates `/etc/spotfi.env` with:

```bash
SPOTFI_TOKEN="a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"
SPOTFI_MQTT_BROKER="ssl://mqtt.spotfi.cloud:8883"
SPOTFI_MAC="00:11:22:33:44:55"  # Auto-detected
```

**Note:** 
- The router will connect with just the token. The cloud identifies the router and provides all configuration.
- The bridge uses **MQTT exclusively** - all communication (metrics, RPC commands, terminal sessions) flows through the MQTT broker.
- No WebSocket connections are used.

---

### Step 3.5: Understanding the MQTT Bridge Architecture

**MQTT-Only Communication:**

The SpotFi bridge uses **MQTT exclusively** for all communication. No WebSocket connections are used.

**MQTT Topics Used:**

- `spotfi/router/{id}/metrics` - Router heartbeat and metrics (published every 30s)
- `spotfi/router/{id}/status` - Online/Offline status (with Last Will and Testament)
- `spotfi/router/{id}/rpc/request` - Incoming RPC commands from API
- `spotfi/router/{id}/rpc/response` - RPC responses to API
- `spotfi/router/{id}/x/in` - Incoming terminal tunnel data from API
- `spotfi/router/{id}/x/out` - Outgoing terminal tunnel data to API

**Benefits of MQTT:**

- ✅ Lightweight protocol - perfect for resource-constrained routers
- ✅ Built-in QoS and message persistence
- ✅ Automatic reconnection with Last Will and Testament
- ✅ Efficient pub/sub model for real-time communication
- ✅ Works through firewalls and NAT without special configuration

**Connection Flow:**

1. Bridge connects to MQTT broker using router token for authentication
2. Bridge subscribes to router-specific topics
3. Bridge publishes metrics and status updates
4. API sends commands via MQTT topics
5. Bridge responds via MQTT topics

---

### Step 4: Configure uSpot from Cloud (Optional)

If you need captive portal functionality, configure uSpot remotely from the SpotFi dashboard:

**Option A: Via Dashboard (Recommended)**

1. Wait for router to appear as **ONLINE** in dashboard (30-60 seconds)
2. Navigate to router settings
3. Click **Setup uSpot** or **Configure Captive Portal**
4. The cloud will remotely install packages and configure everything

**Option B: Via API:**

```bash
# Setup uSpot remotely (installs packages, configures network, firewall, portal)
curl -X POST http://192.168.56.1:8080/api/routers/ROUTER_ID/uspot/setup \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"

# Then configure UAM/RADIUS
# Note: Router secrets (uamSecret and radiusSecret) are automatically generated
# when the router is created - you don't need to provide them manually
curl -X POST http://192.168.56.1:8080/api/routers/ROUTER_ID/uam/configure \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "authMode": "uam",
    "uamServerUrl": "https://api.spotfi.com/uam/login",
    "radiusServer": "YOUR_RADIUS_IP:1812"
  }'
```

**What happens:**

- ✅ Installs uSpot packages remotely
- ✅ Configures network interfaces (LAN + hotspot)
- ✅ Sets up firewall rules
- ✅ Configures HTTPS portal
- ✅ Uses router's automatically generated secrets:
  - **UAM Secret**: Used for CHAP challenge transformation in portal authentication
  - **RADIUS Secret**: Used for RADIUS authentication/accounting with FreeRADIUS server
- ✅ Restarts services

**No manual configuration needed!** Everything is done from the cloud.

**Note:** Each router automatically gets two unique secrets when created:
- **`uamSecret`**: Used for UAM portal CHAP authentication (challenge transformation)
- **`radiusSecret`**: Used for RADIUS server communication (authentication and accounting)

These secrets are generated automatically and stored securely - you don't need to provide or manage them manually.

---

### Step 5: Verify Setup

After running the script, verify everything is working:

**On Router:**

```bash
# Check SpotFi bridge is running
ps | grep spotfi-bridge
/etc/init.d/spotfi-bridge status

# Restart the bridge
/etc/init.d/spotfi-bridge restart

# Check service logs
logread | grep spotfi-bridge

# View configuration
cat /etc/spotfi.env
```

**In SpotFi Dashboard:**

- Router should show as **ONLINE** within 30-60 seconds
- You can now configure router remotely from dashboard
- If uSpot was configured, check captive portal functionality

**Test Remote Configuration:**

```bash
# From dashboard or API, you can now:
# - View router metrics
# - Execute commands
# - Configure network
# - Setup uSpot (if not done yet)
# - View active sessions
```

---

## 📝 Manual Setup (Advanced)

If you prefer to configure everything manually instead of using the automated scripts, the following sections detail each step. **Note:** The automated scripts handle all of this automatically.

### Manual Configuration Steps

The automated scripts (`openwrt-setup-cloud.sh` and `openwrt-setup-uspot.sh`) handle:

- ✅ Package installation
- ✅ Uspot configuration (if using Uspot script)
- ✅ Network interface setup
- ✅ WiFi configuration
- ✅ Firewall rules
- ✅ MQTT bridge installation (if using cloud script)
- ✅ Service initialization

For manual configuration details, see the script source code on GitHub or refer to the troubleshooting section below.

## 🔧 Advanced Configuration

> **Note:** Most configuration is handled automatically by the setup scripts. Only modify these settings if you need custom behavior.

### Custom Captive Portal Page

You can customize the login page by configuring uspot to use your own portal URL:

```bash
# Configure uspot to use custom portal (using named section 'hotspot')
uci set uspot.hotspot.auth_mode='uam'
uci set uspot.hotspot.uam_url="https://your-portal.com/portal"
uci commit uspot
/etc/init.d/uspot restart
```

The portal form must submit to the router's UAM endpoint: `http://<uamip>:<uamport>/logon`

---

### Bandwidth Limits via RADIUS

SpotFi can send bandwidth limits through RADIUS attributes. Uspot automatically applies them:

- **WISPr-Bandwidth-Max-Down**: Download speed limit (bps)
- **WISPr-Bandwidth-Max-Up**: Upload speed limit (bps)

These are configured in your SpotFi RADIUS user settings.

---

### Session Timeout

Control session duration via RADIUS:

```bash
# RADIUS sends Session-Timeout attribute
# Uspot automatically disconnects user after timeout
```

View active sessions:

```bash
ubus call uspot client_list
```

Disconnect a user:

```bash
ubus call uspot client_remove '{"address": "AA:BB:CC:DD:EE:FF"}'
```

---

## 🔍 Troubleshooting

### Problem: "wget: unrecognized option: header"

**Error:**

```
wget: unrecognized option: header=Authorization: token ...
```

**Cause:**
BusyBox `wget` (default on OpenWRT) doesn't support the `--header` option. This is needed for downloading from private GitHub repositories.

**Solutions:**

**Solution 1: Use curl (Recommended)**

```bash
# Check if curl is available
which curl

# If available, use curl instead:
curl -H "Authorization: token $(cat /etc/github_token)" \
     -H "Accept: application/vnd.github.v3.raw" \
     -o /tmp/openwrt-setup-cloud.sh \
     "https://api.github.com/repos/rufaromugabe/spotfi/contents/scripts/openwrt-setup-cloud.sh"
chmod +x /tmp/openwrt-setup-cloud.sh
```

**Solution 2: Install full wget**

```bash
# Install full wget package (replaces BusyBox wget)
opkg update
opkg install wget

# Now wget with headers will work
wget --header="Authorization: token $(cat /etc/github_token)" \
     --header="Accept: application/vnd.github.v3.raw" \
     -O /tmp/openwrt-setup-cloud.sh \
     "https://api.github.com/repos/rufaromugabe/spotfi/contents/scripts/openwrt-setup-cloud.sh"
chmod +x /tmp/openwrt-setup-cloud.sh
```

**Solution 3: Install curl (if not available)**

```bash
# Install curl package
opkg update
opkg install curl ca-bundle

# Then use curl (see Solution 1)
```

**Solution 4: Manual download**
If you can't install packages, download the script on your computer and copy it:

```bash
# On your computer, download the script
# Then copy to router via SCP:
scp openwrt-setup-cloud.sh root@192.168.1.1:/tmp/

# On router:
chmod +x /tmp/openwrt-setup-cloud.sh
```

---

### Problem: "Router shows OFFLINE"

**Check:**

```bash
# Check if bridge is running
ps | grep spotfi-bridge

# Check bridge service status
/etc/init.d/spotfi-bridge status

# Check bridge logs
logread | grep spotfi-bridge

# Check MQTT connection
logread | grep MQTT

# View configuration
cat /etc/spotfi.env

# Test network connectivity
ping api.spotfi.com
```

**Fix:**

```bash
# Restart bridge
/etc/init.d/spotfi-bridge restart

# Check environment variables
cat /etc/spotfi.env
```

---

### Problem: "Bridge not connecting to MQTT broker"

**Error Message:**

```
MQTT connection failed: connection refused
or
Failed to connect to MQTT broker
or
Connecting to ssl://mqtt.example.com/:8883/ws?mac=...&token=...
```

**Cause:**
The Go-based bridge cannot connect to the MQTT broker. This could be due to:
- **Incorrect MQTT broker URL format** (most common)
  - Trailing slash before port: `ssl://mqtt.example.com/:8883` ❌
  - Should be: `ssl://mqtt.example.com:8883` ✅
- Network connectivity issues
- Firewall blocking MQTT ports (8883 for SSL, 1883 for TCP)
- MQTT broker authentication failure
- Old bridge binary version

**Fix:**

1. **Check MQTT Broker URL Format:**

```bash
# View current configuration
cat /etc/spotfi.env

# Check if MQTT broker URL has trailing slash or incorrect format
# Should be: ssl://host:port (no trailing slash, no path, no query params)
```

2. **Fix MQTT Broker URL:**

```bash
# Edit the config file
vi /etc/spotfi.env

# Fix the SPOTFI_MQTT_BROKER line:
# Change: ssl://mqtt.example.com/:8883  (wrong - trailing slash)
# To:     ssl://mqtt.example.com:8883   (correct)

# Or re-run setup script with correct URL format
wget -O /tmp/openwrt-setup-cloud.sh https://raw.githubusercontent.com/rufaromugabe/spotfi/main/scripts/openwrt-setup-cloud.sh && \
sh /tmp/openwrt-setup-cloud.sh YOUR_ROUTER_TOKEN ssl://mqtt.example.com:8883
```

3. **Restart Bridge:**

```bash
/etc/init.d/spotfi-bridge restart
```

**Check MQTT Connection:**

```bash
# Check bridge logs for MQTT connection status
logread | grep -i mqtt

# Check if bridge is running
ps | grep spotfi-bridge

# Verify MQTT broker URL in config
cat /etc/spotfi.env | grep MQTT

# Test network connectivity to MQTT broker
ping mqtt.spotfi.cloud
```

**Update Bridge Binary:**
If you need to update just the bridge binary:

```bash
# Stop the service
/etc/init.d/spotfi-bridge stop

# Re-run the setup script - it will download the latest Go binary
wget -O /tmp/openwrt-setup-cloud.sh https://raw.githubusercontent.com/rufaromugabe/spotfi/main/scripts/openwrt-setup-cloud.sh
sh /tmp/openwrt-setup-cloud.sh YOUR_ROUTER_TOKEN

# Or manually download and replace binary
# (check script for download URL based on your architecture)

# Start the service
/etc/init.d/spotfi-bridge start

# Verify
logread | grep spotfi-bridge
```

**Verification:**
After updating, the bridge should connect to MQTT. You can verify by checking logs:

```bash
# Should show "MQTT Client Connected"
logread | grep -i mqtt

# Check bridge status
/etc/init.d/spotfi-bridge status
```

---

### Problem: "Users can't authenticate"

**Check:**

```bash
# Check uspot status
/etc/init.d/uspot status

# Check active clients
ubus call uspot client_list

# Check logs
logread | grep -E "uspot|radius"

# Test RADIUS manually (use the router's radiusSecret from database)
# You can get it from the SpotFi dashboard or API
echo "User-Name=testuser,User-Password=testpass" | radclient 192.168.42.181:1812 auth ROUTER_RADIUS_SECRET
```

**Fix:**

```bash
# Verify RADIUS settings in uspot config
uci show uspot | grep radius

# Restart uspot
/etc/init.d/uspot restart
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

# Restart uspot
/etc/init.d/uspot restart
```

---

### Problem: "High CPU usage"

**Check:**

```bash
# Check processes
top

# Check memory
free

# Check uspot connections
ubus call uspot client_list
```

**Fix:**

```bash
# Reduce logging
# In uspot config, adjust debug level (using named section 'hotspot'):
uci set uspot.hotspot.debug='0'
uci commit uspot
/etc/init.d/uspot restart
```

---

## 📊 Monitoring Commands

```bash
# View active hotspot users
ubus call uspot client_list

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

### 2. Use x Keys

```bash
# On your computer, generate key
x-keygen -t ed25519

# Copy to router
x-copy-id root@192.168.1.1

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

# Block x from WAN
uci set firewall.@rule[-1].enabled='0'
uci commit firewall
/etc/init.d/firewall restart
```

### 4. Router Secrets Management

**Automatic Secret Generation:**
- When a router is created in SpotFi, two unique secrets are automatically generated:
  - **UAM Secret** (`uamSecret`): Used for portal CHAP authentication
  - **RADIUS Secret** (`radiusSecret`): Used for RADIUS server communication
- These secrets are stored securely in the database and used automatically
- You don't need to manually manage or provide these secrets

**Security Best Practices:**
```bash
# Router secrets are stored in SpotFi database
# Never share or commit secrets to version control
# Secrets are automatically used by the API - no manual configuration needed
# If a secret is compromised, re-register the router to generate new secrets
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

- [ ] Router created in SpotFi dashboard (got token)
- [ ] Downloaded setup script from GitHub
- [ ] Ran setup script with router token
- [ ] SpotFi bridge running and service enabled
- [ ] Router shows ONLINE in SpotFi dashboard (30-60 seconds)
- [ ] Can access router remotely from dashboard
- [ ] (Optional) uSpot configured from cloud
- [ ] (Optional) Test authentication successful
- [ ] (Optional) Test user can connect and browse internet
- [ ] (Optional) Sessions appear in SpotFi dashboard

---

## 🧪 Testing in VirtualBox VM

This section covers how to set up and test SpotFi scripts in a VirtualBox VM.

### Prerequisites

- VirtualBox installed
- OpenWRT image (x86/64)
- Host machine with internet access

### Step 1: Download OpenWRT Image

1. Download OpenWRT x86/64 image:

   ```bash
   # Download from https://downloads.openwrt.org/releases/
   # For example, OpenWRT 23.05.5:
   wget https://downloads.openwrt.org/releases/23.05.5/targets/x86/64/openwrt-23.05.5-x86-64-generic-ext4-combined-efi.img.gz

   # Extract the image
   gunzip openwrt-23.05.5-x86-64-generic-ext4-combined-efi.img.gz
   ```

2. Convert to VDI (VirtualBox format):

   ```bash
   # On Linux/Mac
   VBoxManage convertfromraw openwrt-23.05.5-x86-64-generic-ext4-combined-efi.img openwrt.vdi --format VDI

   # On Windows (use VBoxManage from VirtualBox installation directory)
   "C:\Program Files\Oracle\VirtualBox\VBoxManage.exe" convertfromraw openwrt.img openwrt.vdi --format VDI
   ```

### Step 2: Create VirtualBox VM

1. **Create New VM:**

   - Open VirtualBox → New
   - Name: `OpenWRT-Test`
   - Type: Linux
   - Version: Linux 2.6 / 3.x / 4.x (64-bit)
   - Memory: 512 MB (minimum)
   - Hard disk: Use existing → Select `openwrt.vdi`

2. **Configure Network:**

   **Adapter 1 (WAN):**

   - Enable Network Adapter
   - Attached to: Bridged Adapter
   - Name: Your host network adapter (e.g., Ethernet or Wi-Fi)
   - This will get an IP from your router (for internet access)

   **Adapter 2 (LAN/Hotspot):**

   - Enable Network Adapter
   - Attached to: Internal Network
   - Name: `intnet` (create if needed)
   - This will be used for the hotspot network

   **Adapter 3 (Optional - for management):**

   - Enable Network Adapter
   - Attached to: Host-only Adapter
   - Name: `VirtualBox Host-Only Ethernet Adapter`
   - This allows direct x access from host

### Step 3: Start VM and Get IP Address

1. **Start the VM:**

   - Power on the VM
   - Wait for OpenWRT to boot

2. **Get IP address:**

   ```bash
   # In the VM console, run:
   ip addr show
   ```

   You'll see interfaces like:

   - `eth0` - WAN (bridged adapter - gets IP from your router)
   - `eth1` - LAN (internal network)
   - `eth2` - Host-only (management)

3. **Note the IP addresses:**
   - WAN IP: Usually `192.168.x.x` (from your router's DHCP)
   - Host-only IP: Usually `192.168.56.10` (default)

### Step 4: x into OpenWRT VM

From your host machine:

```bash
# Via host-only adapter (recommended for testing)
x root@192.168.56.10

# Or via WAN IP (if accessible)
x root@<WAN_IP>
```

**Default password:** None (OpenWRT has no password by default - set one!)

```bash
# Set root password (inside VM)
passwd
```

### Step 5: Test Cloud Script

1. **Download and run cloud script:**

   ```bash
   # x into VM
   x root@192.168.56.10

   # Download script
   wget -O /tmp/openwrt-setup-cloud.sh https://raw.githubusercontent.com/rufaromugabe/spotfi/main/scripts/openwrt-setup-cloud.sh
   chmod +x /tmp/openwrt-setup-cloud.sh

   # Run script with your router token
   sh /tmp/openwrt-setup-cloud.sh YOUR_ROUTER_TOKEN
   ```

2. **Verify it works:**

   ```bash
   # Check SpotFi bridge is running
   ps | grep spotfi-bridge

   # Check service status
   /etc/init.d/spotfi-bridge status

   # View logs
   logread | grep spotfi-bridge

   # Check configuration
   cat /etc/spotfi.env
   ```

3. **Check SpotFi dashboard:**
   - Router should appear as ONLINE within 30-60 seconds
   - You can now configure router remotely from dashboard

### Step 6: Configure uSpot from Cloud (Optional)

**Note:** uSpot setup is now done remotely from the cloud, not via script.

1. **Via Dashboard:**

   - Wait for router to show ONLINE
   - Navigate to router settings
   - Click **Setup uSpot** or **Configure Captive Portal**
   - Cloud will remotely install and configure everything

2. **Via API:**

   ```bash
   # Setup uSpot remotely (async - returns job ID immediately)
   curl -X POST http://192.168.56.1:8080/api/routers/ROUTER_ID/uspot/setup/async \
     -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "combinedSSID": true,
       "ssid": "SpotFi",
       "password": "none"
     }'
   
   # Check setup progress
   curl http://192.168.56.1:8080/api/routers/ROUTER_ID/uspot/setup/status \
     -H "Authorization: Bearer YOUR_ADMIN_TOKEN"

   # Configure UAM/RADIUS
   # Note: Router secrets are automatically used from the database
   curl -X POST http://192.168.56.1:8080/api/routers/ROUTER_ID/uam/configure \
     -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "authMode": "uam",
       "uamServerUrl": "https://api.spotfi.com/uam/login",
       "radiusServer": "YOUR_RADIUS_IP:1812"
     }'
   ```

3. **Verify uSpot:**

   ```bash
   # Check uspot status
   /etc/init.d/uspot status

   # Check active sessions
   ubus call uspot client_list

   # View logs
   logread | grep uspot
   ```

4. **Connect test client:**
   - Create another VM or use host machine
   - Connect to internal network (`intnet`)
   - Set static IP: `10.1.0.2/24` (gateway: `10.1.0.1`)
   - Try to access any website → Should redirect to captive portal

### Step 7: Verify Network Setup

Inside OpenWRT VM:

```bash
# Check interfaces
ip addr show

# Expected output:
# eth0: WAN (bridged) - has IP from your router
# eth1: LAN (internal) - no IP yet
# br-lan: LAN bridge - used by uspot in VM
```

### Common Issues and Solutions

**Issue: Can't x into VM**

- **Solution:** Use host-only adapter, not bridged
- Check VM network adapter is enabled
- Verify IP: `ip addr show` in VM

**Issue: No internet in VM**

- **Solution:** Check WAN adapter (eth0) is bridged to your network
- Verify it got an IP: `ip addr show eth0`
- Test: `ping google.com`

**Issue: WiFi configuration skipped**

- **Solution:** This is normal! VMs don't have WiFi hardware
- Uspot will use LAN bridge instead
- Check: `ip addr show br-lan`

**Issue: Can't reach SpotFi server**

- **Solution:** Verify VM has internet access
- Check server IP/hostname is reachable: `ping api.spotfi.com`
- For local testing, use your host's IP: `192.168.56.1` (host-only network)

### Testing Tips

1. **Use host-only network for management:**

   - Easier x access from host
   - Stable IP address

2. **Use bridged adapter for WAN:**

   - Allows internet access
   - Can test real server connectivity

3. **Internal network for hotspot:**

   - Isolated network for captive portal testing
   - Connect test clients here

4. **Quick restart after script:**
   ```bash
   # Restart VM or services
   reboot
   # Or restart services individually
   /etc/init.d/network restart
   /etc/init.d/firewall restart
   ```

### VM Network Configuration Example

```
Host Machine
├── Network Adapter (192.168.1.x)
│   └── Bridged to VM eth0 (WAN)
│
├── Host-Only Adapter (192.168.56.1)
│   └── Connected to VM eth2 (Management)
│       └── VM IP: 192.168.56.10
│
└── Internal Network (intnet)
    └── VM eth1 (LAN/Hotspot)
        └── Gateway: 10.1.0.1
            └── Test Client: 10.1.0.2
```

---

## 📚 Additional Resources

- [OpenWRT Documentation](https://openwrt.org/docs/start)
- [Uspot Documentation](https://openwrt.org/docs/guide-user/services/captive-portal/coova-chilli)
- [SpotFi API Documentation](../README.md)
- [Setup Scripts on GitHub](https://github.com/rufaromugabe/spotfi/tree/main/scripts)

---

**Your OpenWRT router is now integrated with SpotFi!** 🎉

Users can connect to your hotspot, and sessions will appear in your dashboard instantly with real-time accounting data.
