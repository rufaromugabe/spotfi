# Captive Portal Improvements

This document outlines the improvements made to the SpotFi captive portal implementation to align with uspot best practices and modern standards.

## ✅ Implemented Improvements

### 1. RFC8908 Captive Portal API Support

**What it is:**
RFC8908 defines a standard JSON API that allows modern devices (iOS, Android, Windows) to automatically detect and interact with captive portals.

**Implementation:**
- Added `/api` endpoint that returns portal information in RFC8908 format
- Provides `captive`, `user-portal-url`, `seconds-remaining`, `bytes-remaining` fields
- Automatically detected by iOS, Android, and Windows devices

**Benefits:**
- Better user experience with automatic portal detection
- Native notifications on mobile devices
- Reduced support issues from confused users

**Configuration:**
- DHCP Option 114 automatically configured in `openwrt-setup-uspot.sh`
- Endpoint available at: `https://api.spotfi.com/api`

### 2. Enhanced RADIUS Authentication

**Improvements:**
- Proper RADIUS attribute handling (numeric vs string attributes)
- Correct NAS-IP-Address usage (router IP, not client IP)
- Added NAS-Port-Type and Service-Type attributes
- Better error handling and logging

**RADIUS Attributes Now Sent:**
- `NAS-IP-Address`: Router's WAN IP
- `NAS-Identifier`: Router ID
- `Called-Station-Id`: Router MAC address
- `Calling-Station-Id`: Client's hotspot IP
- `User-Name`: Username
- `NAS-Port-Type`: Wireless-802.11
- `Service-Type`: Framed-User

### 3. Router Name Management

**Features:**
- Router name can be set during cloud setup via environment variable
- Router name updates via WebSocket connection
- Automatic name synchronization between router and database

**Usage:**
```bash
./openwrt-setup-cloud.sh ROUTER_ID TOKEN MAC_ADDRESS [SERVER_DOMAIN] [ROUTER_NAME]
```

### 4. Improved Uspot Configuration

**Enhanced Settings:**
- `radius_acct_server`: Explicitly set (matches auth server)
- `interim_update`: 300 seconds (5 minutes) for real-time usage tracking
- `session_timeout`: 7200 seconds (2 hours) default
- `idle_timeout`: 600 seconds (10 minutes) default
- DHCP Option 114 for RFC8908 support

**Best Practices Followed:**
- Both auth and accounting servers configured
- Proper timeout values
- Modern captive portal detection

### 5. Better Active Session Detection

**Optimization:**
- Added database index: `radacct_active_session_username_idx`
- Partial index (only active sessions) for faster queries
- Prevents simultaneous logins across routers

## 📋 Configuration Checklist

### Backend (API Server)

✅ RFC8908 API endpoint: `/api`  
✅ Portal login page: `/portal`  
✅ Portal login handler: `/portal/login`  
✅ Router name updates via WebSocket  
✅ Enhanced RADIUS authentication  
✅ Active session checking with optimized index  

### Router Setup Scripts

✅ `openwrt-setup-uspot.sh`:
- RFC8908 DHCP Option 114
- Complete RADIUS configuration
- Session and idle timeouts
- Proper firewall rules

✅ `openwrt-setup-cloud.sh`:
- Router name support
- Environment variable configuration
- WebSocket name updates

## 🔧 Technical Details

### RFC8908 API Response Format

**Before Login (Current Implementation):**
```json
{
  "captive": true,
  "user-portal-url": "https://api.spotfi.com/portal?nasid=ROUTER_ID"
}
```

**After Login (Future Enhancement):**
To provide session information after login, you would need to implement session tracking (cookies/tokens):
```json
{
  "captive": true,
  "user-portal-url": "https://api.spotfi.com/portal?nasid=ROUTER_ID",
  "seconds-remaining": 3600,
  "bytes-remaining": 1073741824,
  "can-extend-session": false
}
```

**How It Works:**
1. Device connects to WiFi and gets IP via DHCP
2. Device automatically calls `/api` endpoint (from DHCP Option 114)
3. If `captive: true`, device shows "Sign in to WiFi" notification
4. User taps notification → Opens portal URL
5. User logs in → Gets internet access
6. (Future) Device can check `/api` again with session cookie to see remaining time/data

### RADIUS Authentication Flow

