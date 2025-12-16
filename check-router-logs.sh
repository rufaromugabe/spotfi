#!/bin/bash
# Router Diagnostic Script for UAM Authentication Issues

echo "======================================"
echo "SPOTFI UAM ROUTER DIAGNOSTICS"
echo "======================================"
echo ""

echo "1. USPOT CONFIGURATION:"
echo "--------------------------------------"
uci show uspot.hotspot 2>/dev/null || uci show uspot

echo ""
echo "2. UHTTPD UAM LISTENER:"
echo "--------------------------------------"
uci show uhttpd.uam3990 2>/dev/null

echo ""
echo "3. USPOT SERVICE STATUS:"
echo "--------------------------------------"
/etc/init.d/uspot status

echo ""
echo "4. RECENT SYSTEM LOGS (last 50 lines):"
echo "--------------------------------------"
logread | grep -E "(uspot|UAM|RADIUS|auth|challenge|logon)" | tail -50

echo ""
echo "5. USPOT PROCESS STATUS:"
echo "--------------------------------------"
ps | grep -E "(uspot|uhttpd)" | grep -v grep

echo ""
echo "6. NETWORK INTERFACE (hotspot IP):"
echo "--------------------------------------"
ip addr show br-hotspot 2>/dev/null || ip addr show br-lan

echo ""
echo "7. ACTIVE CONNECTIONS:"
echo "--------------------------------------"
netstat -an | grep :3990

echo ""
echo "8. CHECK USPOT HANDLER SCRIPT:"
echo "--------------------------------------"
ls -la /usr/share/uspot/handler-uam.uc 2>/dev/null || echo "Handler script not found!"

echo ""
echo "9. RECENT AUTHENTICATION ATTEMPTS:"
echo "--------------------------------------"
logread | grep -i "access-request\|access-accept\|access-reject\|chap\|pap" | tail -20

echo ""
echo "10. FIREWALL RULES FOR UAM:"
echo "--------------------------------------"
iptables -t nat -L | grep -A5 -B5 uspot 2>/dev/null || echo "No specific uspot rules found"

echo ""
echo "======================================"
echo "DIAGNOSTICS COMPLETE"
echo "======================================"
