# SpotFi VPS Deployment Guide

This guide will help you deploy SpotFi (API, PostgreSQL, and FreeRADIUS) on a fresh VPS using Docker.

## Prerequisites

- VPS with Docker and Docker Compose installed
- Root or sudo access
- Your VPS IP: **20.253.179.225**

## Step 1: Prepare Your VPS

### 1.1 Update System

```bash
sudo apt update && sudo apt upgrade -y
```

### 1.2 Install Docker (if not already installed)

```bash
# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Add your user to docker group (optional, to run without sudo)
sudo usermod -aG docker $USER
newgrp docker

# Install Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Verify installation
docker --version
docker-compose --version
```

## Step 2: Clone and Prepare SpotFi

### 2.1 Clone Repository (or upload files)

```bash
# If using git
git clone <your-repo-url> spotfi
cd spotfi

# Or upload files via SCP/SFTP
```

### 2.2 Create Environment File

```bash
# Copy the example environment file
cp .env.production.example .env
```

### 2.3 Edit Environment Variables

```bash
nano .env
```

**Important:** Update these values:

```env
# Generate a secure password for PostgreSQL
POSTGRES_PASSWORD=your_secure_random_password_here

# Generate a secure JWT secret (min 32 characters)
JWT_SECRET=your_secure_jwt_secret_min_32_characters_here

# Update API URL with your IP
API_URL=http://20.253.179.225:8080
```

**Generate secure passwords:**

```bash
# Generate PostgreSQL password
openssl rand -base64 32

# Generate JWT secret
openssl rand -base64 64
```

## Step 3: Configure Firewall

### 3.1 Open Required Ports

```bash
# If using UFW
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 8080/tcp  # API
sudo ufw allow 1812/udp  # RADIUS Authentication
sudo ufw allow 1813/udp  # RADIUS Accounting
sudo ufw enable

# Or if using iptables
sudo iptables -A INPUT -p tcp --dport 22 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 8080 -j ACCEPT
sudo iptables -A INPUT -p udp --dport 1812 -j ACCEPT
sudo iptables -A INPUT -p udp --dport 1813 -j ACCEPT
```

## Step 4: Initialize Database

### 4.1 Start PostgreSQL First

```bash
# Start only PostgreSQL to set up the database
docker-compose -f docker-compose.production.yml up -d postgres

# Wait for PostgreSQL to be ready (about 10-20 seconds)
docker-compose -f docker-compose.production.yml ps
```

### 4.2 Run Prisma Migrations

```bash
# Option 1: Run migrations from the host (if you have Node.js installed)
npm install
export DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5432/spotfi?schema=public"
npm run prisma:migrate:deploy

# Option 2: Run migrations inside a temporary container
docker run --rm --network spotfi_spotfi-network \
  -v $(pwd):/app -w /app \
  -e DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@postgres:5432/spotfi?schema=public" \
  node:20-slim sh -c "npm install && npm run prisma:migrate:deploy"
```

Replace `YOUR_PASSWORD` with your actual `POSTGRES_PASSWORD` from `.env`.

**Note:** Prisma migrations will create all database tables including FreeRADIUS tables (radacct, radcheck, radreply, radusergroup, nas, radquota, etc.). No manual schema initialization is needed.

### 4.4 Seed Database (Optional)

```bash
# Seed with default users (admin@spotfi.com / admin123, host@spotfi.com / host123)
# Option 1: From host (if Node.js installed)
npm run prisma:seed

# Option 2: Using temporary container
docker run --rm --network spotfi_spotfi-network \
  -v $(pwd):/app -w /app \
  -e DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@postgres:5432/spotfi?schema=public" \
  node:20-slim sh -c "npm install && npm run prisma:seed"
```

## Step 5: Start All Services

### 5.1 Build and Start

```bash
# Build all images
docker-compose -f docker-compose.production.yml build

# Start all services
docker-compose -f docker-compose.production.yml up -d

# Check status
docker-compose -f docker-compose.production.yml ps
```

### 5.2 View Logs

```bash
# View all logs
docker-compose -f docker-compose.production.yml logs -f

# View specific service logs
docker-compose -f docker-compose.production.yml logs -f api
docker-compose -f docker-compose.production.yml logs -f freeradius
docker-compose -f docker-compose.production.yml logs -f postgres
```

## Step 6: Verify Installation

### 6.1 Check API Health

```bash
# From VPS
curl http://localhost:8080/health

# From your local machine
curl http://20.253.179.225:8080/health
```

