#!/bin/bash
# Build script for SpotFi Bridge - Git Bash compatible
# Builds all architectures for OpenWrt routers

set -e

echo "Building SpotFi Bridge for all architectures..."
echo ""

# Check if UPX is available
HAS_UPX=false
if command -v upx &> /dev/null; then
    HAS_UPX=true
    echo "✓ UPX found - binaries will be compressed"
else
    echo "⚠ UPX not found - binaries will not be compressed"
    echo "  Install from: https://upx.github.io/"
fi

echo ""

# Build MIPS
echo "Building for MIPS (mips_24kc)..."
export GOOS=linux
export GOARCH=mips
export GOMIPS=softfloat
go build -ldflags="-s -w" -o spotfi-bridge-mips
if [ "$HAS_UPX" = true ]; then
    upx --best --lzma spotfi-bridge-mips
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
    upx --best --lzma spotfi-bridge-mipsle
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
    upx --best --lzma spotfi-bridge-arm64
    echo "✓ Built and compressed: spotfi-bridge-arm64"
else
    echo "✓ Built: spotfi-bridge-arm64 (not compressed)"
fi
echo ""

# Show file sizes
echo "Binary sizes:"
ls -lh spotfi-bridge-* 2>/dev/null | grep -vE '\.(bat|ps1|sh|md|go|mod)$' | awk '{print $5, $9}'
echo ""
echo "Build complete! Upload binaries to your server and update the download URLs in openwrt-setup-cloud.sh"
