const localtunnel = require('localtunnel');

(async () => {
  const tunnel = await localtunnel({ port: 8080 });
  
  console.log('\n✅ Tunnel is active!');
  console.log(`🌐 Public URL: ${tunnel.url}`);
  console.log(`📡 Forwarding to: http://localhost:8080`);
  console.log('\nPress Ctrl+C to stop the tunnel\n');
  
  tunnel.on('close', () => {
    console.log('\n❌ Tunnel closed');
  });
})();

