#!/bin/bash
# Build script for SpotFi Bridge - Git Bash compatible
# Builds all architectures for OpenWrt routers

set -e

echo "Building SpotFi Bridge for all architectures..."
echo ""

# Check if UPX is available - check local directory first, then PATH
HAS_UPX=false
UPX_CMD=""

# Find UPX - check PATH first (for CI/Linux), then local directory (for Windows)
# On Linux/CI, system UPX takes priority; on Windows, local UPX is used
if command -v upx &> /dev/null 2>&1; then
    UPX_CMD="upx"
    HAS_UPX=true
    echo "✓ UPX found (PATH) - binaries will be compressed"
else
    # Check for local Windows UPX only if PATH didn't work
    # Detect Windows environment
    IS_WINDOWS=false
    if [ -n "$WINDIR" ] || [ "$(uname -s)" = "MINGW"* ] || [ "$(uname -s)" = "MSYS"* ] || [ "$(uname -o)" = "Msys" ]; then
        IS_WINDOWS=true
    fi
    
    if [ "$IS_WINDOWS" = true ]; then
        # On Windows, check for local UPX executables
        if [ -f "./upx/upx-4.2.1-win64/upx.exe" ]; then
            UPX_CMD="./upx/upx-4.2.1-win64/upx.exe"
            HAS_UPX=true
            echo "✓ UPX found (local: ./upx/upx-4.2.1-win64/upx.exe) - binaries will be compressed"
        elif [ -f "./upx/upx.exe" ]; then
            UPX_CMD="./upx/upx.exe"
            HAS_UPX=true
            echo "✓ UPX found (local: ./upx/upx.exe) - binaries will be compressed"
        elif [ -f "upx/upx-4.2.1-win64/upx.exe" ]; then
            UPX_CMD="upx/upx-4.2.1-win64/upx.exe"
            HAS_UPX=true
            echo "✓ UPX found (local: upx/upx-4.2.1-win64/upx.exe) - binaries will be compressed"
        elif [ -f "upx/upx.exe" ]; then
            UPX_CMD="upx/upx.exe"
            HAS_UPX=true
            echo "✓ UPX found (local: upx/upx.exe) - binaries will be compressed"
        fi
    fi
    
    if [ "$HAS_UPX" = false ]; then
        echo "⚠ UPX not found - binaries will not be compressed"
        echo "  Install from: https://upx.github.io/"
        if [ "$IS_WINDOWS" = true ]; then
            echo "  Windows: Place UPX in ./upx/upx.exe or ./upx/upx-4.2.1-win64/upx.exe"
        else
            echo "  Linux: sudo apt install upx-ucl or sudo yum install upx"
            echo "  Mac: brew install upx"
        fi
    fi
fi

echo ""

# Build MIPS
echo "Building for MIPS (mips_24kc)..."
export GOOS=linux
export GOARCH=mips
export GOMIPS=softfloat
go build -ldflags="-s -w" -o spotfi-bridge-mips
if [ "$HAS_UPX" = true ]; then
    $UPX_CMD --best --lzma spotfi-bridge-mips
    echo "✓ Built and compressed: spotfi-bridge-mips"
else
    echo "✓ Built: spotfi-bridge-mips (not compressed)"
fi
echo ""

# Build MIPSLE
echo "Building for MIPSLE (mipsel_24kc)..."
export GOOS=linux
export GOARCH=mipsle
export GOMIPS=softfloat
go build -ldflags="-s -w" -o spotfi-bridge-mipsle
if [ "$HAS_UPX" = true ]; then
    $UPX_CMD --best --lzma spotfi-bridge-mipsle
    echo "✓ Built and compressed: spotfi-bridge-mipsle"
else
    echo "✓ Built: spotfi-bridge-mipsle (not compressed)"
fi
echo ""

