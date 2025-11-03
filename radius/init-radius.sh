#!/bin/sh
set -e

echo "Starting FreeRADIUS initialization..."

# Export PostgreSQL password for non-interactive use
export PGPASSWORD="${DB_PASSWORD}"

# Wait for database to be ready
echo "Waiting for PostgreSQL database to be ready..."
until pg_isready -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}"; do
  echo "Database is unavailable - sleeping"
  sleep 1
done
echo "Database is ready!"

# Run SQL migrations to add missing FreeRADIUS tables and columns
# Note: Password is provided via PGPASSWORD environment variable (set on line 7)
echo "Running database migrations..."
psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -f /config/postgres_schema_additional.sql || echo "Additional schema migration skipped (may already be applied)"
psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -f /config/postgres_radacct_migration.sql || echo "radacct migration skipped (may already be applied)"
psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -f /config/ensure_router_mac.sql || echo "Router MAC migration skipped (may already be applied)"
echo "Migrations completed"

# Enable PostgreSQL module in FreeRADIUS
if [ -f /etc/freeradius/mods-available/sql ]; then
  echo "Configuring FreeRADIUS PostgreSQL connection..."
  
  # Backup original config
  cp /etc/freeradius/mods-available/sql /etc/freeradius/mods-available/sql.bak
  
  # Enable the module
  ln -sf /etc/freeradius/mods-available/sql /etc/freeradius/mods-enabled/sql
  
  # Replace configuration with our custom SQL config that uses environment variables
  cp /config/sql /etc/freeradius/mods-available/sql
  
  echo "SQL module configured"
fi

# Enable SQL in the default site authorize section
if [ -f /etc/freeradius/sites-enabled/default ]; then
  echo "Enabling SQL module in default site..."
  # Replace -sql with sql to enable SQL authentication (use backup extension for Alpine compatibility)
  sed -i.bak 's/^-sql$/sql/' /etc/freeradius/sites-enabled/default && rm -f /etc/freeradius/sites-enabled/default.bak
  echo "SQL enabled in authorize section"
fi

# Validate FreeRADIUS configuration before starting
echo "Validating FreeRADIUS configuration..."
if ! freeradius -CX > /tmp/radius-check.log 2>&1; then
  echo "ERROR: FreeRADIUS configuration validation failed!"
  cat /tmp/radius-check.log
  exit 1
fi
echo "Configuration validated successfully"

# Configure clients
if [ ! -f /etc/freeradius/clients-custom.conf ]; then
  echo "Configuring FreeRADIUS clients..."
  cp /config/clients.conf /etc/freeradius/clients-custom.conf
  
  # Include custom clients config
  if ! grep -q "clients-custom.conf" /etc/freeradius/radiusd.conf; then
    echo "" >> /etc/freeradius/radiusd.conf
    echo "\$INCLUDE clients-custom.conf" >> /etc/freeradius/radiusd.conf
  fi
  
  echo "Clients configured"
fi

# Set debug level based on environment variable
DEBUG_FLAG="-f"
if [ "${RADIUS_DEBUG}" = "yes" ] || [ "${RADIUS_DEBUG}" = "true" ]; then
  DEBUG_FLAG="-x"
  echo "Starting FreeRADIUS in debug mode..."
fi

# Start FreeRADIUS
echo "Starting FreeRADIUS server..."
exec freeradius ${DEBUG_FLAG}
