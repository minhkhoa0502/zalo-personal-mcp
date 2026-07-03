#!/usr/bin/env bash
# Prove the egress sandbox actually contains the MCP server.
#
# Run from the repo root (needs Docker Desktop running):
#   ./sandbox/verify.sh
#
# It performs three checks against the internal network the zalo-mcp container
# uses, and only passes if egress is truly locked to Zalo via the proxy.
set -uo pipefail

NET="zalo-personal-mcp_internal"
CURL="curlimages/curl:8.11.1"
FAILED=0

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }

echo "==> Bringing up egress-proxy"
docker compose up -d egress-proxy >/dev/null || { echo "could not start proxy"; exit 1; }
# Give squid a moment to bind.
sleep 3

echo "==> 1. Direct egress to a non-Zalo host must be BLOCKED (no route)"
if docker run --rm --network "$NET" "$CURL" -sS --max-time 8 https://example.com >/dev/null 2>&1; then
  fail "reached example.com directly — network is NOT isolated"
else
  pass "example.com unreachable directly (no internet route)"
fi

echo "==> 2. Proxied request to a non-Zalo host must be DENIED by the allowlist"
out="$(docker run --rm --network "$NET" "$CURL" -sS --max-time 8 -x http://egress-proxy:3128 http://example.com 2>&1)"
if echo "$out" | grep -qiE "403|access denied|forbidden"; then
  pass "example.com denied by squid allowlist"
else
  fail "example.com was NOT denied by the proxy (got: $(echo "$out" | head -c 80))"
fi

echo "==> 3. Proxied request to a Zalo host must be ALLOWED"
code="$(docker run --rm --network "$NET" "$CURL" -sS --max-time 12 -o /dev/null -w '%{http_code}' -x http://egress-proxy:3128 https://chat.zalo.me 2>/dev/null)"
if [ -n "$code" ] && [ "$code" != "000" ]; then
  pass "chat.zalo.me reachable via proxy (HTTP $code)"
else
  fail "chat.zalo.me not reachable via proxy (check connectivity/tag)"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  printf '\033[32mAll checks passed — egress is contained to Zalo.\033[0m\n'
else
  printf '\033[31mOne or more checks failed — do NOT trust the sandbox until fixed.\033[0m\n'
  exit 1
fi
