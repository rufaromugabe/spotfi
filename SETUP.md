# SpotFi Setup Guide

## Quick Start

1. **Install dependencies:**
   ```bash
   pnpm install
   ```

2. **Set up environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your database credentials
   ```

3. **Setup database:**
   ```bash
   # Generate Prisma Client
   pnpm prisma:generate

   # Run migrations
   pnpm prisma:migrate

   # Seed database (creates default admin and host users)
   pnpm prisma:seed
   ```

   Or use the all-in-one command:
   ```bash
   pnpm setup
   ```

4. **Start development server:**
   ```bash
   pnpm dev
   ```

## Default Users (after seeding)

- **Admin**: `admin@spotfi.com` / `admin123`
- **Host**: `host@spotfi.com` / `host123`

⚠️ **Change these passwords in production!**

## Docker Setup

For full stack deployment with PostgreSQL and FreeRADIUS:

```bash
docker-compose up -d
```

This will start:
- PostgreSQL database (used for both application and RADIUS data)
- FreeRADIUS server (connected to PostgreSQL)
- API server

## API Endpoints

Once running, the API will be available at `http://localhost:8080`

- `GET /health` - Health check
- `POST /api/auth/register` - Register user
- `POST /api/auth/login` - Login
- `GET /api/auth/me` - Get current user (requires auth)
- `GET /api/routers` - List routers (requires auth)
- `WS /ws?id=ROUTER_ID&token=TOKEN` - WebSocket connection

## Next Steps

1. Create routers via API or dashboard
2. Configure MikroTik routers to connect via WebSocket
3. Set up FreeRADIUS integration
4. Monitor usage and billing

