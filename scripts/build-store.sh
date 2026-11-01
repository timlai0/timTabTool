#!/bin/bash
# Build and package the extension for Chrome Web Store submission

set -e

echo "[timTabTool] Type checking and running tests..."
npm run typecheck
npm test

echo "[timTabTool] Building Chrome extension..."
npm run build

echo "[timTabTool] Packaging for Chrome Web Store..."
rm -f timtabtool-chrome.zip
cd dist
zip -r ../timtabtool-chrome.zip . -x "*.DS_Store" ".vite/*"
cd ..

if command -v du &> /dev/null; then
  SIZE=$(du -h timtabtool-chrome.zip | cut -f1)
  echo "[timTabTool] Package created: timtabtool-chrome.zip ($SIZE)"
else
  echo "[timTabTool] Package created: timtabtool-chrome.zip"
fi
echo ""
echo "Next steps:"
echo "  1. Go to https://chrome.google.com/webstore/devconsole"
echo "  2. Click 'New Item' -> Upload timtabtool-chrome.zip"
echo "  3. Fill in listing details from docs/STORE_LISTING.md"
echo "  4. Upload screenshots and promotional images"
echo "  5. Submit for review"
