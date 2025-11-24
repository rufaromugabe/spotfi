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

The build script now builds binaries for **all supported architectures**:
- MIPS (mips_24kc)
- MIPSLE (mipsel_24kc)
- MIPS64 / MIPS64LE (64-bit MIPS)
- ARM64 (aarch64)
- ARM (32-bit ARM, cortex-a5/a7/a8/a9/a15)
- AMD64 (x86_64)
- 386 (32-bit x86, i386/i686)
- RISC-V 64

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

#### For AMD64/x86_64 (x86_64 routers, VMs, or development)

**Linux/Mac:**
```bash
GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o spotfi-bridge-amd64
upx --best --lzma spotfi-bridge-amd64
```

**Windows (PowerShell):**
```powershell
$env:GOOS="linux"; $env:GOARCH="amd64"
go build -ldflags="-s -w" -o spotfi-bridge-amd64
upx --best --lzma spotfi-bridge-amd64
```

**Windows (CMD):**
```cmd
set GOOS=linux
set GOARCH=amd64
go build -ldflags="-s -w" -o spotfi-bridge-amd64
upx --best --lzma spotfi-bridge-amd64
```

#### For 386/i386 (32-bit x86 routers)

**Linux/Mac:**
```bash
GOOS=linux GOARCH=386 go build -ldflags="-s -w" -o spotfi-bridge-386
upx --best --lzma spotfi-bridge-386
```

**Windows (PowerShell):**
```powershell
$env:GOOS="linux"; $env:GOARCH="386"
go build -ldflags="-s -w" -o spotfi-bridge-386
upx --best --lzma spotfi-bridge-386
```

**Windows (CMD):**
```cmd
set GOOS=linux
set GOARCH=386
go build -ldflags="-s -w" -o spotfi-bridge-386
upx --best --lzma spotfi-bridge-386
```

#### For ARM (32-bit ARM routers, e.g., Cortex-A5/A7/A8/A9/A15)

**Linux/Mac:**
```bash
GOOS=linux GOARCH=arm GOARM=7 go build -ldflags="-s -w" -o spotfi-bridge-arm
upx --best --lzma spotfi-bridge-arm
```

**Windows (PowerShell):**
```powershell
$env:GOOS="linux"; $env:GOARCH="arm"; $env:GOARM="7"
go build -ldflags="-s -w" -o spotfi-bridge-arm
upx --best --lzma spotfi-bridge-arm
```

**Windows (CMD):**
```cmd
set GOOS=linux
set GOARCH=arm
set GOARM=7
go build -ldflags="-s -w" -o spotfi-bridge-arm
upx --best --lzma spotfi-bridge-arm
```

#### For MIPS64 (64-bit MIPS routers)

**Linux/Mac:**
```bash
GOOS=linux GOARCH=mips64 GOMIPS=softfloat go build -ldflags="-s -w" -o spotfi-bridge-mips64
upx --best --lzma spotfi-bridge-mips64
```

**For MIPS64LE (64-bit MIPS little-endian):**
```bash
GOOS=linux GOARCH=mips64le GOMIPS=softfloat go build -ldflags="-s -w" -o spotfi-bridge-mips64le
upx --best --lzma spotfi-bridge-mips64le
```

#### For RISC-V 64 (RISC-V routers)

**Linux/Mac:**
```bash
GOOS=linux GOARCH=riscv64 go build -ldflags="-s -w" -o spotfi-bridge-riscv64
upx --best --lzma spotfi-bridge-riscv64
```

### Build Flags Explained

- `-ldflags="-s -w"`: Strips debugging information, reduces binary size by ~30%
- `GOMIPS=softfloat`: Uses software floating point (safest for router compatibility)
- Compression: Automatic via UPX (if available) - reduces binary from ~5MB to ~1.5MB

### Windows Notes

✅ **Yes, you can build on Windows!** Go's cross-compilation works perfectly from Windows.

- The binaries built on Windows are Linux executables (they won't run on Windows)
- Go automatically handles cross-compilation - no special tools needed
- After building, you'll have Linux binaries ready to upload to your server
- If you see `.exe` extensions, the build scripts will rename them automatically

## Compression

**Compression is automatic!** The `build.sh` script automatically compresses all binaries with UPX after building.

**UPX Setup:**
- **Windows**: Place UPX in `./upx/upx.exe` or `./upx/upx-4.2.1-win64/upx.exe` (or add to PATH)
- **Linux**: `sudo apt install upx` or `sudo yum install upx`
- **Mac**: `brew install upx`

The build script will automatically detect and use UPX if available. If UPX is not found, binaries will be built without compression.

**Expected compression results:**
- Original: ~5-6MB per binary
- Compressed: ~1.5-2MB per binary
- Reduction: ~70% smaller

## Deployment

1. **Identify Router Architecture**

   Run on your OpenWrt router:
   ```bash
   opkg print-architecture
   ```
   
   Look for:
   - `mips_24kc` or `mips_*` → Use `spotfi-bridge-mips`
   - `mipsel_24kc` or `mipsel_*` → Use `spotfi-bridge-mipsle`
   - `mips64_octeon` or `mips64_*` → Use `spotfi-bridge-mips64` or `spotfi-bridge-mips64le`
   - `aarch64_*` or `arm64` → Use `spotfi-bridge-arm64`
   - `arm_cortex-*` or `arm_arm*` → Use `spotfi-bridge-arm` (32-bit ARM)
   - `x86_64` or `amd64` → Use `spotfi-bridge-amd64`
   - `i386` or `i686` → Use `spotfi-bridge-386` (32-bit x86)
   - `riscv64` → Use `spotfi-bridge-riscv64`
   
   **Note:** The setup script now automatically detects your architecture and downloads the correct binary!

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

**Example Configuration:**
```bash
SPOTFI_ROUTER_ID="cmichrwmz0003zijqm53zfpdr"
SPOTFI_TOKEN="test-router-token-123"
SPOTFI_MAC="00:11:22:33:44:55"
SPOTFI_WS_URL="ws://192.168.56.1:8080/ws"
SPOTFI_ROUTER_NAME="Main Office Router"
```

**Getting Router Information:**

Get router details from the SpotFi API:
```bash
curl -X GET http://192.168.56.1:8080/api/routers \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**Example API Response:**
```json
{
  "routers": [
    {
      "id": "cmichrwmz0003zijqm53zfpdr",
      "token": "test-router-token-123",
      "macAddress": "00:11:22:33:44:55",
      "name": "Main Office Router"
    }
  ]
}
```

**WebSocket URL Format:**
- Local development: `ws://SERVER_IP:PORT/ws?id=ROUTER_ID&token=TOKEN`
- Production: `wss://api.spotfi.com/ws?id=ROUTER_ID&token=TOKEN`

**Example WebSocket URL:**
```
ws://192.168.56.1:8080/ws?id=cmichrwmz0003zijqm53zfpdr&token=test-router-token-123
```

**Note:** The `id` and `token` query parameters in the WebSocket URL are used for authentication. The bridge will automatically include them when connecting.

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
- Ensure `-ldflags="-s -w"` is used during build
- Compression is automatic if UPX is available (check `./upx/` directory or PATH)

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

