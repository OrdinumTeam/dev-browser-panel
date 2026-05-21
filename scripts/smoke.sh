#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== Build ==="
npm install
npm run compile
npm run package

echo "=== Install ==="
code --install-extension dev-browser-panel-0.1.0.vsix

echo "=== Pre-flight: Chromium binary ==="
CHROMIUM_FOUND=0
for path in \
  "$HOME/Library/Caches/ms-playwright/chromium_headless_shell-"*/chrome-headless-shell-mac-arm64/chrome-headless-shell \
  "$HOME/Library/Caches/ms-playwright/chromium_headless_shell-"*/chrome-headless-shell-mac/chrome-headless-shell \
  "$HOME/.cache/ms-playwright/chromium_headless_shell-"*/chrome-headless-shell-linux/chrome-headless-shell
do
  if [ -f "$path" ]; then
    echo "  Found: $path"
    CHROMIUM_FOUND=1
    break
  fi
done

if [ "$CHROMIUM_FOUND" -eq 0 ]; then
  echo "FAIL: Chromium not found."
  echo "  Fix: npx playwright install chromium"
  echo "       or set devBrowserPanel.chromiumPath in VS Code settings."
  exit 1
fi

echo ""
echo "=== Manual smoke test steps ==="
echo ""
echo "1. Open VS Code in this folder."
echo "2. Run: Cmd+Shift+P → 'Dev Browser Panel: Open'"
echo "3. Check status bar shows '🌐 Browser :9333'."
echo "4. Verify the viewer panel opens with toolbar + canvas."
echo "5. Verify the Logs panel opens in the bottom panel."
echo ""
echo "6. In another terminal, validate CDP is accessible:"
echo "   curl -s -H 'Host: localhost' http://127.0.0.1:9333/json/version | python3 -m json.tool"
echo ""
echo "7. Verify port file:"
echo "   cat ~/.dev-browser-panel/port   # should print 9333"
echo ""
echo "8. Validate dev-browser CLI integration:"
echo "   dev-browser --connect http://localhost:9333 <<< 'const tabs = await browser.listPages(); console.log(JSON.stringify(tabs))'"
echo ""
echo "9. Type 'https://example.com' in URL bar and press Enter."
echo "   Check: page loads in canvas, title updates in tab strip."
echo ""
echo "10. Run: Cmd+Shift+P → 'Dev Browser Panel: Stop Chromium'"
echo "    Check: status bar shows 'Browser OFF', port file removed."
echo "    ps aux | grep chrome-headless | grep -v grep   # should be empty"
echo ""
echo "Build and install: PASS"
echo "Manual steps above require a running VS Code window."
