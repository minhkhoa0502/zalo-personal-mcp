/**
 * Interactive QR login. Run once with `npm run login`:
 *
 *   1. A QR image is written next to your session file.
 *   2. Open it and scan with the Zalo mobile app (Settings → scan QR).
 *   3. On success, the session is encrypted and saved; the MCP server can
 *      then restore it without re-scanning.
 *
 * This is a separate CLI because QR scanning is interactive and cannot happen
 * over the MCP stdio transport.
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { LoginQRCallbackEventType } from "zca-js";
import { config } from "./config.js";
import { buildZalo } from "./zalo-client.js";
import { saveSession, type StoredSession } from "./session.js";
import { configureEgress } from "./net.js";

async function main(): Promise<void> {
  configureEgress();
  const qrPath = resolve(dirname(config.sessionPath), "qr.png");
  const zalo = buildZalo();

  let captured: Omit<StoredSession, "savedAt"> | null = null;

  console.log("Requesting a Zalo login QR code…\n");

  const api = await zalo.loginQR(
    { qrPath, language: "vi" },
    (event) => {
      switch (event.type) {
        case LoginQRCallbackEventType.QRCodeGenerated:
          // When a callback is provided, zca-js does NOT write the QR file
          // itself — it hands us the base64 image, so we write it here.
          writeFileSync(qrPath, Buffer.from(event.data.image, "base64"));
          console.log(`QR code written to:\n  ${qrPath}\n`);
          console.log("Open that image and scan it in the Zalo app (Settings → scan QR).");
          console.log("You have ~100 seconds per code before it expires.\n");
          break;
        case LoginQRCallbackEventType.QRCodeScanned:
          console.log("QR scanned — confirm the login on your phone…");
          break;
        case LoginQRCallbackEventType.QRCodeExpired:
          console.error("QR code expired before it was scanned. Re-run `make login`.");
          break;
        case LoginQRCallbackEventType.QRCodeDeclined:
          console.error("Login was declined on the phone.");
          break;
        case LoginQRCallbackEventType.GotLoginInfo:
          captured = {
            cookie: event.data.cookie,
            imei: event.data.imei,
            userAgent: event.data.userAgent,
          };
          break;
      }
    },
  );

  if (!captured) {
    throw new Error("Login completed but no credentials were captured — please retry.");
  }

  const info = await api.fetchAccountInfo().catch(() => null);
  const displayName = info?.profile?.displayName ?? "(unknown)";

  saveSession({ ...(captured as Omit<StoredSession, "savedAt">), savedAt: new Date().toISOString() });

  console.log(`\n✅ Logged in as ${displayName}.`);
  console.log(`Session encrypted and saved to:\n  ${config.sessionPath}`);
  if (!config.sessionKey) {
    console.log(
      "\nNote: no ZALO_SESSION_KEY set, so a random key file protects the session.\n" +
        "For stronger protection, set ZALO_SESSION_KEY and re-run login.",
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("\nLogin failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
