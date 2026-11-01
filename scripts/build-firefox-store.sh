#!/bin/bash
# Build and package the extension and source archive for Mozilla Add-ons (Firefox AMO) submission

set -e

echo "[timTabTool] Type checking and running tests..."
npm run typecheck
npm test

echo "[timTabTool] Building Firefox extension..."
npm run build:firefox

echo "[timTabTool] Linting Firefox extension with web-ext..."
npm run lint:firefox

echo "[timTabTool] Packaging add-on for Mozilla Add-ons (Firefox)..."
rm -f timtabtool-firefox.zip timtabtool-source.zip
cd dist-firefox
zip -r ../timtabtool-firefox.zip . -x "*.DS_Store" ".vite/*"
cd ..

echo "[timTabTool] Creating clean source archive for AMO review..."
git archive --format=zip -o timtabtool-source.zip HEAD

if command -v du &> /dev/null; then
  SIZE=$(du -h timtabtool-firefox.zip | cut -f1)
  SRC_SIZE=$(du -h timtabtool-source.zip | cut -f1)
  echo "[timTabTool] Add-on package created: timtabtool-firefox.zip ($SIZE)"
  echo "[timTabTool] Source archive created: timtabtool-source.zip ($SRC_SIZE)"
else
  echo "[timTabTool] Add-on package created: timtabtool-firefox.zip"
  echo "[timTabTool] Source archive created: timtabtool-source.zip"
fi

echo ""
echo "Next steps:"
echo "  1. Go to https://addons.mozilla.org/en-US/developers/"
echo "  2. Submit a new add-on or version and upload timtabtool-firefox.zip"
echo "  3. When prompted for source code, upload timtabtool-source.zip"
echo "  4. Copy reviewer build instructions from docs/STORE_LISTING.md"
echo "  5. Submit for review"
