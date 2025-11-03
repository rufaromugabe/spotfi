FROM freeradius/freeradius-server:latest

# Install PostgreSQL client for health checks and migrations
RUN apt-get update && \
    apt-get install -y postgresql-client && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Create config directory
RUN mkdir -p /config

# Copy configuration files
COPY sql /config/sql
COPY clients.conf /config/clients.conf
COPY postgres_schema_additional.sql /config/postgres_schema_additional.sql
COPY postgres_radacct_migration.sql /config/postgres_radacct_migration.sql

# Copy initialization script
COPY init-radius.sh /init-radius.sh
RUN chmod +x /init-radius.sh

# Copy router MAC tracking migration
COPY ensure_router_mac.sql /config/ensure_router_mac.sql

EXPOSE 1812/udp 1813/udp

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD radtest healthcheck healthcheck 127.0.0.1 0 ${RADIUS_SECRET:-testing123} > /dev/null 2>&1 || exit 1

CMD ["sh", "/init-radius.sh"]

