export const renderLoginPage = (props: { 
  actionUrl: string; 
  uamip: string; 
  uamport: string; 
  userurl: string; 
  error?: string;
  // Additional uspot parameters
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

