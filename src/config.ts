/**
 * Runtime configuration, read from environment variables.
 * See .env.example for documentation of each option.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

function expandHome(p: string): string {
  return p.startsWith("~") ? resolve(homedir(), p.slice(1).replace(/^\/+/, "")) : resolve(p);
}

export const config = {
  /** Path to the encrypted Zalo session file (created by `npm run login`). */
  sessionPath: expandHome(process.env.ZALO_SESSION_PATH ?? "./.zalo/session.json"),

  /**
   * Passphrase used to encrypt the session at rest. Strongly recommended.
   * If unset, a random key file is generated next to the session (chmod 600),
   * which protects against casual reading but not against someone with full
   * filesystem access. A passphrase you keep elsewhere is stronger.
   */
  // Treat empty/whitespace (e.g. an unset compose `${ZALO_SESSION_KEY:-}`) as
  // "not provided" so we fall back to keyfile encryption instead of a broken
  // empty-passphrase scrypt path.
  sessionKey: process.env.ZALO_SESSION_KEY?.trim() ? process.env.ZALO_SESSION_KEY : null,

  /**
   * zca-js options. checkUpdate is forced off: per the dependency audit it is
   * the only non-Zalo network egress, and disabling it lets the sandbox use a
   * Zalo-only allowlist. See docs/audit/zca-js-2.1.2.md.
   */
  checkUpdate: false,

  /** zca-js verbose logging. Off by default (would pollute the MCP stdio channel). */
  logging: process.env.ZALO_LOGGING === "true",

  /**
   * Forward proxy for all outbound traffic (the egress-locked sandbox sets this
   * to the Squid allowlist proxy). Read from the standard HTTPS_PROXY env var.
   * When set, undici routes global fetch through it. Security does NOT depend on
   * this being honored — the sandbox network drops any direct egress — but it is
   * what makes legitimate Zalo traffic work inside the sandbox.
   */
  httpsProxy:
    process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? null,
} as const;
