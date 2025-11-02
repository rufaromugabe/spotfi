#!/bin/sh
# FreeRADIUS initialization script for PostgreSQL

set -e

echo "🔧 Configuring FreeRADIUS for PostgreSQL..."

# Initialize FreeRADIUS config directory structure if volume is empty
# Check if the directory structure exists, if not, restore from backup
if [ ! -d /etc/freeradius/3.0/mods-available ] || [ -z "$(ls -A /etc/freeradius/3.0/mods-available 2>/dev/null)" ]; then
  echo "📁 Initializing FreeRADIUS configuration directory structure..."
  
  # Restore base configuration from backup (created in Dockerfile)
  if [ -d /etc/freeradius/3.0.backup ]; then
    echo "   Restoring base configuration from backup..."
    # Copy preserving permissions and attributes
    cp -a /etc/freeradius/3.0.backup/. /etc/freeradius/3.0/ 2>/dev/null || {
      echo "   ⚠️  Some files may have failed to copy, but continuing..."
      # Fallback: create directories if copy failed
      mkdir -p /etc/freeradius/3.0/mods-available
      mkdir -p /etc/freeradius/3.0/mods-enabled
      mkdir -p /etc/freeradius/3.0/sites-available
      mkdir -p /etc/freeradius/3.0/sites-enabled
    }
    echo "   ✅ Base configuration restored"
  else
    echo "   ⚠️  Warning: Backup not found, creating minimal directory structure..."
    # Create necessary directories as fallback
    mkdir -p /etc/freeradius/3.0/mods-available
    mkdir -p /etc/freeradius/3.0/mods-enabled
    mkdir -p /etc/freeradius/3.0/sites-available
    mkdir -p /etc/freeradius/3.0/sites-enabled
    mkdir -p /etc/freeradius/3.0/clients.d
  fi
fi

# Wait for database to be ready
echo "⏳ Waiting for database connection..."
until PGPASSWORD="${DB_PASSWORD}" psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -c '\q' 2>/dev/null; do
  echo "   Database not ready, waiting 2 seconds..."
  sleep 2
done
echo "✅ Database connection established"

# Ensure mods-available directory exists
mkdir -p /etc/freeradius/3.0/mods-available
mkdir -p /etc/freeradius/3.0/mods-enabled

# Configure SQL module for PostgreSQL
cat > /etc/freeradius/3.0/mods-available/sql <<EOF
sql {
    dialect = "postgresql"
    driver = "rlm_sql_\${..dialect}"
    
    pool {
        start = 5
        min = 4
        max = 10
        spare = 3
        uses = 0
        retry_delay = 30
        lifetime = 0
        idle_timeout = 60
    }
    
    server = "${DB_HOST}"
    port = ${DB_PORT}
    login = "${DB_USER}"
    password = "${DB_PASSWORD}"
    radius_db = "${DB_NAME}"
    
    read_clients = yes
    
    accounting_table = "radacct"
    postauth_table = "radpostauth"
    authcheck_table = "radcheck"
    authreply_table = "radreply"
    groupcheck_table = "radgroupcheck"
    groupreply_table = "radgroupreply"
    usergroup_table = "radusergroup"
}
EOF

# Ensure SQL module is enabled
if [ ! -L /etc/freeradius/3.0/mods-enabled/sql ]; then
  ln -s /etc/freeradius/3.0/mods-available/sql /etc/freeradius/3.0/mods-enabled/sql
fi

# Configure clients - allow connections from any IP with the shared secret
# This is needed for initial testing. For production, configure specific clients.
echo "🔐 Configuring RADIUS clients..."
mkdir -p /etc/freeradius/3.0/clients.d

# Create a default client configuration that accepts connections from anywhere
# This allows testing from any IP. For production, restrict to specific IPs.
cat > /etc/freeradius/3.0/clients.d/default.conf <<EOF
# Default client configuration for testing
# Accept connections from any IP address with the shared secret
# For production, create specific client entries for each router/NAS
client default {
    ipaddr = *
    secret = ${RADIUS_SECRET:-testing123}
    require_message_authenticator = no
    nas_type = other
}
EOF

echo "   ✅ Client configuration created"

# Apply database trigger for router MAC tracking (if SQL file exists)
if [ -f /migrations/ensure_router_mac.sql ]; then
  echo "📊 Applying router MAC tracking trigger..."
  PGPASSWORD="${DB_PASSWORD}" psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -f /migrations/ensure_router_mac.sql 2>/dev/null || echo "   Trigger may already exist, skipping..."
fi

echo "✅ FreeRADIUS PostgreSQL configuration complete"

# Determine if debug mode
if [ "${RADIUS_DEBUG:-no}" = "yes" ] || [ "${RADIUS_DEBUG:-no}" = "true" ]; then
  echo "🐛 Starting FreeRADIUS in DEBUG mode..."
  exec freeradius -X
else
  echo "🚀 Starting FreeRADIUS in production mode..."
  exec freeradius -f
fi

