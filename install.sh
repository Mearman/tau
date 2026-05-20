#!/bin/bash
# Pi Chrome Bridge — Install native messaging host manifest
#
# This script installs the native messaging host manifest so Chrome
# can launch the bridge when the extension calls connectNative().
#
# Prerequisites:
#   - Google Chrome (or Chromium-based browser) installed
#   - Developer Mode enabled in chrome://extensions
#   - Pi Chrome Bridge extension loaded via "Load unpacked"

set -euo pipefail

EXTENSION_DIR="$(cd "$(dirname "$0")/chrome-extension" && pwd)"
BRIDGE_DIR="$(cd "$(dirname "$0")/bridge" && pwd)"

# Extension ID is derived from the path hash for unpacked extensions
# This must match what Chrome assigns to the extension when loaded
# via "Load unpacked" from the chrome-extension directory.
# To find the actual ID, load the extension and check chrome://extensions.
echo "Pi Chrome Bridge — Native Messaging Host Installer"
echo ""

# Determine native messaging hosts directory based on OS
case "$(uname -s)" in
    Darwin)
        NMH_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
        ;;
    Linux)
        NMH_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
        ;;
    *)
        echo "Unsupported OS: $(uname -s)"
        exit 1
        ;;
esac

# Ask for extension ID or derive it
if [ -n "${1:-}" ]; then
    EXTENSION_ID="$1"
else
    # Default: path-derived ID for the chrome-extension directory
    EXTENSION_ID="gkhnaechfomopobkjgdhmfkoblnljjfc"
    echo "Using default extension ID: $EXTENSION_ID"
    echo "If different, run: $0 <your-extension-id>"
fi

# Create the native messaging host manifest
mkdir -p "$NMH_DIR"

MANIFEST_PATH="$NMH_DIR/io.pi.chrome_bridge.json"

cat > "$MANIFEST_PATH" << EOF
{
  "name": "io.pi.chrome_bridge",
  "description": "Pi Chrome Bridge — native messaging host for agent↔Chrome communication",
  "path": "$BRIDGE_DIR/pi-chrome-bridge",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF

echo "Installed native messaging host manifest:"
echo "  Manifest:  $MANIFEST_PATH"
echo "  Host:      $BRIDGE_DIR/pi-chrome-bridge"
echo "  Extension: chrome-extension://${EXTENSION_ID}/"
echo ""
echo "Next steps:"
echo "  1. Open chrome://extensions"
echo "  2. Enable Developer Mode (top right)"
echo "  3. Click 'Load unpacked' → select: $EXTENSION_DIR"
echo "  4. The extension will auto-connect to the native host"
