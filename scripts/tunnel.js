#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const isWindows = os.platform() === 'win32';
const cloudflaredPath = path.join(__dirname, '..', '.tools', isWindows ? 'cloudflared.exe' : 'cloudflared');

const args = ['tunnel', '--url', 'http://localhost:8080'];

console.log('Starting Cloudflare Tunnel for localhost:8080...\n');

const child = spawn(cloudflaredPath, args, {
  stdio: 'inherit',
  shell: isWindows
});

child.on('error', (err) => {
  console.error('Error starting tunnel:', err.message);
  console.error('\nMake sure cloudflared is installed in .tools/ directory');
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code || 0);
});

