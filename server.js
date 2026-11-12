import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import multer from "multer";
import pg from "pg";
import {
  decryptBuffer,
  decryptField,
  encryptBuffer,
  encryptField,
  initMessageKey,
  timingSafeEqualString,
} from "./server/crypto.js";
import { asyncHandler } from "./server/express-async.js";
import { getPublicKey, initPush, isPushReady, sendPush } from "./server/push.js";
import {
  isAllowedPushEndpoint,
  isUuid,
  normalizeMediaKey,
  resolveUploadPath,
  safeContentType,
  sanitizeExternalMediaUrl,
} from "./server/security.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const CHAT_PASSWORD = process.env.CHAT_PASSWORD;
if (!CHAT_PASSWORD) {
  console.error("FATAL: Set CHAT_PASSWORD in the environment (no default).");
  process.exit(1);
}
const DATABASE_URL = process.env.DATABASE_URL;
const COOKIE_SECURE = Boolean(process.env.RENDER || process.env.NODE_ENV === "production");
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

initMessageKey({
  messageEncryptionKey: process.env.MESSAGE_ENCRYPTION_KEY,
  chatPassword: CHAT_PASSWORD,
});
initPush({
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY,
  subject: process.env.VAPID_SUBJECT || "mailto:vidhugupta1996@gmail.com",
});
if (process.env.RENDER && !DATABASE_URL) {
  console.warn(
    "WARNING: DATABASE_URL is not set. Add Neon pooled URL in Render → astro-platform-starter → Environment, then restart.",
  );
}
const UPLOAD_DIR = path.join(__dirname, "data", "uploads");

const pool = DATABASE_URL
  ? new pg.Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
      max: 10,
    })
  : null;

