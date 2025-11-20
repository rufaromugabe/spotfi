# SpotFi Quick Start for VPS

Quick deployment guide for VPS with IP **20.253.179.225**.

## Prerequisites

- VPS with Docker installed
- SSH access to the VPS

## Quick Setup (5 minutes)

### 1. Upload Files to VPS

```bash
# On your local machine, upload files to VPS
scp -r . root@20.253.179.225:/root/spotfi
# Or use SFTP/rsync
```

### 2. SSH into VPS

```bash
ssh root@20.253.179.225
cd /root/spotfi
```

### 3. Run Setup Script

```bash
chmod +x setup-vps.sh
./setup-vps.sh
```

The script will:
- ✅ Check/install Docker & Docker Compose
- ✅ Create `.env` with secure passwords
- ✅ Start PostgreSQL
- ✅ Initialize database schemas
- ✅ Run migrations
- ✅ Start all services (API, FreeRADIUS, PostgreSQL)

### 4. Open Firewall Ports

```bash
# UFW
sudo ufw allow 8080/tcp
sudo ufw allow 1812/udp
sudo ufw allow 1813/udp

# Or iptables
sudo iptables -A INPUT -p tcp --dport 8080 -j ACCEPT
sudo iptables -A INPUT -p udp --dport 1812 -j ACCEPT
sudo iptables -A INPUT -p udp --dport 1813 -j ACCEPT
```

### 5. Verify Installation

```bash
# Test API health
curl http://20.253.179.225:8080/health

# Or visit in browser
http://20.253.179.225:8080/docs
```

## Manual Setup (if script fails)

### 1. Create Environment File

```bash
cp env.production.example .env
nano .env
```

Generate secure passwords:
```bash
openssl rand -base64 32  # For POSTGRES_PASSWORD
openssl rand -base64 64  # For JWT_SECRET
```

Update `.env`:
- `POSTGRES_PASSWORD` - use generated password
- `JWT_SECRET` - use generated secret (min 32 chars)
- `API_URL` - already set to http://20.253.179.225:8080

### 2. Start Services

```bash
# Start PostgreSQL first
docker-compose -f docker-compose.production.yml up -d postgres

# Wait 10 seconds for PostgreSQL to be ready
sleep 10

# Start all services
docker-compose -f docker-compose.production.yml up -d

# Check status
docker-compose -f docker-compose.production.yml ps
```

### 3. Run Migrations (if you have Node.js)

```bash
npm install
export DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5432/spotfi?schema=public"
npm run prisma:migrate:deploy
npm run prisma:seed  # Optional: create default users
```

## Access Your Installation

- **API Health**: http://20.253.179.225:8080/health
- **API Docs**: http://20.253.179.225:8080/docs
- **Default Admin**: admin@spotfi.com / admin123
- **Default Host**: host@spotfi.com / host123

⚠️ **Change default passwords after first login!**

## Common Commands

```bash
# View logs
docker-compose -f docker-compose.production.yml logs -f

# Restart services
docker-compose -f docker-compose.production.yml restart

# Stop services
docker-compose -f docker-compose.production.yml stop

# Start services
docker-compose -f docker-compose.production.yml start

# View status
docker-compose -f docker-compose.production.yml ps
```

## Troubleshooting

### Port already in use

```bash
# Check what's using port 8080
sudo netstat -tlnp | grep 8080

# Change PORT in .env if needed
nano .env  # Change PORT=8080 to PORT=8081
```

### Database connection failed

```bash
# Check PostgreSQL logs
docker-compose -f docker-compose.production.yml logs postgres

# Verify database is running
docker-compose -f docker-compose.production.yml ps postgres

# Check .env has correct passwords
cat .env | grep POSTGRES
```

### API won't start

```bash
# Check API logs
docker-compose -f docker-compose.production.yml logs api

# Verify JWT_SECRET is set
cat .env | grep JWT_SECRET
```

## Next Steps

1. Change default user passwords
2. Configure your routers with RADIUS secrets
3. Set up domain name (optional)
4. Configure SSL/TLS (recommended for production)
5. Set up regular backups

For detailed instructions, see `VPS-DEPLOYMENT.md`