# Build ARM64
echo "Building for ARM64 (aarch64)..."
export GOOS=linux
export GOARCH=arm64
unset GOMIPS
go build -ldflags="-s -w" -o spotfi-bridge-arm64
if [ "$HAS_UPX" = true ]; then
    $UPX_CMD --best --lzma spotfi-bridge-arm64
    echo "✓ Built and compressed: spotfi-bridge-arm64"
else
    echo "✓ Built: spotfi-bridge-arm64 (not compressed)"
fi
echo ""

# Build AMD64 (x86_64)
echo "Building for AMD64 (x86_64)..."
export GOOS=linux
export GOARCH=amd64
unset GOMIPS
go build -ldflags="-s -w" -o spotfi-bridge-amd64
if [ "$HAS_UPX" = true ]; then
    $UPX_CMD --best --lzma spotfi-bridge-amd64
    echo "✓ Built and compressed: spotfi-bridge-amd64"
else
    echo "✓ Built: spotfi-bridge-amd64 (not compressed)"
fi
echo ""

# Build 386 (32-bit x86)
echo "Building for 386 (i386/i686)..."
export GOOS=linux
export GOARCH=386
unset GOMIPS
go build -ldflags="-s -w" -o spotfi-bridge-386
if [ "$HAS_UPX" = true ]; then
    $UPX_CMD --best --lzma spotfi-bridge-386
    echo "✓ Built and compressed: spotfi-bridge-386"
else
    echo "✓ Built: spotfi-bridge-386 (not compressed)"
fi
echo ""

# Build ARM (32-bit ARM)
echo "Building for ARM (32-bit, cortex-a5/a7/a8/a9/a15)..."
export GOOS=linux
export GOARCH=arm
export GOARM=7
unset GOMIPS
go build -ldflags="-s -w" -o spotfi-bridge-arm
if [ "$HAS_UPX" = true ]; then
    $UPX_CMD --best --lzma spotfi-bridge-arm
    echo "✓ Built and compressed: spotfi-bridge-arm"
else
    echo "✓ Built: spotfi-bridge-arm (not compressed)"
fi
echo ""

# Build MIPS64 (64-bit MIPS)
echo "Building for MIPS64 (64-bit MIPS big-endian)..."
export GOOS=linux
export GOARCH=mips64
export GOMIPS=softfloat
go build -ldflags="-s -w" -o spotfi-bridge-mips64
if [ "$HAS_UPX" = true ]; then
    $UPX_CMD --best --lzma spotfi-bridge-mips64
    echo "✓ Built and compressed: spotfi-bridge-mips64"
else
    echo "✓ Built: spotfi-bridge-mips64 (not compressed)"
fi
echo ""

# Build MIPS64LE (64-bit MIPS little-endian)
echo "Building for MIPS64LE (64-bit MIPS little-endian)..."
export GOOS=linux
export GOARCH=mips64le
export GOMIPS=softfloat
go build -ldflags="-s -w" -o spotfi-bridge-mips64le
if [ "$HAS_UPX" = true ]; then
    $UPX_CMD --best --lzma spotfi-bridge-mips64le
    echo "✓ Built and compressed: spotfi-bridge-mips64le"
else
    echo "✓ Built: spotfi-bridge-mips64le (not compressed)"
fi
echo ""

# Build RISC-V 64
echo "Building for RISC-V 64..."
export GOOS=linux
export GOARCH=riscv64
unset GOMIPS
go build -ldflags="-s -w" -o spotfi-bridge-riscv64
if [ "$HAS_UPX" = true ]; then
    $UPX_CMD --best --lzma spotfi-bridge-riscv64
    echo "✓ Built and compressed: spotfi-bridge-riscv64"
else
    echo "✓ Built: spotfi-bridge-riscv64 (not compressed)"
fi
echo ""

# Show file sizes
echo "Binary sizes:"
ls -lh spotfi-bridge-* 2>/dev/null | grep -vE '\.(bat|ps1|sh|md|go|mod)$' | awk '{print $5, $9}'
echo ""
echo "Build complete! Upload binaries to your server and update the download URLs in openwrt-setup-cloud.sh"
