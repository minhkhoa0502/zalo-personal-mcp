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

🚧 **Early scaffolding.** The dependency audit and MCP tool implementation are in
progress. Not yet functional.

## Planned MCP tools

| Tool | Description |
|------|-------------|
| `list_threads` | List recent conversations (DMs and groups) |
| `get_messages` | Fetch recent messages from a thread |
| `send_message` | Send a text message to a user or group |
| `mark_read` | Mark a thread as read |
| `send_media` | Send an image/file (later) |

Exact surface is intentionally minimal — we expose only what's needed to keep the
attack surface small.

## Development

```bash
npm install
npm run build
npm run dev
```

Requires Node.js ≥ 20.

## License

[MIT](LICENSE)
