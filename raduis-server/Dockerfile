FROM freeradius/freeradius-server:latest

# Copy the custom entrypoint script into the image
COPY docker-entrypoint.sh /docker-entrypoint.sh

# Copy SQL configuration
COPY sql /etc/freeradius/mods-available/sql

# Copy custom queries.conf with dynamic quota calculation
COPY mods-config/sql/main/postgresql/queries.conf /etc/freeradius/mods-config/sql/main/postgresql/queries.conf

# Make entrypoint executable
RUN chmod +x /docker-entrypoint.sh && \
    chmod 640 /etc/freeradius/mods-available/sql && \
    chmod 640 /etc/freeradius/mods-config/sql/main/postgresql/queries.conf

# Set the custom entrypoint
ENTRYPOINT ["/bin/sh", "/docker-entrypoint.sh"]

# Default command
CMD ["freeradius"]

