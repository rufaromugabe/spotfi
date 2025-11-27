# How to Apply Real-Time Quota Aggregation Changes

This guide walks you through applying all the changes for the real-time quota aggregation feature that prevents "double dip" quota abuse.

## 📋 Summary of Changes

1. **Database Migration**: SQL function, trigger, and disconnect_queue table
2. **Prisma Schema**: Added DisconnectQueue model
3. **Scheduler**: Added quota enforcement job
4. **FreeRADIUS Config**: Dynamic quota calculation in queries.conf
5. **Docker**: Updated to include queries.conf

## 🚀 Step-by-Step Application

### Step 1: Update Prisma Schema and Generate Client

```bash
# Navigate to project root
cd /path/to/spotfi

# Generate Prisma client with new DisconnectQueue model
npx prisma generate
```

### Step 2: Apply Database Migration

You have two options:

#### Option A: Using the Migration Script (Recommended)

```bash
# Run the new migration
cd packages/prisma
npx tsx scripts/run-manual-migrations.ts 005_realtime_quota

# Or run all migrations (will skip already applied ones)
npx tsx scripts/run-manual-migrations.ts
```

#### Option B: Direct SQL Execution

```bash
# Connect to your database
psql -h localhost -U postgres -d spotfi

# Or if using Docker
docker exec -i spotfi-postgres psql -U postgres -d spotfi < packages/prisma/manual-migrations/005_realtime_quota.sql
```

### Step 3: Rebuild Docker Containers

```bash
# Rebuild FreeRADIUS container (includes new queries.conf)
docker-compose -f docker-compose.production.yml build freeradius

# Rebuild API container (includes updated scheduler)
docker-compose -f docker-compose.production.yml build api

# Restart all services
docker-compose -f docker-compose.production.yml up -d
```

### Step 4: Verify Installation

#### Check Database Functions

```bash
docker exec -it spotfi-postgres psql -U postgres -d spotfi -c "\df get_user_total_usage"
```

Expected output:
```
 Schema |        Name         | Result data type | Argument data types
--------+---------------------+------------------+-----------------------
 public | get_user_total_usage | bigint          | check_username text
```

#### Check Disconnect Queue Table

```bash
docker exec -it spotfi-postgres psql -U postgres -d spotfi -c "\d disconnect_queue"
```

Expected output should show the table structure with columns: id, username, reason, processed, created_at, processed_at

#### Check Trigger

```bash
docker exec -it spotfi-postgres psql -U postgres -d spotfi -c "\d+ radacct" | grep -A 5 "trg_check_quota"
```

#### Check FreeRADIUS Config

```bash
# Verify queries.conf is in the container
docker exec spotfi-freeradius ls -la /etc/freeradius/mods-config/sql/main/postgresql/queries.conf

# Check if it contains the UNION clause
docker exec spotfi-freeradius grep -A 5 "UNION" /etc/freeradius/mods-config/sql/main/postgresql/queries.conf
```

#### Check Scheduler Logs

```bash
# View API logs to see scheduler started
docker logs spotfi-api | grep -i "scheduler\|quota enforcement"
```

Expected output:
```
⏰ Starting production scheduler
✅ Scheduler ready
   → Quota enforcement: Every minute (disconnect queue)
```

## 🧪 Testing the Feature

### Test 1: Verify Dynamic Quota Calculation

1. Create a test user with a plan (e.g., 1GB quota)
2. Connect device 1 - should get remaining quota
3. Connect device 2 simultaneously - should get remaining quota (not full quota)
4. Both devices should share the same quota pool

### Test 2: Verify Quota Enforcement

1. Use up all quota on one device
2. Check `disconnect_queue` table:
   ```sql
   SELECT * FROM disconnect_queue WHERE processed = false;
   ```
3. Wait 1 minute (scheduler runs every minute)
4. Check logs:
   ```bash
   docker logs spotfi-api | grep "quota overage"
   ```
5. Verify user was disconnected and `radcheck` has `Auth-Type = Reject`

## 🔍 Troubleshooting

### Migration Fails

If migration fails with "already exists" errors, it's safe to ignore (idempotent). To force re-run:

```bash
npx tsx packages/prisma/scripts/run-manual-migrations.ts 005_realtime_quota --force
```

### FreeRADIUS Not Using New Config

1. Check if queries.conf is mounted correctly:
   ```bash
   docker exec spotfi-freeradius cat /etc/freeradius/mods-config/sql/main/postgresql/queries.conf | head -20
   ```

2. Restart FreeRADIUS:
   ```bash
   docker-compose -f docker-compose.production.yml restart freeradius
   ```

3. Check FreeRADIUS logs:
   ```bash
   docker logs spotfi-freeradius | tail -50
   ```

### Scheduler Not Running

1. Check if scheduler is started:
   ```bash
   docker logs spotfi-api | grep "Scheduler ready"
   ```

2. Check for errors:
   ```bash
   docker logs spotfi-api | grep -i error
   ```

3. Restart API:
   ```bash
   docker-compose -f docker-compose.production.yml restart api
   ```

### Function Not Found

If `get_user_total_usage` function is not found:

```bash
# Re-run the migration
npx tsx packages/prisma/scripts/run-manual-migrations.ts 005_realtime_quota
```

## 📝 Manual Verification Queries

### Check Total Usage for a User

```sql
SELECT get_user_total_usage('username_here');
```

### Check Active Sessions

```sql
SELECT 
    username,
    acctsessionid,
    acctinputoctets + acctoutputoctets as total_bytes,
    acctstarttime
FROM radacct
WHERE username = 'username_here'
AND acctstoptime IS NULL;
```

### Check Disconnect Queue

```sql
SELECT * FROM disconnect_queue 
WHERE processed = false 
ORDER BY created_at DESC;
```

### Check User Plan and Quota

```sql
SELECT 
    u.username,
    p.name as plan_name,
    COALESCE(up.data_quota, p.data_quota) as quota_limit,
    get_user_total_usage(u.username) as total_used,
    COALESCE(up.data_quota, p.data_quota) - get_user_total_usage(u.username) as remaining
FROM end_users u
JOIN user_plans up ON u.id = up.user_id
JOIN plans p ON up.plan_id = p.id
WHERE u.username = 'username_here'
AND up.status = 'ACTIVE';
```

## ✅ Success Checklist

- [ ] Prisma client regenerated
- [ ] Database migration applied (005_realtime_quota.sql)
- [ ] `get_user_total_usage()` function exists
- [ ] `disconnect_queue` table exists
- [ ] `trg_check_quota` trigger exists
- [ ] FreeRADIUS container rebuilt
- [ ] queries.conf contains UNION clause
- [ ] API container rebuilt
- [ ] Scheduler shows "Quota enforcement: Every minute"
- [ ] Test user can authenticate
- [ ] Dynamic quota calculation works

## 🎯 Next Steps

After applying all changes:

1. Monitor the disconnect_queue for the first few hours
2. Check scheduler logs to ensure it's processing correctly
3. Test with multiple simultaneous sessions
4. Monitor FreeRADIUS logs for any query errors

## 📚 Related Files

- Migration: `packages/prisma/manual-migrations/005_realtime_quota.sql`
- Schema: `packages/prisma/schema.prisma` (DisconnectQueue model)
- Scheduler: `apps/api/src/jobs/scheduler.ts`
- FreeRADIUS Config: `raduis-server/mods-config/sql/main/postgresql/queries.conf`
- Docker: `raduis-server/Dockerfile`, `docker-compose.production.yml`

