#!/bin/sh
# FreeRADIUS initialization script for PostgreSQL

set -e

# Determine FreeRADIUS config directory
if [ -d /etc/freeradius/mods-available ]; then
  RADIUS_CONFIG_DIR="/etc/freeradius"
elif [ -d /etc/freeradius/3.0/mods-available ]; then
  RADIUS_CONFIG_DIR="/etc/freeradius/3.0"
else
  RADIUS_CONFIG_DIR="/etc/freeradius"
fi

echo "🔧 Configuring FreeRADIUS for PostgreSQL..."
echo "   Using config directory: $RADIUS_CONFIG_DIR"

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
mkdir -p ${RADIUS_CONFIG_DIR}/mods-available
mkdir -p ${RADIUS_CONFIG_DIR}/mods-enabled

# Check if SQL module is already configured (lock file mechanism)
INIT_LOCK=${RADIUS_CONFIG_DIR}/.radius_sql_configured
if [ -f "$INIT_LOCK" ] && [ -f ${RADIUS_CONFIG_DIR}/mods-available/sql ]; then
  # Verify SQL module is properly configured with read_clients = no
  if grep -q "read_clients = no" ${RADIUS_CONFIG_DIR}/mods-available/sql 2>/dev/null && \
     grep -q "dialect = \"postgresql\"" ${RADIUS_CONFIG_DIR}/mods-available/sql 2>/dev/null; then
    echo "📋 SQL module already configured (lock file exists), skipping SQL configuration..."
  else
    echo "⚠️  SQL module exists but configuration invalid, reconfiguring..."
    rm -f "$INIT_LOCK"
  fi
fi

# Configure SQL module for PostgreSQL (only if not already configured)
if [ ! -f "$INIT_LOCK" ]; then
  cat > ${RADIUS_CONFIG_DIR}/mods-available/sql <<EOF
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
    
    read_clients = no
    
    accounting_table = "radacct"
    postauth_table = "radpostauth"
    authcheck_table = "radcheck"
    authreply_table = "radreply"
    groupcheck_table = "radgroupcheck"
    groupreply_table = "radgroupreply"
    usergroup_table = "radusergroup"
    
    # Include queries from mods-config/sql/main/postgresql/queries.conf
    # This is automatically included based on dialect, but we ensure it exists above
}
EOF

  echo "   ✅ SQL module configured"
  # Create lock file to indicate SQL module is configured
  touch "$INIT_LOCK"
fi

# Ensure SQL module is enabled
if [ ! -L ${RADIUS_CONFIG_DIR}/mods-enabled/sql ]; then
  ln -s ${RADIUS_CONFIG_DIR}/mods-available/sql ${RADIUS_CONFIG_DIR}/mods-enabled/sql
fi

