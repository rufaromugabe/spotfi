# 🚀 Quick WebSocket Test - Troubleshooting

## Problem: WebSocket Taking Long to Connect

This usually means one of these issues:

---

## ✅ Step 1: Is the Server Running?

```bash
# Check if Node.js is running
Get-Process -Name node -ErrorAction SilentlyContinue

# Check if port 3000 is listening
netstat -an | findstr ":3000"
```

**If nothing shows up → Server is NOT running!**

---

## 🚀 Step 2: Start the Dev Server

```bash
# Navigate to API directory
cd apps/api

# Start dev server
npm run dev

# You should see:
# > spotfi-api@1.0.0 dev
# > tsx watch src/index.ts
# 
# Server listening at http://0.0.0.0:3000
# ✅ WebSocket server setup complete
```

**Wait for both messages before testing!**

---

## 🧪 Step 3: Quick Health Check

```bash
# In a new terminal
curl http://localhost:3000/api/health
```

**Expected:**
```json
{"status":"ok"}
```

---

## 🔌 Step 4: Test WebSocket in Postman

### A. First, Create a Test Router

**1. Login:**
```
POST http://localhost:3000/api/auth/login

Body:
{
  "email": "admin@spotfi.com",
  "password": "admin123"
}
```

**2. Get your user ID from the login response, then create router:**
```
POST http://localhost:3000/api/routers

Headers:
Authorization: Bearer YOUR_TOKEN

Body:
{
  "name": "Postman Test",
  "hostId": "YOUR_USER_ID",
  "macAddress": "00:11:22:33:44:55"
}
```

**Save the router `id` and `token` from response!**

---

### B. Connect WebSocket

1. **New → WebSocket Request in Postman**
2. **URL:**
   ```
   ws://localhost:3000/ws?id=YOUR_ROUTER_ID&token=YOUR_ROUTER_TOKEN
   ```
3. **Click Connect**

**Should connect instantly (< 1 second)!**

---

## 🐛 Common Issues & Fixes

### Issue 1: "Cannot connect" - Server Not Running

**Solution:**
```bash
cd apps/api
npm run dev
```

Wait for "Server listening" message!

---

### Issue 2: Slow Connection - Database Issue

**Check database connection:**
```bash
# Test database connection
cd packages/prisma
npx prisma db pull

# If this is slow, your database might be the issue
```

**Fix:** Check your `.env` has correct `DATABASE_URL`

---

### Issue 3: Connection Hangs - Missing Environment Variables

**Check `.env` file exists:**
```bash
# In project root
Get-Content .env | Select-String "DATABASE_URL"
```

**Should show:**
```
DATABASE_URL="postgresql://postgres:passcode@62.72.19.27:5998/spotfi?sslmode=disable"
```

---

### Issue 4: IP Detection Slow

The WebSocket handler tries to detect IP which can be slow. Let's add a timeout:

**Quick fix - Test without real router first:**

Just use Postman from localhost - it will detect `::1` or `127.0.0.1` quickly.

---

## ⚡ Quick Test Without Router Creation

If you already seeded the database:

```bash
# Seed creates test data
cd packages/prisma
npx prisma db seed
```

**Use these test credentials:**
- **Email:** `admin@spotfi.com`
- **Password:** `admin123`

Then check for existing test routers:
```
GET http://localhost:3000/api/routers
Headers: Authorization: Bearer YOUR_TOKEN
```

---

## 🎯 Expected Connection Flow

**Fast connection (< 1 second):**
1. Client sends WebSocket upgrade request
2. Server validates router ID and token (~50ms)
3. Server detects client IP (~10ms)
4. Server initializes connection handler (~100ms)
5. Server sends welcome message
6. **Total: ~200ms**

**Slow connection (> 5 seconds) means:**
- ❌ Database is slow (check connection)
- ❌ Server is busy (restart it)
- ❌ Network issue (check firewall)

---

## 🔍 Debug Logs

When server is running, watch the logs:

```bash
# In the terminal where npm run dev is running
# You should see:
[INFO] Router clm2xyz789 attempting connection from ::1
[INFO] Router authenticated successfully
[INFO] Router clm2xyz789 connected via WebSocket
```

**If you don't see these logs → connection not reaching server!**

---

## ✅ Checklist

- [ ] Server is running (`npm run dev`)
- [ ] Port 3000 is listening (`netstat -an | findstr 3000`)
- [ ] Health check passes (`curl localhost:3000/api/health`)
- [ ] Database is accessible (`npx prisma db pull`)
- [ ] Created test router via API
- [ ] Have router ID and token
- [ ] Using correct WebSocket URL format
- [ ] Postman Desktop (not web version)

---

## 🚀 Fast Path - All In One

```bash
# 1. Start server
cd apps/api
npm run dev

# 2. In new terminal - test health
curl http://localhost:3000/api/health

# 3. If OK, proceed to Postman WebSocket test
```

---

## 💡 Pro Tip

**Add this to your connection handler for debugging:**

The slow part is likely in `handler.initialize(clientIp)` which:
1. Fetches router from database
2. Updates router status
3. Updates IP address
4. Creates/updates NAS entry

If database is slow, all of this takes time!

**Quick test:** Check database speed:
```bash
cd packages/prisma
npx prisma studio
```

Should open instantly. If slow → database connection issue!

---

## 📞 Still Slow?

**Share these details:**
1. Server startup logs (first 10 lines)
2. Connection attempt logs
3. Database connection test result
4. Time it's taking to connect

This will help identify the exact bottleneck!

