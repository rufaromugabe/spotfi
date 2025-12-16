export const renderLogonForm = (props: {
  logonUrl: string;
  username: string;
  userurl: string;
  response?: string;
  password?: string;
}) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SpotFi - Connecting...</title>
    <style>
      body { font-family: system-ui, sans-serif; display: grid; place-items: center; height: 100vh; background: #f4f4f5; }
      .card { background: white; padding: 2rem; border-radius: 1rem; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1); text-align: center; }
      .spinner { border: 3px solid #f3f4f6; border-top: 3px solid #000; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 0 auto 1rem; }
      @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="card">
        <div class="spinner"></div>
        <p>Connecting...</p>
    </div>
    <form id="logonForm" method="GET" action="${props.logonUrl}">
        <input type="hidden" name="username" value="${props.username}">
        <input type="hidden" name="userurl" value="${props.userurl}">
        ${props.response ? `<input type="hidden" name="response" value="${props.response}">` : ''}
        ${props.password ? `<input type="hidden" name="password" value="${props.password}">` : ''}
    </form>
    <script>
        // Auto-submit form to avoid showing credentials in POST response URL
        document.getElementById('logonForm').submit();
    </script>
</body>
</html>`;

export const renderLoginPage = (props: { 
  actionUrl: string; 
  uamip: string; 
  uamport: string; 
  userurl: string; 
  error?: string;
  challenge?: string;
  mac?: string;
  nasid?: string;
  sessionid?: string;
}) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SpotFi Login</title>
    <style>
      :root { --primary: #000; }
      body { font-family: system-ui, sans-serif; display: grid; place-items: center; height: 100vh; background: #f4f4f5; }
      .card { background: white; padding: 2rem; border-radius: 1rem; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1); width: 100%; max-width: 350px; }
      input { width: 100%; padding: 0.75rem; margin-bottom: 1rem; border: 1px solid #e4e4e7; border-radius: 0.5rem; box-sizing: border-box; }
      button { width: 100%; padding: 0.75rem; background: var(--primary); color: white; border: none; border-radius: 0.5rem; cursor: pointer; font-weight: 600; }
      .error { background: #fef2f2; color: #991b1b; padding: 0.75rem; border-radius: 0.5rem; margin-bottom: 1rem; font-size: 0.875rem; }
    </style>
</head>
<body>
    <div class="card">
        <h2 style="text-align:center; margin-top:0;">SpotFi</h2>
        ${props.error ? `<div class="error">${props.error}</div>` : ''}
        
        <form method="POST" action="${props.actionUrl}">
            <input type="hidden" name="uamip" value="${props.uamip}">
            <input type="hidden" name="uamport" value="${props.uamport}">
            <input type="hidden" name="userurl" value="${props.userurl}">
            ${props.challenge ? `<input type="hidden" name="challenge" value="${props.challenge}">` : ''}
            ${props.mac ? `<input type="hidden" name="mac" value="${props.mac}">` : ''}
            ${props.nasid ? `<input type="hidden" name="nasid" value="${props.nasid}">` : ''}
            ${props.sessionid ? `<input type="hidden" name="sessionid" value="${props.sessionid}">` : ''}
            
            <label>Username</label>
            <input type="text" name="username" required autofocus autocomplete="username">
            
            <label>Password</label>
            <input type="password" name="password" required autocomplete="current-password">
            
            <button type="submit">Connect</button>
        </form>
    </div>
</body>
</html>`;

// Helper functions
const formatBytes = (bytes: bigint): string => {
  const num = Number(bytes);
  if (num >= 1073741824) return `${(num / 1073741824).toFixed(2)} GB`;
  if (num >= 1048576) return `${(num / 1048576).toFixed(1)} MB`;
  if (num >= 1024) return `${(num / 1024).toFixed(0)} KB`;
  return `${num} B`;
};

const formatSpeed = (bitsPerSecond: bigint): string => {
  const num = Number(bitsPerSecond);
  if (num >= 1000000) return `${(num / 1000000).toFixed(0)} Mbps`;
  if (num >= 1000) return `${(num / 1000).toFixed(0)} Kbps`;
  return `${num} bps`;
};

export const renderSuccessPage = (props: {
  uamip: string;
  uamport: string;
  userurl?: string;
  mac?: string;
  ip?: string;
  timeleft?: string;
  sessionid?: string;
  username?: string;
  dataBalance?: { used: bigint; total: bigint | null };
  maxSpeed?: { download: bigint | null; upload: bigint | null };
}) => {
  const timeLeftMinutes = props.timeleft ? Math.floor(parseInt(props.timeleft) / 60) : null;
  const logoutUrl = `http://${props.uamip}:${props.uamport}/logoff`;
  
  // Calculate data usage percentage
  let dataUsagePercent: number | null = null;
  let dataRemaining: string | null = null;
  if (props.dataBalance) {
    if (props.dataBalance.total) {
      dataUsagePercent = Math.min(100, Number(props.dataBalance.used * 100n / props.dataBalance.total));
      const remaining = props.dataBalance.total - props.dataBalance.used;
      dataRemaining = remaining > 0n ? formatBytes(remaining) : '0 B';
    } else {
      dataRemaining = 'Unlimited';
    }
  }
  
  // Format speeds
  const downloadSpeed = props.maxSpeed?.download ? formatSpeed(props.maxSpeed.download) : null;
  const uploadSpeed = props.maxSpeed?.upload ? formatSpeed(props.maxSpeed.upload) : null;
  
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SpotFi - Connected</title>
    <style>
      :root { --primary: #000; --success: #16a34a; }
      body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; background: #f4f4f5; padding: 1rem; }
      .card { background: white; padding: 2rem; border-radius: 1rem; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1); width: 100%; max-width: 400px; }
      .success-icon { width: 64px; height: 64px; background: #dcfce7; border-radius: 50%; display: grid; place-items: center; margin: 0 auto 1rem; }
      .success-icon svg { width: 32px; height: 32px; color: var(--success); }
      h2 { text-align: center; margin: 0 0 0.5rem; color: var(--success); }
      .subtitle { text-align: center; color: #6b7280; margin-bottom: 1.5rem; }
      .stats { background: #f9fafb; border-radius: 0.5rem; padding: 1rem; margin-bottom: 1rem; }
      .stat-row { display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid #e5e7eb; }
      .stat-row:last-child { border-bottom: none; }
      .stat-label { color: #6b7280; font-size: 0.875rem; }
      .stat-value { font-weight: 600; }
      .progress-bar { height: 8px; background: #e5e7eb; border-radius: 4px; overflow: hidden; margin-top: 0.5rem; }
      .progress-fill { height: 100%; background: var(--success); transition: width 0.3s; }
      .speed-badges { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
      .badge { flex: 1; background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 0.5rem; padding: 0.75rem; text-align: center; }
      .badge-label { font-size: 0.75rem; color: #6b7280; }
      .badge-value { font-size: 1rem; font-weight: 700; color: #0369a1; }
      .buttons { display: flex; gap: 0.75rem; }
      .btn { flex: 1; padding: 0.75rem; border-radius: 0.5rem; cursor: pointer; font-weight: 600; text-align: center; text-decoration: none; }
      .btn-primary { background: var(--primary); color: white; border: none; }
      .btn-outline { background: white; color: var(--primary); border: 2px solid var(--primary); }
    </style>
</head>
<body>
    <div class="card">
        <div class="success-icon">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
        </div>
        <h2>Connected!</h2>
        <p class="subtitle">${props.username ? `Welcome, ${props.username}` : "You're now online"}</p>
        
        ${(downloadSpeed || uploadSpeed) ? `
        <div class="speed-badges">
          ${downloadSpeed ? `<div class="badge"><div class="badge-label">↓ Download</div><div class="badge-value">${downloadSpeed}</div></div>` : ''}
          ${uploadSpeed ? `<div class="badge"><div class="badge-label">↑ Upload</div><div class="badge-value">${uploadSpeed}</div></div>` : ''}
        </div>
        ` : ''}
        
        <div class="stats">
          ${dataRemaining ? `
          <div class="stat-row" style="flex-direction: column; gap: 0.25rem;">
            <div style="display: flex; justify-content: space-between;">
              <span class="stat-label">Data Balance</span>
              <span class="stat-value">${dataRemaining}</span>
            </div>
            ${dataUsagePercent !== null ? `<div class="progress-bar"><div class="progress-fill" style="width: ${100 - dataUsagePercent}%"></div></div>` : ''}
          </div>
          ` : ''}
          ${timeLeftMinutes !== null ? `<div class="stat-row"><span class="stat-label">Time Remaining</span><span class="stat-value">${timeLeftMinutes} min</span></div>` : ''}
          ${props.ip ? `<div class="stat-row"><span class="stat-label">Your IP</span><span class="stat-value">${props.ip}</span></div>` : ''}
        </div>
        
        <div class="buttons">
          ${props.userurl ? `<a href="${props.userurl}" class="btn btn-primary">Continue Browsing</a>` : `<a href="http://www.google.com" class="btn btn-primary">Start Browsing</a>`}
          <a href="${logoutUrl}" class="btn btn-outline">Logout</a>
        </div>
    </div>
</body>
</html>`;
};

