# MikroTik Router Setup for SpotFi

Complete guide to configure MikroTik routers with SpotFi's real-time accounting system.

---

## 📋 Prerequisites

- MikroTik RouterOS 6.40+ (RouterOS 7+ recommended)
- Admin access to MikroTik router
- Admin access to SpotFi dashboard
- Network connectivity between router and SpotFi server

---

## 🚀 Quick Setup (5 Minutes)

### Step 1: Create Router in SpotFi

**Via API:**
```bash
curl -X POST https://api.spotfi.com/api/routers \
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
    "id": "clm2xyz789",              // ← Router ID
    "token": "abc123...",             // ← WebSocket Token
    "radiusSecret": "def456..."       // ← RADIUS Secret
  }
}
```

---

### Step 2: Configure RADIUS on MikroTik

Connect to your MikroTik router via SSH or Winbox, then run:

```bash
# Add RADIUS server
/radius add \
  service=hotspot \
  address=YOUR_SPOTFI_RADIUS_IP \
  secret=def456... \
  timeout=3s \
  nas-identifier=clm2xyz789

# Enable RADIUS for hotspot
/ip hotspot profile set [find] use-radius=yes

# Optional: Set accounting interval (recommended 300 seconds)
/ip hotspot profile set [find] \
  radius-accounting=yes \
  radius-interim-update=5m
```

**Important:** The `nas-identifier=clm2xyz789` enables **instant session linking** (< 1 second)!

---

### Step 3: Configure Hotspot (If Not Already)

```bash
# Basic hotspot setup (skip if already configured)
/ip hotspot setup
# Follow wizard: choose interface, IP pool, DNS, etc.

# Configure login page (optional)
/ip hotspot profile set [find] \
  html-directory=hotspot \
  login-by=http-pap,http-chap
```

---

### Step 4: Test Connection

#### Test RADIUS Authentication

```bash
# From MikroTik terminal
/radius test \
  address=YOUR_SPOTFI_RADIUS_IP \
  user=testuser \
  password=testpass
```

**Expected output:**
```
status: accepted
```

#### Test User Connection

1. Connect a device to your hotspot WiFi
2. Open browser (should redirect to captive portal)
3. Login with RADIUS credentials
4. Check SpotFi dashboard - session should appear **instantly**

---

## 🔧 Detailed Configuration

### Get Router MAC Address

```bash
# View interface MAC addresses
/interface print

# Use wlan1 MAC for WiFi hotspot
/interface get wlan1 mac-address
```

Use this MAC when creating router in SpotFi.

---

### Configure Multiple RADIUS Servers (High Availability)

```bash
# Primary RADIUS server
/radius add \
  service=hotspot \
  address=primary.spotfi.com \
  secret=YOUR_RADIUS_SECRET \
  nas-identifier=YOUR_ROUTER_ID

# Backup RADIUS server
/radius add \
  service=hotspot \
  address=backup.spotfi.com \
  secret=YOUR_RADIUS_SECRET \
  nas-identifier=YOUR_ROUTER_ID
```

---

### WebSocket Connection (Optional - For Remote Management)

Create a script to maintain WebSocket connection:

```bash
# Create script file
/system script add name=spotfi-connect source={
  :local routerId "clm2xyz789"
  :local token "abc123..."
  :local apiUrl "wss://api.spotfi.com/ws"
  
  # Add MAC parameter for robust tracking
  :local mac [/interface get ether1 mac-address]
  :local macClean [:pick $mac 0 2][:pick $mac 3 5][:pick $mac 6 8][:pick $mac 9 11][:pick $mac 12 14][:pick $mac 15 17]
  
  /tool fetch url="$apiUrl?id=$routerId&token=$token&mac=$macClean" \
    mode=https keep-alive=yes
}

# Run on startup
/system scheduler add \
  name=spotfi-autoconnect \
  on-event=spotfi-connect \
  interval=5m \
  start-time=startup
```

---

## 📊 Verify Setup

### 1. Check RADIUS Configuration

```bash
# View RADIUS settings
/radius print detail

# Should show:
#  service: hotspot
#  address: YOUR_SPOTFI_RADIUS_IP
#  secret: YOUR_RADIUS_SECRET
#  nas-identifier: YOUR_ROUTER_ID
#  timeout: 3s
```