1. User submits credentials on portal page
2. Portal checks for active sessions (optimized query)
3. Portal checks quota availability
4. Portal sends RADIUS Access-Request with proper attributes
5. FreeRADIUS validates credentials and returns Access-Accept/Reject
6. On success, user redirected to destination URL

### Router Name Update Flow

1. Router connects via WebSocket with optional `name` parameter
2. Server updates router name in database if provided
3. Router can also send `update-router-name` message after connection
4. Name synchronized across all systems

## 📚 Documentation References

- **uspot Documentation**: https://github.com/f00b4r0/uspot
- **RFC8908**: Captive Portal API standard
- **RFC2865**: RADIUS Authentication protocol
- **RFC5176**: RADIUS Dynamic Authorization Extensions (future enhancement)

## ✅ Implemented Enhancements

### 1. RFC5176 DAE Support ✅
**Status**: Implemented

Remote disconnect and CoA (Change of Authorization) operations are now supported:

- **DAE Server**: Listens on port 3799 for Disconnect-Request and CoA-Request messages
- **Remote Disconnect**: Administrators can disconnect active sessions via API or RADIUS DAE
- **Session Management**: API endpoints for viewing and managing active sessions
- **CoA Support**: Change session timeout and bandwidth limits dynamically

**API Endpoints**:
- `GET /api/sessions` - List active sessions
- `POST /api/sessions/:sessionId/disconnect` - Disconnect specific session (Admin only)
- `POST /api/sessions/user/:username/disconnect` - Disconnect user from all routers (Admin only)

**Configuration**:
- DAE server starts automatically on port 3799
- Configure `RADIUS_DAE_SECRET` environment variable (defaults to `RADIUS_SECRET`)
- Firewall rule for port 3799 is added automatically in setup script

### 2. HTTPS Portal ✅
**Status**: Implemented

Secure portal access with TLS certificates:

- **Self-Signed Certificate**: Automatically generated during setup
- **uhttpd Configuration**: HTTPS enabled on port 443
- **Certificate Location**: `/etc/uhttpd.crt` and `/etc/uhttpd.key`
- **Portal URL**: Uses HTTPS by default (`https://portal-domain/portal`)

**Setup**:
The setup script automatically:
1. Generates self-signed certificate if not present
2. Configures uhttpd for HTTPS
3. Enables HTTPS portal access

**Production Note**: For production, replace self-signed certificate with a valid CA-signed certificate (Let's Encrypt, etc.)

### 3. Bandwidth Control ✅
**Status**: Implemented

Bandwidth management via RADIUS attributes and ratelimit:

- **RADIUS Attributes**: Bandwidth limits set via RADIUS Reply attributes
- **uspot Integration**: uspot reads bandwidth limits from RADIUS responses
- **ratelimit Package**: Optional OpenWRT package for advanced rate limiting
- **Dynamic Control**: Bandwidth can be changed via CoA requests

**RADIUS Attributes Used**:
- `WISPr-Bandwidth-Max-Up` - Maximum upload bandwidth (bytes/sec)
- `WISPr-Bandwidth-Max-Down` - Maximum download bandwidth (bytes/sec)
- Or vendor-specific attributes like `ChilliSpot-Max-Input-Octets` / `ChilliSpot-Max-Output-Octets`

**Configuration**:
- Set bandwidth limits in `radreply` table for users
- uspot automatically applies limits from RADIUS responses
- ratelimit package provides additional QoS features if installed

## 🚀 Future Enhancements

1. **IPv6 Support**: Experimental IPv6 captive portal support
2. **Advanced QoS**: Traffic shaping and priority queuing
3. **Session Analytics**: Detailed session statistics and reporting

## ✅ Verification

To verify the improvements are working:

1. **RFC8908**: Connect a device and check if it automatically detects the portal
2. **RADIUS**: Check FreeRADIUS logs for proper attribute handling
3. **Router Name**: Check router name updates in dashboard
4. **Active Sessions**: Verify single-login enforcement works
5. **DAE Server**: Check API logs for DAE server startup message on port 3799
6. **HTTPS Portal**: Verify portal is accessible via HTTPS
7. **Bandwidth Control**: Set bandwidth limits in radreply table and verify they're applied
8. **Remote Disconnect**: Use API to disconnect active sessions and verify they're terminated

## 📝 Migration Notes

No breaking changes. All improvements are backward compatible:
- Existing routers continue to work
- RFC8908 is optional (devices fall back to traditional redirect)
- Router name is optional
- Enhanced RADIUS attributes improve compatibility but aren't required

