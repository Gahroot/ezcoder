#!/bin/bash
set -e

echo "=========================================="
echo "Publishing @prestyj packages to npm"
echo "Version: 4.3.55"
echo "=========================================="
echo ""

# Check if logged into npm
if ! npm whoami 2>/dev/null; then
    echo "❌ Not logged into npm. Please run: npm login"
    exit 1
fi

echo "✓ Logged in as: $(npm whoami)"
echo ""

# Build and test
echo "Building packages..."
pnpm run build > /dev/null 2>&1

echo "Running type checks..."
pnpm run check > /dev/null 2>&1

echo "Running tests..."
pnpm run test > /dev/null 2>&1

echo ""
echo "✓ All checks passed"
echo ""

# Publish in dependency order
echo "Publishing @prestyj/ai..."
cd packages/ai && npm publish --access public && cd ../..
echo "✓ @prestyj/ai@4.3.55 published"

echo "Publishing @prestyj/agent..."
cd packages/agent && npm publish --access public && cd ../..
echo "✓ @prestyj/agent@4.3.55 published"

echo "Publishing @prestyj/cli..."
cd packages/cli && npm publish --access public && cd ../..
echo "✓ @prestyj/cli@4.3.55 published"

echo ""
echo "=========================================="
echo "✅ All packages published successfully!"
echo "=========================================="
echo ""
echo "Install with: npm install -g @prestyj/cli@4.3.55"
