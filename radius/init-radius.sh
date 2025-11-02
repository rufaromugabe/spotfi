#!/bin/sh
# FreeRADIUS initialization script for PostgreSQL

set -e

echo "🔧 Configuring FreeRADIUS for PostgreSQL..."

# Install PostgreSQL support
apt-get update
apt-get install -y freeradius-postgresql libpq-dev

# Enable SQL module
if [ ! -L /etc/freeradius/3.0/mods-enabled/sql ]; then
  ln -s /etc/freeradius/3.0/mods-available/sql /etc/freeradius/3.0/mods-enabled/sql
fi

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

echo "✅ FreeRADIUS PostgreSQL configuration complete"
echo "🚀 Starting FreeRADIUS..."

# Start FreeRADIUS in foreground with debug
exec freeradius -X

