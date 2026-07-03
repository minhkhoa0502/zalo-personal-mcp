# Supply-Chain Security Audit: zca-js v2.1.2

**Package:** `zca-js` (unofficial Zalo Web protocol library)
**Repo:** https://github.com/RFS-ADRENO/zca-js
**Audit date:** 2026-07-04

## Summary / Verdict

**SAFE-WITH-CAVEATS.**

Across the full published tarball (`dist/`) and the git source (`src/`), the audit
found **no credential exfiltration, no dynamic code execution, no obfuscation, no
environment/secret harvesting, and no non-Zalo network egress** other than a
benign npm-registry version check. All session material (cookies, `imei`,
`zpw_enk` secret key) is transmitted only to Zalo-owned hosts, and cookie scoping
is enforced by `tough-cookie` against the request origin. The published tarball is
a faithful, un-minified TypeScript compilation of the audited git source.

The caveats are inherent-design trust risks, not evidence of malice: it is an
unofficial reverse-engineered client that by design holds a full Zalo session;
all request/WS base URLs come from Zalo's login response at runtime; there is a
runtime `checkUpdate` call to `registry.npmjs.org` (no credentials sent, gated by
option); and a `custom()` API lets the *consumer* register their own callbacks.
**Safe to vendor at v2.1.2 with the mitigations below.**

## Version & Commit Audited

- npm `zca-js@2.1.2`; tarball shasum `c2fd45b21f5895505dfde5137bef6d0796c3b675`, 547 files, 909.4 kB unpacked.
- Git tag `v2.1.2` = commit **`e6d6074feffb941db2c1e45fe0dc2f946952a0e3`**.

## Registry-vs-Source Drift

**No meaningful drift.** `package.json` tarball-vs-git is identical modulo CRLF
line endings (`diff -w` = 0). Git ignores `dist/` (`.gitignore:92`); the tarball
ships compiled `dist/` and excludes `src/test/examples/scripts` (`.npmignore`) —
normal publish layout. 182 `src/*.ts` map 1:1 to 182 `dist/*.js`. The exhaustive
set of `http(s)://` literals is **identical** between src and dist. Line-by-line
spot check of `dist/update.js`, `dist/apis/login.js`, `dist/utils.js` shows the
same URLs, same cookie/secretKey logic, and even the same comments as the TS —
plain `tsc` output, not minified or injected. (A byte-identical rebuild was not
run because `prebuild` needs `bun`, unavailable in the audit env; semantic + URL +
comment equivalence is strong counter-evidence to injection.)

## Dependency Tree

**8 direct runtime deps; 31 transitive total; `npm audit` = 0 vulnerabilities.**

Direct: `crypto-js`, `form-data`, `json-bigint`, `pako`, `semver`, `spark-md5`,
`tough-cookie`, `ws` — all standard/expected for an HTTP+WS client. The
transitive set is the well-known `form-data`/`es-*`/`get-intrinsic` cluster plus
`tldts` (backs tough-cookie) and `bignumber.js`. Nothing unusual, unmaintained,
or suspicious. `ws`'s native optional deps (`bufferutil`, `utf-8-validate`) are
UNMET OPTIONAL (not installed).

## Install Scripts

**No install-time execution risk.** zca-js has no `preinstall`/`install`/
`postinstall`; its only `prepare: husky` no-ops when installed as a dependency.
Across all 31 deps, the only lifecycle scripts are Jordan-Harband's
`prepublish: "not-in-publish || npm run prepublishOnly"` guards, which **do not
run on `npm install`**. No dependency has `preinstall`/`install`/`postinstall`.

## Network Egress Hosts (full list)

Primitives: only `global.fetch` (via overridable `polyfill`, default
`global.fetch` — `context.ts:205`) and `ws` WebSocket (`apis/listen.ts:176`). No
axios/http/net/tls/dns sockets/sendBeacon.

Hardcoded hosts (identical in src & dist), all Zalo:

- `wpa.chat.zalo.me`
- `chat.zalo.me`
- `id.zalo.me`
- `catalog.zalo.me`
- `developers.zalo.me`
- `jr.chat.zalo.me`
- `zalo.me`

Dynamic hosts are all from Zalo's login response: `${zpwServiceMap.<svc>[0]}`
(= `loginInfo.zpw_service_map_v3`) for API calls, `zpw_ws` for the WebSocket, and
`https://${domain}` from Zalo `set-cookie` domains.

**Only non-Zalo host: `registry.npmjs.org`** (`update.ts:6`) — gated by
`checkUpdate`, fetches only `dist-tags.latest`, does **not** go through
`request()`/`getDefaultHeaders()`, so **no cookies/session are attached**. No
pastebins, IPs, shorteners, analytics, or telemetry anywhere.

## Dynamic Execution Findings

**None.** Zero hits in src and dist for `eval`, `new Function(`,
`child_process`, `exec`/`spawn`, `vm.`, dynamic `require()`/`import()`. The
`custom()` API runs a **consumer-supplied** callback, not remote code.

## Filesystem / Env Findings

**No secret harvesting; zero `process.env` in source.** No reads of `~/.ssh`,
`.env`, `.npmrc`, `.aws`, keychains, or browser profiles. `fs` reads only
caller-supplied upload paths (`changeGroupAvatar.ts:34`,
`changeAccountAvatar.ts:42`, uploadAttachment/uploadProductPhoto/sendMessage).
The only `fs` write is the login QR PNG to a caller-provided `qrPath` (default
`qr.png`) at `apis/loginQR.ts:204`.

## Obfuscation Findings

**None.** No base64 blobs ≥100 chars, no hex literals ≥40 chars in src. The only
fixed hex constants are a zero AES IV and the Zalo `zcid` AES key
(`utils.ts:97,233,252`) — protocol constants. `dist/` is readable `tsc` output,
not minified.

## Credential Handling

Session = cookies (`zpsid`/`zpw_sek`), `imei`, `uid`, secret key `zpw_enk`
(`ctx.secretKey`, set at `zalo.ts:103`). Cookies live in a `tough-cookie` jar;
the `Cookie` header is built via `getCookieString(origin)` where `origin` = the
request URL's own origin (`utils.ts:271,280`), so cookies only go to the host
being contacted — always Zalo. The WebSocket cookie is scoped to `chat.zalo.me`
with a hardcoded `Origin` (`listen.ts:105,183`). `ctx.secretKey` is used **only**
in local `encodeAES`/`decodeAES` (`utils.ts:645,705`) — never placed in any
URL/header/body. Conclusion: session material only ever reaches Zalo hosts.

## Residual Risks + Mitigations

Risks:

1. Unofficial full-session client — trusts maintainers for future versions.
2. Endpoints resolved from Zalo's runtime login response.
3. `checkUpdate` egress to npm registry.
4. `polyfill` / `custom()` are integrator-controlled code surfaces.

Mitigations (adopted by this project):

- **Pin `zca-js@2.1.2` + lockfile integrity hash; re-audit on every bump.**
- **Vendor the audited tarball** rather than pulling live (optional; see ADR follow-up).
- **Set `checkUpdate: false`** to eliminate the only non-Zalo egress.
- **Run under an egress allow-list** of `*.zalo.me` + Zalo service/CDN hosts.
- **Do not pass untrusted `polyfill`/`agent`/`custom()` callbacks.**
- **Store the session encrypted at rest.**

**Bottom line: safe to vendor at v2.1.2 with the pinning/egress mitigations above.**
