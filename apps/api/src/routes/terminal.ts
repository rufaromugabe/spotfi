import { FastifyInstance } from 'fastify';

export async function terminalRoutes(fastify: FastifyInstance) {
  fastify.get('/terminal', async (request, reply) => {
    const defaultWs = request.query && (request.query as any).ws
      ? (request.query as any).ws
      : '';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SpotFi Terminal Test</title>
  <link rel="preconnect" href="https://unpkg.com" />
  <link rel="stylesheet" href="https://unpkg.com/xterm@5.3.0/css/xterm.css" />
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, 'Helvetica Neue', Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol'; background: #0b0f16; color: #dbe2ef; }
    header { padding: 12px 16px; border-bottom: 1px solid #1e293b; background: #0f172a; position: sticky; top: 0; z-index: 10; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    input[type="text"] { flex: 1; min-width: 300px; padding: 8px 10px; background: #0b1220; border: 1px solid #1e293b; color: #e2e8f0; border-radius: 6px; }
    button { padding: 8px 12px; background: #2563eb; border: 0; color: white; border-radius: 6px; cursor: pointer; }
    button.secondary { background: #334155; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    #status { margin-left: auto; font-size: 12px; opacity: 0.85; }
    #container { height: calc(100vh - 70px); padding: 10px; }
    #terminal { height: 100%; border: 1px solid #1e293b; border-radius: 8px; overflow: hidden; }
  </style>
</head>
<body>
  <header>
    <div class="row">
      <input id="wsUrl" type="text" placeholder="wss://host/x?routerId=...&token=..." value="${defaultWs || ''}" />
      <button id="connectBtn">Connect</button>
      <button id="disconnectBtn" class="secondary" disabled>Disconnect</button>
      <span id="status">Disconnected</span>
    </div>
  </header>
  <div id="container">
    <div id="terminal"></div>
  </div>

  <script src="https://unpkg.com/xterm@5.3.0/lib/xterm.js"></script>
  <script src="https://unpkg.com/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
  <script>
    const term = new window.Terminal({
      cursorBlink: true,
      scrollback: 1000,
      convertEol: true,
      disableStdin: false,
      // Disable local echo - let the server/shell handle all echoing
      // This prevents character duplication issues
      localEcho: false,
      theme: {
        background: '#0b0f16',
        foreground: '#e2e8f0',
        cursor: '#93c5fd'
      }
    });
    const fitAddon = new window.FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal'));
    fitAddon.fit();
    window.addEventListener('resize', () => fitAddon.fit());

    const wsInput = document.getElementById('wsUrl');
    const connectBtn = document.getElementById('connectBtn');
    const disconnectBtn = document.getElementById('disconnectBtn');
    const statusEl = document.getElementById('status');

    let ws = null;

    function setStatus(text, color = '#e2e8f0') {
      statusEl.textContent = text;
      statusEl.style.color = color;
    }

    function connect() {
      const url = wsInput.value.trim();
      if (!url) {
        alert('Enter WebSocket URL (e.g. wss://host/x?routerId=...&token=...)');
        return;
      }
      try {
        if (ws) ws.close();
      } catch {}

      setStatus('Connecting...', '#fbbf24');
      ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        setStatus('Connected', '#22c55e');
        connectBtn.disabled = true;
        disconnectBtn.disabled = false;
        // Only focus terminal if page is visible and user is interacting
        if (document.visibilityState === 'visible') {
          // Use setTimeout to ensure focus happens after connection is established
          setTimeout(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
              term.focus();
            }
          }, 100);
        }
        // Send an initial newline to encourage a prompt if needed
        ws.send(new TextEncoder().encode(String.fromCharCode(10)));
      };

      ws.onclose = (evt) => {
        setStatus(\`Disconnected (\${evt.code} - \${evt.reason || 'No reason'})\`, '#ef4444');
        connectBtn.disabled = false;
        disconnectBtn.disabled = true;
      };

      ws.onerror = () => {
        setStatus('WebSocket error', '#ef4444');
      };

      ws.onmessage = async (evt) => {
        try {
          if (evt.data instanceof ArrayBuffer) {
            const decoder = new TextDecoder();
            term.write(decoder.decode(evt.data));
          } else if (evt.data instanceof Blob) {
            const buf = await evt.data.arrayBuffer();
            const decoder = new TextDecoder();
            term.write(decoder.decode(buf));
          } else if (typeof evt.data === 'string') {
            // Fallback if server sends text frames
            term.write(evt.data);
          }
        } catch (e) {
          // Ignore parse errors
        }
      };

      // Send user keystrokes as raw bytes
      // Only send data if page is visible to prevent unwanted input
      term.onData((data) => {
        if (!ws || ws.readyState !== WebSocket.OPEN || document.visibilityState !== 'visible') {
          return;
        }
        
        ws.send(new TextEncoder().encode(data));
      });
    }

    function disconnect() {
      try {
        if (ws) ws.close(1000, 'User requested');
      } finally {
        ws = null;
        connectBtn.disabled = false;
        disconnectBtn.disabled = true;
      }
    }

    connectBtn.addEventListener('click', connect);
    disconnectBtn.addEventListener('click', disconnect);

    // Focus terminal when user clicks on it (prevents unwanted auto-focus)
    document.getElementById('terminal').addEventListener('click', () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        term.focus();
      }
    });

    // Handle visibility changes - don't send data when page is hidden
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && ws && ws.readyState === WebSocket.OPEN) {
        // Blur terminal when page becomes hidden to prevent unwanted input
        term.blur();
      }
    });

    // Auto-fill with example if none provided
    if (!wsInput.value) {
      wsInput.value = 'wss://c40g8skkog0g0ws44wo0c40s.62.72.19.27.sslip.io/x?routerId=cmhujj1f6000112soujpo0noz&token=';
    }
  </script>
</body>
</html>`;

    reply.type('text/html').send(html);
  });
}


