# Docker Deployment Guide

This guide covers deploying the SpotFi API server using Docker and Docker Compose.

## Prerequisites

- Docker Engine 20.10 or later
- Docker Compose V2
- External PostgreSQL database (configured and accessible)

## Quick Start

### 1. Configure Environment Variables

Create a `.env` file in the root directory:

```bash
cp .env.example .env
```

Edit `.env` and update the following required variables:

```env
# Database - IMPORTANT: Update with your external PostgreSQL connection
DATABASE_URL=postgresql://username:password@your-db-host:5432/spotfi

# JWT Secret - IMPORTANT: Change to a secure random string
JWT_SECRET=your-secure-jwt-secret-min-32-characters

# Server Configuration
NODE_ENV=production
PORT=8080
CORS_ORIGIN=https://your-frontend-domain.com
API_URL=https://your-api-domain.com
```

### 2. Prepare the Database

Before starting the application, ensure your external PostgreSQL database is set up:

```bash
# Run Prisma migrations on your external database
npm run prisma:migrate:deploy

# Optional: Seed initial data
npm run prisma:seed
```

### 3. Build and Run

Build and start the containers:

```bash
# Build the image
docker-compose build

# Start the service
docker-compose up -d

# View logs
docker-compose logs -f api
```

The API will be available at `http://localhost:8080` (or your configured PORT).

### 4. Verify Deployment

Check the health endpoint:

```bash
curl http://localhost:8080/health
```

Expected response:

```json
{
  "status": "ok",
  "timestamp": "2025-11-12T10:00:00.000Z"
}
```

Access API documentation:

```
http://localhost:8080/docs
```

## Management Commands

### View Logs

```bash
# Follow logs
docker-compose logs -f api

# View last 100 lines
docker-compose logs --tail=100 api
```

### Restart Service

```bash
docker-compose restart api
```

### Stop Service

```bash
docker-compose stop api
```

### Remove Containers

```bash
docker-compose down
```

### Rebuild After Code Changes

```bash
docker-compose build --no-cache api
docker-compose up -d api
```

## Environment Variables

### Required Variables

| Variable       | Description                                 | Example                               |
| -------------- | ------------------------------------------- | ------------------------------------- |
| `DATABASE_URL` | PostgreSQL connection string (external)     | `postgresql://user:pass@host:5432/db` |
| `JWT_SECRET`   | Secret for JWT token signing (min 32 chars) | `your-secure-random-string`           |

### Optional Variables

| Variable      | Description             | Default                 |
| ------------- | ----------------------- | ----------------------- |
| `NODE_ENV`    | Node environment        | `production`            |
| `PORT`        | Internal container port | `8080`                  |
| `HOST`        | Host binding            | `0.0.0.0`               |
| `CORS_ORIGIN` | Allowed CORS origins    | `*`                     |
| `API_URL`     | Public API URL for docs | `http://localhost:8080` |

## Production Considerations

### Security

1. **JWT Secret**: Use a strong, randomly generated secret:

   ```bash
   openssl rand -base64 64
   ```

2. **CORS Origin**: Set specific domain(s) instead of `*`:

   ```env
   CORS_ORIGIN=https://app.yourdomain.com
   ```

3. **Database**: Ensure PostgreSQL uses SSL/TLS:
   ```env
   DATABASE_URL=postgresql://user:pass@host:5432/db?sslmode=require
   ```

### Networking

If your PostgreSQL database is on the same Docker host:

- Use `host.docker.internal` to connect from the container
- Or connect the API container to the database network

Example with database on same host:

```yaml
# In docker-compose.yml
services:
  api:
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

Then in `.env`:

```env
DATABASE_URL=postgresql://user:pass@host.docker.internal:5432/db
```

### Reverse Proxy

For production, use a reverse proxy (nginx, Traefik, Caddy):

Example nginx configuration:

```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket support
    location /ws {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
    }
}
```

### Monitoring

Check container health:

```bash
docker-compose ps
docker inspect spotfi-api --format='{{.State.Health.Status}}'
```

### Resource Limits

Add resource limits in `docker-compose.yml`:

```yaml
services:
  api:
    deploy:
      resources:
        limits:
          cpus: "2"
          memory: 2G
        reservations:
          cpus: "1"
          memory: 1G
```

## Troubleshooting

### Container won't start

```bash
# Check logs
docker-compose logs api

# Check if port is already in use
netstat -an | grep 8080  # Windows
```

### Database connection issues

```bash
# Test from container
docker-compose exec api sh
# Inside container:
nc -zv your-db-host 5432
```

### Reset and rebuild

```bash
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

## Updates and Maintenance

### Updating the Application

1. Pull latest code:

   ```bash
   git pull origin main
   ```

2. Rebuild and restart:

   ```bash
   docker-compose build api
   docker-compose up -d api
   ```

3. Run migrations if needed:
   ```bash
   npm run prisma:migrate:deploy
   ```

### Backup Considerations

Since the database is external, ensure you have:

- Regular PostgreSQL backups
- Environment variable backups (`.env` file)
- Application configuration backups

## Support

For issues or questions:

- Check logs: `docker-compose logs -f api`
- Review health: `curl http://localhost:8080/health`
- Verify environment: `docker-compose config`
