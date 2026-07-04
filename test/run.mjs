/**
 * Offline regression tests for pure logic (no live Zalo account / Docker needed):
 *   - image-meta header parsing (used by image sends)
 *   - message-log filtering + message shaping (used by the daemon + tools)
 * Run with `npm test` (builds first). Tool/network behaviour is tested live
 * against a real account, which can't run here.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log("PASS", name);
  } catch (e) {
    fail++;
    console.log("FAIL", name, "-", e.message);
  }
};

const dir = mkdtempSync(join(tmpdir(), "zmcp-test-"));

// --- image-meta ------------------------------------------------------------
const { imageMetadataGetter } = await import("../dist/image-meta.js");

const png1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
writeFileSync(join(dir, "a.png"), png1x1);
await t("imageMeta: PNG dimensions", async () => {
  const m = await imageMetadataGetter(join(dir, "a.png"));
  assert.equal(m.width, 1);
  assert.equal(m.height, 1);
  assert.ok(m.size > 0);
});

const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([3, 0, 2, 0, 0x80, 0, 0])]);
writeFileSync(join(dir, "b.gif"), gif);
await t("imageMeta: GIF dimensions (LE)", async () => {
  const m = await imageMetadataGetter(join(dir, "b.gif"));
  assert.equal(m.width, 3);
  assert.equal(m.height, 2);
});

writeFileSync(join(dir, "c.txt"), "not an image");
await t("imageMeta: non-image returns null", async () => {
  assert.equal(await imageMetadataGetter(join(dir, "c.txt")), null);
});

// --- message-log (config reads ZALO_MESSAGE_LOG at import) ------------------
process.env.ZALO_MESSAGE_LOG = join(dir, "log.jsonl");
const { readRecent, shapeMessage } = await import("../dist/message-log.js");

const now = Date.now();
const rec = (mins, thread, content) =>
  JSON.stringify({
    loggedAt: now - mins * 60000,
    ts: String(now - mins * 60000),
    threadType: "user",
    threadId: thread,
    isSelf: false,
    content,
  });
writeFileSync(process.env.ZALO_MESSAGE_LOG, [rec(10, "X", "a"), rec(2, "X", "b"), rec(1, "Y", "c")].join("\n") + "\n");

await t("readRecent: time window", () => {
  assert.equal(readRecent({ sinceMs: now - 5 * 60000 }).length, 2);
});
await t("readRecent: threadId filter", () => {
  const r = readRecent({ sinceMs: now - 5 * 60000, threadId: "X" });
  assert.equal(r.length, 1);
  assert.equal(r[0].content, "b");
});
await t("readRecent: limit keeps newest", () => {
  const r = readRecent({ limit: 1 });
  assert.equal(r[0].content, "c");
});
await t("shapeMessage: maps cliMsgId + quote", () => {
  const s = shapeMessage(
    { type: 0, threadId: "T", isSelf: false, data: { uidFrom: "u", dName: "N", ts: "123", msgId: "m", cliMsgId: "c", content: "hi", msgType: "webchat" } },
    "live",
    now,
  );
  assert.equal(s.threadType, "user");
  assert.equal(s.cliMsgId, "c");
  assert.equal(s.quote.msgId, "m");
  assert.equal(s.quote.cliMsgId, "c");
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
