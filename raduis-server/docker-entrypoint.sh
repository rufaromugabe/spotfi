#!/bin/sh
set -e

# this if will check if the first argument is a flag
# but only works if all arguments require a hyphenated flag
# -v; -SL; -f arg; etc will work, but not arg1 arg2
if [ "$#" -eq 0 ] || [ "${1#-}" != "$1" ]; then
    set -- freeradius "$@"
fi

# check for the expected command
if [ "$1" = 'freeradius' ]; then
    shift
    # Enable SQL module
    ln -sf /etc/freeradius/mods-available/sql /etc/freeradius/mods-enabled/
    
    # Fix permissions for the SQL configuration file
    chmod 640 /etc/freeradius/mods-enabled/sql
    
    # Start FreeRADIUS in foreground with debugging
    exec freeradius -X "$@"
fi

# many people are likely to call "radiusd" as well, so allow that
if [ "$1" = 'radiusd' ]; then
    shift
    exec freeradius -x "$@"
fi

# else default to run whatever the user wanted like "bash" or "sh"
exec "$@"
