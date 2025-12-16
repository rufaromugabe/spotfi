# Authentication Fix Summary

## Date: Dec 16, 2025

## Problem Identified

### Root Cause:
The portal could NOT find the router in the database, causing it to use `uamSecret=none` instead of the correct UAM secret, resulting in an incorrect CHAP response that the router rejected.

### Why Router Lookup Failed:

**Database has:**
```json
{
  "name": "Rufaro Main ",                    // Has trailing space
  "nasipaddress": "102.210.115.1",           // WAN IP
  "macAddress": "80:af:ca:c6:70:55",
  "uamSecret": "391487087f0adffeffbe44aa399ef811"
}
```

**UAM request provides:**
```
nasid=Rufaro-Main-         (name with hyphens)
uamip=10.1.30.1            (hotspot IP, not WAN IP)
called=80:AF:CA:C6:70:55   (router MAC address)
```

**Previous lookup logic:**
1. ❌ Name lookup: `"RufaroMain-"` doesn't match `"Rufaro Main "` (spaces vs hyphens)
2. ❌ IP lookup: `10.1.30.1` doesn't match `102.210.115.1` (hotspot IP vs WAN IP)
3. ❌ Result: Router not found → `uamSecret=none` → wrong CHAP → reject

## Solution Implemented

### Fixed Router Lookup in `portal.ts`:

**New lookup priority:**
1. ✅ **MAC Address** (most reliable) - uses `called` parameter
2. ✅ **Name matching** (improved) - normalizes both sides for comparison
3. ✅ **IP Address** (fallback) - kept for backward compatibility

### Code Changes:

```typescript
// 1. Try by MAC address (called parameter = router/AP MAC) - MOST RELIABLE
if (called) {
  const normalizedMac = called.toUpperCase();
  routerConfig = await prisma.router.findFirst({
    where: { 
      macAddress: {
        equals: normalizedMac,
        mode: 'insensitive'
      }
    },
    select: { id: true, nasipaddress: true, uamSecret: true, name: true, macAddress: true }
  });
}

// 2. Improved name matching with normalization
if (!routerConfig && nasid) {
  const normalizedNasid = nasid.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  const allRouters = await prisma.router.findMany({...});
  
  routerConfig = allRouters.find(r => {
    const normalizedDbName = r.name?.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || '';
    return normalizedDbName === normalizedNasid || normalizedDbName.includes(normalizedNasid);
  }) || null;
}
```

### Benefits:
- ✅ MAC address is unique and doesn't change
- ✅ Not affected by name formatting differences
- ✅ Not affected by IP address changes
- ✅ Better logging for debugging

## How to Apply the Fix

### 1. Restart the API Server:

**If using Docker:**
```bash
cd /c/Users/rufaro/Documents/spotfi
docker-compose restart api
# OR
docker-compose down && docker-compose up -d
```

**If running locally:**
```bash
cd /c/Users/rufaro/Documents/spotfi
# Stop the current server (Ctrl+C)
# Then restart:
npm run dev
# OR for production:
npm run build && npm start
```

### 2. Test Authentication:

1. **Connect** to `HIT GUEST` WiFi (hotspot)
2. **Open browser** and visit http://example.com
3. **Login** with username: `testuser` and password
4. **Monitor logs** in both router and server

### 3. Monitor Server Logs:

You should now see:
```
[UAM] Found router by MAC: Rufaro Main (cmj5tqoms0002ylu25pft7k17), MAC=80:AF:CA:C6:70:55
[RADIUS] Access-Accept for testuser from freeradius:1812
[UAM] testuser authenticated, CHAP redirect (challenge=..., uamSecret=present)
```

Instead of:
```
[UAM] Router not found for nasid=Rufaro-Main-, uamip=10.1.30.1
[UAM] testuser authenticated, CHAP redirect (challenge=..., uamSecret=none)
```

## Expected Result

**Before fix:**
```
Portal → Can't find router → uamSecret=none → Wrong CHAP → Router rejects → res=reject
```

**After fix:**
```
Portal → Finds router by MAC → uamSecret=present → Correct CHAP → Router accepts → Internet access! ✅
```

## Files Modified

- `apps/api/src/routes/portal.ts` - Improved router lookup logic

## Additional Notes

### Why MAC Address Lookup is Better:

1. **Unique identifier** - Each router has a unique MAC
2. **Doesn't change** - MAC address is stable unlike IP addresses
3. **Already available** - UAM protocol provides it in `called` parameter
4. **No formatting issues** - Just case normalization needed

### Troubleshooting:

If authentication still fails after restart:

1. **Check if router MAC is correct in database:**
   ```bash
   # Should match the 'called' parameter from UAM request
   called=80:AF:CA:C6:70:55
   ```

2. **Verify UAM secret is set:**
   - Database: `uamSecret = "391487087f0adffeffbe44aa399ef811"`
   - Router config: `uspot.hotspot.uam_secret = "391487087f0adffeffbe44aa399ef811"`

3. **Check server logs** for the new log messages

4. **Monitor router logs:**
   ```bash
   ssh root@10.1.30.1 'logread -f | grep -E "(uspot|RADIUS|auth)"'
   ```

## Next Steps

1. ✅ Restart API server
2. ✅ Test authentication with `testuser`
3. ✅ Verify user gets internet access
4. ✅ Check both server and router logs

## Success Criteria

You'll know it's working when:
- ✅ Server log shows: `Found router by MAC`
- ✅ Server log shows: `uamSecret: present` (not `none`)
- ✅ Router accepts authentication (no `res=reject`)
- ✅ User gets internet access
- ✅ Session appears in active sessions list

