# 🚀 WebSocket Test - Quick Guide (Port 8080)

## ✅ Server is Running on Port 8080!

**WebSocket URL:**
```
ws://localhost:8080/ws?id=ROUTER_ID&token=ROUTER_TOKEN
```

---

## Step 1: Login to Get Admin Token

**Postman Request:**
```
POST http://localhost:8080/api/auth/login
```

**Body (JSON):**
```json
{
  "email": "admin@spotfi.com",
  "password": "admin123"
}
```

**Expected Response:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "clm1abc123",
    "email": "admin@spotfi.com",
    "role": "ADMIN"
  }
}
```

**📝 Save the `token` and `user.id`!**

---

## Step 2: Create Test Router

**Postman Request:**
```
POST http://localhost:8080/api/routers
```

**Headers:**
```
Authorization: Bearer YOUR_TOKEN_FROM_STEP_1
Content-Type: application/json
```

**Body:**
```json
{
  "name": "Postman Test Router",
  "hostId": "YOUR_USER_ID_FROM_STEP_1",
  "macAddress": "00:11:22:33:44:55",
  "location": "Test Lab"
}
```

**Expected Response:**
```json
{
  "router": {
    "id": "clm2xyz789abc",
    "name": "Postman Test Router",
    "token": "a1b2c3d4e5f6...",
    "radiusSecret": "secret123...",
    "status": "OFFLINE"
  }
}
```

**📝 SAVE THESE:**
- ✅ `id` (Router ID)
- ✅ `token` (WebSocket Token)

---

## Step 3: Test WebSocket in Postman

### A. Create WebSocket Request

1. **Postman Desktop** → **New** → **WebSocket Request**
2. **URL:**
   ```
   ws://localhost:8080/ws?id=YOUR_ROUTER_ID&token=YOUR_ROUTER_TOKEN
   ```
   
   **Example:**
   ```
   ws://localhost:8080/ws?id=clm2xyz789abc&token=a1b2c3d4e5f6g7h8i9j0
   ```

3. **Click "Connect"**

---

### B. Expected Result

**Should connect in < 1 second!** ⚡

**You'll receive a welcome message:**
```json
{
  "type": "connected",
  "routerId": "clm2xyz789abc",
  "timestamp": "2025-11-11T12:34:56.789Z"
}
```

---

## Step 4: Send Test Messages

### Send PING

**In Postman "Message" tab, send:**
```json
{
  "type": "ping"
}
```

**Expected Response:**
```json
{
  "type": "pong",
  "timestamp": "2025-11-11T12:34:56.789Z"
}
```

---

### Send Metrics

```json
{
  "type": "metrics",
  "metrics": {
    "cpuLoad": 45,
    "memoryUsage": 60,
    "uptime": 86400,
    "activeConnections": 12,
    "macAddress": "00:11:22:33:44:55"
  }
}
```

---

## Step 5: Verify Connection

**Get Router Status:**
```
GET http://localhost:8080/api/routers/YOUR_ROUTER_ID
```

**Headers:**
```
Authorization: Bearer YOUR_TOKEN
```

**Expected:**
```json
{
  "router": {
    "id": "clm2xyz789abc",
    "status": "ONLINE",
    "lastSeen": "2025-11-11T12:34:56.789Z",
    "nasipaddress": "::1"
  }
}
```

**✅ Status should be "ONLINE"!**

---

## 🎯 Quick Checklist

- [ ] Server running on port 8080
- [ ] Logged in via API
- [ ] Created test router
- [ ] Have router ID and token
- [ ] Connected WebSocket in Postman
- [ ] Received welcome message
- [ ] Ping/pong works
- [ ] Router status is ONLINE

---

## 🔧 Troubleshooting

### Connection Closes Immediately

**Check:**
1. Router ID is correct
2. Token is correct (copy-paste, no spaces)
3. URL format: `ws://localhost:8080/ws?id=ID&token=TOKEN`

---

### No Welcome Message

**Check Postman:**
- Click "Messages" tab
- Messages should appear there

---

### Router Stays OFFLINE

**Wait 2 seconds**, then refresh the GET request.

If still OFFLINE:
- Check WebSocket is actually connected
- Look at server logs for errors

---

## 📚 Full Documentation

- **Complete Guide:** `docs/WEBSOCKET-TESTING-POSTMAN.md`
- **MikroTik Setup:** `MIKROTIK-LOCAL-TEST.md`

---

## 🎉 Success!

Once you see:
- ✅ WebSocket connected
- ✅ Welcome message received
- ✅ Ping returns pong
- ✅ Router status = ONLINE

**You're ready to connect your MikroTik router!**

Use these URLs for MikroTik:
- API: `http://192.168.56.1:8080`
- WebSocket: `ws://192.168.56.1:8080/ws`

