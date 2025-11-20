#!/bin/bash

# SpotFi VPS Setup Script
# This script automates the deployment of SpotFi on a fresh VPS

set -e

echo "========================================="
echo "SpotFi VPS Deployment Script"
echo "========================================="
echo ""

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "Docker is not installed. Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    sudo usermod -aG docker $USER
    echo "Docker installed. Please log out and log back in, then run this script again."
    exit 0
fi

# Check if Docker Compose is installed
if ! command -v docker-compose &> /dev/null; then
    echo "Docker Compose is not installed. Installing Docker Compose..."
    sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    sudo chmod +x /usr/local/bin/docker-compose
fi

# Check if .env exists
if [ ! -f .env ]; then
    echo "Creating .env file from example..."
    cp env.production.example .env
    
    # Generate secure passwords
    POSTGRES_PASSWORD=$(openssl rand -base64 32 | tr -d '\n')
    JWT_SECRET=$(openssl rand -base64 64 | tr -d '\n')
    
    # Update .env with generated passwords (use | as delimiter to avoid issues with special chars)
    sed -i "s|spotfi_password|$POSTGRES_PASSWORD|" .env
    sed -i "s|CHANGE_ME_TO_SECURE_JWT_SECRET_MIN_32_CHARACTERS|$JWT_SECRET|" .env
    
    echo "✅ Created .env with auto-generated secure passwords"
    echo "⚠️  IMPORTANT: Keep your .env file secure! Passwords have been auto-generated."
else
    echo "✅ .env file already exists"
fi

# Source environment variables
source .env

# Start PostgreSQL first
echo ""
echo "Starting PostgreSQL database..."
docker-compose -f docker-compose.production.yml up -d postgres

# Wait for PostgreSQL to be ready
echo "Waiting for PostgreSQL to be ready..."
timeout=60
counter=0
while ! docker-compose -f docker-compose.production.yml exec -T postgres pg_isready -U ${POSTGRES_USER:-postgres} > /dev/null 2>&1; do
    sleep 1
    counter=$((counter + 1))
    if [ $counter -ge $timeout ]; then
        echo "❌ PostgreSQL failed to start within $timeout seconds"
        exit 1
    fi
done
echo "✅ PostgreSQL is ready"

# Run Prisma migrations (requires Node.js)
if command -v node &> /dev/null && [ -f package.json ]; then
    echo ""
    echo "Running Prisma migrations..."
    export DATABASE_URL="postgresql://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD}@localhost:5432/${POSTGRES_DB:-spotfi}?schema=public"
    
    if [ ! -d node_modules ]; then
        echo "Installing dependencies..."
        npm install
    fi
    
    npm run prisma:generate
    npm run prisma:migrate:deploy
    echo "✅ Prisma migrations completed"
else
    echo ""
    echo "⚠️  Node.js not found or package.json missing. Skipping Prisma migrations."
    echo "   You can run migrations manually later with:"
    echo "   npm install && npm run prisma:migrate:deploy"
fi

# Build and start all services
echo ""
echo "Building Docker images..."
docker-compose -f docker-compose.production.yml build

echo ""
echo "Starting all services..."
docker-compose -f docker-compose.production.yml up -d

# Wait for services to be healthy
echo ""
echo "Waiting for services to start..."
sleep 10

# Check service status
echo ""
echo "Service Status:"
docker-compose -f docker-compose.production.yml ps

# Test API health
echo ""
echo "Testing API health..."
sleep 5
if curl -f http://localhost:8080/health > /dev/null 2>&1; then
    echo "✅ API is healthy and responding"
else
    echo "⚠️  API health check failed. Check logs with: docker-compose -f docker-compose.production.yml logs api"
fi

echo ""
echo "========================================="
echo "✅ Deployment Complete!"
echo "========================================="
echo ""
echo "Your SpotFi installation is now running!"
echo ""
echo "Access your API:"
echo "  - Health: http://20.253.179.225:8080/health"
echo "  - Docs:   http://20.253.179.225:8080/docs"
echo ""
echo "Default users (change passwords after first login!):"
echo "  - Admin: admin@spotfi.com / admin123"
echo "  - Host:  host@spotfi.com / host123"
echo ""
echo "Useful commands:"
echo "  - View logs:    docker-compose -f docker-compose.production.yml logs -f"
echo "  - Stop:         docker-compose -f docker-compose.production.yml stop"
echo "  - Start:        docker-compose -f docker-compose.production.yml start"
echo "  - Restart:      docker-compose -f docker-compose.production.yml restart"
echo "  - Status:       docker-compose -f docker-compose.production.yml ps"
echo ""
echo "⚠️  IMPORTANT:"
echo "  1. Change default user passwords after first login"
echo "  2. Keep your .env file secure (contains database passwords)"
echo "  3. Set up regular database backups"
echo ""