---

### 2. Check Hotspot Profile

```bash
# Verify RADIUS is enabled
/ip hotspot profile print

# Should show:
#  use-radius: yes
#  radius-accounting: yes
```

---

### 3. Monitor RADIUS Traffic

```bash
# Watch RADIUS packets
/tool sniffer quick \
  interface=ether1 \
  port=1812,1813

# Should see Access-Request, Accounting-Start, Accounting-Stop
```

---

### 4. Check Active Sessions

```bash
# View current hotspot users
/ip hotspot active print

# View RADIUS messages
/log print where topics~"radius"
```

---

## 🎯 Advanced Configuration

### Custom Landing Page

```bash
# Upload custom hotspot files
/file print
# Upload via FTP to /hotspot/ directory

# Set custom HTML directory
/ip hotspot profile set [find] html-directory=hotspot-custom
```

---

### Bandwidth Limits (From RADIUS)

SpotFi can send bandwidth limits via RADIUS attributes:

```bash
# MikroTik automatically applies these from RADIUS reply:
# WISPr-Bandwidth-Max-Down: 10000000 (10 Mbps)
# WISPr-Bandwidth-Max-Up: 5000000 (5 Mbps)

# View active limits
/ip hotspot active print detail
```

---

### Session Timeout (From RADIUS)

```bash
# RADIUS sends Session-Timeout attribute
# MikroTik automatically disconnects user after timeout

# View remaining time
/ip hotspot active print detail
# Shows: idle-timeout, uptime, session-time-left
```

---

## 🔍 Troubleshooting

### Problem: "RADIUS not responding"

**Check:**
```bash
# Ping RADIUS server
/ping YOUR_SPOTFI_RADIUS_IP count=5

# Check firewall
/ip firewall filter print where dst-port=1812,1813

# Verify RADIUS secret
/radius print detail
```

**Fix:**
1. Ensure firewall allows UDP ports 1812, 1813
2. Verify RADIUS server IP is correct
3. Confirm RADIUS secret matches SpotFi

---

### Problem: "Authentication failed"

**Check:**
```bash
# Test with known credentials
/radius test address=YOUR_SPOTFI_RADIUS_IP \
  user=testuser password=testpass

# Check logs
/log print where topics~"radius,error"
```

**Fix:**
1. Verify user exists in SpotFi RADIUS users
2. Check password is correct
3. Ensure `nas-identifier` is set

---

### Problem: "Sessions not appearing in SpotFi"

**Check:**
```bash
# Verify NAS-Identifier is set
/radius print detail
# Must show: nas-identifier=YOUR_ROUTER_ID

# Check accounting is enabled
/ip hotspot profile print
# Must show: radius-accounting=yes
```

**Fix:**
1. Add `nas-identifier` to RADIUS config
2. Enable accounting in hotspot profile
3. Restart hotspot: `/ip hotspot disable [find]; /ip hotspot enable [find]`

---

### Problem: "Router shows offline in SpotFi"

**Cause:** WebSocket not connected or router hasn't sent heartbeat

**Fix:**
```bash
# Verify internet connectivity
/ping 8.8.8.8

# Check if script is running
/system scheduler print
/system script print

# Manually run connection script
/system script run spotfi-connect
```

---

## 📱 Complete Example Configuration

