# 🛰️ SpotFi – Cloud ISP Management Platform

SpotFi is a cloud-based ISP management system for controlling OpenWRT routers remotely, monitoring usage, and automating billing.

## Architecture

```
┌─────────────────────────────────┐
│      SpotFi Cloud (Backend)     │
├─────────────────────────────────┤
│  Node.js API (Fastify)          │
│  WebSocket Server               │
│  Prisma + PostgreSQL            │
│  FreeRADIUS Integration         │
│  Billing Engine                 │
└─────────────────────────────────┘
              ▲
              │ HTTPS / WSS / RADIUS
              ▼
┌─────────────────────────────────┐
│      OpenWRT Router             │
├─────────────────────────────────┤
│  CoovaChilli (Captive Portal)   │
│  RADIUS Client                  │
│  Python WebSocket Bridge        │
│  Real-time Metrics              │
└─────────────────────────────────┘
```

## Features

- ✅ Multi-tenant authentication (ADMIN & HOST roles)
- ✅ WebSocket-based remote router control
- ✅ FreeRADIUS AAA integration
- ✅ **Cross-router quota management** - Users can use quota across multiple routers
- ✅ Automated billing and invoicing
- ✅ Real-time router monitoring
- ✅ Usage tracking and analytics
- ✅ Automated cron jobs for data sync

## Tech Stack

- **Backend**: Node.js + Fastify
- **Database**: PostgreSQL (via Prisma)
- **Authentication**: JWT
- **Real-time**: WebSocket (ws)
- **AAA**: FreeRADIUS (PostgresSQL)
- **Cron Jobs**: node-cron
- **Containerization**: Docker

## Project Structure

```
spotfi/
├── apps/
│   └── api/                 # Backend API server
│       ├── src/
│       │   ├── routes/      # API routes
│       │   ├── services/    # Business logic
│       │   ├── websocket/   # WebSocket server
│       │   └── jobs/        # Cron jobs
│       └── Dockerfile
├── packages/
│   ├── prisma/              # Database schema & migrations
│   └── shared/              # Shared types & utilities
├── docker-compose.yml
└── README.md
```

## Getting Started

### Prerequisites

- Node.js 18+ and pnpm 8+
- Docker and Docker Compose (for full stack)
- PostgreSQL (for development)

### Installation

1. **Clone and install dependencies:**

```bash
pnpm install
```

2. **Set up environment variables:**

```bash
cp .env.example .env
# Edit .env with your configuration
```

3. **Generate Prisma Client:**

```bash
pnpm prisma:generate
```

4. **Run database migrations:**

```bash
pnpm prisma:migrate
```

5. **Seed the database:**

```bash
pnpm prisma:seed
```

This creates default users:
- Admin: `admin@spotfi.com` / `admin123`
- Host: `host@spotfi.com` / `host123`

### Development

```bash
# Start the API server
pnpm dev
```

The server will start on `http://localhost:8080`

### Production (Docker)

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f api

