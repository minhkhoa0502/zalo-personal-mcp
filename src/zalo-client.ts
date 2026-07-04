/**
 * Thin wrapper around zca-js: builds the client with our hardened options and
 * restores a saved session. QR login itself lives in login.ts (it is
 * interactive and cannot run over the MCP stdio channel).
 */
import type { Agent } from "node:http";
import { HttpsProxyAgent } from "https-proxy-agent";
import { Zalo, ThreadType, Reactions, type API } from "zca-js";
import { config } from "./config.js";
import { loadSession } from "./session.js";
import { imageMetadataGetter } from "./image-meta.js";

export { ThreadType, Reactions };
export type ZaloApi = API;

let cached: ZaloApi | null = null;

export function buildZalo(opts?: { selfListen?: boolean }): Zalo {
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
    // selfListen must be true for the listener to emit YOUR OWN messages;
    // zca-js drops them before emitting when this is false.
    selfListen: opts?.selfListen ?? false,
    agent,
    // Needed to send images; zca-js has no built-in (its docs use `sharp`).
    imageMetadataGetter,
  });
}

async function loginFromSession(opts?: { selfListen?: boolean }): Promise<ZaloApi> {
  const session = loadSession();
  if (!session) {
    throw new Error(
      "Not logged in. Run `npm run login` once to authenticate via QR code, " +
        "then restart the MCP server.",
    );
  }
  const zalo = buildZalo(opts);
  return zalo.login({
    imei: session.imei,
    cookie: session.cookie as never,
    userAgent: session.userAgent,
    language: session.language,
  });
}

/**
 * Return a logged-in API for request/response tools, restoring from the saved
 * session. Cached for the process lifetime (selfListen off).
 */
export async function getApi(): Promise<ZaloApi> {
  if (cached) return cached;
  cached = await loginFromSession();
  return cached;
}

/**
 * A fresh (uncached) logged-in API dedicated to the listener, so its
 * `selfListen` can differ from the request api without affecting it.
 */
export async function getListenerApi(selfListen: boolean): Promise<ZaloApi> {
  return loginFromSession({ selfListen });
}

/** Map a user-facing thread-type string to the zca-js enum. */
export function toThreadType(kind: "user" | "group"): ThreadType {
  return kind === "group" ? ThreadType.Group : ThreadType.User;
}