# Ensure SQL query templates exist (required for SQL module to work)
# FreeRADIUS needs the query templates in mods-config/sql/main/postgresql/
if [ ! -d ${RADIUS_CONFIG_DIR}/mods-config/sql/main/postgresql ]; then
  mkdir -p ${RADIUS_CONFIG_DIR}/mods-config/sql/main/postgresql
  # Copy query templates from backup if available, or create minimal ones
  if [ -d ${RADIUS_CONFIG_DIR}.backup/mods-config/sql/main/postgresql ]; then
    cp -r ${RADIUS_CONFIG_DIR}.backup/mods-config/sql/main/postgresql/* ${RADIUS_CONFIG_DIR}/mods-config/sql/main/postgresql/ 2>/dev/null || true
  else
    # Create minimal query files if backup doesn't exist
    # FreeRADIUS 3.x queries.conf format - just query strings, no blocks
    echo "   📝 Creating SQL query templates..."
    cat > ${RADIUS_CONFIG_DIR}/mods-config/sql/main/postgresql/queries.conf <<'QUERYEOF'
# FreeRADIUS PostgreSQL Query Templates
# This file contains SQL queries used by the SQL module
# Column names match FreeRADIUS standard schema (UserName, Attribute, Value)

# Authentication check query - retrieves user credentials from radcheck
authorize_check_query = "SELECT id, \"UserName\", \"Attribute\", op, \"Value\" FROM ${authcheck_table} WHERE \"UserName\" = '%{SQL-User-Name}' ORDER BY id"

# Authentication reply query - retrieves user attributes from radreply  
authorize_reply_query = "SELECT id, \"UserName\", \"Attribute\", \"Value\" FROM ${authreply_table} WHERE \"UserName\" = '%{SQL-User-Name}' ORDER BY id"

# Group check query
group_check_query = "SELECT id, \"GroupName\", \"Attribute\", op, \"Value\" FROM ${groupcheck_table} WHERE \"GroupName\" = '%{SQL-Group-Name}' ORDER BY id"

# Group reply query
group_reply_query = "SELECT id, \"GroupName\", \"Attribute\", \"Value\" FROM ${groupreply_table} WHERE \"GroupName\" = '%{SQL-Group-Name}' ORDER BY id"

# User group membership query
usergroup_check_query = "SELECT \"GroupName\" FROM ${usergroup_table} WHERE \"UserName\" = '%{SQL-User-Name}' ORDER BY priority"

# Accounting start query
accounting_start_query = "INSERT INTO ${accounting_table} (acctuniqueid, username, nasipaddress, acctstarttime, acctsessiontime, acctinputoctets, acctoutputoctets, accttotaloctets, framedipaddress) VALUES ('%{%{Acct-Unique-Session-Id}:-%{%{Acct-Session-ID}:-%{%{Auth-Type}:-noauth}}}-%{%{NAS-IP-Address}:-%{%{NAS-IPv6-Address}:-0.0.0.0}}}', '%{SQL-User-Name}', '%{%{NAS-IP-Address}:-%{%{NAS-IPv6-Address}:-%{Packet-Src-IP-Address}}}', NOW(), 0, 0, 0, 0, '%{Framed-IP-Address}')"

# Accounting stop query
accounting_stop_query = "UPDATE ${accounting_table} SET acctstoptime = NOW(), acctsessiontime = '%{Acct-Session-Time}', acctinputoctets = '%{Acct-Input-Octets}', acctoutputoctets = '%{Acct-Output-Octets}', accttotaloctets = '%{Acct-Input-Octets}' + '%{Acct-Output-Octets}' WHERE acctuniqueid = '%{%{Acct-Unique-Session-Id}:-%{%{Acct-Session-ID}:-%{%{Auth-Type}:-noauth}}}'"

# Accounting update query
accounting_update_query = "UPDATE ${accounting_table} SET acctinputoctets = '%{Acct-Input-Octets}', acctoutputoctets = '%{Acct-Output-Octets}', accttotaloctets = '%{Acct-Input-Octets}' + '%{Acct-Output-Octets}' WHERE acctuniqueid = '%{%{Acct-Unique-Session-Id}:-%{%{Acct-Session-ID}:-%{%{Auth-Type}:-noauth}}}'"

# Post-auth query
postauth_query = "INSERT INTO ${postauth_table} (username, pass, reply, authdate, class) VALUES ('%{User-Name}', '%{User-Password}', '%{reply:Packet-Type}', NOW(), '%{Class}')"
QUERYEOF
  fi
fi

# Ensure default site is enabled
if [ ! -L ${RADIUS_CONFIG_DIR}/sites-enabled/default ]; then
  if [ -f ${RADIUS_CONFIG_DIR}/sites-available/default ]; then
    ln -s ${RADIUS_CONFIG_DIR}/sites-available/default ${RADIUS_CONFIG_DIR}/sites-enabled/default
  elif [ -f ${RADIUS_CONFIG_DIR}.backup/sites-available/default ]; then
    # Copy from backup if available
    mkdir -p ${RADIUS_CONFIG_DIR}/sites-available
    cp ${RADIUS_CONFIG_DIR}.backup/sites-available/default ${RADIUS_CONFIG_DIR}/sites-available/default 2>/dev/null || true
    ln -s ${RADIUS_CONFIG_DIR}/sites-available/default ${RADIUS_CONFIG_DIR}/sites-enabled/default
  fi
fi

# Ensure inner-tunnel site is enabled (for EAP)
if [ ! -L ${RADIUS_CONFIG_DIR}/sites-enabled/inner-tunnel ]; then
  if [ -f ${RADIUS_CONFIG_DIR}/sites-available/inner-tunnel ]; then
    ln -s ${RADIUS_CONFIG_DIR}/sites-available/inner-tunnel ${RADIUS_CONFIG_DIR}/sites-enabled/inner-tunnel
  elif [ -f ${RADIUS_CONFIG_DIR}.backup/sites-available/inner-tunnel ]; then
    mkdir -p ${RADIUS_CONFIG_DIR}/sites-available
    cp ${RADIUS_CONFIG_DIR}.backup/sites-available/inner-tunnel ${RADIUS_CONFIG_DIR}/sites-available/inner-tunnel 2>/dev/null || true
    ln -s ${RADIUS_CONFIG_DIR}/sites-available/inner-tunnel ${RADIUS_CONFIG_DIR}/sites-enabled/inner-tunnel
  fi
fi

# If default site doesn't exist, create a minimal one that uses SQL
if [ ! -f ${RADIUS_CONFIG_DIR}/sites-available/default ]; then
  echo "📝 Creating minimal default site configuration..."
  mkdir -p ${RADIUS_CONFIG_DIR}/sites-available
  cat > ${RADIUS_CONFIG_DIR}/sites-available/default <<'SITEEOF'
server default {
    listen {
        type = auth
        ipaddr = *
        port = 1812
    }
    
    listen {
        type = acct
        ipaddr = *
        port = 1813
    }
    
    authorize {
        preprocess
        sql
        if (noop) {
            ok
        }
    }
    
    authenticate {
        Auth-Type SQL {
            sql
        }
    }
    
    preacct {
        preprocess
        acct_unique
        sql
    }
    
    accounting {
        sql
        unix
        radutmp
    }
    
    session {
        sql
    }
    
    post-auth {
        sql
        remove_reply_message_if_eap
        Post-Auth-Type REJECT {
            attr_filter.access_reject
        }
    }
    
    pre-proxy {
    }
    
    post-proxy {
        eap
    }
}
SITEEOF
  # Ensure sites-enabled directory exists
  mkdir -p ${RADIUS_CONFIG_DIR}/sites-enabled
  # Enable the site
  if [ ! -L ${RADIUS_CONFIG_DIR}/sites-enabled/default ]; then
    ln -s ${RADIUS_CONFIG_DIR}/sites-available/default ${RADIUS_CONFIG_DIR}/sites-enabled/default
  fi
  echo "   ✅ Default site created and enabled"
fi

# Configure clients - allow connections from any IP with the shared secret
# This is needed for initial testing. For production, configure specific clients.
echo "🔐 Configuring RADIUS clients..."
mkdir -p ${RADIUS_CONFIG_DIR}/clients.d

# Only create default client config if it doesn't exist (preserve manual changes)
if [ ! -f ${RADIUS_CONFIG_DIR}/clients.d/default.conf ]; then
  # Create a default client configuration that accepts connections from anywhere
  # This allows testing from any IP. For production, restrict to specific IPs.
  cat > ${RADIUS_CONFIG_DIR}/clients.d/default.conf <<EOF
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
else
  echo "   ℹ️  Client configuration already exists, skipping..."
fi

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

