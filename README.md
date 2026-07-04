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
| `zalo_listen` | Open the realtime listener for a window; return incoming messages (live + on-connect backlog) |
| `zalo_recent_messages` | Read messages captured by the background daemon (last N minutes) — the reliable "what did I miss?" |

The surface is intentionally minimal to keep the attack surface small.

### Background message capture (daemon)

`zalo_listen` only sees messages during its call window. For durable "what did I
receive recently?", run the **daemon**, which owns the listener and appends every
incoming message to `.zalo/messages.jsonl` (surviving restarts):

```bash
make daemon        # start it (add ZALO_SELF_LISTEN=true to also capture your own)
make daemon-logs   # watch it
make daemon-stop   # stop it
```

Then `zalo_recent_messages` reads that log. Note: Zalo allows only one web
listener per account, so **don't use `zalo_listen` while the daemon is running.**

> [!NOTE]
> **DM history is not fetchable.** The Zalo Web protocol only exposes history for
> *groups* (`getGroupChatHistory`). One-to-one messages arrive through the
> realtime listener, not a fetch endpoint. So `zalo_get_messages` supports groups
> only, and **`zalo_listen`** is the way to read incoming DMs — it opens the
> WebSocket listener for a fixed window and returns what arrives (plus the backlog
> Zalo pushes on connect). The listener runs inside the sandbox by tunnelling its
> WebSocket through the Squid proxy (`ws` uses an `http.Agent`, so we pass it an
> `HttpsProxyAgent`).

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
make build     # build the server image
make login     # one-time QR login inside the sandbox (scan ./.zalo/qr.png)
make verify    # prove egress is contained to Zalo only
```

`make help` lists all targets (`build`, `up`, `login`, `verify`, `logs`,
`down`, `clean`). The equivalent raw commands are in
[sandbox/README.md](sandbox/README.md).

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
