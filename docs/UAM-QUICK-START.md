# UAM Server Configuration

## Environment Variables

```bash
UAM_SERVER_URL=https://api.spotfi.com/uam/login
RADIUS_SERVER_1=radius.hotspotsystem.com
RADIUS_SERVER_2=radius2.hotspotsystem.com
RADIUS_SECRET=hotsys123
RADIUS_PORT=1812
API_URL=https://api.spotfi.com
```

## Router Configuration

```
UAM Server: https://api.spotfi.com/uam/login
RADIUS server 1: radius.hotspotsystem.com
RADIUS server 2: radius2.hotspotsystem.com
RADIUS Secret: hotsys123
CoA Port: 3799
UAM Allowed: api.spotfi.com,8.8.8.8,8.8.4.4
```

**OpenWRT with uspot:**

```bash
# uspot uses named sections (e.g., 'hotspot' or 'captive')
uci set uspot.hotspot=uspot
uci set uspot.hotspot.enabled='1'
uci set uspot.hotspot.interface='hotspot'
uci set uspot.hotspot.setname='uspot_hotspot'
uci set uspot.hotspot.auth_mode='uam'
uci set uspot.hotspot.uam_port='3990'
uci set uspot.hotspot.uam_url="https://api.spotfi.com/uam/login"
uci set uspot.hotspot.radius_auth_server="radius.hotspotsystem.com"
uci set uspot.hotspot.radius_secret="hotsys123"
uci commit uspot
/etc/init.d/uspot restart
```

## Endpoints

- `GET/POST {UAM_SERVER_URL}` - UAM server endpoint (e.g., `https://api.spotfi.com/uam/login`)
- `GET /api` - RFC8908 Captive Portal API

## Features

- Standard UAM/WISPr protocol
- RADIUS authentication
- CoA (RFC 5176) support