```bash
# ===============================================
# Complete MikroTik Hotspot Setup for SpotFi
# ===============================================

# 1. Configure Internet Access
/ip address add address=192.168.88.1/24 interface=ether1
/ip route add gateway=YOUR_ISP_GATEWAY

# 2. Configure WiFi (if using wireless)
/interface wireless set wlan1 \
  mode=ap-bridge \
  ssid="SpotFi-Guest" \
  frequency=auto \
  channel-width=20/40mhz-XX \
  security-profile=default

# 3. Add RADIUS Server
/radius add \
  service=hotspot \
  address=spotfi.example.com \
  secret=YOUR_RADIUS_SECRET \
  timeout=3s \
  nas-identifier=YOUR_ROUTER_ID

# 4. Setup Hotspot
/ip pool add name=hotspot-pool ranges=10.5.50.2-10.5.50.254

/ip hotspot profile add \
  name=spotfi-profile \
  use-radius=yes \
  radius-accounting=yes \
  radius-interim-update=5m \
  login-by=http-pap

/ip hotspot add \
  name=spotfi-hotspot \
  interface=wlan1 \
  address-pool=hotspot-pool \
  profile=spotfi-profile

# 5. Configure DNS
/ip dns set servers=8.8.8.8,8.8.4.4

# 6. NAT for internet access
/ip firewall nat add \
  chain=srcnat \
  action=masquerade \
  out-interface=ether1

# 7. Allow RADIUS traffic
/ip firewall filter add \
  chain=output \
  protocol=udp \
  dst-port=1812,1813 \
  action=accept

# Setup complete!
```

---

## 🔐 Security Best Practices

### 1. Use Strong RADIUS Secret
```bash
# Generate strong secret (32+ characters)
# Use in both MikroTik and SpotFi
```

### 2. Enable Firewall
```bash
# Block unauthorized access to router
/ip firewall filter add \
  chain=input \
  protocol=tcp \
  dst-port=22,23,8291 \
  src-address-list=!trusted \
  action=drop

# Add trusted IPs
/ip firewall address-list add \
  list=trusted \
  address=YOUR_ADMIN_IP
```

### 3. Use HTTPS for Hotspot
```bash
# Generate SSL certificate
/certificate add name=spotfi-cert \
  common-name=hotspot.local \
  key-usage=digital-signature,key-encipherment

/certificate sign spotfi-cert

# Enable HTTPS
/ip hotspot profile set [find] \
  use-radius=yes \
  ssl-certificate=spotfi-cert
```

### 4. Secure Admin Access
```bash
# Change default credentials
/user set admin password=STRONG_PASSWORD

# Disable unnecessary services
/ip service disable telnet,ftp,www

# Enable only SSH
/ip service set ssh port=2222
```

---

## 📈 Monitoring & Maintenance

### View Statistics
```bash
# Hotspot statistics
/ip hotspot active print
/ip hotspot user print

# RADIUS statistics
/log print where topics~"radius"

# Bandwidth usage
/interface monitor-traffic ether1
```

### Regular Maintenance
```bash
# Update RouterOS (monthly)
/system package update check-for-updates
/system package update download
/system reboot

# Backup configuration (weekly)
/system backup save name=spotfi-backup
/export file=spotfi-config

# Clean old logs (monthly)
/log print count-only
/log print where message~"old-pattern"
```

---

## 🆘 Support Commands

### Diagnostic Info
```bash
# Router info
/system resource print
/system identity print
/system routerboard print

# Network info
/ip address print
/ip route print
/interface print

# Export config for support
/export file=config-for-support
```

### Reset to Defaults (Careful!)
```bash
# Backup first!
/system backup save name=before-reset

# Reset configuration
/system reset-configuration no-defaults=yes

# Or keep basic config
/system reset-configuration keep-users=yes
```

---

## ✅ Setup Checklist

- [ ] Router created in SpotFi (got ID, token, secret)
- [ ] RADIUS server configured with correct IP
- [ ] RADIUS secret matches SpotFi
- [ ] `nas-identifier` set to router ID
- [ ] Hotspot configured and enabled
- [ ] RADIUS accounting enabled
- [ ] Test authentication successful
- [ ] Test session appears in SpotFi (< 1 sec)
- [ ] WebSocket connection active
- [ ] Firewall allows RADIUS traffic
- [ ] Admin password changed from default
- [ ] Configuration backed up

---

## 📚 References

- [MikroTik Hotspot Documentation](https://wiki.mikrotik.com/wiki/Manual:Hotspot)
- [MikroTik RADIUS Configuration](https://wiki.mikrotik.com/wiki/Manual:RADIUS_Client)
- [SpotFi API Documentation](../README.md)

---

**Your MikroTik router is now integrated with SpotFi!** 🎉

Users can connect to your hotspot, and sessions will appear in your dashboard **instantly** (< 1 second). Accounting data is tracked in real-time for accurate billing.

