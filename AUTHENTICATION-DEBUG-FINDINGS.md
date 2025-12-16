# Authentication Debug Findings

## Date: Dec 16, 2025

## Problem Summary
User seeing "Authentication failed" message when trying to login to captive portal.

## Root Cause Analysis

### ✅ What's Working:
1. **API Server**: Running and accessible at `https://app.31.97.217.241.sslip.io`
2. **RADIUS Server**: Reachable from router (31.97.217.241:1812)
3. **Router Configuration**: Properly configured with UAM mode
4. **Network Connectivity**: Router can ping RADIUS server (196-220ms latency)
5. **uSpot Service**: Running on router
6. **UAM Handler**: Script present at `/usr/share/uspot/handler-uam.uc`

### ❌ The Issue:
**User was connecting from the WRONG network!**

## Network Configuration

### Hotspot WiFi (Captive Portal) ✅
- **SSID**: `HIT GUEST`
- **Interface**: br-hotspot
- **IP Range**: 10.1.30.x
- **Gateway**: 10.1.30.1
- **UAM Enabled**: YES
- **Physical**: phy0-ap0, radio0 + radio1

### Admin WiFi (No Captive Portal) ❌
- **SSID**: `SpotFi-Admin`
- **Interface**: br-lan
- **IP Range**: 192.168.1.x
- **Gateway**: 192.168.1.1
- **UAM Enabled**: NO
- **Physical**: phy0-ap1

## Router Configuration Details

```bash
uspot.hotspot.auth_mode='uam'
uspot.hotspot.auth_server='31.97.217.241'
uspot.hotspot.auth_port='1812'
uspot.hotspot.auth_secret='testing123'           # RADIUS master secret
uspot.hotspot.nasid='Rufaro-Main-'
uspot.hotspot.nasmac='80:AF:CA:C6:70:55'
uspot.hotspot.uam_port='3990'
uspot.hotspot.uam_server='https://app.31.97.217.241.sslip.io/uam/login'
uspot.hotspot.challenge='391487087f0adffeffbe44aa399ef811'    # UAM secret
uspot.hotspot.uam_secret='391487087f0adffeffbe44aa399ef811'  # UAM secret
```

## Error Log Analysis

### Error at 16:20:06
```
daemon.err uhttpd[3299]: uspot: 192.168.1.212 - config not found for "null"
```
**Meaning**: User tried to access UAM from LAN interface (192.168.1.212) instead of hotspot interface (10.1.30.x)

### Device Connection History
```
16:11:15 - Connected to hotspot → Got IP 10.1.30.212 ✅
16:13:07 - Connected to phy0-ap1 (switched networks)
16:13:12 - Connected to LAN → Got IP 192.168.1.212 ❌
16:13:37 - Deauthenticated from hotspot due to inactivity
16:20:06 - Tried to access UAM from LAN IP → ERROR
```

## Solution Steps

### For Testing:

1. **Disconnect** from all WiFi networks
2. **Connect** to `HIT GUEST` WiFi (NOT SpotFi-Admin)
3. **Wait** for device to get IP in 10.1.30.x range
4. **Open browser** and visit any HTTP website (e.g., http://example.com)
5. **Should be redirected** to captive portal automatically
6. **Login** with credentials
7. **Monitor** the authentication flow

### Expected Authentication Flow:

```
User → Opens HTTP site
  ↓
Router → Intercepts and redirects to UAM portal
  ↓
Portal → Shows login page with challenge
  ↓
User → Enters username/password
  ↓
Portal → Authenticates with RADIUS (using master secret)
  ↓
RADIUS → Returns Access-Accept
  ↓
Portal → Computes CHAP response (using UAM secret)
  ↓
Portal → Redirects to http://10.1.30.1:3990/logon?response=...
  ↓
Router → Validates CHAP with RADIUS
  ↓
Router → Grants internet access OR rejects
```

## Monitoring Commands

### Real-time Log Monitoring
```bash
# From your computer
ssh root@10.1.30.1 'logread -f | grep -E "(uspot|UAM|RADIUS|auth|10.1.30)"'
```

### Check Current Sessions
```bash
ssh root@10.1.30.1 'uspot sessions'
```

### Check uSpot Status
```bash
ssh root@10.1.30.1 '/etc/init.d/uspot status'
```

### Restart uSpot if needed
```bash
ssh root@10.1.30.1 '/etc/init.d/uspot restart && /etc/init.d/uhttpd restart'
```

## Next Steps for Debugging

If authentication still fails after connecting to the correct network:

1. **Monitor API Server Logs**: Check what the Node.js API is logging
2. **Monitor RADIUS Server Logs**: Check if RADIUS is receiving requests
3. **Check CHAP Computation**: Verify the CHAP response matches what router expects
4. **Verify Secrets**: Ensure UAM secret in database matches router config

## Configuration Secrets

- **RADIUS Master Secret**: `testing123` (configured on router and API server)
- **UAM Secret**: `391487087f0adffeffbe44aa399ef811` (from database, configured on router)
- These must match between:
  - Router config (`uci show uspot.hotspot`)
  - Database (`router.uamSecret`)
  - API environment (`RADIUS_MASTER_SECRET`)

## Files Created for Debugging

1. `/c/Users/rufaro/Documents/spotfi/check-router-logs.sh` - Full diagnostic script
2. `/c/Users/rufaro/Documents/spotfi/monitor-auth.sh` - Real-time auth monitoring
3. This document - Findings and solutions

