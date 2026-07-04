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
import { MuteAction } from "zca-js";
import { getApi, getListenerApi, toThreadType, Reactions } from "./zalo-client.js";
import { config } from "./config.js";
import { readRecent, shapeMessage, logExists } from "./message-log.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const reactionNames = Object.keys(Reactions) as (keyof typeof Reactions)[];

/** Quoted-message shape accepted by zalo_send_message (from a message's `quote`). */
const quoteSchema = z
  .object({
    content: z.any(),
    msgType: z.string(),
    propertyExt: z.any().optional(),
    uidFrom: z.string(),
    msgId: z.string(),
    cliMsgId: z.string(),
    ts: z.union([z.string(), z.number()]),
    ttl: z.number().optional(),
  })
  .passthrough();

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
      title: "Get Zalo group message history (often unavailable)",
      description:
        "Try to fetch a GROUP's message history. IMPORTANT: Zalo's group-history " +
        "endpoint frequently returns 404 (deprecated server-side), and 1-1 DM " +
        "history is never fetchable. To read messages reliably, run the daemon " +
        "(`make daemon`) and use zalo_recent_messages, or zalo_listen for a live " +
        "window. Only try this for groups.",
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
            "1-1 DM history is not fetchable via the Zalo Web API. Read DMs by " +
              "running the daemon (make daemon) + zalo_recent_messages, or use " +
              "zalo_listen for a live window.",
          );
        }
        const api = await getApi();
        try {
          return ok(await api.getGroupChatHistory(threadId, count));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/404/.test(msg)) {
            return fail(
              "Group history unavailable: Zalo returned 404 for this endpoint " +
                "(it appears deprecated server-side; this affects all groups, not " +
                "just this one). To read incoming messages instead, run the daemon " +
                "(`make daemon`) and use zalo_recent_messages, or zalo_listen for a " +
                "live window.",
            );
          }
          throw err;
        }
      }),
  );

  server.registerTool(
    "zalo_send_message",
    {
      title: "Send a Zalo message",
      description:
        "Send a plain-text message to a user (DM) or a group. To reply/quote a " +
        "message, pass its `quote` object (from zalo_recent_messages / zalo_listen).",
      inputSchema: {
        threadId: z.string().describe("Recipient id (user id or group id)"),
        threadType: threadType,
        message: z.string().min(1).describe("Message text to send"),
        quote: quoteSchema.optional().describe("Message to reply to (its `quote` object)"),
      },
    },
    ({ threadId, threadType: kind, message, quote }) =>
      guard(async () => {
        const api = await getApi();
        const content = quote ? { msg: message, quote: quote as never } : message;
        const res = await api.sendMessage(content, threadId, toThreadType(kind));
        return ok(res);
      }),
  );

  server.registerTool(
    "zalo_react",
    {
      title: "React to a Zalo message",
      description:
        "Add an emoji reaction to a message. Needs the message's msgId and " +
        "cliMsgId (both in zalo_recent_messages / zalo_listen output).",
      inputSchema: {
        threadId: z.string().describe("Thread the message is in"),
        threadType: threadType,
        msgId: z.string().describe("Target message msgId"),
        cliMsgId: z.string().describe("Target message cliMsgId"),
        reaction: z
          .enum(reactionNames as [string, ...string[]])
          .describe("Reaction name, e.g. HEART, LIKE, HAHA, WOW, CRY, ANGRY"),
      },
    },
    ({ threadId, threadType: kind, msgId, cliMsgId, reaction }) =>
      guard(async () => {
        const api = await getApi();
        const icon = Reactions[reaction as keyof typeof Reactions];
        const res = await api.addReaction(icon, {
          threadId,
          type: toThreadType(kind),
          data: { msgId, cliMsgId },
        });
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

  server.registerTool(
    "zalo_get_user_info",
    {
      title: "Get Zalo user profile(s)",
      description: "Look up profile info for one or more user ids.",
      inputSchema: {
        userId: z.string().describe("User id, or comma-separated ids"),
      },
    },
    ({ userId }) =>
      guard(async () => {
        const api = await getApi();
        const ids = userId.includes(",") ? userId.split(",").map((s) => s.trim()) : userId;
        return ok(await api.getUserInfo(ids));
      }),
  );

  server.registerTool(
    "zalo_find_user",
    {
      title: "Find a Zalo user by phone number",
      description:
        "Look up a user by phone number (e.g. 84... or 0...). Returns their public " +
        "profile if found. Only works for numbers discoverable on Zalo.",
      inputSchema: {
        phone: z.string().describe("Phone number to look up"),
      },
    },
    ({ phone }) =>
      guard(async () => {
        const api = await getApi();
        return ok(await api.findUser(phone));
      }),
  );

  server.registerTool(
    "zalo_group_members",
    {
      title: "List a Zalo group's members",
      description:
        "Return member profiles for a group. Fetches the member list from the " +
        "group info, then their profiles (chunked).",
      inputSchema: {
        groupId: z.string().describe("Group id (from zalo_list_threads)"),
        limit: z.number().int().min(1).max(500).default(200).describe("Max members to resolve"),
      },
    },
    ({ groupId, limit }) =>
      guard(async () => {
        const api = await getApi();
        const info = await api.getGroupInfo(groupId);
        const g = (info?.gridInfoMap ?? {})[groupId] as
          | { name?: string; memVerList?: string[] }
          | undefined;
        const allIds = (g?.memVerList ?? []).map((x) => String(x).split("_")[0]);
        const ids = allIds.slice(0, limit);
        const profiles: Record<string, unknown> = {};
        for (let i = 0; i < ids.length; i += 50) {
          const r = await api.getGroupMembersInfo(ids.slice(i, i + 50));
          Object.assign(profiles, r?.profiles ?? {});
        }
        return ok({
          groupId,
          name: g?.name,
          totalMembers: allIds.length,
          resolved: Object.keys(profiles).length,
          members: profiles,
        });
      }),
  );

  server.registerTool(
    "zalo_send_link",
    {
      title: "Send a Zalo link (with preview)",
      description: "Send a URL to a user or group; Zalo renders a link preview.",
      inputSchema: {
        threadId: z.string().describe("Recipient id"),
        threadType: threadType,
        link: z.string().url().describe("URL to send"),
        message: z.string().optional().describe("Optional text with the link"),
      },
    },
    ({ threadId, threadType: kind, link, message }) =>
      guard(async () => {
        const api = await getApi();
        return ok(await api.sendLink({ link, msg: message }, threadId, toThreadType(kind)));
      }),
  );

  server.registerTool(
    "zalo_send_sticker",
    {
      title: "Send a Zalo sticker",
      description:
        "Search stickers by keyword and send the best match to a user or group.",
      inputSchema: {
        threadId: z.string().describe("Recipient id"),
        threadType: threadType,
        keyword: z.string().describe("Sticker search keyword (e.g. 'hi', 'love')"),
      },
    },
    ({ threadId, threadType: kind, keyword }) =>
      guard(async () => {
        const api = await getApi();
        const results = await api.searchSticker(keyword);
        if (!results || results.length === 0) return fail(`No stickers found for "${keyword}"`);
        const s = results[0] as { type: number; cate_id: number; sticker_id: number };
        const res = await api.sendSticker(
          { id: s.sticker_id, cateId: s.cate_id, type: s.type },
          threadId,
          toThreadType(kind),
        );
        return ok({ keyword, sent: { id: s.sticker_id, cateId: s.cate_id }, result: res });
      }),
  );

  server.registerTool(
    "zalo_send_bank_card",
    {
      title: "Send a Zalo bank card",
      description:
        "Send a bank-transfer card (shows account details / VietQR). binBank is the " +
        "6-digit bank BIN (e.g. Vietcombank 970436, Techcombank 970407, MB 970422).",
      inputSchema: {
        threadId: z.string().describe("Recipient id"),
        threadType: threadType,
        binBank: z.number().int().describe("Bank BIN, e.g. 970436 for Vietcombank"),
        accountNumber: z.string().describe("Bank account number"),
        accountName: z.string().optional().describe("Account holder name"),
      },
    },
    ({ threadId, threadType: kind, binBank, accountNumber, accountName }) =>
      guard(async () => {
        const api = await getApi();
        const res = await api.sendBankCard(
          { binBank: binBank as never, numAccBank: accountNumber, nameAccBank: accountName },
          threadId,
          toThreadType(kind),
        );
        return ok({ result: res });
      }),
  );

  // --- Group management (mutating) ------------------------------------------

  server.registerTool(
    "zalo_create_group",
    {
      title: "Create a Zalo group",
      description: "Create a new group with the given members. Creates a real group.",
      inputSchema: {
        name: z.string().optional().describe("Group name"),
        memberIds: z.array(z.string()).min(1).describe("User ids to add (at least one)"),
      },
    },
    ({ name, memberIds }) =>
      guard(async () => {
        const api = await getApi();
        return ok(await api.createGroup({ name, members: memberIds }));
      }),
  );

  server.registerTool(
    "zalo_rename_group",
    {
      title: "Rename a Zalo group",
      description: "Change a group's name.",
      inputSchema: {
        groupId: z.string().describe("Group id"),
        name: z.string().min(1).describe("New group name"),
      },
    },
    ({ groupId, name }) =>
      guard(async () => {
        const api = await getApi();
        return ok(await api.changeGroupName(name, groupId));
      }),
  );

  server.registerTool(
    "zalo_add_group_members",
    {
      title: "Add members to a Zalo group",
      description: "Add one or more users to a group.",
      inputSchema: {
        groupId: z.string().describe("Group id"),
        memberIds: z.array(z.string()).min(1).describe("User ids to add"),
      },
    },
    ({ groupId, memberIds }) =>
      guard(async () => {
        const api = await getApi();
        return ok(await api.addUserToGroup(memberIds, groupId));
      }),
  );

  server.registerTool(
    "zalo_remove_group_members",
    {
      title: "Remove members from a Zalo group",
      description: "Remove one or more users from a group (requires admin rights).",
      inputSchema: {
        groupId: z.string().describe("Group id"),
        memberIds: z.array(z.string()).min(1).describe("User ids to remove"),
      },
    },
    ({ groupId, memberIds }) =>
      guard(async () => {
        const api = await getApi();
        return ok(await api.removeUserFromGroup(memberIds, groupId));
      }),
  );

  // --- Friend management (mutating) -----------------------------------------

  server.registerTool(
    "zalo_send_friend_request",
    {
      title: "Send a Zalo friend request",
      description: "Send a friend request to a user with a greeting message.",
      inputSchema: {
        userId: z.string().describe("User id to friend"),
        message: z.string().default("Hi, let's connect on Zalo.").describe("Greeting message"),
      },
    },
    ({ userId, message }) =>
      guard(async () => {
        const api = await getApi();
        return ok(await api.sendFriendRequest(message, userId));
      }),
  );

  server.registerTool(
    "zalo_accept_friend_request",
    {
      title: "Accept a Zalo friend request",
      description: "Accept a pending friend request from a user.",
      inputSchema: { userId: z.string().describe("User id whose request to accept") },
    },
    ({ userId }) =>
      guard(async () => {
        const api = await getApi();
        return ok(await api.acceptFriendRequest(userId));
      }),
  );

  server.registerTool(
    "zalo_remove_friend",
    {
      title: "Remove a Zalo friend",
      description: "Unfriend a user. Irreversible (you'd need to re-friend).",
      inputSchema: { userId: z.string().describe("User id to unfriend") },
    },
    ({ userId }) =>
      guard(async () => {
        const api = await getApi();
        return ok(await api.removeFriend(userId));
      }),
  );

  server.registerTool(
    "zalo_set_friend_alias",
    {
      title: "Set or clear a Zalo friend alias",
      description: "Set a custom alias (nickname) for a friend, or clear it with an empty alias.",
      inputSchema: {
        userId: z.string().describe("Friend's user id"),
        alias: z.string().describe("Alias to set; empty string clears it"),
      },
    },
    ({ userId, alias }) =>
      guard(async () => {
        const api = await getApi();
        const res = alias.length > 0
          ? await api.changeFriendAlias(alias, userId)
          : await api.removeFriendAlias(userId);
        return ok({ cleared: alias.length === 0, result: res });
      }),
  );

  // --- Conversation controls (your own view; reversible) --------------------

  server.registerTool(
    "zalo_mute",
    {
      title: "Mute or unmute a Zalo conversation",
      description: "Mute (silence notifications) or unmute a thread. Affects only your account.",
      inputSchema: {
        threadId: z.string().describe("Thread id"),
        threadType: threadType,
        mute: z.boolean().default(true).describe("true = mute, false = unmute"),
      },
    },
    ({ threadId, threadType: kind, mute }) =>
      guard(async () => {
        const api = await getApi();
        const res = await api.setMute(
          { action: mute ? MuteAction.MUTE : MuteAction.UNMUTE },
          threadId,
          toThreadType(kind),
        );
        return ok({ muted: mute, result: res });
      }),
  );

  server.registerTool(
    "zalo_pin",
    {
      title: "Pin or unpin a Zalo conversation",
      description: "Pin or unpin a thread in your conversation list.",
      inputSchema: {
        threadId: z.string().describe("Thread id"),
        threadType: threadType,
        pinned: z.boolean().default(true).describe("true = pin, false = unpin"),
      },
    },
    ({ threadId, threadType: kind, pinned }) =>
      guard(async () => {
        const api = await getApi();
        const res = await api.setPinnedConversations(pinned, threadId, toThreadType(kind));
        return ok({ pinned, result: res });
      }),
  );

  server.registerTool(
    "zalo_archive",
    {
      title: "Archive or unarchive a Zalo conversation",
      description: "Move a thread to/from the archived chat list.",
      inputSchema: {
        threadId: z.string().describe("Thread id"),
        threadType: threadType,
        archived: z.boolean().default(true).describe("true = archive, false = unarchive"),
      },
    },
    ({ threadId, threadType: kind, archived }) =>
      guard(async () => {
        const api = await getApi();
        const res = await api.updateArchivedChatList(archived, {
          id: threadId,
          type: toThreadType(kind),
        });
        return ok({ archived, result: res });
      }),
  );

  server.registerTool(
    "zalo_get_labels",
    {
      title: "Get Zalo conversation labels",
      description: "List your conversation labels (folders) and their members.",
      inputSchema: {},
    },
    () =>
      guard(async () => {
        const api = await getApi();
        return ok(await api.getLabels());
      }),
  );
}
