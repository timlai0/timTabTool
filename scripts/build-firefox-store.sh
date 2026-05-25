#!/bin/bash
# Build and package the extension for Mozilla Add-on (Firefox) submission

set -e

echo "🔨 Building Firefox extension..."
npm run build:firefox

echo "📦 Packaging for Mozilla Add-ons (Firefox)..."
cd dist-firefox
zip -r ../tabpilot-firefox.zip . -x "*.DS_Store" ".vite/*"
cd ..

if command -v du &> /dev/null; then
  SIZE=$(du -h tabpilot-firefox.zip | cut -f1)
  echo "✅ Package created: tabpilot-firefox.zip ($SIZE)"
else
  echo "✅ Package created: tabpilot-firefox.zip"
fi

echo ""
echo "Next steps:"
echo "  1. Go to https://addons.mozilla.org/en-US/developers/"
echo "  2. Submit your new add-on or a new version"
echo "  3. Upload tabpilot-firefox.zip"
echo "  4. Fill in version and compatibility notes"
echo "  5. Submit for review"
