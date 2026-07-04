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

✅ **Working.** QR login + encrypted session, an egress-locked Docker sandbox, a
background message-capture daemon, and **28 MCP tools** (messaging, media,
reactions, lookups, group/friend management, conversation controls) — all
verified against a live account. The `zca-js@2.1.2` dependency has been audited
([report](docs/audit/zca-js-2.1.2.md)).

## MCP tools

| Tool | Description |
|------|-------------|
| `zalo_account_info` | Return the logged-in account's own profile |
| `zalo_list_threads` | List friends (DMs) and groups, with their ids |
| `zalo_get_messages` | Try group history (often 404s — prefer the daemon; see note below) |
| `zalo_send_message` | Send a plain-text message; optionally quote/reply to a message |
| `zalo_react` | Add an emoji reaction (HEART, LIKE, HAHA, …) to a message |
| `zalo_mark_read` | Clear the unread marker on a thread |
| `zalo_listen` | Open the realtime listener for a window; return incoming messages (live + on-connect backlog) |
| `zalo_recent_messages` | Read messages captured by the background daemon (last N minutes) — the reliable "what did I miss?" |
| `zalo_send_media` | Send a local image/file (from `./.zalo`) to a user or group |
| `zalo_download_attachment` | Download a received attachment by URL into `./.zalo/inbox` |
| `zalo_get_user_info` | Look up profile info for one or more user ids |
| `zalo_find_user` | Find a user by phone number |
| `zalo_group_members` | List a group's member profiles |
| `zalo_send_link` | Send a URL with a link preview |
| `zalo_send_sticker` | Search by keyword and send a sticker |
| `zalo_send_bank_card` | Send a bank-transfer card (account details / VietQR) |
| `zalo_create_group` | Create a new group with members |
| `zalo_rename_group` | Change a group's name |
| `zalo_add_group_members` | Add members to a group |
| `zalo_remove_group_members` | Remove members from a group (admin) |
| `zalo_send_friend_request` | Send a friend request |
| `zalo_accept_friend_request` | Accept a pending friend request |
| `zalo_remove_friend` | Unfriend a user |
| `zalo_set_friend_alias` | Set or clear a friend's alias |
| `zalo_mute` | Mute/unmute a conversation |
| `zalo_pin` | Pin/unpin a conversation |
| `zalo_archive` | Archive/unarchive a conversation |
| `zalo_get_labels` | List your conversation labels |

> [!CAUTION]
> The group/friend tools **mutate real contacts and groups** and some are
> irreversible (unfriend, remove member). They were verified as wired and
> type-safe; only the reversible alias tool was executed against a live account
> during testing. Use them deliberately.

### Background message capture (daemon)

`zalo_listen` only sees messages during its call window. For durable "what did I
receive recently?", run the **daemon**, which owns the listener and appends every
incoming message to `.zalo/messages.jsonl` (surviving restarts):

```bash
make daemon        # start it (add ZALO_SELF_LISTEN=true to also capture your own)
make daemon-logs   # watch it
make daemon-stop   # stop it
```

Then `zalo_recent_messages` reads that log. Two caveats: Zalo allows only one web
listener per account, so **don't use `zalo_listen` while the daemon is running**;
and the daemon only captures messages that arrive **while it is running** — it
cannot recover history from before it started (there is no history-fetch API).

#### Start the daemon at login (macOS)

So capture survives reboots, install a LaunchAgent:

```bash
make autostart-install     # LaunchAgent that starts the daemon at login
make autostart-uninstall   # remove it
```

The agent waits for Docker, then starts the proxy + daemon. The session
passphrase is read from the **macOS Keychain** (never stored in the plist), from
service `zalo-personal-mcp-session-key`:

```bash
security add-generic-password -U -a "$USER" -s zalo-personal-mcp-session-key -w 'YOUR_PASSPHRASE'
```

**Also enable Docker Desktop → Settings → General → "Start Docker Desktop when you
sign in"** — otherwise the agent waits (up to ~5 min) until Docker is up.
`restart: unless-stopped` alone is **not** enough to survive a reboot, because it
only acts while the Docker daemon is already running. Agent logs: `.zalo/autostart.log`.

> [!IMPORTANT]
> **Reading messages: use the daemon, not `zalo_get_messages`.** History fetch is
> unreliable on Zalo Web: 1-1 DM history is never fetchable, and the group-history
> endpoint (`getGroupChatHistory`) currently returns **404** (deprecated
> server-side) — `zalo_get_messages` will tell you so. The reliable way to read
> incoming messages is the **realtime listener**:
> - **`make daemon`** runs a background listener that logs every incoming message
>   to `.zalo/messages.jsonl`; query it with **`zalo_recent_messages`** (e.g. last
>   N minutes). This is the only way to answer "what did I receive?" after the fact
>   — it must already be running when the messages arrive.
> - **`zalo_listen`** opens a one-off live window (no daemon needed).
>
> The listener runs inside the sandbox by tunnelling its WebSocket through the
> Squid proxy (`ws` uses an `http.Agent`, so we pass it an `HttpsProxyAgent`).

## Setup

Runs on Node.js ≥ 22; the Docker image uses **Node 24** (current Active LTS) by
default. To build against a private registry/mirror, set `NODE_IMAGE`:

```bash
NODE_IMAGE=reg.mini.dev/node:24.18.0 docker compose build
```

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
npm test             # offline regression tests (image parser, log filters)
npm run audit:deps   # npm audit (runtime deps)
```

`npm test` covers the pure logic that can run without a live account (the image
header parser and message-log filtering). Tool/network behaviour is verified
live against a real Zalo account.

After changing server code, rebuild and reconnect:

```bash
make rebuild         # rebuilds the image (+ recreates the daemon if running)
```

A **new** Claude Code session picks up the new image automatically. To update a
**running** session (e.g. to see new/changed tools), reconnect the server —
`/mcp` → select `zalo` → reconnect — since MCP clients read the tool list once at
connect time.

## License

[MIT](LICENSE)
