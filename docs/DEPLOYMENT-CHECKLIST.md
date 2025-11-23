# Deployment Checklist

## Pre-Deployment Validation

### 1. Code Validation
- [ ] Run `npm run validate:radius` - Check for invalid RADIUS attributes
- [ ] Run `npm run build` - Ensure build succeeds
- [ ] Check for any `Max-Daily-Session` references: `grep -r "Max-Daily-Session" . --exclude-dir=node_modules`
- [ ] Verify all RADIUS attributes use valid FreeRADIUS attributes

### 2. Database Validation
- [ ] Run migrations: `npm run prisma:migrate:deploy`
- [ ] Verify no invalid attributes in database:
  ```sql
  SELECT DISTINCT attribute FROM radcheck WHERE attribute NOT IN (
    'User-Password', 'Cleartext-Password', 'Simultaneous-Use', 'Auth-Type'
  );
  ```
- [ ] Check for invalid attributes: `npm run validate:radius`

### 3. RADIUS Server Validation
- [ ] Test authentication: `docker exec spotfi-freeradius radtest testuser testpass 127.0.0.1 0 testing123`
- [ ] Check FreeRADIUS logs for errors: `docker logs spotfi-freeradius --tail 50 | grep -i "error\|unknown\|fail"`
- [ ] Verify SQL module is enabled in authorize section
- [ ] Ensure SQL queries use lowercase column names (username, attribute, value, op)

### 4. Environment Variables
- [ ] Verify all required env vars are set in `.env` or `docker-compose.production.yml`
- [ ] Check `DATABASE_URL` is correct
- [ ] Verify `JWT_SECRET` is set (not default value)
- [ ] Verify `POSTGRES_PASSWORD` is secure
- [ ] Check `API_URL` matches your deployment environment

### 5. Docker Services
- [ ] Verify all services are healthy: `docker-compose ps`
- [ ] Check service logs for errors: `docker-compose logs`
- [ ] Ensure volumes are properly mounted
- [ ] Verify network connectivity between services

## Post-Deployment Validation

### 1. Service Health Checks
- [ ] API health check: `curl http://localhost:8080/health`
- [ ] Database connection: `docker exec spotfi-postgres pg_isready -U postgres`
- [ ] FreeRADIUS status: `docker exec spotfi-freeradius freeradius -v`

### 2. RADIUS Authentication Tests
- [ ] Test valid user: `docker exec spotfi-freeradius radtest testuser testpass 127.0.0.1 0 testing123`
  - Should return: `Access-Accept`
- [ ] Test invalid user: `docker exec spotfi-freeradius radtest invaliduser wrongpass 127.0.0.1 0 testing123`
  - Should return: `Access-Reject`
- [ ] Test wrong password: `docker exec spotfi-freeradius radtest testuser wrongpass 127.0.0.1 0 testing123`
  - Should return: `Access-Reject`

### 3. Functional Tests
- [ ] Create a new end user via API
- [ ] Assign a plan to the user
- [ ] Verify RADIUS attributes are created correctly
- [ ] Test user authentication via RADIUS
- [ ] Verify plan limits are enforced

### 4. Monitoring
- [ ] Check FreeRADIUS logs for any "Unknown name" errors
- [ ] Monitor database for invalid attribute insertions
- [ ] Verify quota tracking is working
- [ ] Check WebSocket connections are established

## Quick Validation Commands

```bash
# 1. Validate RADIUS attributes
npm run validate:radius

# 2. Check code for invalid attributes
grep -r "Max-Daily-Session" . --exclude-dir=node_modules

# 3. Check database for invalid attributes
docker exec spotfi-postgres psql -U postgres -d spotfi -c \
  "SELECT DISTINCT attribute FROM radcheck WHERE attribute NOT IN ('User-Password', 'Cleartext-Password', 'Simultaneous-Use', 'Auth-Type');"

# 4. Test RADIUS authentication
docker exec spotfi-freeradius radtest testuser testpass 127.0.0.1 0 testing123

# 5. Check FreeRADIUS logs for errors
docker logs spotfi-freeradius --tail 50 | grep -i "error\|unknown\|fail"

# 6. Verify all services are running
docker-compose ps

# 7. Check service health
curl http://localhost:8080/health
```

## Common Issues and Fixes

### Issue: "Unknown name" errors in FreeRADIUS logs
**Fix**: Run validation script and remove invalid attributes from database

### Issue: Authentication fails with "No Auth-Type found"
**Fix**: 
1. Ensure SQL module is enabled in `/etc/freeradius/sites-enabled/default`
2. Verify users are in groups (`radusergroup` table)
3. Check password attributes exist in `radcheck`

### Issue: SQL queries fail
**Fix**: 
1. Verify column names are lowercase (username, attribute, value, op)
2. Check SQL queries in `/etc/freeradius/mods-config/sql/main/postgresql/queries.conf`
3. Ensure database connection is working

### Issue: Invalid attributes in database
**Fix**:
1. Update code to use valid attributes
2. Clean database: `DELETE FROM radcheck WHERE attribute = 'Max-Daily-Session';`
3. Re-run validation: `npm run validate:radius`

## Automated Validation

The validation script (`npm run validate:radius`) automatically checks:
- ✅ All attributes in `radcheck` table
- ✅ All attributes in `radreply` table
- ✅ Known invalid attributes (e.g., `Max-Daily-Session`)
- ✅ Unknown attributes not in standard list

Run this before every deployment to catch issues early!

