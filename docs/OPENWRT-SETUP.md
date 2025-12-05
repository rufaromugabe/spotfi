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

Create a GitHub Personal Access Token:
1. Go to GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Generate new token with `repo` scope
3. Copy the token (starts with `ghp_`)

**Option 1: Store token on router (recommended):**
```bash
# Store token securely
echo "ghp_your_token_here" > /etc/github_token
chmod 600 /etc/github_token

# Download script
wget --header="Authorization: token $(cat /etc/github_token)" \
     --header="Accept: application/vnd.github.v3.raw" \
     -O /tmp/openwrt-setup-cloud.sh \
     "https://api.github.com/repos/rufaromugabe/spotfi/contents/scripts/openwrt-setup-cloud.sh"
chmod +x /tmp/openwrt-setup-cloud.sh
```

**Option 2: Use environment variable:**
```bash
export GITHUB_TOKEN="ghp_your_token_here"
wget --header="Authorization: token ${GITHUB_TOKEN}" \
     --header="Accept: application/vnd.github.v3.raw" \
     -O /tmp/openwrt-setup-cloud.sh \
     "https://api.github.com/repos/rufaromugabe/spotfi/contents/scripts/openwrt-setup-cloud.sh"
chmod +x /tmp/openwrt-setup-cloud.sh
```

---

### Step 3: Run Setup Script (Token-Only)

**Cloudflare Tunnel-like Setup - Just provide your token!**

```bash
# Basic usage (uses default server: wss://api.spotfi.com/ws)
sh /tmp/openwrt-setup-cloud.sh YOUR_ROUTER_TOKEN

# With custom server (for self-hosting)
sh /tmp/openwrt-setup-cloud.sh YOUR_ROUTER_TOKEN wvgss://your-server.com/ws

# With GitHub token (if not stored in /etc/github_token)
sh /tmp/openwrt-setup-cloud.sh YOUR_ROUTER_TOKEN wss://api.spotfi.com/ws ghp_your_token_here
```

**Example:**
```bash
# Using token from Step 1
sh /tmp/openwrt-setup-cloud.sh a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6
```

**What the script does:**
- ✅ Detects router architecture automatically
- ✅ Downloads and installs SpotFi bridge binary
- ✅ Auto-detects MAC address
- ✅ Creates minimal config with just token
- ✅ Sets up init scripts and starts service

**Environment Variables Created:**

The script creates `/etc/spotfi.env` with:
```bash
SPOTFI_TOKEN="a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"
SPOTFI_WS_URL="wss://api.spotfi.com/ws"
SPOTFI_MAC="00:11:22:33:44:55"  # Auto-detected
```

**Note:** The router will connect with just the token. The cloud identifies the router and provides all configuration.

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
curl -X POST http://192.168.56.1:8080/api/routers/ROUTER_ID/uam/configure \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "uamServerUrl": "https://api.spotfi.com/uam/login",
    "radiusServer": "YOUR_RADIUS_IP",
    "radiusSecret": "YOUR_RADIUS_SECRET"
  }'
```

**What happens:**
- ✅ Installs uSpot packages remotely
- ✅ Configures network interfaces (LAN + hotspot)
- ✅ Sets up firewall rules
- ✅ Configures HTTPS portal
- ✅ Restarts services

**No manual configuration needed!** Everything is done from the cloud.


---

### Step 5: Verify Setup

After running the script, verify everything is working:

**On Router:**
```bash
# Check SpotFi bridge is running
ps | grep spotfi-bridge
/etc/init.d/spotfi-bridge status

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
- ✅ WebSocket bridge installation (if using cloud script)
- ✅ Service initialization

For manual configuration details, see the script source code on GitHub or refer to the troubleshooting section below.

## 🔧 Advanced Configuration

> **Note:** Most configuration is handled automatically by the setup scripts. Only modify these settings if you need custom behavior.

### Custom Captive Portal Page

You can customize the login page by configuring uspot to use your own portal URL:

```bash
# Configure uspot to use custom portal
uci set uspot.@instance[0].portal_url="https://your-portal.com/portal"
uci commit uspot
/etc/init.d/uspot restart
```

The portal form must submit to the router's UAM endpoint: `http://<uamip>:<uamport>/login`

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

### Problem: "Router shows OFFLINE"

**Check:**
```bash
# Check if bridge is running
ps | grep spotfi-bridge

# Check bridge service status
/etc/init.d/spotfi-bridge status

# Check bridge logs
logread | grep spotfi-bridge

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

### Problem: "Error starting x session: Exception occurred in preexec_fn"

**Error Message:**
```
Error starting x session: Exception occurred in preexec_fn.
File "/root/spotfi-bridge/bridge.py", line 260, in handle_x_start
```

**Cause:**
This error indicates your router is running an **old version** of `bridge.py` that still uses `preexec_fn`, which is not supported on OpenWrt/BusyBox systems.

**Fix:**
Re-run the setup script with your token:

```bash
# Download and run setup script with your router token
wget -O /tmp/openwrt-setup-cloud.sh https://raw.githubusercontent.com/rufaromugabe/spotfi/main/scripts/openwrt-setup-cloud.sh && \
sh /tmp/openwrt-setup-cloud.sh YOUR_ROUTER_TOKEN
```

**Alternative: Quick Update (Bridge Only)**
If you only need to update the bridge.py file:

```bash
# Stop the service
/etc/init.d/spotfi-bridge stop

# Download and update bridge.py
wget -O /tmp/openwrt-setup-cloud.sh https://raw.githubusercontent.com/rufaromugabe/spotfi/main/scripts/openwrt-setup-cloud.sh

# Extract just the bridge.py part (lines 101-645)
# Or re-run the full setup script - it's safe to run multiple times

# Start the service
/etc/init.d/spotfi-bridge start

# Verify
logread -f | grep -i x
```

**Verification:**
After updating, x sessions should work without errors. You can verify by checking logs:

```bash
# Should NOT show preexec_fn errors anymore
logread | grep -i x
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

# Test RADIUS manually
echo "User-Name=testuser,User-Password=testpass" | radclient 192.168.42.181:1812 auth YOUR_RADIUS_SECRET
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
# In uspot config, adjust debug level:
uci set uspot.@instance[0].debug='0'
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
   # Setup uSpot remotely
   curl -X POST http://192.168.56.1:8080/api/routers/ROUTER_ID/uspot/setup \
     -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
   
   # Configure UAM/RADIUS
   curl -X POST http://192.168.56.1:8080/api/routers/ROUTER_ID/uam/configure \
     -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "uamServerUrl": "https://api.spotfi.com/uam/login",
       "radiusServer": "YOUR_RADIUS_IP",
       "radiusSecret": "YOUR_RADIUS_SECRET"
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

