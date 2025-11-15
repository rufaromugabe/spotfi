# SSH Tunnel Testing Guide

Complete guide to test the SSH tunnel functionality in SpotFi.

---

## 📋 Prerequisites

Before testing, ensure:

1. **Backend API is running**
   ```bash
   cd apps/api
   npm run dev
   # Server should start on http://localhost:8080
   ```

2. **Router is online**
   - Router must be connected via WebSocket (`/ws` endpoint)
   - Check router status: `GET /api/routers/:id` should show `status: "ONLINE"`

3. **Authentication token**
   - Login to get JWT token: `POST /api/auth/login`
   - Save the token for WebSocket authentication

4. **Router ID**
   - Get router ID from: `GET /api/routers`
   - Save the router ID

---

## 🧪 Testing Methods

### Method 1: Postman WebSocket (Recommended for Quick Testing)

#### Step 1: Get Authentication Token

**Request:**
```
POST http://localhost:8080/api/auth/login
Content-Type: application/json

{
  "email": "admin@spotfi.com",
  "password": "admin123"
}
```

**Response:**
```json
{
  "user": { ... },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Save the `token` value.**

#### Step 2: Get Router ID

**Request:**
```
GET http://localhost:8080/api/routers
Authorization: Bearer {your_token}
```

**Response:**
```json
{
  "routers": [
    {
      "id": "cmhujj1f6000112soujpo0noz",
      "name": "Office Router",
      "status": "ONLINE",
      ...
    }
  ]
}
```

**Save the router `id` and verify `status` is `"ONLINE"`.**

#### Step 3: Connect to SSH WebSocket

**In Postman:**

1. Create a new request
2. Change method to **WS** (WebSocket)
3. Enter URL:
   ```
   ws://localhost:8080/ws/ssh?routerId={routerId}&token={jwt_token}
   ```
   wss://c40g8skkog0g0ws44wo0c40s.62.72.19.27.sslip.io/ws/ssh?routerId=cmhujj1f6000112soujpo0noz&token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJjbWh0dmN2MmIwMDAwMjJ4NDZyOGU3amx1IiwiZW1haWwiOiJhZG1pbkBzcG90ZmkuY29tIiwicm9sZSI6IkFETUlOIiwiaWF0IjoxNzYzMDY2Mzc3fQ.Y5JTXW4gFvcpyI0dlDTGQc2zJoRgOjwDEdUao6nKw8c
   **Example:**
   ```
   ws://localhost:8080/ws/ssh?routerId=cmhujj1f6000112soujpo0noz&token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   ```

4. Click **Connect**

**Expected Result:**
- ✅ Connection opens successfully
- ✅ No error messages
- ✅ Backend logs show: `SSH tunnel established: {sessionId}...`
- ✅ Router logs show: `SSH session started: {sessionId}`

**If router is offline:**
- ❌ Connection closes with code `503`
- ❌ Message: `Router is offline`

**If authentication fails:**
- ❌ Connection closes with code `1008`
- ❌ Message: `Invalid authentication token`

#### Step 4: Send Test Commands

**In Postman WebSocket:**

1. Select message type: **Binary** or **Text**
2. Send test command:
   - **Text mode:** Type `ls\n` (command + newline)
   - **Binary mode:** Send bytes: `6C 73 0A` (hex for "ls\n")

**Expected Result:**
- ✅ Router executes command
- ✅ Command output appears in response
- ✅ Example output: `bin  etc  lib  root  tmp  usr  var`

**Test Commands:**
```
ls\n              # List files
pwd\n             # Print working directory
whoami\n          # Current user
uname -a\n        # System info
echo "test"\n     # Echo test
```

#### Step 5: Verify Data Flow

**Check Backend Logs:**
```bash
# Should see:
SSH tunnel established: {sessionId} for router {routerId} by user {userId}
```

**Check Router Logs (via SSH or logread):**
```bash
# On router, check logs:
logread | grep -i ssh

# Should see:
SSH session started: {sessionId}
Received: ssh-start
Received: ssh-data
```

---

### Method 2: Using cURL (Command Line)

#### Step 1: Get Token and Router ID