async function migrate() {
  if (!pool) return;
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE IF NOT EXISTS chat_users (
      username TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_name TEXT NOT NULL,
      user_id TEXT,
      ts BIGINT NOT NULL,
      body_text TEXT,
      media TEXT,
      kind TEXT,
      fname TEXT,
      saved BOOLEAN NOT NULL DEFAULT false,
      view_once BOOLEAN NOT NULL DEFAULT false,
      media_viewed BOOLEAN NOT NULL DEFAULT false,
      media_key TEXT
    );
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS view_once BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS media_viewed BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS media_key TEXT;
    CREATE INDEX IF NOT EXISTS chat_messages_ts_idx ON chat_messages (ts DESC);
    CREATE TABLE IF NOT EXISTS chat_meta (
      id TEXT PRIMARY KEY,
      ended_by TEXT,
      ts BIGINT
    );
    INSERT INTO chat_meta (id, ended_by, ts) VALUES ('chat', NULL, NULL)
      ON CONFLICT (id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS chat_sessions (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      user_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_presence (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      last_seen TIMESTAMPTZ NOT NULL
    );
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS reply_to UUID;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS marked BOOLEAN NOT NULL DEFAULT false;
    CREATE TABLE IF NOT EXISTS chat_push_subscriptions (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS chat_stories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      ts BIGINT NOT NULL,
      caption_text TEXT,
      media_key TEXT NOT NULL,
      kind TEXT,
      saved BOOLEAN NOT NULL DEFAULT false
    );
    ALTER TABLE chat_stories ADD COLUMN IF NOT EXISTS saved BOOLEAN NOT NULL DEFAULT false;
    CREATE INDEX IF NOT EXISTS chat_stories_ts_idx ON chat_stories (ts DESC);
    CREATE TABLE IF NOT EXISTS chat_uploads (
      media_key TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_uploads_user_idx ON chat_uploads (user_id);
    CREATE TABLE IF NOT EXISTS chat_scrapbook_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      item_type TEXT NOT NULL,
      title_text TEXT,
      body_text TEXT,
      media_key TEXT,
      kind TEXT,
      ts BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_scrapbook_ts_idx ON chat_scrapbook_items (ts DESC);
    CREATE TABLE IF NOT EXISTS chat_scrapbook_dates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      label_text TEXT NOT NULL,
      event_date DATE NOT NULL,
      yearly_repeat BOOLEAN NOT NULL DEFAULT true,
      marked BOOLEAN NOT NULL DEFAULT true,
      note_text TEXT,
      media_key TEXT,
      kind TEXT,
      ts BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_scrapbook_dates_day_idx ON chat_scrapbook_dates (event_date);
  `);
}

const SCRAP_TYPES = new Set(["memory", "quote", "note"]);

function rowOwnedByUser(row, user) {
  if (!row || !user) return false;
  if (row.user_id && row.user_id === user.user_id) return true;
  if (row.user_name && row.user_name === user.username) return true;
  return false;
}

async function assertMediaUploadOwner(userId, mediaKey) {
  const key = normalizeMediaKey(mediaKey);
  if (!key) return false;
  const { rows } = await pool.query(
    `SELECT user_id FROM chat_uploads WHERE media_key = $1`,
    [key],
  );
  if (!rows[0]) return false;
  return rows[0].user_id === userId;
}

function polishLocal(text) {
  let s = String(text || "")
    .trim()
    .replace(/\s+/g, " ");
  if (!s) return s;
  s = s.replace(/\bi\b/g, "I");
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (!/[.!?…]$/.test(s)) s += ".";
  return s.slice(0, 2000);
}

async function enhanceWithAi(text) {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return { text: polishLocal(text), provider: "local" };
  const base = process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
  const model = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
  const r = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      max_tokens: 400,
      messages: [
        {
          role: "system",
          content:
            "Rewrite the user's chat message in clear, natural English. Keep the same meaning, warmth, and flirtiness. Fix grammar and flow. Output only the rewritten message—no quotes or commentary.",
        },
        { role: "user", content: String(text).slice(0, 2000) },
      ],
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data.error?.message || `AI HTTP ${r.status}`;
    throw Object.assign(new Error(msg), { status: 502 });
  }
  const out = data.choices?.[0]?.message?.content?.trim();
  if (!out) throw Object.assign(new Error("Empty AI response"), { status: 502 });
  return { text: out.slice(0, 2000), provider: "openai" };
}

const GIF_PRESETS = {
  spicy: "romantic passionate couple",
  cute: "love cute hearts couple",
  flirty: "flirty kiss sexy",
  mood: "sensual mood lighting",
};

/** Klipy returns media under `file` → { hd|md|sm|xs } → { gif|webp|... } → { url } */
function klipyPickUrl(block) {
  if (!block || typeof block !== "object") return null;
  return block.gif?.url || block.webp?.url || block.mp4?.url || block.jpg?.url || null;
}

function unlinkMediaKeys(keys) {
  const unique = [...new Set(keys.map((k) => normalizeMediaKey(k)).filter(Boolean))];
  for (const k of unique) {
    const p = resolveUploadPath(UPLOAD_DIR, k);
    if (p && fs.existsSync(p)) fs.unlink(p, () => {});
  }
}

function mapKlipyGif(item) {
  const file = item.file || item.files || item.media || {};
  const send =
    klipyPickUrl(file.hd) ||
    klipyPickUrl(file.md) ||
    klipyPickUrl(file.sm) ||
    klipyPickUrl(file) ||
    (typeof item.url === "string" ? item.url : null);
  const preview =
    klipyPickUrl(file.sm) ||
    klipyPickUrl(file.xs) ||
    klipyPickUrl(file.md) ||
    send;
  if (!send) return null;
  return {
    id: String(item.id ?? item.slug ?? ""),
    title: item.title || item.slug || "gif",
    url: send,
    preview: preview || send,
  };
}

function sessionUser(req) {
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  return req.cookies?.velvet_session || bearer || null;
}

function setSessionCookie(res, token) {
  res.cookie("velvet_session", token, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "strict",
    maxAge: SESSION_MS,
    path: "/",
  });
}

function clearSessionCookie(res) {
  res.clearCookie("velvet_session", { path: "/", httpOnly: true, secure: COOKIE_SECURE });
}

const DEVICE_COOKIE = "shhh_device";
const MAX_UPLOADS_PER_USER = 80;
const MAX_UPLOADS_PER_HOUR = 25;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

function getOrSetDeviceId(req, res) {
  let id = req.cookies?.[DEVICE_COOKIE];
  if (!id || !isUuid(id)) {
    id = crypto.randomUUID();
    res.cookie(DEVICE_COOKIE, id, {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: "strict",
      maxAge: 400 * 24 * 60 * 60 * 1000,
      path: "/",
    });
  }
  return id;
}

async function authMiddleware(req, res, next) {
  try {
    if (!pool) return res.status(503).json({ error: "Database unavailable" });
    const token = sessionUser(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const { rows } = await pool.query(
      `SELECT username, user_id FROM chat_sessions
       WHERE token = $1 AND expires_at > NOW()`,
      [token],
    );
    if (!rows[0]) return res.status(401).json({ error: "Session expired" });
    req.user = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const id = crypto.randomUUID();
      const rawExt = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, "");
      const ext = rawExt.slice(0, 12);
      cb(null, `${id}${ext}`);
    },
  }),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
});

function mimeFromFilename(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
  };
  return safeContentType(map[ext] || "application/octet-stream");
}

function sendEncryptedFile(res, filePath, contentType) {
  const kind = safeContentType(contentType);
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Type", kind);
  if (kind.startsWith("image/") || kind.startsWith("video/")) {
    res.setHeader("Content-Disposition", "inline");
  } else {
    res.setHeader("Content-Disposition", "attachment");
  }
  const enc = fs.readFileSync(filePath);
  const plain = decryptBuffer(enc);
  res.send(plain);
}

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: [
          "'self'",
          "blob:",
          "data:",
          "https:",
          "https://static.klipy.com",
          "https://static1.klipy.com",
          "https://static2.klipy.com",
          "https://media.tenor.com",
          "https://media1.tenor.com",
        ],
        mediaSrc: ["'self'", "blob:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);
app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again later." },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api", apiLimiter);
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  next();
});

const viewOnceLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  message: { error: "Too many view requests." },
});

const uploadUserLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: MAX_UPLOADS_PER_HOUR,
  standardHeaders: true,
  message: { error: "Upload limit reached. Try again later." },
  keyGenerator: (req) => req.user?.user_id || req.ip,
});

const gifSearchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  message: { error: "GIF search rate limit — try again in a moment." },
  keyGenerator: (req) => req.user?.user_id || req.ip,
});

app.get("/api/config", (_req, res) => {
  res.json({
    vapidPublicKey: getPublicKey(),
    pushEnabled: isPushReady(),
    gifEnabled: Boolean(process.env.TENOR_API_KEY || process.env.KLIPY_API_KEY),
    enhanceAi: Boolean(process.env.OPENAI_API_KEY?.trim()),
    storiesEnabled: Boolean(pool),
    scrapbookEnabled: Boolean(pool),
    maxUploadMb: Math.round(MAX_FILE_BYTES / (1024 * 1024)),
  });
});

app.get(
  "/api/auth/me",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const token = sessionUser(req);
    if (token) {
      const expires = new Date(Date.now() + SESSION_MS);
      await pool.query(`UPDATE chat_sessions SET expires_at = $1 WHERE token = $2`, [expires, token]);
      setSessionCookie(res, token);
    }
    res.json({ username: req.user.username, userId: req.user.user_id });
  }),
);

app.get(
  "/api/health",
  asyncHandler(async (_req, res) => {
  if (!pool) {
    return res.status(503).json({ ok: false, db: false, message: "DATABASE_URL not configured" });
  }
  try {
    await pool.query("SELECT 1");
    res.json({
      ok: true,
      db: true,
      backend: "neon",
      app: "shhh",
      commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) || null,
    });
  } catch (e) {
    res.status(503).json({ ok: false, db: false, message: "Database unreachable" });
  }
  }),
);

app.post(
  "/api/auth/enter",
  loginLimiter,
  asyncHandler(async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database unavailable" });
  const username = String(req.body.username || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
  const password = String(req.body.password || "");
  if (username.length < 3) return res.status(400).json({ error: "Username too short" });
  if (!timingSafeEqualString(password, CHAT_PASSWORD)) {
    return res.status(403).json({ error: "Wrong password" });
  }

  const deviceId = getOrSetDeviceId(req, res);
  const existing = await pool.query(
    `SELECT username, owner_id FROM chat_users WHERE username = $1`,
    [username],
  );
  let ownerId;
  if (existing.rows[0]) {
    ownerId = existing.rows[0].owner_id;
  } else {
    ownerId = deviceId;
    await pool.query(
      `INSERT INTO chat_users (username, owner_id, created_at) VALUES ($1, $2, $3)`,
      [username, ownerId, Date.now()],
    );
  }

  const token = crypto.randomUUID();
  const expires = new Date(Date.now() + SESSION_MS);
  await pool.query(
    `INSERT INTO chat_sessions (token, username, user_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [token, username, ownerId, expires],
  );

  setSessionCookie(res, token);
  res.json({ username });
  }),
);

app.post(
  "/api/auth/leave",
  authMiddleware,
  asyncHandler(async (req, res) => {
  const token = sessionUser(req);
  if (token) {
    await pool.query(`DELETE FROM chat_sessions WHERE token = $1`, [token]);
  }
  await pool.query(`DELETE FROM chat_presence WHERE user_id = $1`, [req.user.user_id]);
  await pool.query(`DELETE FROM chat_push_subscriptions WHERE user_id = $1`, [req.user.user_id]);
  clearSessionCookie(res);
  res.json({ ok: true });
  }),
);

async function broadcastPush(excludeUserId, payload) {
  if (!pool || !isPushReady()) return 0;
  const { rows } = await pool.query(
    `SELECT endpoint, p256dh, auth FROM chat_push_subscriptions WHERE user_id IS DISTINCT FROM $1`,
    [excludeUserId],
  );
  let sent = 0;
  await Promise.all(
    rows.map(async (sub) => {
      try {
        await sendPush(sub, payload);
        sent++;
      } catch {
        await pool.query(`DELETE FROM chat_push_subscriptions WHERE endpoint = $1`, [sub.endpoint]);
      }
    }),
  );
  return sent;
}

function publicMessage(row, viewer) {
  const isSender = row.user === viewer;
  const hasMedia = !!(row.media || row.media_key);
  const m = {
    id: row.id,
    user: row.user,
    ts: row.ts,
    text: decryptField(row.text),
    kind: row.kind,
    fname: row.fname,
    saved: row.saved,
    marked: !!row.marked,
    replyTo: row.reply_to || null,
    replyQuote: row.reply_user
      ? { user: row.reply_user, text: decryptField(row.reply_text)?.slice(0, 120) }
      : null,
    viewOnce: !!row.view_once,
    mediaViewed: !!row.media_viewed,
    hasMedia,
  };
  if (row.view_once) {
    m.media = null;
    m.hasMedia = !row.media_viewed && !isSender;
    m.viewOnceState = row.media_viewed ? "opened" : isSender ? "sent" : "ready";
  } else if (row.media_key) {
    m.media = `/api/media/${row.media_key}`;
  } else {
    m.media = row.media;
  }
  return m;
}

app.get(
  "/api/messages",
  authMiddleware,
  asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT m.id, m.user_name AS "user", m.user_id AS uid, m.ts, m.body_text AS text,
            m.media, m.kind, m.fname, m.saved, m.view_once, m.media_viewed, m.media_key,
            m.reply_to, m.marked,
            p.user_name AS reply_user, p.body_text AS reply_text
     FROM chat_messages m
     LEFT JOIN chat_messages p ON p.id = m.reply_to
     ORDER BY m.ts DESC LIMIT 200`,
  );
  res.json({
    messages: rows.reverse().map((r) => publicMessage(r, req.user.username)),
  });
  }),
);

app.post(
  "/api/messages",
  authMiddleware,
  asyncHandler(async (req, res) => {
  const { text, media, kind, fname, viewOnce, mediaKey, replyTo } = req.body || {};
  const ts = Date.now();
  const once = !!viewOnce;
  let mediaVal = null;
  let storedKey = null;
  const keyFromClient = normalizeMediaKey(mediaKey);
  if (keyFromClient) {
    const filePath = resolveUploadPath(UPLOAD_DIR, keyFromClient);
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(400).json({ error: "Invalid media upload" });
    }
    const owned = await assertMediaUploadOwner(req.user.user_id, keyFromClient);
    if (!owned) {
      return res.status(403).json({ error: "Upload does not belong to this session" });
    }
    storedKey = keyFromClient;
    await pool.query(`DELETE FROM chat_uploads WHERE media_key = $1`, [keyFromClient]);
    if (!once) mediaVal = `/api/media/${storedKey}`;
  } else if (!once) {
    mediaVal = sanitizeExternalMediaUrl(media);
  }
  if (once && !storedKey) {
    return res.status(400).json({ error: "View-once requires a valid upload" });
  }
  let replyId = null;
  if (replyTo && isUuid(replyTo)) {
    const chk = await pool.query(`SELECT id FROM chat_messages WHERE id = $1`, [replyTo]);
    if (chk.rows[0]) replyId = replyTo;
  }
  const safeKind = kind ? safeContentType(kind) : null;
  const safeFname = fname ? String(fname).slice(0, 80).replace(/[^\w.\- ]/g, "") : null;
  const { rows } = await pool.query(
    `INSERT INTO chat_messages (user_name, user_id, ts, body_text, media, kind, fname, saved, view_once, media_key, reply_to)
     VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9, $10)
     RETURNING id, user_name AS "user", user_id AS uid, ts, body_text AS text, media, kind, fname, saved,
               view_once, media_viewed, media_key, reply_to, marked`,
    [
      req.user.username,
      req.user.user_id,
      ts,
      text ? encryptField(String(text).slice(0, 2000)) : null,
      mediaVal,
      safeKind,
      safeFname,
      once,
      storedKey,
      replyId,
    ],
  );
  const out = publicMessage(rows[0], req.user.username);
  res.status(201).json(out);
  const preview = out.text
    ? String(out.text).slice(0, 120)
  : out.hasMedia
    ? "📎 Sent media"
    : "New message";
  void broadcastPush(req.user.user_id, {
    title: `💋 @${req.user.username}`,
    body: preview,
    icon: "/icons/icon.svg",
    badge: "/icons/heart-badge.svg",
    tag: "velvet-msg",
    data: { url: "/", kind: "message" },
  });
  }),
);

app.patch(
  "/api/messages/:id/mark",
  authMiddleware,
  asyncHandler(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: "Invalid id" });
  const { rows } = await pool.query(
    `UPDATE chat_messages SET marked = NOT marked
     WHERE id = $1
     RETURNING id, marked`,
    [req.params.id],
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
  }),
);

app.post(
  "/api/push/subscribe",
  authMiddleware,
  asyncHandler(async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: "Invalid subscription" });
  }
  if (!isAllowedPushEndpoint(endpoint)) {
    return res.status(400).json({ error: "Push endpoint not allowed" });
  }
  await pool.query(
    `INSERT INTO chat_push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, p256dh = $3, auth = $4`,
    [req.user.user_id, endpoint, keys.p256dh, keys.auth],
  );
  res.json({ ok: true });
  }),
);

app.post(
  "/api/thinking-of-you",
  authMiddleware,
  asyncHandler(async (req, res) => {
  const from = req.user.username;
  const payload = {
    title: "💗 Thinking of you",
    body: `@${from} is thinking of you on shhh`,
    icon: "/icons/icon.svg",
    badge: "/icons/heart-badge.svg",
    tag: "velvet-heart",
    data: { url: "/", kind: "heart" },
  };
  const sent = await broadcastPush(req.user.user_id, payload);
  res.json({ sent, pushEnabled: isPushReady() });
  }),
);

app.get(
  "/api/gifs/search",
  authMiddleware,
  gifSearchLimiter,
  asyncHandler(async (req, res) => {
  const tier = String(req.query.tier || "spicy");
  const q = String(req.query.q || GIF_PRESETS[tier] || GIF_PRESETS.spicy);
  const klipy = process.env.KLIPY_API_KEY?.trim();
  const tenor = process.env.TENOR_API_KEY?.trim();

  async function fetchKlipy(path, params) {
    const url = new URL(`https://api.klipy.com/api/v1/${encodeURIComponent(klipy)}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const r = await fetch(url);
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.result === false) {
      const msg =
        data.errors?.message?.[0] ||
        data.message ||
        (typeof data.errors === "string" ? data.errors : null) ||
        `Klipy HTTP ${r.status}`;
      throw Object.assign(new Error(msg), { status: 502 });
    }
    const list = data.data?.data || data.data?.gifs || (Array.isArray(data.data) ? data.data : []);
    return (Array.isArray(list) ? list : []).map(mapKlipyGif).filter(Boolean);
  }

  if (klipy) {
    try {
      const params = {
        q,
        page: "1",
        per_page: "24",
        locale: "us",
        content_filter: "low",
        format_filter: "gif,webp",
      };
      let results = await fetchKlipy("/gifs/search", params);
      if (!results.length && !req.query.q) {
        results = await fetchKlipy("/gifs/trending", {
          page: "1",
          per_page: "24",
          locale: "us",
          content_filter: "low",
        });
      }
      return res.json({ results, provider: "klipy" });
    } catch (e) {
      return res.status(e.status || 502).json({ error: e.message || "Klipy search failed" });
    }
  }

  if (tenor) {
    const url = new URL("https://tenor.googleapis.com/v2/search");
    url.searchParams.set("key", tenor);
    url.searchParams.set("q", q);
    url.searchParams.set("limit", "24");
    url.searchParams.set("media_filter", "gif,tinygif");
    url.searchParams.set("contentfilter", "low");
    const r = await fetch(url);
    const data = await r.json();
    const results = (data.results || []).map((item) => {
      const m = item.media_formats || {};
      const gif = m.tinygif || m.gif || m.mediumgif;
      return {
        id: item.id,
        title: item.content_description || item.title,
        url: gif?.url,
        preview: m.tinygif?.url || gif?.url,
      };
    });
    return res.json({ results, provider: "tenor" });
  }

  return res.status(503).json({
    error: "GIF search not configured — set KLIPY_API_KEY (recommended) or TENOR_API_KEY on Render",
  });
  }),
);

