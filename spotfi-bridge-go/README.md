# SpotFi Bridge - Go Implementation

A high-performance WebSocket bridge for OpenWrt routers, written in Go. This replaces the Python implementation with a single static binary that requires no dependencies.

## Why Go?

- **Single Static Binary**: No dependencies, no version mismatches, just works
- **Concurrency**: Goroutines handle WebSocket heartbeat while simultaneously processing UBUS calls and PTY shells
- **Cross-Compilation**: Build for MIPS/MIPSLE/ARM64 from your development machine
- **Memory Safety**: No segfaults or buffer overflows
- **Small Binary Size**: ~1.5MB after compression (fits on routers with >8MB flash)

## Building

### Prerequisites

- Go 1.21 or later ([Download](https://go.dev/dl/))
- UPX (optional, for binary compression): 
  - Linux/Mac: `brew install upx` or `apt install upx`
  - Windows: [Download from GitHub](https://github.com/upx/upx/releases)

### Quick Build (All Architectures)

**Linux/Mac/Git Bash (Windows):**
```bash
./build.sh
# Or if not executable:
bash build.sh
```

**Windows (PowerShell):**
```powershell
.\build.ps1
```

**Windows (CMD):**
```cmd
build.bat
```

**Note for Windows users:** Git Bash is often the easiest option - just run `bash build.sh` in Git Bash terminal.

### Manual Build Commands

#### For MIPS (Atheros routers, e.g., GL.iNet AR750, TP-Link)

**Linux/Mac:**
```bash
GOOS=linux GOARCH=mips GOMIPS=softfloat go build -ldflags="-s -w" -o spotfi-bridge-mips
upx --best --lzma spotfi-bridge-mips
```

**Windows (PowerShell):**
```powershell
$env:GOOS="linux"; $env:GOARCH="mips"; $env:GOMIPS="softfloat"
go build -ldflags="-s -w" -o spotfi-bridge-mips
upx --best --lzma spotfi-bridge-mips
```

**Windows (CMD):**
```cmd
set GOOS=linux
set GOARCH=mips
set GOMIPS=softfloat
go build -ldflags="-s -w" -o spotfi-bridge-mips
upx --best --lzma spotfi-bridge-mips
```

#### For MIPSLE (MediaTek routers, e.g., MT300N-V2)

**Linux/Mac:**
```bash
GOOS=linux GOARCH=mipsle GOMIPS=softfloat go build -ldflags="-s -w" -o spotfi-bridge-mipsle
upx --best --lzma spotfi-bridge-mipsle
```

**Windows (PowerShell):**
```powershell
$env:GOOS="linux"; $env:GOARCH="mipsle"; $env:GOMIPS="softfloat"
go build -ldflags="-s -w" -o spotfi-bridge-mipsle
upx --best --lzma spotfi-bridge-mipsle
```

**Windows (CMD):**
```cmd
set GOOS=linux
set GOARCH=mipsle
set GOMIPS=softfloat
go build -ldflags="-s -w" -o spotfi-bridge-mipsle
upx --best --lzma spotfi-bridge-mipsle
```

#### For ARM64 (Modern routers, e.g., GL.iNet Slate AX)

**Linux/Mac:**
```bash
GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o spotfi-bridge-arm64
upx --best --lzma spotfi-bridge-arm64
```

**Windows (PowerShell):**
```powershell
$env:GOOS="linux"; $env:GOARCH="arm64"
go build -ldflags="-s -w" -o spotfi-bridge-arm64
upx --best --lzma spotfi-bridge-arm64
```

**Windows (CMD):**
```cmd
set GOOS=linux
set GOARCH=arm64
go build -ldflags="-s -w" -o spotfi-bridge-arm64
upx --best --lzma spotfi-bridge-arm64
```

### Build Flags Explained

- `-ldflags="-s -w"`: Strips debugging information, reduces binary size by ~30%
- `GOMIPS=softfloat`: Uses software floating point (safest for router compatibility)
- `upx --best --lzma`: Compresses binary from ~5MB to ~1.5MB

### Windows Notes

✅ **Yes, you can build on Windows!** Go's cross-compilation works perfectly from Windows.

- The binaries built on Windows are Linux executables (they won't run on Windows)
- Go automatically handles cross-compilation - no special tools needed
- After building, you'll have Linux binaries ready to upload to your server
- If you see `.exe` extensions, the build scripts will rename them automatically

## Deployment

1. **Identify Router Architecture**

   Run on your OpenWrt router:
   ```bash
   opkg print-architecture
   ```
   
   Look for:
   - `mips_24kc` → Use `spotfi-bridge-mips`
   - `mipsel_24kc` → Use `spotfi-bridge-mipsle`
   - `aarch64_*` → Use `spotfi-bridge-arm64`

2. **Upload Binaries**

   Upload the appropriate binary to your server and make it accessible via HTTPS.

3. **Update Setup Script**

   Update `scripts/openwrt-setup-cloud.sh` with your binary download URLs:
   ```bash
   DOWNLOAD_URL="https://your-server.com/bin/spotfi-bridge-mipsle"
   ```

4. **Run Setup Script**

   The setup script will automatically:
   - Detect the router architecture
   - Download the correct binary
   - Install it to `/usr/bin/spotfi-bridge`
   - Create the init script
   - Start the service

## Configuration

The bridge reads configuration from `/etc/spotfi.env`:

```
SPOTFI_ROUTER_ID=your_router_id
SPOTFI_TOKEN=your_token
SPOTFI_MAC=your_mac_address
SPOTFI_WS_URL=wss://api.spotfi.com/ws
SPOTFI_ROUTER_NAME=Your Router Name
```

## Features

- **UBUS RPC Proxy**: Generic RPC handler for all router commands
- **PTY Terminal Support**: Full terminal emulation via WebSocket
- **Metrics Collection**: System metrics, memory, CPU load, active users
- **Auto-Reconnect**: Automatic reconnection on connection loss
- **Heartbeat**: Periodic metrics updates every 30 seconds

## Advantages Over Python Version

1. **No Dependencies**: Single binary, no Python packages needed
2. **Better Concurrency**: Goroutines prevent blocking issues
3. **Stability**: Process isolation - if ubus hangs, only that goroutine is affected
4. **Performance**: Faster execution, lower memory footprint
5. **Easier Deployment**: Just download and run, no package installation

## Troubleshooting

### Binary too large
- Use `upx` compression: `upx --best --lzma spotfi-bridge-mipsle`
- Ensure `-ldflags="-s -w"` is used during build

### Binary won't run on router
- Verify architecture match: `opkg print-architecture`
- Check binary permissions: `chmod +x /usr/bin/spotfi-bridge`
- Test binary manually: `/usr/bin/spotfi-bridge`

### Connection issues
- Check `/etc/spotfi.env` exists and is readable
- Verify WebSocket URL is correct
- Check router logs: `logread -f`

## License

Same as main SpotFi project.

