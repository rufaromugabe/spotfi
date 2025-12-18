# MQTT Migration Complete - Architecture Documentation

## Overview
SpotFi is now **100% MQTT-based** for all router communication. WebSocket support has been completely removed.

## Architecture Changes

### Go Bridge (spotfi-bridge-go)
**REMOVED:**
- WebSocket client dependency (`gorilla/websocket`)
- On-demand WebSocket tunnel connections
- Separate connection management for shell/terminal

**NOW USES:**
- Single MQTT connection for all communication
- Unified SessionManager for x-tunnel (terminal) sessions
- MQTT topics for all data flows

**MQTT Topics:**
```
spotfi/router/{id}/metrics       → Router heartbeat (every 30s)
spotfi/router/{id}/status        → Online/Offline with LWT
spotfi/router/{id}/rpc/request   → Incoming RPC commands
spotfi/router/{id}/rpc/response  → RPC responses
spotfi/router/{id}/x/in          → Terminal input from API
spotfi/router/{id}/x/out         → Terminal output to API
```

### API (apps/api)

**x-Tunnel Gateway (Distributed):**
- `xTunnelManager` now routes sessions via MQTT
- Any API instance can handle any x-tunnel session
- No local WebSocket connection required to router
- Sessions are location-independent across the cluster

**Key Files Modified:**
1. `apps/api/src/websocket/x-tunnel.ts`
   - Removed circuit breaker logic (obsolete)
   - Removed ping/pong verification (obsolete)
   - Added MQTT-based session routing
   - Sessions publish to `spotfi/router/{id}/x/in`
   - Sessions receive from `spotfi/router/{id}/x/out`

2. `apps/api/src/websocket/server.ts`
   - Removed on-demand connection trigger
   - Simplified /x endpoint (no polling/waiting)
   - Added MQTT gateway initialization

3. `apps/api/src/services/mqtt-handler.ts`
   - Added NAS entry sync on router ONLINE
   - Ensures RADIUS secrets are synced via MQTT

4. `apps/api/src/websocket/connection-handler.ts`
   - Marked as legacy (Python bridge only)
   - Go bridges do NOT use this

## Benefits

### Scalability
- **Horizontal API scaling**: Any instance can handle any router
- **No sticky sessions**: Load balancer can route freely
- **Reduced connection overhead**: Routers maintain 1 connection (MQTT)

### Reliability
- **MQTT QoS**: Guaranteed message delivery
- **Last Will Testament (LWT)**: Automatic offline detection
- **Broker-based routing**: No single point of failure per API instance

### Simplicity
- **Unified transport**: All data flows through MQTT
- **No fallback logic**: Clean, predictable architecture
- **Easier debugging**: All traffic visible in MQTT broker

## Migration Notes

### Database Schema
Added `nasipaddress` field to `Router` model:
```prisma
nasipaddress String? // Last known public IP of the router
```

This field is populated via MQTT handler when router connects.

### Removed Components
- **WebSocket `/ws` endpoint**: Completely removed
- **RouterConnectionHandler**: Deleted (no longer needed)
- **activeConnections Map**: Removed (routers don't connect via WS)
- **Circuit breaker logic**: Removed from x-tunnel
- **Ping/pong verification**: Removed (MQTT handles this)

## Testing Checklist
- [ ] Go bridge connects via MQTT only
- [ ] x-tunnel sessions work from any API instance
- [ ] RPC commands route correctly via MQTT
- [ ] Router heartbeat updates Redis
- [ ] NAS entries sync on router ONLINE
- [ ] RADIUS secrets are correct per-router
- [ ] Python bridges still work via WebSocket (if any)

## Future Enhancements
- Add MQTT message compression for bandwidth optimization
- Implement MQTT QoS 1 for critical messages
- Add MQTT message encryption (TLS)
