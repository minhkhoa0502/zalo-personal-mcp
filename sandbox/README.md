# Egress-locked sandbox

This is the runtime containment layer from
[ADR-0001](../docs/adr/0001-architecture-and-dependency-strategy.md) and
[SECURITY.md](../SECURITY.md): even if `zca-js` (or a transitive dep) were
compromised, it has **nowhere to send your Zalo session or messages**.

## How it works

```
                 internal net (no gateway)        egress net (internet)
  ┌────────────┐   HTTPS_PROXY=egress-proxy:3128   ┌──────────────┐
  │  zalo-mcp  │ ───────────────────────────────▶ │ egress-proxy │ ──▶ *.zalo.me
  └────────────┘                                   │   (squid)    │ ──▶ *.zadn.vn / *.zdn.vn
   no direct route out                             └──────────────┘ ──▶ *.zaloapp.com
                                                    denies everything else
```

- **`zalo-mcp`** is attached only to the `internal` Docker network
  (`internal: true`), which has **no route to the internet**. Its one reachable
  peer is the proxy.
- **`egress-proxy`** (Squid) permits connections **only to Zalo domains**
  (see [`squid.conf`](squid.conf)) and does the DNS resolution itself (via
  HTTP CONNECT), so not even DNS lookups leak.
- **Fail-closed:** if the app isn't pointed at the proxy, or a malicious
  dependency opens a raw socket to an attacker host, there is no route — the
  connection dies. Legitimate Zalo traffic is the only thing that works.

The app-level piece (`src/net.ts` routing `undici` global fetch through
`HTTPS_PROXY`) only provides *functionality*. The *security* comes from the
network isolation above — it does not depend on the app cooperating.

## Usage

From the repo root, with Docker Desktop running:

```bash
# 1. (optional but recommended) set a passphrase for the session at rest
export ZALO_SESSION_KEY='some-strong-passphrase'

# 2. build the server image + start the proxy
docker compose build
docker compose up -d egress-proxy

# 3. one-time interactive login (writes ./.zalo/qr.png — open & scan it)
docker compose run --rm -T zalo-mcp node dist/login.js

# 4. verify the sandbox actually contains egress
./sandbox/verify.sh
```

Then point your MCP client at the sandboxed server:

```json
{
  "mcpServers": {
    "zalo": {
      "command": "docker",
      "args": [
        "compose", "-f", "/absolute/path/to/zalo-personal-mcp/docker-compose.yml",
        "run", "--rm", "-T", "zalo-mcp"
      ],
      "env": { "ZALO_SESSION_KEY": "some-strong-passphrase" }
    }
  }
}
```

`run --rm -T` attaches the container's stdio to the client (the MCP transport)
and removes the container on exit. The `egress-proxy` dependency stays up.

## Verifying

`./sandbox/verify.sh` runs three checks and passes only if all hold:

1. A direct request to `example.com` from the internal network **fails** (no route).
2. A proxied request to `example.com` is **denied** by the allowlist (HTTP 403).
3. A proxied request to `chat.zalo.me` **succeeds**.

## Hardening notes

- **Pin the proxy image by digest** after first pull for full reproducibility:
  ```bash
  docker compose pull egress-proxy
  docker inspect --format '{{index .RepoDigests 0}}' ubuntu/squid:6.6-24.04_edge
  # then replace the image: line with ubuntu/squid@sha256:...
  ```
- The allowlist lives in [`squid.conf`](squid.conf); widen it only with hosts
  confirmed Zalo-owned in the dependency audit.
- The live DM **listener** (`zalo_listen`) uses a WebSocket via `ws`, which does
  not honor `HTTPS_PROXY`. We pass it an explicit `HttpsProxyAgent` pointed at
  the Squid proxy (see `buildZalo()` in `src/zalo-client.ts`), so it too is
  contained to Zalo hosts. Verified: the listener connects from the internal-only
  network, which is only possible through the proxy.