```bash
# Login
TOKEN=$(curl -s -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@spotfi.com","password":"admin123"}' \
  | jq -r '.token')

# Get Router ID
ROUTER_ID=$(curl -s http://localhost:8080/api/routers \
  -H "Authorization: Bearer $TOKEN" \
  | jq -r '.routers[0].id')

echo "Token: $TOKEN"
echo "Router ID: $ROUTER_ID"
```

#### Step 2: Test with wscat (WebSocket Client)

**Install wscat:**
```bash
npm install -g wscat
```

**Connect:**
```bash
wscat -c "ws://localhost:8080/ws/ssh?routerId=$ROUTER_ID&token=$TOKEN"
```

**Send commands:**
```
> ls\n
< bin  etc  lib  root  tmp  usr  var
> pwd\n
< /root
```

---

### Method 3: Frontend Integration (xterm.js)

#### Step 1: Install Dependencies

```bash
npm install xterm xterm-addon-attach xterm-addon-fit
```

#### Step 2: Create Terminal Component

**React/Next.js Example:**

```tsx
import { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';
import { AttachAddon } from 'xterm-addon-attach';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

interface RouterTerminalProps {
  routerId: string;
  token: string;
}

export function RouterTerminal({ routerId, token }: RouterTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!terminalRef.current) return;

    // Create terminal instance
    const term = new Terminal({
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
      },
      fontSize: 14,
      fontFamily: 'Monaco, "Courier New", monospace',
      cursorBlink: true,
      cursorStyle: 'block',
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    // Connect to SSH WebSocket
    const wsUrl = `ws://localhost:8080/ws/ssh?routerId=${routerId}&token=${token}`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('SSH tunnel connected');
      const attachAddon = new AttachAddon(ws);
      term.loadAddon(attachAddon);
      term.open(terminalRef.current!);
      fitAddon.fit();
    };

    ws.onerror = (error) => {
      console.error('SSH tunnel error:', error);
      term.writeln('\r\n\x1b[31mConnection error. Router may be offline.\x1b[0m');
    };

    ws.onclose = (event) => {
      console.log('SSH tunnel closed:', event.code, event.reason);
      if (event.code !== 1000) {
        term.writeln(`\r\n\x1b[31mConnection closed: ${event.reason || 'Unknown error'}\x1b[0m`);
      }
    };

    terminal.current = term;
    wsRef.current = ws;

    // Handle window resize
    const handleResize = () => {
      fitAddon.fit();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      ws.close();
      term.dispose();
    };
  }, [routerId, token]);

  return (
    <div
      ref={terminalRef}
      style={{
        width: '100%',
        height: '100%',
        padding: '10px',
        backgroundColor: '#1e1e1e',
      }}
    />
  );
}
```

#### Step 3: Use Component

```tsx
import { RouterTerminal } from './RouterTerminal';

function App() {
  const routerId = 'cmhujj1f6000112soujpo0noz';
  const token = 'your-jwt-token';

  return (
    <div style={{ height: '600px' }}>
      <RouterTerminal routerId={routerId} token={token} />
    </div>
  );
}
```

---

## 🔍 Verification Checklist

### Backend Verification

- [ ] Backend API is running
- [ ] WebSocket endpoint `/ws/ssh` is accessible
- [ ] JWT authentication works
- [ ] Router access control works (admin/host permissions)
- [ ] Session management works (sessions created/cleaned up)

### Router Verification

- [ ] Router is connected via `/ws` endpoint
- [ ] Router shows as `ONLINE` in dashboard
- [ ] Router bridge script is running
- [ ] Python modules available (`pty`, `select`, `threading`, `base64`)
- [ ] Shell is available (`/bin/sh`)

### Connection Verification

- [ ] WebSocket connection opens successfully
- [ ] No authentication errors
- [ ] Router receives `ssh-start` message
- [ ] PTY session created on router
- [ ] Data flows bidirectionally

### Functionality Verification

- [ ] Commands execute on router
- [ ] Command output appears in terminal
- [ ] Multiple commands work sequentially
- [ ] Terminal responds to keyboard input
- [ ] Session cleanup works on disconnect

---

## 🐛 Troubleshooting

### Issue: Connection Closes Immediately

**Possible Causes:**
1. Router is offline
2. Invalid authentication token
3. Router ID doesn't exist
4. User doesn't have access to router

**Solutions:**
```bash
# Check router status
curl http://localhost:8080/api/routers/{routerId} \
  -H "Authorization: Bearer {token}"