app.post(
  "/api/messages/:id/view-once",
  authMiddleware,
  viewOnceLimiter,
  asyncHandler(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: "Invalid id" });
  const { rows } = await pool.query(
    `SELECT id, user_name, media, kind, media_key, view_once, media_viewed
     FROM chat_messages WHERE id = $1`,
    [req.params.id],
  );
  const msg = rows[0];
  if (!msg?.view_once) return res.status(400).json({ error: "Not a view-once message" });
  if (msg.user_name === req.user.username) {
    return res.status(403).json({ error: "Sender cannot open view-once" });
  }
  const key = normalizeMediaKey(msg.media_key);
  if (!key) return res.status(404).json({ error: "Media gone" });
  const filePath = resolveUploadPath(UPLOAD_DIR, key);
  const claim = await pool.query(
    `UPDATE chat_messages SET media = NULL, media_viewed = true
     WHERE id = $1 AND media_viewed = false
     RETURNING id`,
    [req.params.id],
  );
  if (!claim.rows[0]) return res.status(410).json({ error: "Already viewed" });
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(410).json({ error: "Media expired" });
  }
  sendEncryptedFile(res, filePath, msg.kind || mimeFromFilename(key));
  fs.unlink(filePath, () => {});
  }),
);

app.patch(
  "/api/messages/save-all",
  authMiddleware,
  asyncHandler(async (_req, res) => {
  const { rowCount } = await pool.query(
    `UPDATE chat_messages SET saved = true WHERE saved = false`,
  );
  res.json({ saved: rowCount });
  }),
);

