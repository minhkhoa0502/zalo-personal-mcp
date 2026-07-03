# zalo-personal-mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that
lets AI clients (Claude Code, Claude Desktop, Cursor, …) interact with a
**personal Zalo account**.

Zalo only offers an official API for **Official Accounts (OA)** — there is no
official API for personal accounts. This project bridges that gap by exposing a
small, self-owned MCP server on top of the community-maintained
[`zca-js`](https://github.com/RFS-ADRENO/zca-js) protocol library.

> [!WARNING]
> Automating a **personal** Zalo account is **against Zalo's Terms of Service**
> and can get your account **restricted or banned**. This project is for
> personal, educational, and research use. Use a disposable/secondary account,
> keep automation light and human-like, and accept the risk. You are responsible
> for how you use it.

## Why this exists / design decisions

The full reasoning — why we build our own server instead of adopting an existing
one, why we depend on `zca-js` instead of rewriting the protocol, why not Rust,
and how we handle the supply-chain trust problem — is documented as an
Architecture Decision Record:

- [ADR-0001: Architecture & dependency strategy](docs/adr/0001-architecture-and-dependency-strategy.md)

TL;DR:

- **We own the MCP server** (this repo). It's thin glue and we control it fully.
- **We depend on `zca-js` for the protocol** (QR login, request encryption,
  websocket listener). Reimplementing it is weeks of fragile work and a
  permanent maintenance burden; the community keeps `zca-js` in sync with Zalo.
- **We treat `zca-js` as untrusted-until-audited**: vendored, version-pinned,
  audited on every upgrade, and run under an **egress-locked, least-privilege
  sandbox** so a hypothetical malicious version has nowhere to send your data.

## Security model

See [SECURITY.md](SECURITY.md). The short version:

1. **Audit** the dependency once (see [`docs/audit/`](docs/audit/)).
2. **Pin** the exact version with a lockfile integrity hash — no auto-updates.
3. **Review the diff** on every upgrade (small, incremental).
4. **Contain** at runtime: the process can only reach Zalo domains and only
   sees its own Zalo session — nothing else. Containment is the real backstop,
   not detection.

## Status

✅ **Working — first tools implemented.** QR login + session persistence and five
MCP tools are functional. The `zca-js@2.1.2` dependency has been audited
([report](docs/audit/zca-js-2.1.2.md)).

## MCP tools

| Tool | Description |
|------|-------------|
| `zalo_account_info` | Return the logged-in account's own profile |
| `zalo_list_threads` | List friends (DMs) and groups, with their ids |
| `zalo_get_messages` | Fetch recent **group** message history |
| `zalo_send_message` | Send a plain-text message to a user or group |
| `zalo_mark_read` | Clear the unread marker on a thread |

The surface is intentionally minimal to keep the attack surface small.

> [!NOTE]
> **DM history is not fetchable.** The Zalo Web protocol only exposes history for
> *groups* (`getGroupChatHistory`). One-to-one messages arrive through the
> realtime listener, not a fetch endpoint, so `zalo_get_messages` supports groups
> only and returns an explanation for `user` threads. Live DM streaming is a
> possible future addition.

## Setup

Requires Node.js ≥ 20.

```bash
npm install          # installs pinned deps + writes package-lock.json (integrity hashes)
npm run build        # compile TypeScript to dist/
npm run login        # one-time: scan the QR with the Zalo mobile app
```

`npm run login` writes a QR image next to your session file (default
`./.zalo/qr.png`); open it and scan via the Zalo app (Settings → scan QR). On
success the session is **encrypted at rest** and saved to
`./.zalo/session.json`. Set `ZALO_SESSION_KEY` before logging in for
passphrase-based encryption (recommended — see [`.env.example`](.env.example)).

## Running sandboxed (recommended)

For the real security guarantee, run the server in the egress-locked Docker
sandbox — it can only reach Zalo domains, so a compromised dependency has
nowhere to exfiltrate. See **[sandbox/README.md](sandbox/README.md)**.

```bash
docker compose build
docker compose up -d egress-proxy
docker compose run --rm -T zalo-mcp node dist/login.js   # one-time QR login
./sandbox/verify.sh                                       # prove containment
```

## Using it with an MCP client

Point your client at the built server. Example (`.mcp.json` / Claude Desktop
`mcpServers`):

```json
{
  "mcpServers": {
    "zalo": {
      "command": "node",
      "args": ["/absolute/path/to/zalo-personal-mcp/dist/index.js"],
      "env": {
        "ZALO_SESSION_PATH": "/absolute/path/to/zalo-personal-mcp/.zalo/session.json",
        "ZALO_SESSION_KEY": "your-strong-passphrase"
      }
    }
  }
}
```

## Development

```bash
npm run dev          # tsc --watch
npm run typecheck    # type-check only
npm run audit:deps   # npm audit (runtime deps)
```

## License

[MIT](LICENSE)