# Verify token is valid
curl http://localhost:8080/api/auth/me \
  -H "Authorization: Bearer {token}"

# Check router WebSocket connection
# On router: ps | grep bridge.py
# Should show bridge process running
```

### Issue: No Response to Commands

**Possible Causes:**
1. Router bridge doesn't handle SSH messages
2. PTY module not available
3. Shell process not starting

**Solutions:**
```bash
# Check router logs
logread | grep -i ssh

# Test PTY availability on router
python3 -c "import pty; print('PTY available')"

# Check if bridge is receiving messages
# Look for "Received: ssh-start" in logs
```

### Issue: "PTY module not available"

**Solution:**
```bash
# On router, install full Python package
opkg update
opkg install python3-full

# Or add fallback in bridge script (see implementation)
```

### Issue: Terminal Not Displaying Output

**Possible Causes:**
1. Data encoding issues
2. WebSocket message format incorrect
3. Frontend not handling binary data

**Solutions:**
- Check browser console for errors
- Verify WebSocket is receiving messages
- Check data encoding (should be base64 in JSON, binary in WebSocket)

### Issue: Session Not Cleaning Up

**Check:**
```bash
# Backend logs should show session cleanup
# Router logs should show session stopped

# Manually check active sessions
# (Would need to add endpoint or check logs)
```

---

## 📊 Expected Performance

### Latency

- **Typical round-trip:** 20-50ms
- **Acceptable for terminal:** < 100ms
- **User experience:** Should feel instant

### Throughput

- **Text commands:** Full speed
- **File transfers:** Limited by network, not tunnel
- **Multiple sessions:** Supported (one per connection)

### Resource Usage

- **Backend:** ~5-10MB per active session
- **Router:** ~2-5MB per active session
- **Network:** Minimal overhead (~10-20% for WebSocket framing)

---

## ✅ Success Criteria

The SSH tunnel is working correctly if:

1. ✅ Connection opens without errors
2. ✅ Commands execute on router
3. ✅ Command output appears in terminal
4. ✅ Multiple commands work sequentially
5. ✅ Session cleans up on disconnect
6. ✅ No memory leaks (sessions properly closed)
7. ✅ Works through firewalls/NAT
8. ✅ Secure (JWT authentication required)

---

## 🔐 Security Notes

1. **Authentication Required:** All connections require valid JWT token
2. **Access Control:** Users can only access routers they own (or all if admin)
3. **Router Must Be Online:** Router must be connected via WebSocket first
4. **Session Isolation:** Each session is isolated
5. **Automatic Cleanup:** Sessions timeout after 1 hour or on disconnect

---

## 📝 Test Cases

### Basic Functionality

- [ ] Connect to SSH tunnel
- [ ] Execute `ls` command
- [ ] Execute `pwd` command
- [ ] Execute `whoami` command
- [ ] Execute `uname -a` command

### Advanced Functionality

- [ ] Execute multi-line commands
- [ ] Navigate directories (`cd`, `ls`)
- [ ] Edit files (`vi`, `nano`)
- [ ] Run scripts
- [ ] Check system resources (`top`, `free`)

### Error Handling

- [ ] Invalid router ID → Connection rejected
- [ ] Invalid token → Connection rejected
- [ ] Router offline → Connection rejected
- [ ] Network interruption → Session cleanup
- [ ] Invalid command → Error message displayed

### Edge Cases

- [ ] Very long command output
- [ ] Binary data handling
- [ ] Special characters in commands
- [ ] Terminal resize
- [ ] Multiple concurrent sessions

---

## 🚀 Next Steps

After successful testing:

1. **Integrate into Frontend:** Add terminal component to dashboard
2. **Add Features:** Terminal resize, copy/paste, session history
3. **Monitor Performance:** Track latency, resource usage
4. **Security Audit:** Review authentication and access control
5. **Documentation:** Update user-facing docs

---

## 📞 Support

If you encounter issues:

1. Check backend logs: `npm run dev` output
2. Check router logs: `logread | grep -i ssh`
3. Verify prerequisites are met
4. Test with Postman first (simplest method)
5. Check network connectivity

---

**Last Updated:** 2024
**Version:** 1.0.0