# Stop services
docker-compose down
```

## API Documentation

**Swagger UI**: Once the server is running, visit:
- **http://localhost:8080/docs** - Interactive API documentation with Swagger UI

The Swagger documentation includes:
- All API endpoints with descriptions
- Request/response schemas
- Authentication requirements
- Try-it-out functionality

You can also access the OpenAPI JSON spec at:
- **http://localhost:8080/docs/json** - OpenAPI 3.0 specification

## API Endpoints

### Authentication

- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `GET /api/auth/me` - Get current user (requires auth)

### Routers

- `GET /api/routers` - List all routers (auth required)
  - Admins see all routers, hosts see only their own
- `GET /api/routers/:id` - Get router details (auth required)
  - Admins can access any router, hosts only their own
- `POST /api/routers` - Create new router (Admin only)
  - Requires `hostId` in body - assigns router to specific host
  - Validates that hostId exists and user has HOST role
- `PUT /api/routers/:id` - Update router (auth required)
  - Admins can update any router, hosts only their own
- `DELETE /api/routers/:id` - Delete router (auth required)
  - Admins can delete any router, hosts only their own
- `POST /api/routers/:id/command` - Send command to router (WebSocket, auth required)
  - Admins can send commands to any router, hosts only their own
- `GET /api/routers/:id/stats` - Get router statistics (auth required)
  - Admins can view stats for any router, hosts only their own

### Router Management (Remote Control via WebSocket)

These endpoints require the router to be online and connected via WebSocket:

**System Information:**
- `POST /api/routers/:id/system/info` - Get router system information (CPU, memory, uptime)
- `POST /api/routers/:id/system/board` - Get router board information
- `POST /api/routers/:id/system/uptime` - Get router uptime (seconds + human-readable format)
- `POST /api/routers/:id/system/reboot` - Reboot router (Admin only)

**Network Management:**
- `POST /api/routers/:id/network/interfaces` - Get network interface status
- `POST /api/routers/:id/network/statistics` - Get detailed network statistics (bytes, packets, errors)
- `POST /api/routers/:id/network/speed` - Get real-time network speed/throughput (Mbps, Kbps)
- `POST /api/routers/:id/network/comprehensive` - Get comprehensive network info (all-in-one)

**Wireless:**
- `POST /api/routers/:id/wireless/status` - Get wireless interface status

**Configuration (UCI):**
- `POST /api/routers/:id/uci/read` - Read UCI configuration
- `POST /api/routers/:id/uci/set` - Update UCI configuration (Admin only)
- `POST /api/routers/:id/uci/commit` - Commit UCI configuration changes (Admin only)

**File Operations:**
- `POST /api/routers/:id/files/read` - Read files from router

**Services:**
- `POST /api/routers/:id/services/:action` - Control services (start/stop/restart/status) (Admin only)

**Advanced:**
- `POST /api/routers/:id/ubus` - Execute ubus RPC calls (Admin only)
- `POST /api/routers/:id/command/execute` - Execute shell commands (Admin only)
- `POST /api/routers/:id/logs` - Get router logs
- `POST /api/routers/:id/dhcp/leases` - Get DHCP leases (connected devices)

**Permissions:**
- Read-only endpoints (system info, network statistics, logs, etc.) are accessible to both HOST and ADMIN users
- Modification endpoints (reboot, UCI config changes, service control, ubus calls, shell commands) are **Admin only** for security
- HOST users can only access their own routers, ADMIN users can access all routers

### Invoices (Earnings/Payments)

- `GET /api/invoices` - List all invoices (auth required)
  - Admins see all invoices, hosts see only their earnings
- `GET /api/invoices/:id` - Get invoice details (auth required)
  - Admins can view any invoice, hosts only their own
- `POST /api/invoices/:id/pay` - Mark invoice as paid (Admin only)
  - Used when platform processes payment to host

### Quota Management (Cross-Router Data Limits)

- `GET /api/quota/:username` - Get user quota information (Admin only)
- `POST /api/quota` - Create or update user quota (Admin only)
  - Set data limits (e.g., 10 GB) that apply across all routers
- `GET /api/quota/:username/check` - Check if user has remaining quota (Public)
- `POST /api/quota/:username/reset` - Reset user quota for new period (Admin only)
- `GET /api/quota` - Get quota statistics (Admin only)

**Quota Features:**
- ✅ Cross-router quota tracking - Users can use quota on any router
- ✅ Single login enforcement - Users can only be logged in to one router at a time
- ✅ Dual limit enforcement - Both data quota and period expiry enforced by NAS
- ✅ Automatic quota updates via database triggers
- ✅ Real-time quota enforcement via FreeRADIUS
- ✅ Quota exhausted detection before login
- ✅ Period expiry handled via Session-Timeout attribute

### WebSocket

- `WS /ws?id=ROUTER_ID&token=ROUTER_TOKEN` - Router connection endpoint

## Router Integration

### OpenWRT Router Setup

SpotFi uses **OpenWRT** routers with **CoovaChilli** (captive portal) and a Python WebSocket bridge for real-time monitoring.

**📖 See [OpenWRT Setup Guide](docs/OPENWRT-SETUP.md) for detailed instructions**

**🔧 See [SSH Tunnel Testing Guide](docs/SSH-TUNNEL-TESTING.md) for testing remote terminal access**

#### Quick Setup:

1. **Create router in SpotFi** (get router ID, token, and RADIUS secret)

2. **Run auto-setup script** on your OpenWRT router:

**For WebSocket bridge only (cloud monitoring):**
```bash
# SSH into router
ssh root@192.168.1.1