app.delete(
  "/api/messages/bulk",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const raw = req.body?.ids;
    if (!Array.isArray(raw) || !raw.length) {
      return res.status(400).json({ error: "Provide ids array" });
    }
    const ids = [...new Set(raw.filter((id) => isUuid(id)))];
    if (!ids.length) return res.status(400).json({ error: "No valid message ids" });
    const doomed = await pool.query(
      `SELECT id, media_key, user_id, user_name FROM chat_messages WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    const owned = doomed.rows.filter((r) => rowOwnedByUser(r, req.user));
    if (!owned.length) {
      return res.status(403).json({ error: "You can only delete your own messages" });
    }
    const ownedIds = owned.map((r) => r.id);
    unlinkMediaKeys(owned.map((r) => r.media_key));
    const { rowCount } = await pool.query(
      `DELETE FROM chat_messages WHERE id = ANY($1::uuid[])`,
      [ownedIds],
    );
    res.json({
      ok: true,
      deleted: rowCount,
      skipped: ids.length - ownedIds.length,
    });
  }),
);

app.delete(
  "/api/messages",
  authMiddleware,
  asyncHandler(async (req, res) => {
  const all = req.query.all === "true";
  if (all) {
    const confirm = String(req.body?.confirmPassword || "");
    if (!timingSafeEqualString(confirm, CHAT_PASSWORD)) {
      return res.status(403).json({ error: "Room password required to delete all saved messages" });
    }
    const doomed = await pool.query(
      `SELECT media_key FROM chat_messages WHERE media_key IS NOT NULL`,
    );
    unlinkMediaKeys(doomed.rows.map((r) => r.media_key));
    await pool.query(`DELETE FROM chat_messages`);
  } else {
    const doomed = await pool.query(
      `SELECT media_key FROM chat_messages
       WHERE saved = false
         AND (user_id = $1 OR (user_id IS NULL AND user_name = $2))
         AND media_key IS NOT NULL`,
      [req.user.user_id, req.user.username],
    );
    unlinkMediaKeys(doomed.rows.map((r) => r.media_key));
    await pool.query(
      `DELETE FROM chat_messages
       WHERE saved = false AND (user_id = $1 OR (user_id IS NULL AND user_name = $2))`,
      [req.user.user_id, req.user.username],
    );
  }
  if (all) {
    await pool.query(
      `UPDATE chat_meta SET ended_by = $1, ts = $2 WHERE id = 'chat'`,
      [req.user.user_id, Date.now()],
    );
  }
  res.json({ ok: true });
  }),
);

app.get(
  "/api/meta",
  authMiddleware,
  asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT ended_by AS "endedBy", ts FROM chat_meta WHERE id = 'chat'`,
  );
  res.json(rows[0] || {});
  }),
);

