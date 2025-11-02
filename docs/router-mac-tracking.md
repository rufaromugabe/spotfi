# Router MAC Address Tracking - How It Works

## Overview

SpotFi uses **router MAC addresses** for reliable tracking instead of IP addresses. This ensures routers can be identified even when their IP addresses change (dynamic IPs, DHCP, etc.).

## How MAC Address Tracking Works

### Method 1: WebSocket Capture (Primary - Automatic) ✅

**This method works regardless of router configuration!**

```
1. Router connects via WebSocket → Server detects router IP automatically
2. Router sends MAC address in ?mac= parameter OR server extracts from connection
3. Server stores MAC in Router table → Always available for tracking
4. RADIUS accounting arrives → Database trigger looks up MAC by IP → Auto-populates nasmacaddress
5. Matching uses MAC address → Reliable even if IP changes
```

**Key Benefits:**
- ✅ Works without any router configuration changes
- ✅ Automatic IP detection
- ✅ MAC captured on first connection
- ✅ Database trigger ensures MAC is always in accounting records

### Method 2: RADIUS NAS-Identifier (Optional Enhancement)

You can optionally configure routers to include MAC address in RADIUS `NAS-Identifier` field for additional redundancy.

#### MikroTik RouterOS

```bash
# Get router MAC from main interface
:local routerMac [/interface ethernet get ether1 mac-address]

# Set system identity to include MAC
/system identity set name="MikroTik-$routerMac"
```

This makes the MAC appear in RADIUS packets:
```
NAS-Identifier = "MikroTik-DC:2C:6E:8A:71:5F"
```

#### OpenWrt

```bash
# Get router MAC
MAC=$(cat /sys/class/net/eth0/address | tr '[:lower:]' '[:upper:]' | tr -d ':')

# Set hostname with MAC
uci set system.@system[0].hostname="Router-$MAC"
uci commit system
```

#### Ubiquiti UniFi / EdgeRouter

```bash
# Set hostname to include MAC
MAC=$(ip link show eth0 | grep -oE '([[:xdigit:]]{1,2}:){5}[[:xdigit:]]{1,2}' | tr '[:lower:]' '[:upper:]')
echo "Router-$MAC" > /etc/hostname
hostname -F /etc/hostname
```

## Database Trigger (Automatic MAC Population)

SpotFi uses a PostgreSQL trigger that automatically populates router MAC addresses in accounting records:

```sql
-- When RADIUS accounting record arrives:
-- 1. Trigger fires BEFORE INSERT
-- 2. Looks up router MAC by IP address (nasipaddress)
-- 3. Populates nasmacaddress field automatically
-- 4. Ensures MAC is always available even if router didn't send it
```

This means:
- ✅ Router MAC is **always** in accounting records (after first WebSocket connection)
- ✅ Works even if router doesn't send MAC in RADIUS packets
- ✅ Automatic - no manual configuration needed
- ✅ Reliable tracking across IP changes

## Why MAC Address Tracking is Better

| Feature | IP Address | MAC Address |
|---------|-----------|-------------|
| Changes over time | ❌ Yes (DHCP, dynamic) | ✅ No (hardware identifier) |
| Reliable tracking | ❌ Breaks on IP change | ✅ Always works |
| Router configuration | ✅ Works by default | ✅ Works by default (WebSocket) |
| RADIUS visibility | ✅ Always sent | ⚙️ Optional (but auto-populated) |

## Verification

### Check Router MAC is Captured

```sql
-- Verify router MAC is stored
SELECT id, name, nasipaddress, mac_address 
FROM routers 
WHERE mac_address IS NOT NULL;
```

### Check Accounting Records Have MAC

```sql
-- Verify accounting records have router MAC
SELECT 
  acctuniqueid,
  nasipaddress,
  nasmacaddress,
  nasidentifier,
  router_id
FROM radacct 
WHERE nasmacaddress IS NOT NULL
LIMIT 10;
```

### Test Dynamic IP Handling

1. Router gets new IP from DHCP
2. Router connects via WebSocket → Server updates IP automatically
3. Old accounting records (with old IP) → Still linked by MAC address
4. New accounting records (with new IP) → Trigger populates MAC automatically
5. All records stay linked to same router ✅

## Troubleshooting

### Router MAC Not Captured

**Check WebSocket connection:**
```bash
# Verify router is connecting
SELECT id, name, status, mac_address, last_seen 
FROM routers 
WHERE status = 'ONLINE';
```

**Manually set MAC if needed:**
```sql
UPDATE routers 
SET mac_address = 'AA:BB:CC:DD:EE:FF' 
WHERE id = 'router-id';
```

### Accounting Records Missing MAC

**Check trigger is active:**
```sql
SELECT * FROM pg_trigger 
WHERE tgname = 'trigger_update_accounting_router_mac';
```

**Manually backfill:**
```sql
UPDATE radacct 
SET nasmacaddress = (
  SELECT mac_address 
  FROM routers 
  WHERE routers.nasipaddress = radacct.nasipaddress 
  LIMIT 1
)
WHERE nasmacaddress IS NULL;
```

### Router Not Linking to Accounting Records

**Check matching logic:**
1. Router has MAC address stored? ✅
2. Router has IP address? ✅
3. Accounting records have matching IP or MAC? ✅
4. Trigger is populating nasmacaddress? ✅

**Manual linking test:**
```sql
-- Find unlinked records that should match
SELECT 
  r.id as router_id,
  r.name as router_name,
  r.mac_address,
  COUNT(ra.acctuniqueid) as unlinked_count
FROM routers r
LEFT JOIN radacct ra ON (
  ra.nasipaddress = r.nasipaddress 
  OR ra.nasmacaddress = r.mac_address
)
WHERE ra.router_id IS NULL
GROUP BY r.id, r.name, r.mac_address;
```

## Summary

**SpotFi's MAC tracking is reliable because:**

1. ✅ **WebSocket captures MAC** - No router configuration needed
2. ✅ **Database trigger auto-populates** - MAC always in accounting records
3. ✅ **Works with any router** - No special RADIUS configuration required
4. ✅ **Handles dynamic IPs** - MAC never changes, tracking always works
5. ✅ **Optional router enhancement** - Can add MAC to NAS-Identifier for redundancy

You don't need to configure routers to send MAC in RADIUS - it works automatically! The optional NAS-Identifier configuration is just for additional visibility and redundancy.

