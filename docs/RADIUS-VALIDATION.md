# RADIUS Attribute Validation

## Overview

This document describes the RADIUS attribute validation system that prevents invalid attributes from being used in the SpotFi platform.

## Why Validation is Important

FreeRADIUS has strict requirements for attribute names. Using invalid attributes causes:
- ❌ Authentication failures
- ❌ SQL parsing errors
- ❌ "Unknown name" errors in logs
- ❌ Complete RADIUS service failures

## Running Validation

### Quick Validation

```bash
npm run validate:radius
```

This command:
- ✅ Checks all attributes in `radcheck` table
- ✅ Checks all attributes in `radreply` table
- ✅ Identifies known invalid attributes
- ✅ Warns about unknown attributes
- ✅ Provides fix suggestions

### Before Deployment

Always run validation before deploying:

```bash
npm run predeploy
```

This runs validation AND builds the project.

## Valid RADIUS Attributes

### radcheck (Authentication Checks)

These attributes are used for authentication and authorization checks:

- `User-Password` - User password (plain text)
- `Cleartext-Password` - User password (alternative)
- `NT-Password` - NT hashed password
- `LM-Password` - LM hashed password
- `MD5-Password` - MD5 hashed password
- `SHA-Password` - SHA hashed password
- `Crypt-Password` - Crypt hashed password
- `SSHA-Password` - Salted SHA password
- `SMD5-Password` - Salted MD5 password
- `SHA1-Password` - SHA1 hashed password
- `SHA2-Password` - SHA2 hashed password
- `Auth-Type` - Authentication type (e.g., "Reject" to disable user)
- `Simultaneous-Use` - **Max concurrent sessions** (use this, NOT Max-Daily-Session)
- `Expiration` - Account expiration date
- `Fall-Through` - Control attribute processing
- `Reply-Message` - Message to return to user
- `Auth-Data-Type` - Authentication data type
- `Password-With-Header` - Password with header

### radreply (Reply Attributes)

These attributes are returned to the NAS after successful authentication:

- `Session-Timeout` - Maximum session duration (seconds)
- `Idle-Timeout` - Maximum idle time (seconds)
- `WISPr-Bandwidth-Max-Down` - Download bandwidth limit (bits/sec)
- `WISPr-Bandwidth-Max-Up` - Upload bandwidth limit (bits/sec)
- `ChilliSpot-Max-Total-Octets` - Total data quota (bytes)
- `ChilliSpot-Max-Input-Octets` - Input data limit (bytes)
- `ChilliSpot-Max-Output-Octets` - Output data limit (bytes)
- `Service-Type` - Service type (e.g., "Framed-User")
- `Framed-Protocol` - Framed protocol type
- `Framed-IP-Address` - IP address to assign
- `Framed-IP-Netmask` - IP netmask
- `Framed-Route` - Route to add
- `Framed-IPv6-Prefix` - IPv6 prefix
- `Framed-IPv6-Pool` - IPv6 pool
- `Framed-IPv6-Route` - IPv6 route
- `Class` - Class attribute for session tracking
- `Reply-Message` - Message to return
- `MikroTik-Total-Limit` - Vendor-specific data limit

## Invalid Attributes

### Known Invalid Attributes

These attributes should **NEVER** be used:

- ❌ `Max-Daily-Session` - **Use `Simultaneous-Use` instead**

### Why These Are Invalid

- `Max-Daily-Session` is not a standard FreeRADIUS attribute
- FreeRADIUS doesn't recognize it, causing SQL parsing errors
- The correct attribute for concurrent session limits is `Simultaneous-Use`

## Validation Output

### Success Example

```
🔍 Validating RADIUS attributes...

📋 Checking radcheck attributes...
✅ Valid: User-Password
✅ Valid: Cleartext-Password
✅ Valid: Simultaneous-Use
✅ Valid: Auth-Type

📋 Checking radreply attributes...
✅ Valid: Session-Timeout
✅ Valid: Idle-Timeout
✅ Valid: WISPr-Bandwidth-Max-Down
✅ Valid: WISPr-Bandwidth-Max-Up
✅ Valid: ChilliSpot-Max-Total-Octets
✅ Valid: Service-Type

📊 Summary:
   radcheck attributes found: 4
   radreply attributes found: 6
   Invalid entries: 0

✅ All RADIUS attributes are valid!
   Ready for deployment.
```

### Error Example

```
🔍 Validating RADIUS attributes...

📋 Checking radcheck attributes...
✅ Valid: User-Password
❌ Invalid radcheck attribute: "Max-Daily-Session" (known invalid attribute)

📊 Summary:
   radcheck attributes found: 2
   radreply attributes found: 0
   Invalid entries: 1

❌ Validation failed! Fix invalid attributes before deployment.

💡 To fix invalid attributes:
   1. Update code to use valid attributes (e.g., Simultaneous-Use instead of Max-Daily-Session)
   2. Clean up database: DELETE FROM radcheck WHERE attribute IN ('Max-Daily-Session');
   3. Re-run validation: npm run validate:radius
```

## Fixing Invalid Attributes

### Step 1: Update Code

Replace invalid attributes in your code:

```typescript
// ❌ WRONG
await upsertRadCheck(username, 'Max-Daily-Session', maxSessions.toString());

// ✅ CORRECT
await upsertRadCheck(username, 'Simultaneous-Use', maxSessions.toString());
```

### Step 2: Clean Database

Remove invalid attributes from existing data:

```sql
-- Remove invalid attributes from radcheck
DELETE FROM radcheck WHERE attribute = 'Max-Daily-Session';

-- Remove invalid attributes from radreply
DELETE FROM radreply WHERE attribute = 'Max-Daily-Session';
```

### Step 3: Re-validate

Run validation again to confirm:

```bash
npm run validate:radius
```

## Integration with CI/CD

### GitHub Actions Example

```yaml
name: Validate RADIUS Attributes

on: [push, pull_request]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm ci
      - run: npm run validate:radius
```

### Pre-commit Hook

Add to `.husky/pre-commit`:

```bash
#!/bin/sh
npm run validate:radius
```

## Code Guidelines

When adding new RADIUS attributes:

1. **Always verify** the attribute is valid in FreeRADIUS documentation
2. **Check** RFC 2865, 2866, 2867, 2868 for standard attributes
3. **Test** with `radtest` before committing
4. **Never use** custom attributes without vendor-specific prefixes
5. **Reference** the attribute source in code comments

### Valid Attribute Sources

- RFC 2865 (RADIUS Authentication)
- RFC 2866 (RADIUS Accounting)
- RFC 2867 (Tunnel Attributes)
- RFC 2868 (RADIUS Attributes for Tunnel Protocol Support)
- Vendor-specific (e.g., ChilliSpot, WISPr, MikroTik)

## Troubleshooting

### Validation Script Fails to Connect

**Error**: `Can't reach database server`

**Fix**: Ensure database is running and `DATABASE_URL` is set correctly.

### Unknown Attributes Warning

**Warning**: `Unknown radcheck attribute: "Custom-Attribute"`

**Action**: 
- If it's a valid vendor-specific attribute, add it to `VALID_RADCHECK_ATTRIBUTES` in the validation script
- If it's invalid, remove it from the database

### False Positives

If you're using a valid vendor-specific attribute that's not in the list, you can:
1. Add it to the validation script's valid attributes list
2. Or use the `--skip-unknown` flag (if implemented)

## Related Documentation

- [Deployment Checklist](./DEPLOYMENT-CHECKLIST.md)
- [End User Management](./END-USER-MANAGEMENT.md)
- [FreeRADIUS Documentation](https://freeradius.org/documentation/)

