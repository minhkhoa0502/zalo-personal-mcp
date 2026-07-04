/**
 * Append-only JSONL log of captured Zalo messages, written by the daemon
 * (src/daemon.ts) and read by the zalo_recent_messages tool. Lives on the
 * mounted volume so it survives container restarts.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { ThreadType } from "./zalo-client.js";

const MAX_BYTES = 5 * 1024 * 1024; // trim when the log grows past ~5 MB
const KEEP_LINES = 5000; // …down to the most recent N lines

export interface LoggedMessage {
  /** ms epoch when we captured it (fallback ordering key). */
  loggedAt: number;
  source: "live" | "backlog";
  threadType: "user" | "group";
  threadId?: string;
  isSelf: boolean;
  fromId?: string;
  fromName?: string;
  /** Zalo message timestamp (ms as string), when present. */
  ts?: string;
  msgId?: string;
  content: unknown;
}

/** Convert a zca-js listener Message into our compact log record. */
export function shapeMessage(
  msg: any,
  source: "live" | "backlog",
  loggedAt: number,
): LoggedMessage {
  const d = msg?.data ?? {};
  return {
    loggedAt,
    source,
    threadType: msg?.type === ThreadType.Group ? "group" : "user",
    threadId: msg?.threadId,
    isSelf: !!msg?.isSelf,
    fromId: d.uidFrom,
    fromName: d.dName,
    ts: d.ts,
    msgId: d.msgId,
    content: d.content,
  };
}

export function appendMessage(rec: LoggedMessage): void {
  mkdirSync(dirname(config.messageLogPath), { recursive: true });
  appendFileSync(config.messageLogPath, JSON.stringify(rec) + "\n");
  trimIfLarge();
}

function trimIfLarge(): void {
  try {
    if (statSync(config.messageLogPath).size <= MAX_BYTES) return;
    const lines = readFileSync(config.messageLogPath, "utf8").split("\n").filter(Boolean);
    writeFileSync(config.messageLogPath, lines.slice(-KEEP_LINES).join("\n") + "\n");
  } catch {
    /* best-effort */
  }
}

export function readRecent(opts: {
  sinceMs?: number;
  limit?: number;
  threadId?: string;
}): LoggedMessage[] {
  if (!existsSync(config.messageLogPath)) return [];
  let recs = readFileSync(config.messageLogPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as LoggedMessage;
      } catch {
        return null;
      }
    })
    .filter((r): r is LoggedMessage => r != null);

  if (opts.threadId) recs = recs.filter((r) => r.threadId === opts.threadId);
  if (opts.sinceMs != null) {
    recs = recs.filter((r) => (Number(r.ts) || r.loggedAt) >= opts.sinceMs!);
  }
  if (opts.limit != null) recs = recs.slice(-opts.limit);
  return recs;
}

export function logExists(): boolean {
  return existsSync(config.messageLogPath);
}
