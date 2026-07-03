# Security model

This project automates a **personal Zalo account** via the unofficial
[`zca-js`](https://github.com/RFS-ADRENO/zca-js) protocol library. That library
handles the most sensitive data you have here: your **Zalo session** (cookies,
IMEI, secret key) and **all message content**. Our security model exists to make
depending on it safe.

See [ADR-0001](docs/adr/0001-architecture-and-dependency-strategy.md) for the
full rationale. This document is the operational summary.

## Threat model

- **Primary threat:** a malicious or compromised version of `zca-js` (or one of
  its transitive dependencies) **exfiltrating** the Zalo session or messages to
  an attacker-controlled destination, or running malicious code on the host.
- **Not in scope:** Zalo-side account bans (inherent to personal-account
  automation), or compromise of the host OS itself.

## Controls

### 1. Audit (baseline)
Before first use and on every upgrade, `zca-js` is audited for: install scripts,
network egress destinations, dynamic code execution (`eval`, `Function`,
`child_process`), filesystem/env access beyond its needs, obfuscation, and
registry-vs-source drift. Reports live in [`docs/audit/`](docs/audit/).

### 2. Pin & vendor (control what runs)
- Exact version pin + `package-lock.json` integrity hashes. **No `^`/`~`
  ranges.** A changed published tarball fails install rather than updating
  silently.
- Optionally vendor the audited source/dist into the repo so what runs is
  byte-for-byte what was audited.

### 3. Deliberate upgrades (catch injection)
Upgrades are reviewed PRs. Diff the new version against the audited one before
bumping — patches are incremental, so this is a few minutes and is the step that
catches a poisoned release.

### 4. Runtime containment (the real backstop)
- **Egress allowlist** — the server may reach **only Zalo domains**
  (`*.zalo.me`, `*.zadn.vn`, `*.zaloapp.com`, and Zalo CDN hosts). Enforced by
  running in a container behind a firewall/proxy that blocks everything else.
  With this in place, a compromised dependency has **nowhere to send data**.
- **Least privilege** — the process is given only its Zalo session store and
  nothing else: no unrelated env vars, no secrets, no broad filesystem access.

> **Principle: containment beats detection.** We assume we may miss a malicious
> change in review, and rely on the egress lock so it cannot cause harm anyway.

## Handling your session

- Store the Zalo session outside the repo; never commit it. `.gitignore`
  excludes common session/secret file patterns.
- Prefer a disposable/secondary Zalo account for automation.

## Reporting a vulnerability

Open a private security advisory on this repository, or contact the maintainer
directly. Please do not open public issues for undisclosed vulnerabilities.
