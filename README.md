# 🛰️ SpotFi – Cloud ISP Management Platform

SpotFi is a cloud-based platform that helps you manage WiFi routers remotely. Think of it as a control center that lets you monitor and control multiple routers from anywhere, track how much data users consume, and automatically handle billing.

## What is SpotFi?

SpotFi is designed for Internet Service Providers (ISPs) or anyone managing multiple WiFi hotspots. Instead of visiting each router location to check status or make changes, you can do everything from a web dashboard in the cloud.

**In simple terms:**
- You have WiFi routers (like at cafes, hotels, or public spaces)
- Users connect to these routers and need to log in through a captive portal
- SpotFi manages user accounts, tracks data usage, enforces limits, and handles payments
- You can monitor and control all your routers from one central dashboard

## Key Features

- **Remote Router Management** - Control routers from anywhere via web dashboard
- **Real-time Monitoring** - See router status, CPU, memory, network speed, and connected users in real-time
- **User Authentication** - Secure login system with captive portal support
- **Data Quota Management** - Set data limits for users that work across all your routers
- **Usage Tracking** - Monitor how much data each user consumes
- **Automated Billing** - Generate invoices automatically based on usage
- **Multi-User Support** - Different roles (Admin and Host) with appropriate permissions
- **WebSocket Communication** - Real-time connection between routers and cloud platform

## How It Works

1. **Routers connect to SpotFi** - Your OpenWRT routers establish a secure connection to the cloud platform
2. **Users connect to WiFi** - When someone connects, they see a login page (captive portal)
3. **Authentication** - Users log in with credentials managed by SpotFi
4. **Usage Tracking** - The system tracks how much data each user consumes
5. **Remote Control** - You can monitor router health, reboot devices, view logs, and manage settings remotely
6. **Billing** - Monthly invoices are automatically generated based on data usage

## Deployment

### Prerequisites

- Docker and Docker Compose installed on your server
- PostgreSQL database (can be included in docker-compose)
- Environment variables configured (see `.env.example`)

### Production Deployment

To build and deploy the API service in production:

```bash
# Build the API container
docker-compose -f docker-compose.production.yml build api

# Start the API service
docker-compose -f docker-compose.production.yml up -d api
```

### View Logs

```bash
# View API logs
docker-compose -f docker-compose.production.yml logs -f api
```

### Stop Services

```bash
# Stop the API service
docker-compose -f docker-compose.production.yml down
```

## Configuration

Before deploying, make sure to:

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` with your configuration:
   - Database connection string
   - JWT secret for authentication
   - Server port and other settings

3. Run database migrations (if needed):
   ```bash
   docker-compose -f docker-compose.production.yml exec api pnpm prisma:migrate
   ```

## Accessing the System

Once deployed, the API will be available at:
- **API Server**: `http://localhost:8080` (or your configured port)
- **API Documentation**: `http://localhost:8080/docs` (Swagger UI)

## Router Integration

SpotFi works with OpenWRT routers. Routers connect to the platform via WebSocket for real-time communication and use RADIUS for user authentication.

For detailed router setup instructions, see the [OpenWRT Setup Guide](docs/OPENWRT-SETUP.md).

## License

MIT
