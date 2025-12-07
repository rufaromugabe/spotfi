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
# Force NODE_ENV=development to ensure devDependencies (like typescript) are installed
RUN NODE_ENV=development npm ci || (echo "Warning: package-lock.json out of sync, using npm install..." && NODE_ENV=development npm install)

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

# Install curl for health checks and tsx for running TypeScript migration scripts
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g tsx

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

# Ensure migrations directory is explicitly copied (in case it was missed or filtered)
COPY packages/prisma/migrations ./packages/prisma/migrations
COPY packages/prisma/manual-migrations ./packages/prisma/manual-migrations

EXPOSE 8080

# Create entrypoint script that runs migrations before starting
# Order: Prisma migrations first (create tables), then Manual migrations (triggers, functions)
RUN mkdir -p /app/scripts && \
    echo '#!/bin/bash' > /app/scripts/docker-entrypoint.sh && \
    echo 'set -e' >> /app/scripts/docker-entrypoint.sh && \
    echo 'echo "🚀 Starting SpotFi API Server..."' >> /app/scripts/docker-entrypoint.sh && \
    echo '' >> /app/scripts/docker-entrypoint.sh && \
    echo '# Step 1: Run Prisma migrations (create tables)' >> /app/scripts/docker-entrypoint.sh && \
    echo 'echo "📦 Running Prisma migrations..."' >> /app/scripts/docker-entrypoint.sh && \
    echo 'npm run prisma:migrate:deploy' >> /app/scripts/docker-entrypoint.sh && \
    echo '' >> /app/scripts/docker-entrypoint.sh && \
    echo '# Step 2: Run manual SQL migrations (triggers, functions, partial indexes)' >> /app/scripts/docker-entrypoint.sh && \
    echo 'echo "🔧 Running manual SQL migrations (using pg Client directly)..."' >> /app/scripts/docker-entrypoint.sh && \
    echo 'cd packages/prisma && npx tsx scripts/run-manual-migrations.ts' >> /app/scripts/docker-entrypoint.sh && \
    echo 'cd ../..' >> /app/scripts/docker-entrypoint.sh && \
    echo '' >> /app/scripts/docker-entrypoint.sh && \
    echo 'echo "✨ Starting API server..."' >> /app/scripts/docker-entrypoint.sh && \
    echo 'exec npm run start' >> /app/scripts/docker-entrypoint.sh && \
    chmod +x /app/scripts/docker-entrypoint.sh

# Use entrypoint script to run migrations before starting
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
