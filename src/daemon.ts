/**
 * Background message-capture daemon. Owns the Zalo realtime listener for the
 * lifetime of the process and appends every incoming message to the persistent
 * log (config.messageLogPath). The zalo_recent_messages tool then answers
 * "what did I receive recently" without needing a live listen window.
 *
 * Run as a long-lived container service (docker compose up -d zalo-daemon).
 * Only one web listener may run per account, so do not run `zalo_listen` while
 * this daemon is active.
 */
import { configureEgress } from "./net.js";
import { getListenerApi } from "./zalo-client.js";
import { appendMessage, shapeMessage } from "./message-log.js";
import { config } from "./config.js";

async function main(): Promise<void> {
  configureEgress();
  const api = await getListenerApi(config.selfListen);

  const record = (msg: unknown, source: "live" | "backlog") => {
    try {
      appendMessage(shapeMessage(msg, source, Date.now()));
    } catch (err) {
      console.error("[daemon] failed to log message:", err);
    }
  };

  api.listener.on("message", (m) => record(m, "live"));
  api.listener.on("old_messages", (msgs) => (msgs ?? []).forEach((m) => record(m, "backlog")));
  api.listener.on("connected", () => console.error("[daemon] connected — capturing messages"));
  api.listener.on("closed", (code, reason) =>
    console.error("[daemon] listener closed:", code, reason),
  );
  api.listener.on("error", (e) => console.error("[daemon] listener error:", e));

  // retryOnClose keeps the daemon reconnecting if the socket drops.
  api.listener.start({ retryOnClose: true });
  console.error(
    `[daemon] started (selfListen=${config.selfListen}); logging to ${config.messageLogPath}`,
  );
}

main().catch((err) => {
  console.error("[daemon] fatal:", err);
  process.exit(1);
});
