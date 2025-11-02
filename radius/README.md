# FreeRADIUS Configuration

FreeRADIUS is configured to use PostgreSQL as its database backend, sharing the same database as the SpotFi application.

## Configuration

The `init-radius.sh` script automatically:
1. Installs PostgreSQL support (`freeradius-postgresql`)
2. Enables the SQL module
3. Configures the SQL module to connect to PostgreSQL
4. Starts FreeRADIUS

## Database Tables

FreeRADIUS uses these tables in PostgreSQL:
- `radcheck` - User credentials for authentication
- `radreply` - User attributes (bandwidth limits, quotas)
- `radacct` - Accounting data (session start/stop, data usage)
- `radpostauth` - Post-authentication records (optional, for debugging)

These tables are defined in the Prisma schema and created via migrations.

## Connection

FreeRADIUS connects to PostgreSQL using the same credentials as the API:
- Host: `db` (Docker service name)
- Port: `5432`
- Database: From `POSTGRES_DB` environment variable
- User: From `POSTGRES_USER` environment variable
- Password: From `POSTGRES_PASSWORD` environment variable

## Manual Setup (if not using Docker)

If setting up FreeRADIUS manually:

1. Install PostgreSQL support:
   ```bash
   sudo apt-get install freeradius-postgresql libpq-dev
   ```

2. Enable SQL module:
   ```bash
   sudo ln -s /etc/freeradius/3.0/mods-available/sql /etc/freeradius/3.0/mods-enabled/sql
   ```

3. Edit `/etc/freeradius/3.0/mods-available/sql` and set:
   ```
   dialect = "postgresql"
   server = "localhost"
   port = 5432
   login = "spotfi"
   password = "spotfi_password"
   radius_db = "spotfi_db"
   ```

4. Restart FreeRADIUS:
   ```bash
   sudo systemctl restart freeradius
   ```

