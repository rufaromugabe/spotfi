# SSH Tunnel Data Flow Debugging Guide

Quick reference for checking if data is being received at each stage of the SSH tunnel.

---

## 🔍 Data Flow Overview

```
Frontend (Postman/xterm.js)
    ↓ Binary WebSocket
Backend Server (/ws/ssh)
    ↓ JSON WebSocket (base64 encoded)
Router Bridge (Python)
    ↓ PTY (pseudo-terminal)
Shell Process (/bin/sh)
```

---

## 📊 How to Check Data Reception

### Stage 1: Frontend → Backend

**What to check:** Is the backend receiving data from the client?

**Server Logs:**
```bash
# Watch for these log messages:
[SSH {sessionId}] Received X bytes from client, forwarding to router
[SSH {sessionId}] Sending X bytes to router (encoded: Y chars)
```

**How to verify:**
1. Send a command from Postman (e.g., `echo "test"`)
2. Check server logs immediately
3. Should see: `[SSH {sessionId}] Received X bytes from client`

**If you DON'T see this:**
- Client not sending data correctly
- WebSocket connection issue
- Check Postman is using Binary mode (not Text)

---

### Stage 2: Backend → Router

**What to check:** Is the router receiving data from the backend?

**Server Logs:**
```bash
# Should see:
[SSH {sessionId}] Sending X bytes to router (encoded: Y chars)
```

**Router Logs:**
```bash
# SSH into router and check logs:
logread | grep -i ssh
# Or watch in real-time:
logread -f | grep -i ssh

# Should see:
Received: ssh-data
Received {N} bytes for session {sessionId}
Wrote {N} bytes to PTY
```

**How to verify:**
1. Check server logs show data being sent
2. Check router logs show `Received: ssh-data`
3. If server sends but router doesn't receive → Router WebSocket issue

**If router doesn't receive:**
- Router WebSocket connection might be dead
- Message routing issue
- Check router bridge is running: `ps | grep bridge.py`

---

### Stage 3: Router → Shell (PTY)

**What to check:** Is the shell receiving and processing commands?

**Router Logs:**
```bash
# Should see:
Received {N} bytes for session {sessionId}
Wrote {N} bytes to PTY for session {sessionId}
```

**How to verify:**
1. Send command: `echo "test"`
2. Check router logs show data written to PTY
3. Shell should execute command

**If PTY write fails:**
- PTY might not be created
- Check for: `PTY created for session {sessionId}`
- Check for: `SSH session started: {sessionId}, PID: {pid}`
- Verify PTY module: `python3 -c "import pty; print('OK')"`

---

### Stage 4: Shell → Router (PTY Output)

**What to check:** Is the shell sending output back?

**Router Logs:**
```bash
# Should see:
Sent {N} bytes from PTY for session {sessionId}
```

**How to verify:**
1. After sending command, check router logs
2. Should see `Sent X bytes from PTY` messages
3. This means shell executed command and produced output

**If no output:**
- Shell might not be running
- PTY read thread might be dead
- Check process: `ps aux | grep {pid}` (from session start log)

---

### Stage 5: Router → Backend

**What to check:** Is the backend receiving data from router?

**Server Logs:**
```bash
# Should see:
[Router {id}] Received message type: ssh-data
[Router {id}] Received ssh-data from router for session {sessionId} (data length: X)
[Router {id}] Decoded Y bytes from router, forwarding to client session {sessionId}
```

**How to verify:**
1. Check server logs after router sends data
2. Should see router message received
3. Should see data decoded and forwarded

**If backend doesn't receive:**
- Router not sending `ssh-data` messages
- Check router logs for `Sent X bytes from PTY`
- Message format might be wrong

---

### Stage 6: Backend → Frontend

**What to check:** Is the frontend receiving data from backend?

**Server Logs:**
```bash
# Should see:
[SSH {sessionId}] Sending X bytes to client
```

**Frontend (Postman):**
- Should see response in Postman WebSocket messages
- Binary data should appear as terminal output

**How to verify:**
1. Check server logs show data sent to client
2. Check Postman receives message
3. If server sends but client doesn't receive → Client WebSocket issue

---

## 🛠️ Quick Debugging Commands

### Check Server Logs (Real-time)
```bash
# If using npm run dev:
# Logs appear in terminal automatically

# If using production (PM2/systemd):
# Check logs based on your setup
tail -f /var/log/spotfi-api.log
# Or
journalctl -u spotfi-api -f
```

### Check Router Logs (Real-time)
```bash
# SSH into router
ssh root@router-ip

# Watch logs
logread -f | grep -E "ssh|bridge|Received|Sent|PTY"

# Or check bridge process directly
ps aux | grep bridge.py
# Get PID and check /proc/{PID}/fd/ for open file descriptors
```

