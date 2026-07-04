#!/usr/bin/env bash
# Launched at macOS login by the LaunchAgent (see install-autostart.sh).
# Waits for Docker to be ready, then starts the egress proxy + message-capture
# daemon. The session passphrase is read from the macOS Keychain so it never
# lives in a plist or a plaintext file.
set -uo pipefail

# LaunchAgents run with a minimal PATH that omits the Docker CLI. Add the common
# install locations (Docker Desktop symlink, Homebrew, Docker's own bin).
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.docker/bin:$PATH"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
KEYCHAIN_SERVICE="zalo-personal-mcp-session-key"

# Wait up to ~5 minutes for the Docker daemon (Docker Desktop is slow to boot).
for _ in $(seq 1 60); do
  docker info >/dev/null 2>&1 && break
  sleep 5
done
if ! docker info >/dev/null 2>&1; then
  echo "[autostart] Docker not ready after 5 min; giving up. Is Docker Desktop set to start at login?" >&2
  exit 1
fi

# Read the passphrase from the Keychain (empty if absent → keyfile mode).
ZALO_SESSION_KEY="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null || true)"
export ZALO_SESSION_KEY

cd "$REPO" || exit 1
echo "[autostart] starting egress-proxy + zalo-daemon at $(date)"
exec docker compose up -d egress-proxy zalo-daemon
