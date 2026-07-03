# Dependency audits

Supply-chain audit reports for runtime dependencies, per the strategy in
[ADR-0001](../adr/0001-architecture-and-dependency-strategy.md).

Re-run the relevant audit before every version bump and commit the updated
report alongside the upgrade PR.

## Reports

- [`zca-js-2.1.2.md`](zca-js-2.1.2.md) — **SAFE-WITH-CAVEATS** (audited 2026-07-04).
  No exfiltration, dynamic exec, obfuscation, or non-Zalo egress (except a gated,
  credential-free npm version check). Safe to vendor with pinning + `checkUpdate: false`
  + egress allowlist.
