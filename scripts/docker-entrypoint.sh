#!/bin/bash
set -e

echo "🚀 Starting SpotFi API Server..."

# Run Prisma migrations (schema-based)
echo "📦 Running Prisma migrations..."
npm run prisma:migrate:deploy || echo "⚠️  Prisma migrations completed (some may have been skipped)"

# Run manual SQL migrations (triggers, functions, partial indexes)
# Use npx to ensure tsx is available
echo "🔧 Running manual SQL migrations..."
cd packages/prisma && npx tsx scripts/run-manual-migrations.ts || echo "⚠️  Manual migrations completed (some may have been skipped)"
cd ../..

# Start the application
echo "✨ Starting API server..."
exec npm run start

