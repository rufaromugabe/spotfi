# UAM Server Configuration

## Environment Variables

```bash
UAM_SECRET=your-secure-uam-secret-min-32-chars
UAM_SERVER_PATH=/uam/login
RADIUS_SERVER_1=radius.hotspotsystem.com
RADIUS_SERVER_2=radius2.hotspotsystem.com
RADIUS_SECRET=hotsys123
RADIUS_PORT=1812
API_URL=https://api.spotfi.com
```

## Router Configuration

```
UAM Server: https://api.spotfi.com/uam/login
UAM Secret: your-secure-uam-secret-min-32-chars
RADIUS server 1: radius.hotspotsystem.com
RADIUS server 2: radius2.hotspotsystem.com
RADIUS Secret: hotsys123
CoA Port: 3799
UAM Allowed: api.spotfi.com,8.8.8.8,8.8.4.4
```

**OpenWRT with uspot:**
```bash
uci set uspot.@instance[0].portal_url="https://api.spotfi.com/uam/login"
uci set uspot.@instance[0].radius_auth_server="radius.hotspotsystem.com"
uci set uspot.@instance[0].radius_secret="hotsys123"
uci set uspot.@instance[0].uam_secret="your-secure-uam-secret-min-32-chars"
uci commit uspot
/etc/init.d/uspot restart
```

**Note:** If uspot doesn't support `uam_secret` option, append it to the portal URL:
```bash
uci set uspot.@instance[0].portal_url="https://api.spotfi.com/uam/login?uamsecret=your-secure-uam-secret-min-32-chars"
```

## Endpoints

- `GET/POST {UAM_SERVER_PATH}` - UAM server endpoint (default: `/uam/login`)
- `GET /api` - RFC8908 Captive Portal API

## Features

- Standard UAM/WISPr protocol
- UAM Secret validation
- RADIUS authentication
- CoA (RFC 5176) support
