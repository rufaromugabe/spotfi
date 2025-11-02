FROM freeradius/freeradius-server:latest

# Install PostgreSQL support and required packages
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    freeradius-postgresql \
    libpq-dev \
    postgresql-client \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy initialization script and migration file
COPY init-radius.sh /init-radius.sh
RUN chmod +x /init-radius.sh

# Create migrations directory (migration file can be mounted as volume if needed)
RUN mkdir -p /migrations

# Create directories for persistent config
RUN mkdir -p /etc/freeradius/3.0/mods-enabled && \
    mkdir -p /var/log/freeradius && \
    chown -R freerad:freerad /var/log/freeradius

# Expose RADIUS ports
EXPOSE 1812/udp 1813/udp

# Health check script
RUN echo '#!/bin/sh\n\
if [ "$1" = "healthcheck" ]; then\n\
  radtest healthcheck healthcheck 127.0.0.1 0 testing123 > /dev/null 2>&1\n\
  exit $?\n\
fi\n\
exec "$@"\n\
' > /docker-entrypoint.sh && chmod +x /docker-entrypoint.sh

# Run initialization and start FreeRADIUS
CMD ["/init-radius.sh"]

