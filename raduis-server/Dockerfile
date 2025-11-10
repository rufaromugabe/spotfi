FROM freeradius/freeradius-server:latest

# Copy the custom entrypoint script into the image
COPY docker-entrypoint.sh /docker-entrypoint.sh

# Copy SQL configuration
COPY sql /etc/freeradius/mods-available/sql

# Make entrypoint executable
RUN chmod +x /docker-entrypoint.sh && \
    chmod 640 /etc/freeradius/mods-available/sql

# Set the custom entrypoint
ENTRYPOINT ["/bin/sh", "/docker-entrypoint.sh"]

# Default command
CMD ["freeradius"]

