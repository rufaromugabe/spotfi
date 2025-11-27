#!/bin/bash
# Quick script to apply all real-time quota aggregation changes

set -e

echo "íº€ Applying Real-Time Quota Aggregation Changes..."
echo ""

# Step 1: Generate Prisma client
echo "í³¦ Step 1: Generating Prisma client..."
npx prisma generate
echo "âœ… Prisma client generated"
echo ""

# Step 2: Apply database migration
echo "í´§ Step 2: Applying database migration..."
cd packages/prisma
npx tsx scripts/run-manual-migrations.ts 005_realtime_quota
cd ../..
echo "âœ… Database migration applied"
echo ""

# Step 3: Rebuild containers
echo "í°³ Step 3: Rebuilding Docker containers..."
docker-compose -f docker-compose.production.yml build freeradius api
echo "âœ… Containers rebuilt"
echo ""

# Step 4: Restart services
echo "í´„ Step 4: Restarting services..."
docker-compose -f docker-compose.production.yml up -d
echo "âœ… Services restarted"
echo ""

echo "âœ¨ All changes applied successfully!"
echo ""
echo "í³‹ Verification commands:"
echo "  - Check function: docker exec spotfi-postgres psql -U postgres -d spotfi -c '\\df get_user_total_usage'"
echo "  - Check table: docker exec spotfi-postgres psql -U postgres -d spotfi -c '\\d disconnect_queue'"
echo "  - Check scheduler: docker logs spotfi-api | grep 'Quota enforcement'"
echo ""
