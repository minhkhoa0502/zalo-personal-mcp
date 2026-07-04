/**
 * Thin wrapper around zca-js: builds the client with our hardened options and
 * restores a saved session. QR login itself lives in login.ts (it is
 * interactive and cannot run over the MCP stdio channel).
 */
import type { Agent } from "node:http";
import { HttpsProxyAgent } from "https-proxy-agent";
import { Zalo, ThreadType, type API } from "zca-js";
import { config } from "./config.js";
import { loadSession } from "./session.js";

export { ThreadType };
export type ZaloApi = API;

let cached: ZaloApi | null = null;

export function buildZalo(): Zalo {
  // The realtime listener uses a `ws` WebSocket, which takes an http.Agent —
  // NOT undici's dispatcher. So inside the sandbox (no direct egress) we give
  // it an HttpsProxyAgent pointed at the Squid allowlist proxy, mirroring what
  // configureEgress() does for fetch. Without this the listener can't connect.
  const agent = config.httpsProxy
    ? (new HttpsProxyAgent(config.httpsProxy) as unknown as Agent)
    : undefined;

  return new Zalo({
    // Hardened per docs/audit/zca-js-2.1.2.md:
    checkUpdate: config.checkUpdate, // false → no non-Zalo egress
    logging: config.logging, // off → keeps MCP stdio clean
    selfListen: false,
    agent,
  });
}

/**
 * Return a logged-in API, restoring from the saved session. Cached for the
 * process lifetime. Throws a clear, actionable error if there is no session.
 */
export async function getApi(): Promise<ZaloApi> {
  if (cached) return cached;

  const session = loadSession();
  if (!session) {
    throw new Error(
      "Not logged in. Run `npm run login` once to authenticate via QR code, " +
        "then restart the MCP server.",
    );
  }

  const zalo = buildZalo();
  cached = await zalo.login({
    imei: session.imei,
    cookie: session.cookie as never,
    userAgent: session.userAgent,
    language: session.language,
  });
  return cached;
}

/** Map a user-facing thread-type string to the zca-js enum. */
export function toThreadType(kind: "user" | "group"): ThreadType {
  return kind === "group" ? ThreadType.Group : ThreadType.User;
}