# Download and run cloud setup script
curl -O https://your-server.com/scripts/openwrt-setup-cloud.sh
chmod +x openwrt-setup-cloud.sh

# Run with your router credentials
./openwrt-setup-cloud.sh ROUTER_ID TOKEN SERVER_IP MAC_ADDRESS [WS_PORT]
```

**For CoovaChilli/RADIUS captive portal only:**
```bash
curl -O https://your-server.com/scripts/openwrt-setup-chilli.sh
chmod +x openwrt-setup-chilli.sh

# Run with your router credentials
./openwrt-setup-chilli.sh ROUTER_ID RADIUS_SECRET SERVER_IP MAC_ADDRESS [WS_PORT]
```

The scripts automatically install and configure:
- ✅ **Cloud script**: Python WebSocket bridge (real-time monitoring and remote control)
- ✅ **Chilli script**: CoovaChilli (captive portal with RADIUS support), network and firewall configuration, auto-start services

#### Manual Setup:

See the [complete OpenWRT setup guide](docs/OPENWRT-SETUP.md) for step-by-step manual configuration.

#### Supported Hardware:

- **GL.iNet routers** (OpenWRT pre-installed) - Recommended
- **TP-Link Archer C7**
- **Linksys WRT series**
- Any OpenWRT-compatible router with 128MB+ RAM

#### Features:

- ✅ **Full RADIUS AAA** (Authentication, Authorization, Accounting)
- ✅ **Real-time WebSocket** connection for monitoring and control
- ✅ **Captive Portal** with customizable login page
- ✅ **Session Management** (bandwidth limits, timeouts from RADIUS)
- ✅ **Live Metrics** (CPU, memory, active users, network speed, uptime)
- ✅ **Remote Commands** (reboot, status, logs)
- ✅ **Remote Router Management** (ubus calls, UCI config, network statistics, file operations, service control)

## FreeRADIUS Integration

SpotFi uses PostgreSQL for both application data and RADIUS accounting. FreeRADIUS writes accounting data directly to PostgreSQL, and the system syncs it via cron jobs.

**📖 See [FreeRADIUS Setup Guide](docs/freeradius-setup.md) for detailed setup instructions**

### RADIUS Tables

- `radcheck` - User credentials
- `radreply` - User attributes (bandwidth limits)
- `radacct` - Accounting data (sessions, usage)
- `radpostauth` - Post-authentication logging
- `radgroupcheck`, `radgroupreply`, `radusergroup` - Group-based management
- `nas` - RADIUS clients (Network Access Servers)

### Sync Jobs

- **Hourly**: Sync RADIUS accounting → Router totalUsage
- **Monthly**: Generate invoices for all routers
- **Every 5 minutes**: Update router online/offline status

## Billing

Invoices (earnings/payments due to hosts) are automatically generated on the 1st of each month based on router usage.

- **Business Model**: Platform pays hosts monthly for data consumed by end users on their routers
- Usage is calculated from `radacct` table
- Payment = Usage (MB) × Payment Rate Per MB (default: $0.02/MB)
- Invoices are created with status `PENDING` (platform hasn't paid host yet)
- Only admins can mark invoices as `PAID` after processing payment to hosts

## Environment Variables

See `.env.example` for all available configuration options.

Key variables:
- `DATABASE_URL` - PostgreSQL connection string
- `JWT_SECRET` - Secret for JWT token signing
- `PAYMENT_RATE_PER_MB` - Payment rate per MB (what platform pays hosts, default: 0.02)
- `BILLING_COST_PER_MB` - Legacy name, use `PAYMENT_RATE_PER_MB` instead
- `PORT` - API server port (default: 8080)

## Development Notes

- The API uses TypeScript with ESM modules
- Prisma schema is in `packages/prisma/schema.prisma`
- WebSocket connections are authenticated via router token
- All database operations use Prisma ORM

## License

MIT

#   s p o t f i 
 
 