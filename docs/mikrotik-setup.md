# MikroTik Router Setup Guide

This guide explains how to connect MikroTik routers to SpotFi's cloud management platform.

## Prerequisites

- MikroTik router with RouterOS 6.40 or later
- Router registered in SpotFi dashboard (you'll get a Router ID and Token)
- SpotFi API endpoint URL

## Step 1: Register Router in SpotFi

1. Login to SpotFi dashboard
2. Create a new router entry
3. Copy the Router ID and Token

## Step 2: Configure RADIUS on MikroTik

Connect to your router via Winbox or SSH and run:

```bash
# Add RADIUS server
/ip radius add service=hotspot address=<SPOTFI_RADIUS_IP> secret=<RADIUS_SECRET>

# Enable RADIUS for hotspot profile
/ip hotspot profile set hotspot1 radius=yes
```

Replace:
- `<SPOTFI_RADIUS_IP>` with your SpotFi RADIUS server IP
- `<RADIUS_SECRET>` with your RADIUS secret (configured in FreeRADIUS)

## Step 3: WebSocket Connection Script

Create a scheduler script to maintain WebSocket connection:

### Router Script (RouterOS)

```bash
# Variables
:local routerId "YOUR_ROUTER_ID"
:local routerToken "YOUR_ROUTER_TOKEN"
:local wsUrl "wss://api.spotfi.com/ws?id=$routerId&token=$routerToken"
:local reconnectInterval 60

# WebSocket connection script
:local connectWs do={
    :local result [/tool fetch url=$wsUrl \
        http-method=websocket \
        output=none \
        http-header-field="Authorization: Bearer $routerToken" \
        as-value]
    
    :if ($result->"status" = "success") do={
        :log info "Connected to SpotFi WebSocket"
    } else={
        :log error "Failed to connect to SpotFi WebSocket"
    }
}

# Initial connection
$connectWs

# Schedule reconnection every minute
/system scheduler add \
    name="spotfi-reconnect" \
    interval=$reconnectInterval \
    start-time=startup \
    on-event="$connectWs"
```

### Sending Metrics

To send router metrics to SpotFi via WebSocket:

```bash
# Get interface statistics
:local interfaceName "ether1"
:local rxBytes [/interface ethernet get $interfaceName rx-byte]
:local txBytes [/interface ethernet get $interfaceName tx-byte]

# Create metrics JSON
:local metricsJson "{\"type\":\"metrics\",\"interface\":\"$interfaceName\",\"rxBytes\":$rxBytes,\"txBytes\":$txBytes,\"timestamp\":\"$(/system clock get date) $(/system clock get time)\"}"

# Send via WebSocket (if connected)
# Note: MikroTik RouterOS doesn't have native WebSocket client in scripts
# You may need to use an external agent or tool
```

## Step 4: Remote Commands

SpotFi can send commands to your router via WebSocket. The router should listen for commands:

```json
{
  "id": "command-123",
  "type": "command",
  "command": "reboot",
  "params": {},
  "timestamp": "2024-01-01T00:00:00Z"
}
```

Supported commands:
- `reboot` - Restart the router
- `get-status` - Get router status
- `fetch-logs` - Get router logs
- `update-config` - Update router configuration

## Step 5: Hotspot User Authentication

When a user connects to the hotspot:

1. MikroTik sends Access-Request to FreeRADIUS
2. FreeRADIUS validates credentials from `radcheck` table
3. If valid, FreeRADIUS responds with Access-Accept and attributes (bandwidth limits)
4. MikroTik allows connection and enforces limits
5. MikroTik sends Accounting-Start, periodic Accounting-Update, and Accounting-Stop packets

## Troubleshooting

### WebSocket Connection Issues

1. Check firewall rules - ensure port 443 (WSS) is allowed
2. Verify router ID and token are correct
3. Check SpotFi API logs for connection errors
4. Ensure router can reach the SpotFi API endpoint

### RADIUS Authentication Issues

1. Verify RADIUS secret matches on both sides
2. Check FreeRADIUS logs: `tail -f /var/log/freeradius/radius.log`
3. Verify user exists in `radcheck` table
4. Check network connectivity between router and RADIUS server

### Accounting Data Not Syncing

1. Verify Accounting-Start/Stop packets are being sent
2. Check FreeRADIUS SQL module is enabled
3. Verify database connection in FreeRADIUS config
4. Check SpotFi cron job logs for sync errors

## Advanced: Custom Router Agent

For more advanced features, consider deploying a lightweight agent on the router (e.g., via Docker or a compiled binary) that:

- Maintains persistent WebSocket connection
- Handles reconnection logic
- Sends periodic metrics
- Executes remote commands
- Reports router health status

This agent can be deployed as a RouterOS package or run in a container environment.

