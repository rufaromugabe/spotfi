# 🚀 How to Start the SpotFi Server

## Quick Start

```bash
# Navigate to API directory
cd apps/api

# Start development server
npm run dev
```

That's it! 🎉

---

## What You Should See

When the server starts successfully, you'll see:

```
> @spotfi/api@1.0.0 dev
> tsx watch src/index.ts

Environment variables loaded from .env
[12:34:56] INFO: Server listening at http://0.0.0.0:3000
[12:34:56] INFO: Documentation at http://localhost:3000/documentation
⏰ Starting production scheduler...
✅ Scheduler ready
   → Invoices: Monthly on 1st at 2 AM
   → Status checks: Every 5 minutes
   → Daily stats: Daily at 1 AM
   → Session tracking: Real-time (database triggers)
```

**Wait for these messages before testing!**

---

## Test Server is Running

Open a **new terminal** and run:

```bash
curl http://localhost:3000/api/health
```

**Expected:**
```json
{"status":"ok"}
```

---

## Now Test WebSocket in Postman

### 1. Create a Router

**Login first:**
```
POST http://localhost:3000/api/auth/login

Body:
{
  "email": "admin@spotfi.com",
  "password": "admin123"
}
```

**Create router:**
```
POST http://localhost:3000/api/routers

Headers:
Authorization: Bearer YOUR_TOKEN_FROM_LOGIN

Body:
{
  "name": "Postman Test",
  "hostId": "YOUR_USER_ID_FROM_LOGIN",
  "macAddress": "00:11:22:33:44:55"
}
```

**Save the `id` and `token` from response!**

---

### 2. Connect WebSocket

In Postman:
1. **New → WebSocket Request**
2. **URL:**
   ```
   ws://localhost:3000/ws?id=YOUR_ROUTER_ID&token=YOUR_ROUTER_TOKEN
   ```
3. **Click Connect**

Should connect in < 1 second! ⚡

---

## Troubleshooting

### Server Won't Start

**Check Node.js version:**
```bash
node --version
# Should be v18+ or v20+
```

**Install dependencies:**
```bash
npm install
```

**Check database connection:**
```bash
# In project root, check .env file exists
Get-Content .env | Select-String "DATABASE_URL"
```

---

### Port Already in Use

**Kill existing process:**
```bash
# Find process on port 3000
netstat -ano | findstr :3000

# Kill it (use PID from above)
taskkill /PID YOUR_PID /F
```

---

### Database Connection Error

**Test database:**
```bash
cd ../../packages/prisma
npx prisma db pull
```

If this fails, check your `DATABASE_URL` in `.env`

---

## Stop the Server

Press `Ctrl + C` in the terminal where server is running

---

## Other Commands

```bash
# Build for production
npm run build

# Run production build
npm run start

# Run in development (with hot reload)
npm run dev
```

---

## Next Steps

Once server is running:
1. ✅ Test health endpoint
2. ✅ Create router via API
3. ✅ Test WebSocket in Postman
4. ✅ Connect real MikroTik router

---

**Documentation:**
- WebSocket Testing: `docs/WEBSOCKET-TESTING-POSTMAN.md`
- MikroTik Setup: `MIKROTIK-LOCAL-TEST.md`