### Test Data Flow Manually

**1. Send test command:**
```
In Postman: Send "ls\n" (binary mode)
```

**2. Watch server logs:**
```
Should see:
[SSH xxx] Received 3 bytes from client
[SSH xxx] Sending 3 bytes to router
```

**3. Watch router logs:**
```
Should see:
Received: ssh-data
Received 3 bytes for session xxx
Wrote 3 bytes to PTY
Sent 50 bytes from PTY  # (ls command output)
```

**4. Watch server logs again:**
```
Should see:
[Router xxx] Received ssh-data
[SSH xxx] Sending 50 bytes to client
```

**5. Check Postman:**
```
Should see response with directory listing
```

---

## 🔴 Common Issues and What to Check

### Issue: No data received from client

**Check:**
- Server logs: `[SSH {sessionId}] Received X bytes from client`
- If missing → Client not sending or WebSocket issue

**Fix:**
- Use Binary mode in Postman
- Check WebSocket connection is open
- Verify session was created successfully

---

### Issue: Router not receiving data

**Check:**
- Server logs: `[SSH {sessionId}] Sending X bytes to router`
- Router logs: `Received: ssh-data`
- If server sends but router doesn't receive → Router WebSocket dead

**Fix:**
- Check router is online: `GET /api/routers/:id` → status: "ONLINE"
- Restart router bridge: `/etc/init.d/spotfi-bridge restart`
- Check router WebSocket connection

---

### Issue: PTY not receiving data

**Check:**
- Router logs: `Wrote {N} bytes to PTY`
- If missing → PTY write failed

**Fix:**
- Verify PTY was created: `PTY created for session {sessionId}`
- Check SSH session exists: Look for `SSH session started`
- Verify PTY module: `python3 -c "import pty"`

---

### Issue: No output from shell

**Check:**
- Router logs: `Sent {N} bytes from PTY`
- If missing → Shell not producing output or PTY read failing

**Fix:**
- Check shell process is alive: `ps aux | grep {pid}`
- Verify command executed: Try simple command like `echo test`
- Check PTY read thread is running

---

### Issue: Backend not receiving from router

**Check:**
- Router logs: `Sent {N} bytes from PTY`
- Server logs: `[Router {id}] Received ssh-data`
- If router sends but server doesn't receive → Message routing issue

**Fix:**
- Verify message format: Should be `{type: 'ssh-data', sessionId: '...', data: 'base64...'}`
- Check router bridge `send_message()` is working
- Verify WebSocket connection is active

---

### Issue: Frontend not receiving data

**Check:**
- Server logs: `[SSH {sessionId}] Sending X bytes to client`
- Postman: Should show received message
- If server sends but client doesn't receive → Client WebSocket issue

**Fix:**
- Check client WebSocket is open
- Verify data format (should be binary)
- Check browser console for errors (if using web frontend)

---

## 📝 Debugging Checklist

When troubleshooting "no response", check each stage:

- [ ] **Stage 1:** Server receives from client?
  - Check: `[SSH {sessionId}] Received X bytes from client`
  
- [ ] **Stage 2:** Router receives from server?
  - Check: Router logs show `Received: ssh-data`
  
- [ ] **Stage 3:** PTY receives data?
  - Check: Router logs show `Wrote X bytes to PTY`
  
- [ ] **Stage 4:** Shell produces output?
  - Check: Router logs show `Sent X bytes from PTY`
  
- [ ] **Stage 5:** Server receives from router?
  - Check: `[Router {id}] Received ssh-data`
  
- [ ] **Stage 6:** Client receives from server?
  - Check: `[SSH {sessionId}] Sending X bytes to client`
  - Check: Postman shows received message

---

## 🎯 Quick Test Script

**On Server:**
```bash
# Watch logs in real-time
tail -f server.log | grep -E "\[SSH|\[Router"
```

**On Router (SSH session):**
```bash
# Watch router logs
logread -f | grep -E "ssh|Received|Sent|PTY"
```

**In Postman:**
1. Connect to SSH WebSocket
2. Send command: `ls\n` (binary mode)
3. Watch both server and router logs simultaneously
4. Trace data flow through all stages

---

## 💡 Pro Tips

1. **Use timestamps:** All logs include timestamps - match them up
2. **Check session ID:** Use the same session ID to trace a single command
3. **Byte counts:** Verify byte counts match at each stage
4. **Start simple:** Test with `echo test` before complex commands
5. **One command at a time:** Don't send multiple commands until first one works

---

**Last Updated:** 2024
**Version:** 1.0.0