Expected response:
```json
{"status":"ok","timestamp":"2025-01-XX..."}
```

### 6.2 Access API Documentation

Open in your browser:
```
http://20.253.179.225:8080/docs
```

### 6.3 Test FreeRADIUS

```bash
# Test RADIUS authentication (from within the container)
docker-compose -f docker-compose.production.yml exec freeradius radtest testuser testpass localhost 0 testing123
```

### 6.4 Check Database Connection

```bash
# Connect to PostgreSQL
docker-compose -f docker-compose.production.yml exec postgres psql -U postgres -d spotfi

# Inside psql, check tables
\dt
\q
```

## Step 7: Security Hardening

### 7.1 Change Default Passwords

**IMPORTANT:** After first login, change default user passwords via API:

```bash
# Login as admin
curl -X POST http://20.253.179.225:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@spotfi.com","password":"admin123"}'

# Use the returned JWT token to change password
# (See API documentation at /docs for password change endpoint)
```

### 7.2 Restrict Database Access

The PostgreSQL database is only accessible within the Docker network. The port 5432 is exposed for debugging but can be removed from `docker-compose.production.yml` if not needed externally.

### 7.3 Set Up SSL/TLS (Recommended for Production)

Consider setting up nginx reverse proxy with Let's Encrypt SSL:

```nginx
server {
    listen 80;
    server_name 20.253.179.225;

    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

## Step 8: Maintenance Commands

### 8.1 Stop Services

```bash
docker-compose -f docker-compose.production.yml stop
```

### 8.2 Start Services

```bash
docker-compose -f docker-compose.production.yml start
```

### 8.3 Restart Services

```bash
docker-compose -f docker-compose.production.yml restart
```

### 8.4 Update Application

```bash
# Pull latest code
git pull

# Rebuild and restart
docker-compose -f docker-compose.production.yml build
docker-compose -f docker-compose.production.yml up -d

# Run new migrations if any
npm run prisma:migrate:deploy
```

### 8.5 Backup Database

```bash
# Create backup
docker-compose -f docker-compose.production.yml exec postgres pg_dump -U postgres spotfi > backup_$(date +%Y%m%d_%H%M%S).sql

# Restore backup
cat backup_YYYYMMDD_HHMMSS.sql | docker-compose -f docker-compose.production.yml exec -T postgres psql -U postgres spotfi
```

### 8.6 View Logs

```bash
# All services
docker-compose -f docker-compose.production.yml logs -f

# Specific service
docker-compose -f docker-compose.production.yml logs -f api
docker-compose -f docker-compose.production.yml logs -f freeradius
docker-compose -f docker-compose.production.yml logs -f postgres
```

## Troubleshooting

### Issue: API won't start

```bash
# Check logs
docker-compose -f docker-compose.production.yml logs api

# Common issues:
# - Database connection: Check DATABASE_URL in .env
# - JWT_SECRET missing: Ensure JWT_SECRET is set in .env
# - Port already in use: Change PORT in .env or stop conflicting service
```

### Issue: FreeRADIUS can't connect to database

```bash
# Check FreeRADIUS logs
docker-compose -f docker-compose.production.yml logs freeradius

# Verify database is accessible
docker-compose -f docker-compose.production.yml exec freeradius ping postgres

# Check database credentials match in .env
```

### Issue: Database connection refused

```bash
# Check if PostgreSQL is running
docker-compose -f docker-compose.production.yml ps postgres

# Check PostgreSQL logs
docker-compose -f docker-compose.production.yml logs postgres

# Verify network connectivity
docker-compose -f docker-compose.production.yml exec api ping postgres
```

### Issue: Can't access API from browser

```bash
# Check firewall
sudo ufw status

# Check if service is listening
sudo netstat -tlnp | grep 8080

# Test locally on VPS
curl http://localhost:8080/health

# Check CORS settings in .env
```

## Next Steps

1. **Set up a domain** (optional): Point your domain to `20.253.179.225` and update `API_URL` and `CORS_ORIGIN` in `.env`

2. **Configure routers**: Use the API to create routers and get RADIUS secrets for your OpenWRT routers

3. **Set up monitoring**: Consider adding monitoring tools like Prometheus/Grafana

4. **Regular backups**: Set up automated database backups

5. **SSL Certificate**: Set up SSL/TLS with Let's Encrypt for secure connections

## Support

- Check logs: `docker-compose -f docker-compose.production.yml logs -f`
- API Health: `curl http://20.253.179.225:8080/health`
- API Docs: `http://20.253.179.225:8080/docs`

