# Quick Start: Create Your First Release

## Step 1: Commit and Push the Workflow

```bash
git add .github/workflows/release-binaries.yml
git commit -m "Add automatic release workflow"
git push origin main
```

## Step 2: Create Your First Release

### Option A: Using Git Tag (Recommended)

```bash
# Create a version tag
git tag v1.0.0

# Push the tag to trigger the workflow
git push origin v1.0.0
```

### Option B: Manual Workflow Dispatch

1. Go to: `https://github.com/rufaromugabe/spotfi/actions`
2. Click on **Build and Release Binaries**
3. Click **Run workflow**
4. Enter version: `v1.0.0`
5. Click **Run workflow**

## Step 3: Wait for Build

- Go to **Actions** tab to watch the build progress
- The workflow will:
  1. Build all 9 binaries
  2. Compress them with UPX
  3. Create a GitHub Release
  4. Upload all binaries

## Step 4: Verify Release

1. Go to: `https://github.com/rufaromugabe/spotfi/releases`
2. You should see your release with all binaries attached
3. Each binary will be available at:
   ```
   https://github.com/rufaromugabe/spotfi/releases/latest/download/spotfi-bridge-{ARCH}
   ```

## Step 5: Test on Router

The setup script will now automatically download from GitHub Releases:

```bash
wget -O /tmp/openwrt-setup-cloud.sh https://raw.githubusercontent.com/rufaromugabe/spotfi/main/scripts/openwrt-setup-cloud.sh
sh /tmp/openwrt-setup-cloud.sh ROUTER_ID TOKEN MAC_ADDRESS WS_URL
```

## Troubleshooting

**Workflow fails?**
- Check Actions tab for error messages
- Ensure Go 1.21+ is available (workflow uses 1.21)
- Check that build.sh is executable

**Binaries not uploaded?**
- Check file paths in workflow
- Verify binaries were built successfully
- Check Actions logs for upload errors

**Release not created?**
- Verify GITHUB_TOKEN has release permissions
- Check if tag already exists
- Review workflow logs for errors

