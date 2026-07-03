/**
 * Egress routing. When a forward proxy is configured (the sandbox sets
 * HTTPS_PROXY to the Squid allowlist proxy), route Node's global fetch — which
 * is what zca-js uses — through it via undici's ProxyAgent.
 *
 * This is the FUNCTIONALITY half of the sandbox. The SECURITY half is the
 * container network dropping all direct egress; see docker-compose.yml and
 * sandbox/squid.conf. A malicious dependency that ignores this dispatcher and
 * opens a raw socket still has no route off the internal network.
 */
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { config } from "./config.js";

export function configureEgress(): void {
  if (!config.httpsProxy) return;
  setGlobalDispatcher(new ProxyAgent(config.httpsProxy));
  console.error(`[zalo-personal-mcp] egress routed through proxy: ${config.httpsProxy}`);
}
