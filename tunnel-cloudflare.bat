@echo off
echo Starting Cloudflare Tunnel for localhost:8080...
echo.
cd /d "%~dp0"
.tools\cloudflared.exe tunnel --url http://localhost:8080

