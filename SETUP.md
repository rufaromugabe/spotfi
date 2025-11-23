# SpotFi Setup Guide

## Quick Start

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set up environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your database credentials
   ```

3. **Setup database:**
   ```bash
   # Generate Prisma Client
   npm run prisma:generate

   # Run migrations
   npm run prisma:migrate

   # Seed database (creates default admin and host users)
   npm run prisma:seed
   ```

   Or use the all-in-one command:
   ```bash
   npm run setup
   ```

4. **Start development server:**
   ```bash
   npm run dev
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

## Validation

Before deploying, validate RADIUS attributes:

```bash
npm run validate:radius
```

This checks for invalid RADIUS attributes that could cause authentication failures. See [RADIUS Validation Guide](docs/RADIUS-VALIDATION.md) for details.

## Next Steps

1. **Validate RADIUS attributes**: `npm run validate:radius`
2. Create routers via API or dashboard
3. Configure OpenWRT routers to connect via WebSocket
4. Set up FreeRADIUS integration
5. Monitor usage and billing

## Deployment

Before deploying to production:

1. Run validation: `npm run validate:radius`
2. Check deployment checklist: [Deployment Checklist](docs/DEPLOYMENT-CHECKLIST.md)
3. Verify all environment variables are set
4. Test RADIUS authentication