app.post(
  "/api/presence",
  authMiddleware,
  asyncHandler(async (req, res) => {
  const name = String(req.body.name || req.user.username);
  await pool.query(
    `INSERT INTO chat_presence (user_id, username, last_seen)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET username = $2, last_seen = NOW()`,
    [req.user.user_id, name],
  );
  res.json({ ok: true });
  }),
);

app.get(
  "/api/presence",
  authMiddleware,
  asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT username FROM chat_presence
     WHERE last_seen > NOW() - INTERVAL '90 seconds'
     ORDER BY username`,
  );
  res.json({ online: rows.length, users: rows });
  }),
);

const enhanceLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  message: { error: "Too many enhance requests." },
  keyGenerator: (req) => req.user?.user_id || req.ip,
});

const storyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  message: { error: "Story upload limit — try later." },
  keyGenerator: (req) => req.user?.user_id || req.ip,
});

app.post(
  "/api/enhance-text",
  authMiddleware,
  enhanceLimiter,
  asyncHandler(async (req, res) => {
    const raw = String(req.body?.text || "").trim();
    if (raw.length < 2) return res.status(400).json({ error: "Type something first" });
    try {
      const result = await enhanceWithAi(raw);
      res.json(result);
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message || "Enhance failed" });
    }
  }),
);

app.get(
  "/api/stories",
  authMiddleware,
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT id, user_name AS "user", user_id, ts, caption_text AS caption_enc, media_key, kind, saved
       FROM chat_stories ORDER BY ts DESC LIMIT 120`,
    );
    res.json({
      stories: rows.map((r) => ({
        id: r.id,
        user: r.user,
        userId: r.user_id,
        ts: r.ts,
        caption: decryptField(r.caption_enc),
        media: r.media_key ? `/api/media/${r.media_key}` : null,
        kind: r.kind,
        saved: !!r.saved,
      })),
    });
  }),
);

