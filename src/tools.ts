/**
 * MCP tool definitions. Each tool restores the saved Zalo session lazily via
 * getApi() and returns a JSON text payload.
 *
 * Note on message history: the Zalo Web protocol only exposes history for
 * *groups* (getGroupChatHistory). One-to-one DM history is delivered through
 * the realtime listener, not a fetch endpoint, so zalo_get_messages returns a
 * clear explanation for user threads instead of pretending to page history.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { getApi, getListenerApi, toThreadType } from "./zalo-client.js";
import { config } from "./config.js";
import { readRecent, shapeMessage, logExists } from "./message-log.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Directory bind-mounted into the container (holds session, log, media). */
const dataDir = dirname(config.sessionPath);

/** Resolve a user-supplied file path against the mounted data dir if relative. */
function resolveDataPath(p: string): string {
  return isAbsolute(p) ? p : resolve(dataDir, p);
}

type TextResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): TextResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): TextResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Run a handler, turning thrown errors into MCP error results. */
async function guard(fn: () => Promise<TextResult>): Promise<TextResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(`Zalo error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const threadType = z.enum(["user", "group"]).describe("Thread kind: 'user' (DM) or 'group'");

export function registerTools(server: McpServer): void {
  server.registerTool(
    "zalo_account_info",
    {
      title: "Get Zalo account info",
      description: "Return the logged-in account's own profile (id, display name, etc.).",
      inputSchema: {},
    },
    () =>
      guard(async () => {
        const api = await getApi();
        const info = await api.fetchAccountInfo();
        return ok(info?.profile ?? info);
      }),
  );

  server.registerTool(
    "zalo_list_threads",
    {
      title: "List Zalo threads",
      description:
        "List conversations the account can message: friends (DMs) and groups. " +
        "Use the returned ids as threadId for other tools.",
      inputSchema: {
        includeFriends: z.boolean().default(true).describe("Include friends/DMs"),
        includeGroups: z.boolean().default(true).describe("Include groups"),
      },
    },
    ({ includeFriends, includeGroups }) =>
      guard(async () => {
        const api = await getApi();
        const result: { friends?: unknown[]; groups?: unknown[] } = {};

        if (includeFriends) {
          const friends = await api.getAllFriends();
          result.friends = (friends ?? []).map((f) => ({
            id: f.userId,
            name: f.displayName || f.zaloName || f.username,
            username: f.username,
          }));
        }

        if (includeGroups) {
          const groups = await api.getAllGroups();
          const ids = Object.keys(groups?.gridVerMap ?? {});
          // Zalo rejects getGroupInfo with more than 100 ids at once, so chunk.
          const names: Record<string, { name?: string }> = {};
          const BATCH = 50;
          for (let i = 0; i < ids.length; i += BATCH) {
            const info = await api.getGroupInfo(ids.slice(i, i + BATCH));
            Object.assign(names, info?.gridInfoMap ?? {});
          }
          result.groups = ids.map((id) => ({ id, name: names[id]?.name ?? "(unknown)" }));
        }

        return ok(result);
      }),
  );

  server.registerTool(
    "zalo_get_messages",
    {
      title: "Get Zalo group message history",
      description:
        "Fetch recent messages from a GROUP thread. Note: the Zalo Web API only " +
        "exposes history for groups; 1-1 DM history is not fetchable (it arrives " +
        "via the realtime listener), so 'user' threads return an explanation.",
      inputSchema: {
        threadId: z.string().describe("Group id (from zalo_list_threads)"),
        threadType: threadType.default("group"),
        count: z.number().int().min(1).max(100).default(20).describe("How many messages"),
      },
    },
    ({ threadId, threadType: kind, count }) =>
      guard(async () => {
        if (kind === "user") {
          return fail(
            "The Zalo Web API does not expose fetchable history for 1-1 DMs. " +
              "DM messages are only available live through the realtime listener. " +
              "Group history is supported: call this tool with threadType='group'.",
          );
        }
        const api = await getApi();
        const history = await api.getGroupChatHistory(threadId, count);
        return ok(history);
      }),
  );

  server.registerTool(
    "zalo_send_message",
    {
      title: "Send a Zalo message",
      description: "Send a plain-text message to a user (DM) or a group.",
      inputSchema: {
        threadId: z.string().describe("Recipient id (user id or group id)"),
        threadType: threadType,
        message: z.string().min(1).describe("Message text to send"),
      },
    },
    ({ threadId, threadType: kind, message }) =>
      guard(async () => {
        const api = await getApi();
        const res = await api.sendMessage(message, threadId, toThreadType(kind));
        return ok(res);
      }),
  );

  server.registerTool(
    "zalo_mark_read",
    {
      title: "Mark a Zalo thread as read",
      description: "Clear the unread marker on a user or group thread.",
      inputSchema: {
        threadId: z.string().describe("Thread id to mark read"),
        threadType: threadType,
      },
    },
    ({ threadId, threadType: kind }) =>
      guard(async () => {
        const api = await getApi();
        const res = await api.removeUnreadMark(threadId, toThreadType(kind));
        return ok(res);
      }),
  );

  server.registerTool(
    "zalo_listen",
    {
      title: "Listen for incoming Zalo messages",
      description:
        "Open the realtime listener for a fixed window and return the messages seen. " +
        "This is the ONLY way to read incoming DMs (Zalo has no DM history fetch). " +
        "On connect Zalo also pushes a backlog of recent messages received while " +
        "offline (marked source='backlog'); messages arriving during the window are " +
        "source='live'. Returns after `seconds` elapse.",
      inputSchema: {
        seconds: z
          .number()
          .int()
          .min(3)
          .max(120)
          .default(20)
          .describe("How long to listen before returning"),
        includeSelf: z
          .boolean()
          .default(false)
          .describe("Include messages you sent yourself"),
      },
    },
    ({ seconds, includeSelf }) =>
      guard(async () => {
        // A dedicated listener api whose selfListen matches includeSelf — with
        // selfListen off, zca-js never emits your own messages at all.
        const api = await getListenerApi(includeSelf);
        const collected: ReturnType<typeof shapeMessage>[] = [];
        let connected = false;
        let errored: string | null = null;

        const onMessage = (m: any) => collected.push(shapeMessage(m, "live", Date.now()));
        const onOld = (msgs: any[]) =>
          (msgs ?? []).forEach((m) => collected.push(shapeMessage(m, "backlog", Date.now())));

        api.listener.on("message", onMessage);
        api.listener.on("old_messages", onOld);
        api.listener.on("connected", () => {
          connected = true;
        });
        api.listener.on("error", (e: unknown) => {
          errored = e instanceof Error ? e.message : String(e);
        });

        try {
          api.listener.start();
          await sleep(seconds * 1000);
        } finally {
          try {
            api.listener.stop();
          } catch {
            /* ignore */
          }
        }

        const messages = collected.filter((m) => includeSelf || !m.isSelf);
        return ok({
          connected,
          error: errored,
          windowSeconds: seconds,
          count: messages.length,
          messages,
        });
      }),
  );

  server.registerTool(
    "zalo_recent_messages",
    {
      title: "Get recently received Zalo messages",
      description:
        "Read messages captured by the background daemon — the reliable way to " +
        "answer 'what did I receive recently?'. Requires the daemon running " +
        "(`make daemon`); it owns the listener and logs every message. If the " +
        "daemon isn't running, this returns whatever was logged previously — use " +
        "zalo_listen for an ad-hoc live window instead.",
      inputSchema: {
        sinceMinutes: z
          .number()
          .min(1)
          .max(1440)
          .default(5)
          .describe("Only messages from the last N minutes"),
        limit: z.number().int().min(1).max(500).default(50).describe("Max messages to return"),
        threadId: z.string().optional().describe("Filter to one thread id"),
      },
    },
    ({ sinceMinutes, limit, threadId }) =>
      guard(async () => {
        const sinceMs = Date.now() - sinceMinutes * 60 * 1000;
        const messages = readRecent({ sinceMs, limit, threadId });
        return ok({
          daemonRunning: logExists(),
          logPath: config.messageLogPath,
          sinceMinutes,
          count: messages.length,
          messages,
        });
      }),
  );

  server.registerTool(
    "zalo_send_media",
    {
      title: "Send a Zalo image/file/voice",
      description:
        "Send a local file as an attachment (image, document, etc.) to a user or " +
        "group. The file must be reachable inside the sandbox: place it in the " +
        "mounted data dir (./.zalo) and pass a relative name, or an absolute " +
        "container path. Relative paths resolve against the data dir.",
      inputSchema: {
        threadId: z.string().describe("Recipient id (user id or group id)"),
        threadType: threadType,
        filePath: z.string().describe("File to send (relative to ./.zalo, or absolute)"),
        caption: z.string().optional().describe("Optional caption/text"),
      },
    },
    ({ threadId, threadType: kind, filePath, caption }) =>
      guard(async () => {
        const api = await getApi();
        const abs = resolveDataPath(filePath);
        const ext = extname(abs).toLowerCase().slice(1);
        const isImage = ["jpg", "jpeg", "png", "webp", "gif"].includes(ext);

        const send = () =>
          api.sendMessage({ msg: caption ?? "", attachments: [abs] }, threadId, toThreadType(kind));

        // Images resolve without a listener. For files/videos, zca-js waits for
        // a WebSocket upload-confirmation event, so we bring a transient
        // listener up on this same context for the duration of the send.
        if (isImage) {
          return ok({ sent: abs, isImage, result: await send() });
        }

        await new Promise<void>((res, rej) => {
          let done = false;
          const timer = setTimeout(() => {
            if (!done) {
              done = true;
              rej(new Error("listener did not connect within 15s"));
            }
          }, 15000);
          api.listener.on("connected", () => {
            if (!done) {
              done = true;
              clearTimeout(timer);
              res();
            }
          });
          api.listener.on("error", () => {
            if (!done) {
              done = true;
              clearTimeout(timer);
              rej(new Error("listener error while connecting"));
            }
          });
          api.listener.start();
        });
        try {
          return ok({ sent: abs, isImage, result: await send() });
        } finally {
          try {
            api.listener.stop();
          } catch {
            /* ignore */
          }
        }
      }),
  );

  server.registerTool(
    "zalo_download_attachment",
    {
      title: "Download a received Zalo attachment",
      description:
        "Download an attachment by URL (the `href` from a message's content, e.g. " +
        "from zalo_recent_messages) into ./.zalo/inbox and return the saved path. " +
        "The session cookie is attached so protected Zalo CDN URLs work.",
      inputSchema: {
        url: z.string().url().describe("Attachment URL (href) from a message"),
        filename: z.string().optional().describe("Save as this name (else derived from URL)"),
      },
    },
    ({ url, filename }) =>
      guard(async () => {
        const api = await getApi();
        let cookie = "";
        try {
          cookie = String(await api.getCookie());
        } catch {
          /* proceed without cookie */
        }
        const res = await fetch(url, {
          headers: cookie ? { cookie } : {},
        });
        if (!res.ok) return fail(`Download failed: HTTP ${res.status} ${res.statusText}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const inbox = join(dataDir, "inbox");
        mkdirSync(inbox, { recursive: true });
        const name = filename || basename(new URL(url).pathname) || "attachment";
        const dest = join(inbox, name);
        writeFileSync(dest, buf);
        return ok({ savedTo: dest, bytes: buf.length });
      }),
  );
}
