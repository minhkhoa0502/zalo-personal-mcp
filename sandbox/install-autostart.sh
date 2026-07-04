#!/usr/bin/env bash
# Install a macOS LaunchAgent that starts the message-capture daemon at login.
# Idempotent: re-running reinstalls/reloads. Uninstall with `make autostart-uninstall`.
set -euo pipefail

[ "$(uname)" = "Darwin" ] || {
  echo "This autostart uses macOS LaunchAgents; on Linux use a systemd user unit instead." >&2
  exit 1
}

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.zalo-personal-mcp.daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SERVICE="zalo-personal-mcp-session-key"

if ! security find-generic-password -s "$SERVICE" -w >/dev/null 2>&1; then
  echo "Session passphrase is not in the Keychain. Add it first, then re-run:" >&2
  echo "  security add-generic-password -U -a \"\$USER\" -s $SERVICE -w 'YOUR_PASSPHRASE'" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$REPO/.zalo"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$REPO/sandbox/start-daemon.sh</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>StandardOutPath</key><string>$REPO/.zalo/autostart.log</string>
    <key>StandardErrorPath</key><string>$REPO/.zalo/autostart.log</string>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"

echo "Installed LaunchAgent: $PLIST"
echo "It runs at every login: waits for Docker, then starts egress-proxy + zalo-daemon."
echo
echo "IMPORTANT: also enable Docker Desktop to start at login"
echo "  Docker Desktop -> Settings -> General -> 'Start Docker Desktop when you sign in'"
echo "Otherwise the agent waits (up to 5 min) and gives up until you open Docker."
echo "Logs: $REPO/.zalo/autostart.log"