app.post(
  "/api/stories",
  authMiddleware,
  storyLimiter,
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Photo or video required" });
    const mime = safeContentType(req.file.mimetype);
  if (!mime.startsWith("image/") && !mime.startsWith("video/")) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: "Updates must be images or video" });
    }
    const captionRaw = String(req.body?.caption || "").trim().slice(0, 500);
    const recent = await pool.query(
      `SELECT ts FROM chat_stories WHERE user_id = $1 ORDER BY ts DESC LIMIT 1`,
      [req.user.user_id],
    );
    if (recent.rows[0] && Date.now() - Number(recent.rows[0].ts) < 3000) {
      fs.unlink(req.file.path, () => {});
      return res.status(409).json({ error: "Please wait a moment before posting again" });
    }
    try {
      const raw = fs.readFileSync(req.file.path);
      fs.writeFileSync(req.file.path, encryptBuffer(raw));
    } catch {
      fs.unlink(req.file.path, () => {});
      return res.status(500).json({ error: "Upload encryption failed" });
    }
    const safeName = normalizeMediaKey(req.file.filename);
    if (!safeName) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: "Invalid filename" });
    }
    const ts = Date.now();
    const { rows } = await pool.query(
      `INSERT INTO chat_stories (user_name, user_id, ts, caption_text, media_key, kind, saved)
       VALUES ($1, $2, $3, $4, $5, $6, false)
       RETURNING id, user_name AS "user", ts, media_key, kind, saved`,
      [
        req.user.username,
        req.user.user_id,
        ts,
        captionRaw ? encryptField(captionRaw) : null,
        safeName,
        mime,
      ],
    );
    const row = rows[0];
    res.status(201).json({
      id: row.id,
      user: row.user,
      ts: row.ts,
      caption: captionRaw,
      media: `/api/media/${row.media_key}`,
      kind: row.kind,
      saved: !!row.saved,
    });
  }),
);

app.patch(
  "/api/stories/:id/save",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: "Invalid id" });
    const { rows } = await pool.query(
      `UPDATE chat_stories SET saved = NOT saved WHERE id = $1 RETURNING id, saved`,
      [req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  }),
);

app.patch(
  "/api/stories/save-all",
  authMiddleware,
  asyncHandler(async (_req, res) => {
    const { rowCount } = await pool.query(`UPDATE chat_stories SET saved = true WHERE saved = false`);
    res.json({ saved: rowCount });
  }),
);

