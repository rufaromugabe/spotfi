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

### Step 1: Get Router Information from SpotFi

**Option A: Create New Router via API:**
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

**Option B: Get Existing Router via API:**
```bash
curl -X GET http://192.168.56.1:8080/api/routers \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**Example Response:**
```json
{
  "routers": [
    {
      "id": "cmichrwmz0003zijqm53zfpdr",
      "name": "Main Office Router",
      "hostId": "cmichrwmh0001zijqnyac16rj",
      "token": "test-router-token-123",
      "radiusSecret": "4e314bb12afc2d2be771429a6d14d6d7",
      "status": "OFFLINE",
      "lastSeen": "2025-11-24T18:55:32.701Z",
      "totalUsage": 0,
      "nasipaddress": "172.18.0.1",
      "macAddress": "00:11:22:33:44:55",
      "location": "Main Office - Floor 1",
      "createdAt": "2025-11-24T01:52:21.751Z",
      "updatedAt": "2025-11-24T18:56:05.985Z",
      "host": {
        "id": "cmichrwmh0001zijqnyac16rj",
        "email": "host@spotfi.com"
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 1,
    "totalPages": 1,
    "hasMore": false
  }
}
```

**Extract the following values from the response:**
- `id` → **ROUTER_ID**: `cmichrwmz0003zijqm53zfpdr`
- `token` → **TOKEN**: `test-router-token-123`
- `macAddress` → **MAC_ADDRESS**: `00:11:22:33:44:55`

**Construct WebSocket URL:**
The WebSocket URL format is: `ws://SERVER_IP:PORT/ws?id=ROUTER_ID&token=TOKEN`

**Example:**
- Server IP: `192.168.56.1`
- Server Port: `8080`
- Router ID: `cmichrwmz0003zijqm53zfpdr`
- Token: `test-router-token-123`

**WebSocket URL:** `ws://192.168.56.1:8080/ws?id=cmichrwmz0003zijqm53zfpdr&token=test-router-token-123`

**Note:** For production with HTTPS, use `wss://` instead of `ws://`

---

### Step 2: Download and Run Setup Scripts

SSH into your OpenWRT router:

```bash
ssh root@192.168.56.10
```

**Choose your setup option:**

#### Option A: WebSocket Bridge Only (Cloud Monitoring)

For routers that only need real-time monitoring and remote control (no captive portal):

**Using the example values from Step 1:**

```bash
# Download and run the cloud setup script
wget -O /tmp/openwrt-setup-cloud.sh https://raw.githubusercontent.com/rufaromugabe/spotfi/main/scripts/openwrt-setup-cloud.sh && \
sh /tmp/openwrt-setup-cloud.sh \
  cmichrwmz0003zijqm53zfpdr \
  test-router-token-123 \
  00:11:22:33:44:55 \
  ws://192.168.56.1:8080/ws
```

**Or with WSS (HTTPS) for production:**
```bash
sh /tmp/openwrt-setup-cloud.sh \
  cmichrwmz0003zijqm53zfpdr \
  test-router-token-123 \
  00:11:22:33:44:55 \
  wss://api.spotfi.com/ws
```

**Note:** Using `sh` explicitly avoids potential "not found" errors on some OpenWrt systems. If you prefer, you can also use `chmod +x` and run directly, but `sh` is more reliable.

**Parameters:**
- `ROUTER_ID` - Router ID from Step 1 (e.g., `cmichrwmz0003zijqm53zfpdr`)
- `TOKEN` - Router token from Step 1 (e.g., `test-router-token-123`)
- `MAC_ADDRESS` - Router MAC address from Step 1 (e.g., `00:11:22:33:44:55`)
- `SERVER_DOMAIN` - (Optional) SpotFi server WebSocket URL
  - For local development: `ws://192.168.56.1:8080/ws`
  - For production: `wss://api.spotfi.com/ws` (default if omitted)

**Environment Variables Created:**

The script creates `/etc/spotfi.env` with:
```bash
SPOTFI_ROUTER_ID="cmichrwmz0003zijqm53zfpdr"
SPOTFI_TOKEN="test-router-token-123"
SPOTFI_MAC="00:11:22:33:44:55"
SPOTFI_WS_URL="ws://192.168.56.1:8080/ws"
SPOTFI_ROUTER_NAME="Main Office Router"
```

**Note:** The server domain is optional and will default to `wss://api.spotfi.com/ws`. If you're self-hosting SpotFi, specify your server WebSocket URL:
```bash
sh /tmp/openwrt-setup-cloud.sh ROUTER_ID TOKEN MAC_ADDRESS ws://your-server-ip:8080/ws
```

**Troubleshooting "not found" error:**

If you get an error like `-ash: /tmp/openwrt-setup-cloud.sh: not found` after downloading the script, use one of these solutions:

**Quick fix (recommended):** Run the script with `sh` explicitly:
```bash
sh /tmp/openwrt-setup-cloud.sh ROUTER_ID TOKEN MAC_ADDRESS
```

**Alternative fix:** The issue is often due to Windows line endings (CRLF). Fix it with:
```bash
# Convert line endings from CRLF to LF using tr (more reliable on BusyBox)
tr -d '\r' < /tmp/openwrt-setup-cloud.sh > /tmp/openwrt-setup-cloud-fixed.sh
mv /tmp/openwrt-setup-cloud-fixed.sh /tmp/openwrt-setup-cloud.sh
chmod +x /tmp/openwrt-setup-cloud.sh

# Then run the script
/tmp/openwrt-setup-cloud.sh ROUTER_ID TOKEN MAC_ADDRESS
```

**One-liner with sh (easiest):**
```bash
wget -O /tmp/openwrt-setup-cloud.sh https://raw.githubusercontent.com/rufaromugabe/spotfi/main/scripts/openwrt-setup-cloud.sh && \
sh /tmp/openwrt-setup-cloud.sh ROUTER_ID TOKEN MAC_ADDRESS
```

#### Option B: Uspot/RADIUS Only (Captive Portal)

For routers that only need captive portal with RADIUS authentication (no WebSocket bridge):

```bash
# Download and run the Uspot setup script (replace with your actual values)
# Portal URL is optional - defaults to https://api.spotfi.com
wget -O /tmp/openwrt-setup-uspot.sh https://raw.githubusercontent.com/rufaromugabe/spotfi/main/scripts/openwrt-setup-uspot.sh && \
sh /tmp/openwrt-setup-uspot.sh \
  cmhujj1f6000112soujpo0noz \
  5d62856936faa4919a8ab07671b04103 \
  08:00:27:BA:FE:8D \
  62.72.19.27 \
  https://c40g8skkog0g0ws44wo0c40s.62.72.19.27.sslip.io
```

wget -O /tmp/openwrt-setup-uspot.sh https://raw.githubusercontent.com/rufaromugabe/spotfi/main/scripts/openwrt-setup-uspot.sh && chmod +x /tmp/openwrt-setup-uspot.sh &&  sh /tmp/openwrt-setup-uspot.sh cmhujj1f6000112soujpo0noz 5d62856936faa4919a8ab07671b04103 08:00:27:BA:FE:8D 62.72.19.27 https://c40g8skkog0g0ws44wo0c40s.62.72.19.27.sslip.io



**Note:** Using `sh` explicitly avoids potential "not found" errors on some OpenWrt systems.

**Parameters:**
- `ROUTER_ID` - Router ID from Step 1
- `RADIUS_SECRET` - RADIUS secret from Step 1
- `MAC_ADDRESS` - Router MAC address
- `RADIUS_IP` - RADIUS server IP
- `PORTAL_URL` - (Optional) Captive portal URL (defaults to `https://api.spotfi.com`)

**Note:** The portal URL is optional and will default to `https://api.spotfi.com`. If you're self-hosting SpotFi, specify your portal URL:
```bash
/tmp/openwrt-setup-uspot.sh ROUTER_ID RADIUS_SECRET MAC_ADDRESS RADIUS_IP https://your-portal.com
```

#### Option C: Both (Run Both Scripts)

If you need both WebSocket bridge AND Uspot, run both scripts in order:

```bash
# First, install WebSocket bridge
wget -O /tmp/openwrt-setup-cloud.sh https://raw.githubusercontent.com/rufaromugabe/spotfi/main/scripts/openwrt-setup-cloud.sh
chmod +x /tmp/openwrt-setup-cloud.sh
/tmp/openwrt-setup-cloud.sh cmhujj1f6000112soujpo0noz e26b8c19afa977... 08:00:27:BA:FE:8D

# Then, install Uspot
wget -O /tmp/openwrt-setup-uspot.sh https://raw.githubusercontent.com/rufaromugabe/spotfi/main/scripts/openwrt-setup-uspot.sh
chmod +x /tmp/openwrt-setup-uspot.sh
/tmp/openwrt-setup-uspot.sh cmhujj1f6000112soujpo0noz 5d62856936faa... 08:00:27:BA:FE:8D 62.72.19.27 https://your-portal.com
```

**Note:** If you need to specify a custom server WebSocket URL, add it as the 4th parameter:
```bash
/tmp/openwrt-setup-cloud.sh ROUTER_ID TOKEN MAC_ADDRESS wss://your-server.com/ws
/tmp/openwrt-setup-uspot.sh ROUTER_ID RADIUS_SECRET MAC_ADDRESS RADIUS_IP https://your-portal.com
```


---

### Step 3: Verify Setup

After running the script(s), verify everything is working:

```bash
# Check WebSocket bridge (if installed)
ps | grep bridge.py
/etc/init.d/spotfi-bridge status

# Check uspot (if installed)
/etc/init.d/uspot status
ubus call uspot client_list

# View logs
logread | tail -n 50
```

Check in SpotFi dashboard:
- Router should show as **ONLINE** (if WebSocket bridge is installed)
- Status should update within 60 seconds

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

### Problem: "Error starting x session: Exception occurred in preexec_fn"

**Error Message:**
```
Error starting x session: Exception occurred in preexec_fn.
File "/root/spotfi-bridge/bridge.py", line 260, in handle_x_start
```

**Cause:**
This error indicates your router is running an **old version** of `bridge.py` that still uses `preexec_fn`, which is not supported on OpenWrt/BusyBox systems.

**Fix:**
Re-run the setup script to update `bridge.py` with the latest version:

```bash
# For cloud setup (WebSocket bridge only)
wget -O /tmp/openwrt-setup-cloud.sh https://raw.githubusercontent.com/rufaromugabe/spotfi/main/scripts/openwrt-setup-cloud.sh && \
sh /tmp/openwrt-setup-cloud.sh \
  YOUR_ROUTER_ID \
  YOUR_TOKEN \
  YOUR_MAC_ADDRESS \
  wss://your-server.com/ws

# Or for Uspot setup (captive portal)
wget -O /tmp/openwrt-setup-uspot.sh https://raw.githubusercontent.com/rufaromugabe/spotfi/main/scripts/openwrt-setup-uspot.sh && \
sh /tmp/openwrt-setup-uspot.sh \
  YOUR_ROUTER_ID \
  YOUR_RADIUS_SECRET \
  YOUR_MAC_ADDRESS \
  YOUR_RADIUS_IP \
  https://your-portal-url.com
```

wget -O /tmp/openwrt-setup-cloud.sh https://raw.githubusercontent.com/rufaromugabe/spotfi/main/scripts/openwrt-setup-cloud.sh && \
sh /tmp/openwrt-setup-cloud.sh \
  cmhujj1f6000112soujpo0noz \
  5d62856936faa4919a8ab07671b04103 \
  08:00:27:BA:FE:8D \
  62.72.19.27

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

- [ ] Router created in SpotFi (got ID, token, secret)
- [ ] Downloaded setup script(s) from GitHub
- [ ] Ran setup script(s) with correct parameters
- [ ] WebSocket bridge running (if using cloud script)
- [ ] Uspot running (if using uspot script)
- [ ] Router shows ONLINE in SpotFi dashboard
- [ ] Test authentication successful (if using uspot)
- [ ] Test user can connect and browse internet (if using uspot)
- [ ] Sessions appear in SpotFi dashboard (if using uspot)

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
   
   # Run script (replace with your actual values)
   /tmp/openwrt-setup-cloud.sh ROUTER_ID TOKEN MAC_ADDRESS
   ```

2. **Verify it works:**
   ```bash
   # Check WebSocket bridge is running
   ps | grep bridge.py
   
   # Check service status
   /etc/init.d/spotfi-bridge status
   
   # View logs
   logread | tail -n 50
   ```

3. **Check SpotFi dashboard:**
   - Router should appear as ONLINE
   - Metrics should be updating

### Step 6: Test Uspot Script (Optional)

**Note:** In a VM, there's no WiFi, but uspot will use the LAN bridge.

1. **Download and run uspot script:**
   ```bash
   # Download script
   wget -O /tmp/openwrt-setup-uspot.sh https://raw.githubusercontent.com/rufaromugabe/spotfi/main/scripts/openwrt-setup-uspot.sh
   chmod +x /tmp/openwrt-setup-uspot.sh
   
   # Run script (replace with your actual values)
   sh /tmp/openwrt-setup-uspot.sh ROUTER_ID RADIUS_SECRET MAC_ADDRESS RADIUS_IP PORTAL_URL
   ```

2. **Expected behavior in VM:**
   - WiFi configuration will be skipped (normal for VMs)
   - Uspot will use LAN bridge (`br-lan`)
   - Script will configure hotspot interface on LAN bridge

3. **Test captive portal:**
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

