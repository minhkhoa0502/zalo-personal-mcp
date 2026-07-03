/**
 * Encrypted-at-rest storage for the Zalo session (cookies, imei, userAgent).
 *
 * Format (JSON on disk):
 *   { v, kdf: "scrypt" | "keyfile", salt?, iv, tag, data }  // all base64
 *
 * The session is the crown jewel — anyone holding it can act as your Zalo
 * account. We encrypt with AES-256-GCM. The key comes from either:
 *   - a passphrase in ZALO_SESSION_KEY (scrypt-derived), or
 *   - a random key file stored next to the session with mode 0600.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { config } from "./config.js";

const ALGO = "aes-256-gcm";
const SCRYPT_SALT_LEN = 16;
const IV_LEN = 12;

/** The credential blob zca-js needs to restore a session (`Zalo.login`). */
export interface StoredSession {
  imei: string;
  cookie: unknown;
  userAgent: string;
  language?: string;
  /** When the session was saved (ISO), for humans reading the file. */
  savedAt: string;
}

interface EncryptedPayload {
  v: 1;
  kdf: "scrypt" | "keyfile";
  salt?: string;
  iv: string;
  tag: string;
  data: string;
}

function keyFilePath(): string {
  return config.sessionPath + ".key";
}

/** Load or create the random key file used when no passphrase is configured. */
function getOrCreateKeyFile(): Buffer {
  const p = keyFilePath();
  if (existsSync(p)) {
    const key = readFileSync(p);
    if (key.length !== 32) throw new Error(`Corrupt key file at ${p} (expected 32 bytes)`);
    return key;
  }
  mkdirSync(dirname(p), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(p, key, { mode: 0o600 });
  chmodSync(p, 0o600);
  return key;
}

function deriveKey(kdf: "scrypt" | "keyfile", salt?: Buffer): Buffer {
  if (kdf === "scrypt") {
    if (!config.sessionKey) throw new Error("scrypt session requires ZALO_SESSION_KEY");
    if (!salt) throw new Error("scrypt session missing salt");
    return scryptSync(config.sessionKey, salt, 32);
  }
  return getOrCreateKeyFile();
}

export function saveSession(session: StoredSession): void {
  const useScrypt = config.sessionKey != null;
  const kdf = useScrypt ? "scrypt" : "keyfile";
  const salt = useScrypt ? randomBytes(SCRYPT_SALT_LEN) : undefined;
  const key = deriveKey(kdf, salt);
  const iv = randomBytes(IV_LEN);

  const cipher = createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(session), "utf8");
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload: EncryptedPayload = {
    v: 1,
    kdf,
    ...(salt ? { salt: salt.toString("base64") } : {}),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: data.toString("base64"),
  };

  mkdirSync(dirname(config.sessionPath), { recursive: true });
  writeFileSync(config.sessionPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  chmodSync(config.sessionPath, 0o600);
}

export function loadSession(): StoredSession | null {
  if (!existsSync(config.sessionPath)) return null;

  const payload = JSON.parse(readFileSync(config.sessionPath, "utf8")) as EncryptedPayload;
  if (payload.v !== 1) throw new Error(`Unsupported session file version: ${payload.v}`);

  if (payload.kdf === "scrypt" && !config.sessionKey) {
    throw new Error(
      "Session is encrypted with a passphrase but ZALO_SESSION_KEY is not set.",
    );
  }

  const salt = payload.salt ? Buffer.from(payload.salt, "base64") : undefined;
  const key = deriveKey(payload.kdf, salt);
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");

  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  try {
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.data, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8")) as StoredSession;
  } catch {
    throw new Error(
      "Failed to decrypt session (wrong key/passphrase or corrupt file). " +
        "Re-run `npm run login` to create a fresh session.",
    );
  }
}

export function hasSession(): boolean {
  return existsSync(config.sessionPath);
}

/** Constant-time compare helper (exported for tests / future auth checks). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