app.delete(
  "/api/stories",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const all = req.query.all === "true";
    if (all) {
      const confirm = String(req.body?.confirmPassword || "");
      if (!timingSafeEqualString(confirm, CHAT_PASSWORD)) {
        return res.status(403).json({ error: "Room password required to delete all updates" });
      }
      const doomed = await pool.query(`SELECT media_key FROM chat_stories WHERE media_key IS NOT NULL`);
      unlinkMediaKeys(doomed.rows.map((r) => r.media_key));
      await pool.query(`DELETE FROM chat_stories`);
    } else {
      const doomed = await pool.query(
        `SELECT media_key FROM chat_stories
         WHERE saved = false AND user_id = $1 AND media_key IS NOT NULL`,
        [req.user.user_id],
      );
      unlinkMediaKeys(doomed.rows.map((r) => r.media_key));
      await pool.query(`DELETE FROM chat_stories WHERE saved = false AND user_id = $1`, [
        req.user.user_id,
      ]);
    }
    res.json({ ok: true });
  }),
);

app.delete(
  "/api/stories/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: "Invalid id" });
    const { rows } = await pool.query(
      `SELECT id, user_id, media_key FROM chat_stories WHERE id = $1`,
      [req.params.id],
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "Not found" });
    if (row.user_id !== req.user.user_id) {
      return res.status(403).json({ error: "You can only delete your own updates" });
    }
    unlinkMediaKeys([row.media_key]);
    await pool.query(`DELETE FROM chat_stories WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  }),
);

const scrapbookLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  message: { error: "Scrapbook save limit — try later." },
  keyGenerator: (req) => req.user?.user_id || req.ip,
});

function mapScrapItem(row) {
  return {
    id: row.id,
    user: row.user_name,
    userId: row.user_id,
    type: row.item_type,
    title: row.title_text ? decryptField(row.title_text) : "",
    body: decryptField(row.body_text),
    media: row.media_key ? `/api/media/${row.media_key}` : null,
    kind: row.kind,
    ts: row.ts,
  };
}

function mapScrapDate(row) {
  const d = row.event_date;
  const iso = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  return {
    id: row.id,
    user: row.user_name,
    userId: row.user_id,
    label: decryptField(row.label_text),
    date: iso,
    yearly: !!row.yearly_repeat,
    marked: !!row.marked,
    note: row.note_text ? decryptField(row.note_text) : "",
    media: row.media_key ? `/api/media/${row.media_key}` : null,
    kind: row.kind,
    ts: row.ts,
  };
}

app.get(
  "/api/scrapbook/items",
  authMiddleware,
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT id, user_name, user_id, item_type, title_text, body_text, media_key, kind, ts
       FROM chat_scrapbook_items ORDER BY ts DESC LIMIT 200`,
    );
    res.json({ items: rows.map(mapScrapItem) });
  }),
);

app.post(
  "/api/scrapbook/items",
  authMiddleware,
  scrapbookLimiter,
  asyncHandler(async (req, res) => {
    const type = String(req.body?.type || "note").toLowerCase();
    if (!SCRAP_TYPES.has(type)) return res.status(400).json({ error: "Invalid type" });
    const title = String(req.body?.title || "").trim().slice(0, 120);
    const body = String(req.body?.body || "").trim().slice(0, 2000);
    if (!body && !req.body?.mediaKey) {
      return res.status(400).json({ error: "Add text or a photo" });
    }
    let mediaKey = null;
    let kind = null;
    const keyFromClient = normalizeMediaKey(req.body?.mediaKey);
    if (keyFromClient) {
      const owned = await assertMediaUploadOwner(req.user.user_id, keyFromClient);
      if (!owned) return res.status(403).json({ error: "Upload does not belong to this session" });
      const filePath = resolveUploadPath(UPLOAD_DIR, keyFromClient);
      if (!filePath || !fs.existsSync(filePath)) {
        return res.status(400).json({ error: "Invalid media upload" });
      }
      mediaKey = keyFromClient;
      kind = safeContentType(req.body?.kind);
      await pool.query(`DELETE FROM chat_uploads WHERE media_key = $1`, [keyFromClient]);
    }
    const ts = Date.now();
    const { rows } = await pool.query(
      `INSERT INTO chat_scrapbook_items (user_name, user_id, item_type, title_text, body_text, media_key, kind, ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, user_name, user_id, item_type, title_text, body_text, media_key, kind, ts`,
      [
        req.user.username,
        req.user.user_id,
        type,
        title ? encryptField(title) : null,
        body ? encryptField(body) : null,
        mediaKey,
        kind,
        ts,
      ],
    );
    res.status(201).json(mapScrapItem(rows[0]));
  }),
);

