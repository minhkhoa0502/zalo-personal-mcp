# ADR-0001: Architecture & dependency strategy

- **Status:** Accepted
- **Date:** 2026-07-04
- **Deciders:** Repository owner

## Context

We want an MCP server that lets AI clients drive a **personal Zalo account**
(send/receive messages, list threads, etc.).

Constraints and facts established during research:

- Zalo offers an official API **only for Official Accounts (OA)**, not for
  personal accounts.
- Automating a personal account requires an **unofficial** library that
  imitates the Zalo Web client (QR login, AES-encrypted request params, an
  encrypted websocket listener).
- Because this is a Terms-of-Service violation with real ban risk, **no
  reputable/large organization publishes such a library**, and none of the
  existing projects clear a "famous author or ≥1000 GitHub stars" bar. The
  category simply cannot meet that bar.

### Candidates surveyed

| Project | Type | Stars | Notes |
|---|---|---|---|
| [`zca-js`](https://github.com/RFS-ADRENO/zca-js) | Protocol library (JS/TS) | ~536 | Active (releases through 2026), MIT, de-facto standard |
| [`zalo-agent-cli`](https://github.com/PhucMPham/zalo-agent-cli) | CLI + MCP server on zca-js | ~147 | Active, MIT |
| [`openzca`](https://github.com/darkamenosa/openzca) | CLI on zca-js | ~94 | Active, MIT |
| [`zlapi`](https://github.com/Its-VrxxDev/zlapi) | Protocol library (Python) | ~89 | Stale (last push 2024) |
| [`zalo-personal`](https://github.com/caochitam/zalo-personal) | OpenClaw ext on zca-js | ~51 | Active, MIT |
| [`claude-plugin-zalo`](https://github.com/imrim12/claude-plugin-zalo) | MCP plugin | ~0 | New |

Nearly the entire ecosystem builds on **`zca-js`** as the protocol layer.

## Decision

Build **our own MCP server** (this repo, Node/TypeScript) and depend on
**`zca-js`** as the protocol layer, run under a **hardened, egress-locked
sandbox**.

Two layers, deliberately treated differently:

| Layer | Effort to own | Decision |
|---|---|---|
| **Protocol** (login, encryption, websocket) | Very high (weeks) + permanent maintenance | **Depend on `zca-js`** — vendored, pinned, audited |
| **MCP server** (tool glue) | Low (hours) | **Own it** — full control |

## Options considered and rejected

### 1. Adopt an existing MCP server (e.g. `zalo-agent-cli`)
Rejected. It sits *on top of* `zca-js`, so it **doubles the trust surface** — we
would be auditing two independent small authors and re-auditing both on every
upgrade. Since the server layer is trivial to write, adopting a second
stranger's code buys nothing.

### 2. Reimplement the protocol from scratch (no `zca-js`)
Rejected. "From scratch" means re-reverse-engineering QR login, AES-ECB param
encryption, key derivation, and the encrypted websocket — the exact hard work
`zca-js` already did. Costs:
- **Weeks** of effort, and it's **fragile**: it breaks whenever Zalo changes
  their web client.
- **Permanent maintenance burden**: with no upstream, *we* re-reverse-engineer
  on every Zalo change. This directly contradicts "don't reinvent the wheel."
- Unless truly zero-dependency (impractical), we'd still pull transitive deps
  from other small authors — trading one **audited** dependency for several
  **unaudited** ones. Usually a *worse* security posture.

### 3. Port `zca-js` to Rust for performance
Rejected. The workload is **I/O-bound**: each operation is dominated by a
~50–300 ms network round-trip to Zalo; the CPU work (AES on a few KB, JSON
parse) is microseconds — well under 0.1% of wall-clock. Rust optimizes the
0.1% and leaves the 99.9% untouched → no perceptible speedup for a single
personal account. Worse, a port is a **hard fork** that re-creates the
maintenance burden from option 2 *plus* the overhead of continually translating
upstream fixes, and risks subtle crypto transcription bugs. Worst square on the
board.

## Supply-chain trust strategy

We cannot prove any external dependency will be clean **forever** (maintainer
compromise, malicious new maintainer, tarball swap). So we **engineer so that
future cleanliness does not matter**. Two layers:

### Layer A — control exactly what code runs
- **Vendor** the audited source/dist into this repo (what runs == what we
  audited), or pin via lockfile if not vendored.
- **Pin the exact version + lockfile integrity hash** (`sha512`). No `^`/`~`
  ranges. A changed tarball fails install instead of silently updating.
- **Deliberate upgrades only**: every bump is a reviewed PR. Zalo patches are
  incremental, so the diff review is minutes — and that review is what catches
  injected payloads.

### Layer B — contain it (the real backstop)
- **Egress allowlist**: the process may reach **only Zalo domains**
  (`*.zalo.me`, `*.zadn.vn`, `*.zaloapp.com`, Zalo CDN). A compromised version
  has nowhere to exfiltrate to — even if we never notice the compromise.
- **Least privilege**: the process sees only its own Zalo session store, no
  other env vars, secrets, or broad filesystem access.

**Mindset: containment beats detection.** Audit once for a baseline, review
small diffs on upgrade, and rely on the sandbox for everything we miss.

## Consequences

**Positive**
- Fastest path to a working, maintainable server.
- The hard, fragile protocol layer is maintained by an active community; we bump
  a version when Zalo changes.
- Full ownership and minimal attack surface in the layer that orchestrates data.
- A hypothetical malicious dependency cannot exfiltrate data (egress lock).

**Negative / accepted**
- We depend on `zca-js`'s continued maintenance (mitigated: it is active; if it
  dies we can vendor-and-freeze or migrate).
- Recurring (small) cost: audit the diff on each upgrade.
- Inherent ToS/ban risk of personal-account automation — out of scope to fix.

## Follow-ups

- [x] Complete the initial `zca-js` audit → [`docs/audit/zca-js-2.1.2.md`](../audit/zca-js-2.1.2.md)
      (2026-07-04, **SAFE-WITH-CAVEATS**).
- [x] Pin + lockfile-hash the dependency (`package-lock.json`). Vendoring in-repo
      remains optional; pinned-npm chosen first.
- [x] Wire zca-js with `checkUpdate: false` (removes the only non-Zalo egress) and
      never pass untrusted `polyfill`/`agent`/`custom()` callbacks. (`src/config.ts`,
      `src/zalo-client.ts`)
- [x] Store the Zalo session encrypted at rest (AES-256-GCM, `src/session.ts`).
- [x] Implement the minimal MCP tool surface: QR login → account_info →
      list_threads → get_messages (groups) → send_message → mark_read.
- [x] Implement the egress-locked sandbox (container + Squid allowlist proxy) —
      allowlist `.zalo.me`, `.zadn.vn`, `.zaloapp.com`, `.zdn.vn`. See `sandbox/`,
      `docker-compose.yml`, `Dockerfile`, and `sandbox/verify.sh`.
- [x] Live DM listener support (`zalo_listen`) — WebSocket tunnelled through the
      Squid proxy via `HttpsProxyAgent` so it runs inside the sandbox. This is the
      only way to read incoming DMs (no DM history fetch endpoint exists).
