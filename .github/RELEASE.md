# Release Process

This document explains how to create releases with pre-built binaries.

## Automatic Release (Recommended)

### Option 1: Create a Git Tag

```bash
# Create and push a version tag
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions will automatically:
1. Build all binaries for all architectures
2. Compress them with UPX
3. Create a GitHub Release
4. Upload all binaries as release assets

### Option 2: Manual Workflow Dispatch

1. Go to **Actions** tab in GitHub
2. Select **Build and Release Binaries** workflow
3. Click **Run workflow**
4. Enter version (e.g., `v1.0.0`)
5. Click **Run workflow**

## Release Assets

Each release will include:
- Individual binaries for each architecture (`spotfi-bridge-*`)
- Archive containing all binaries (`spotfi-bridge-binaries.tar.gz`)

## Binary Download URLs

After release, binaries are available at:
```
https://github.com/rufaromugabe/spotfi/releases/latest/download/spotfi-bridge-{ARCH}
```

For example:
- `https://github.com/rufaromugabe/spotfi/releases/latest/download/spotfi-bridge-amd64`
- `https://github.com/rufaromugabe/spotfi/releases/latest/download/spotfi-bridge-arm64`
- etc.

## Version Format

Use semantic versioning:
- `v1.0.0` - Major release
- `v1.0.1` - Patch release
- `v1.1.0` - Minor release

## Testing Releases

To test the release process:
1. Create a pre-release tag: `git tag v1.0.0-rc1`
2. Push: `git push origin v1.0.0-rc1`
3. Check the Actions tab for build status
4. Verify binaries in the Releases section

