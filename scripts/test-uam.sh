#!/bin/bash
#
# Quick UAM Server Test Script
# Tests UAM endpoints with seed data
#

set -e

API_URL="${API_URL:-http://localhost:8080}"
ROUTER_IP="${ROUTER_IP:-10.1.30.1}"
ROUTER_PORT="${ROUTER_PORT:-80}"

# Get router ID from API if not set
if [ -z "$ROUTER_ID" ]; then
  echo "Getting router ID from API..."
  if command -v jq >/dev/null 2>&1; then
    TOKEN=$(curl -s -X POST "$API_URL/api/auth/login" \
      -H "Content-Type: application/json" \
      -d '{"email":"admin@spotfi.com","password":"admin123"}' | jq -r '.token' 2>/dev/null)
    
    if [ -n "$TOKEN" ] && [ "$TOKEN" != "null" ]; then
      ROUTER_ID=$(curl -s -X GET "$API_URL/api/routers" \
        -H "Authorization: Bearer $TOKEN" | jq -r '.routers[0].id' 2>/dev/null)
      if [ -n "$ROUTER_ID" ] && [ "$ROUTER_ID" != "null" ]; then
        echo "Using router ID: $ROUTER_ID"
      fi
    fi
  else
    echo "Note: jq not found, skipping router ID auto-detection"
    echo "Set ROUTER_ID environment variable if needed"
  fi
fi

echo "=========================================="
echo "UAM Server Test Script"
echo "=========================================="
echo ""
echo "API URL: $API_URL"
echo "Router IP: $ROUTER_IP"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Test 1: GET Login Page
echo -e "${YELLOW}Test 1: GET Login Page${NC}"
NASID_PARAM=""
[ -n "$ROUTER_ID" ] && NASID_PARAM="&nasid=$ROUTER_ID"
RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL/uam/login?uamip=$ROUTER_IP&uamport=$ROUTER_PORT&userurl=http://www.google.com$NASID_PARAM")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "200" ] && echo "$BODY" | grep -q "SpotFi"; then
  echo -e "${GREEN}✓ Login page works (HTTP $HTTP_CODE)${NC}"
else
  echo -e "${RED}✗ Login page failed (HTTP $HTTP_CODE)${NC}"
  echo "$BODY" | head -n5
fi
echo ""

# Test 2: RFC8908 Captive Portal API
echo -e "${YELLOW}Test 2: RFC8908 Captive Portal API${NC}"
NASID_PARAM=""
[ -n "$ROUTER_ID" ] && NASID_PARAM="?nasid=$ROUTER_ID"
RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL/api$NASID_PARAM")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "200" ] && echo "$BODY" | grep -q "captive"; then
  echo -e "${GREEN}✓ RFC8908 API works (HTTP $HTTP_CODE)${NC}"
  if command -v jq >/dev/null 2>&1; then
    echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
  else
    echo "$BODY"
  fi
else
  echo -e "${RED}✗ RFC8908 API failed (HTTP $HTTP_CODE)${NC}"
  echo "$BODY"
fi
echo ""

# Test 3: Authentication with valid credentials
echo -e "${YELLOW}Test 3: Authentication (testuser/testpass)${NC}"
RESPONSE=$(curl -s --max-time 10 -w "\n%{http_code}" -X POST "$API_URL/uam/login?uamip=$ROUTER_IP&uamport=$ROUTER_PORT&userurl=http://www.google.com" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=testuser&password=testpass&uamip=$ROUTER_IP&uamport=$ROUTER_PORT&userurl=http://www.google.com" 2>&1)
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if echo "$BODY" | grep -q "google.com" || [ "$HTTP_CODE" = "302" ] || [ "$HTTP_CODE" = "301" ]; then
  echo -e "${GREEN}✓ Authentication successful (HTTP $HTTP_CODE)${NC}"
else
  echo -e "${RED}✗ Authentication failed (HTTP $HTTP_CODE)${NC}"
  echo "$BODY" | head -n10
fi
echo ""

# Test 4: Invalid credentials
echo -e "${YELLOW}Test 4: Invalid Credentials${NC}"
RESPONSE=$(curl -s --max-time 10 -w "\n%{http_code}\n%{redirect_url}" -X POST "$API_URL/uam/login?uamip=$ROUTER_IP&uamport=$ROUTER_PORT&userurl=http://www.google.com" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=testuser&password=wrongpass&uamip=$ROUTER_IP&uamport=$ROUTER_PORT&userurl=http://www.google.com" 2>&1)
HTTP_CODE=$(echo "$RESPONSE" | tail -n2 | head -n1)
REDIRECT_URL=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-2)

if [ "$HTTP_CODE" = "302" ] && echo "$REDIRECT_URL" | grep -qi "error.*invalid\|error.*password"; then
  echo -e "${GREEN}✓ Invalid credentials rejected correctly (HTTP $HTTP_CODE)${NC}"
  echo "  Redirect URL contains error message"
elif [ "$HTTP_CODE" = "302" ]; then
  echo -e "${YELLOW}⚠ Got redirect (HTTP $HTTP_CODE) but error not detected in URL${NC}"
  echo "  Redirect: $REDIRECT_URL" | head -c 80
  echo "..."
else
  echo -e "${RED}✗ Invalid credentials not handled properly (HTTP $HTTP_CODE)${NC}"
  echo "$BODY" | head -n5
fi
echo ""

# Test 5: Missing UAM IP
echo -e "${YELLOW}Test 6: Missing UAM IP${NC}"
# Test without UAM secret to avoid secret validation interfering
# If UAM_SECRET is set, we need to provide it or it will fail secret check first
if [ -n "$ENV_UAM_SECRET" ]; then
  # UAM_SECRET is set, so we test with it to get past secret validation
  RESPONSE=$(curl -s --max-time 5 -w "\n%{http_code}" "$API_URL/uam/login?userurl=http://www.google.com&uamsecret=$UAM_SECRET" 2>&1)
else
  # No UAM_SECRET, test without it
  RESPONSE=$(curl -s --max-time 5 -w "\n%{http_code}" "$API_URL/uam/login?userurl=http://www.google.com" 2>&1)
fi
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "400" ]; then
  echo -e "${GREEN}✓ Missing UAM IP rejected (HTTP 400)${NC}"
else
  echo -e "${RED}✗ Missing UAM IP not rejected (HTTP $HTTP_CODE)${NC}"
  echo "$BODY" | head -n3
fi
echo ""

echo "=========================================="
echo "Testing Complete!"
echo "=========================================="
echo ""
echo "Test Users (from seed.ts):"
echo "  - testuser / testpass"
echo "  - demo / demo123"
echo "  - john.doe / password123"
echo "  - jane.smith / secure456"
echo ""
echo "To test with real router:"
echo "  1. Configure router with UAM server URL"
echo "  2. Connect device to router WiFi"
echo "  3. Try to access any website"
echo "  4. Should redirect to login page"
echo ""

