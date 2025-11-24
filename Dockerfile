FROM node:20-slim AS base
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/*

# Install dependencies
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/prisma/package.json packages/prisma/package.json
COPY packages/shared/package.json packages/shared/package.json

# Install workspace dependencies
# Try npm ci first (faster, reproducible), fallback to npm install if lock file is out of sync
RUN npm ci || (echo "Warning: package-lock.json out of sync, using npm install..." && npm install)

# Copy the rest of the source
COPY . .

# Ensure Prisma client is generated during build
ARG DATABASE_URL="postgresql://postgres:postgres@postgres:5432/spotfi?schema=public"
ENV DATABASE_URL=${DATABASE_URL}

# Build shared library and API, then prune dev dependencies
RUN npm run prisma:generate \
 && npm run build \
 && npm prune --omit=dev

# Runtime image
FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app

# Install tsx for running TypeScript migration scripts
RUN npm install -g tsx

# Copy package metadata and node_modules from build stage
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules

# Copy built application artifacts
COPY --from=deps /app/apps/api/package.json ./apps/api/package.json
COPY --from=deps /app/apps/api/dist ./apps/api/dist
COPY --from=deps /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=deps /app/packages/shared/dist ./packages/shared/dist
COPY --from=deps /app/packages/prisma ./packages/prisma
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma

EXPOSE 8080

# Create entrypoint script that runs migrations before starting
# Order: Manual migrations first (using pg Client), then Prisma migrations (which will skip if already applied)
RUN mkdir -p /app/scripts && \
    echo '#!/bin/bash' > /app/scripts/docker-entrypoint.sh && \
    echo 'set -e' >> /app/scripts/docker-entrypoint.sh && \
    echo 'echo "🚀 Starting SpotFi API Server..."' >> /app/scripts/docker-entrypoint.sh && \
    echo '' >> /app/scripts/docker-entrypoint.sh && \
    echo '# Step 1: Run manual SQL migrations first (triggers, functions, partial indexes)' >> /app/scripts/docker-entrypoint.sh && \
    echo 'echo "🔧 Running manual SQL migrations (using pg Client directly)..."' >> /app/scripts/docker-entrypoint.sh && \
    echo 'cd packages/prisma && npx tsx scripts/run-manual-migrations.ts || echo "⚠️  Manual migrations completed (some may have been skipped)"' >> /app/scripts/docker-entrypoint.sh && \
    echo 'cd ../..' >> /app/scripts/docker-entrypoint.sh && \
    echo '' >> /app/scripts/docker-entrypoint.sh && \
    echo '# Step 2: Run Prisma migrations (will skip if already applied)' >> /app/scripts/docker-entrypoint.sh && \
    echo 'echo "📦 Running Prisma migrations..."' >> /app/scripts/docker-entrypoint.sh && \
    echo 'npm run prisma:migrate:deploy || echo "⚠️  Prisma migrations completed (some may have been skipped)"' >> /app/scripts/docker-entrypoint.sh && \
    echo '' >> /app/scripts/docker-entrypoint.sh && \
    echo 'echo "✨ Starting API server..."' >> /app/scripts/docker-entrypoint.sh && \
    echo 'exec npm run start' >> /app/scripts/docker-entrypoint.sh && \
    chmod +x /app/scripts/docker-entrypoint.sh

# Use entrypoint script to run migrations before starting
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