app.delete(
  "/api/scrapbook/items/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: "Invalid id" });
    const { rows } = await pool.query(
      `SELECT user_id, media_key FROM chat_scrapbook_items WHERE id = $1`,
      [req.params.id],
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "Not found" });
    if (row.user_id !== req.user.user_id) {
      return res.status(403).json({ error: "You can only delete your own scrapbook entries" });
    }
    unlinkMediaKeys([row.media_key]);
    await pool.query(`DELETE FROM chat_scrapbook_items WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  }),
);

app.get(
  "/api/scrapbook/dates",
  authMiddleware,
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT id, user_name, user_id, label_text, event_date, yearly_repeat, marked,
              note_text, media_key, kind, ts
       FROM chat_scrapbook_dates
       ORDER BY event_date ASC, ts DESC LIMIT 300`,
    );
    res.json({ dates: rows.map(mapScrapDate) });
  }),
);

app.post(
  "/api/scrapbook/dates",
  authMiddleware,
  scrapbookLimiter,
  asyncHandler(async (req, res) => {
    const label = String(req.body?.label || "").trim().slice(0, 120);
    const dateStr = String(req.body?.date || "").slice(0, 10);
    if (!label) return res.status(400).json({ error: "Label required" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ error: "Use date YYYY-MM-DD" });
    }
    const yearly = req.body?.yearly !== false;
    const note = String(req.body?.note || "").trim().slice(0, 500);
    let mediaKey = null;
    let kind = null;
    const keyFromClient = normalizeMediaKey(req.body?.mediaKey);
    if (keyFromClient) {
      const owned = await assertMediaUploadOwner(req.user.user_id, keyFromClient);
      if (!owned) return res.status(403).json({ error: "Upload does not belong to this session" });
      mediaKey = keyFromClient;
      kind = safeContentType(req.body?.kind);
      await pool.query(`DELETE FROM chat_uploads WHERE media_key = $1`, [keyFromClient]);
    }
    const ts = Date.now();
    const { rows } = await pool.query(
      `INSERT INTO chat_scrapbook_dates
       (user_name, user_id, label_text, event_date, yearly_repeat, marked, note_text, media_key, kind, ts)
       VALUES ($1,$2,$3,$4::date,$5,true,$6,$7,$8,$9)
       RETURNING id, user_name, user_id, label_text, event_date, yearly_repeat, marked, note_text, media_key, kind, ts`,
      [
        req.user.username,
        req.user.user_id,
        encryptField(label),
        dateStr,
        yearly,
        note ? encryptField(note) : null,
        mediaKey,
        kind,
        ts,
      ],
    );
    res.status(201).json(mapScrapDate(rows[0]));
  }),
);

app.patch(
  "/api/scrapbook/dates/:id/mark",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: "Invalid id" });
    const { rows } = await pool.query(
      `UPDATE chat_scrapbook_dates SET marked = NOT marked
       WHERE id = $1 RETURNING id, marked`,
      [req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  }),
);

app.delete(
  "/api/scrapbook/dates/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: "Invalid id" });
    const { rows } = await pool.query(
      `SELECT user_id, media_key FROM chat_scrapbook_dates WHERE id = $1`,
      [req.params.id],
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "Not found" });
    if (row.user_id !== req.user.user_id) {
      return res.status(403).json({ error: "You can only remove your own dates" });
    }
    unlinkMediaKeys([row.media_key]);
    await pool.query(`DELETE FROM chat_scrapbook_dates WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  }),
);

app.post(
  "/api/upload",
  authMiddleware,
  uploadUserLimiter,
  upload.single("file"),
  asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  const { rows: quota } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM chat_messages WHERE user_id = $1 AND media_key IS NOT NULL`,
    [req.user.user_id],
  );
  if ((quota[0]?.c ?? 0) >= MAX_UPLOADS_PER_USER) {
    fs.unlink(req.file.path, () => {});
    return res.status(429).json({ error: "Upload quota reached for this account" });
  }
  try {
    const raw = fs.readFileSync(req.file.path);
    fs.writeFileSync(req.file.path, encryptBuffer(raw));
  } catch {
    fs.unlink(req.file.path, () => {});
    return res.status(500).json({ error: "Upload encryption failed" });
  }
  const viewOnce = req.body.viewOnce === "true" || req.body.viewOnce === true;
  const safeName = normalizeMediaKey(req.file.filename);
  if (!safeName) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: "Invalid filename" });
  }
  await pool.query(
    `INSERT INTO chat_uploads (media_key, user_id, created_at) VALUES ($1, $2, $3)
     ON CONFLICT (media_key) DO UPDATE SET user_id = EXCLUDED.user_id, created_at = EXCLUDED.created_at`,
    [safeName, req.user.user_id, Date.now()],
  );
  const url = viewOnce ? null : `/api/media/${safeName}`;
  res.json({
    id: safeName,
    mediaKey: safeName,
    url,
    kind: safeContentType(req.file.mimetype),
    viewOnce,
  });
  }),
);

app.get(
  "/api/media/:filename",
  authMiddleware,
  (req, res) => {
  const filePath = resolveUploadPath(UPLOAD_DIR, req.params.filename);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).end();
  sendEncryptedFile(res, filePath, mimeFromFilename(req.params.filename));
  },
);

app.use((err, _req, res, _next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File too large" });
  }
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: "Server error" });
});
app.use(
  express.static(path.join(__dirname, "public"), {
    etag: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith("index.html")) {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }),
);

app.get("*", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

await migrate();
app.listen(PORT, () => {
  console.log(`vvvaaa listening on ${PORT}, db=${pool ? "on" : "off"}`);
});
