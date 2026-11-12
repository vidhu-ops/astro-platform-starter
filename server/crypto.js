import crypto from "node:crypto";

const PREFIX = "enc:v1:";

let _key = null;

export function initMessageKey({ messageEncryptionKey, chatPassword }) {
  if (messageEncryptionKey) {
    const buf = Buffer.from(messageEncryptionKey, "base64");
    if (buf.length !== 32) {
      throw new Error("MESSAGE_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
    }
    _key = buf;
    return;
  }
  if (chatPassword) {
    _key = crypto.scryptSync(chatPassword, "velvet-msg-v1", 32);
    return;
  }
  _key = null;
}

function key() {
  if (!_key) throw new Error("MESSAGE_ENCRYPTION_KEY not configured");
  return _key;
}

export function encryptField(plain) {
  if (plain == null || plain === "") return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptField(stored) {
  if (stored == null || stored === "") return stored;
  if (!String(stored).startsWith(PREFIX)) return stored;
  const raw = Buffer.from(String(stored).slice(PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const d = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}

export function timingSafeEqualString(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}
