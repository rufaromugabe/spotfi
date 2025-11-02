# Multi-stage build for production
FROM node:20-alpine AS base

# Install pnpm
RUN npm install -g pnpm

# Set working directory
WORKDIR /app

# Copy workspace files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.json ./

# Copy package configurations
COPY packages/prisma/package.json ./packages/prisma/
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages ./packages
COPY apps/api ./apps/api

# Generate Prisma Client
RUN pnpm prisma:generate

# Build the application
RUN pnpm --filter api build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/prisma/package.json ./packages/prisma/
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/

# Install production dependencies only
RUN pnpm install --prod --frozen-lockfile

# Copy built application and Prisma files
COPY --from=base /app/packages/prisma ./packages/prisma
COPY --from=base /app/apps/api/dist ./apps/api/dist
COPY --from=base /app/node_modules/.prisma ./node_modules/.prisma

# Expose port
EXPOSE 8080

# Run migrations and start server
CMD ["sh", "-c", "pnpm --filter prisma migrate deploy && pnpm --filter api start"]

