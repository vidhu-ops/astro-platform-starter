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
    "WARNING: DATABASE_URL is not set. Add Neon pooled URL in Render → Meow? → Environment, then restart.",
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
  `);
}

const GIF_PRESETS = {
  spicy: "romantic passionate couple",
  cute: "love cute hearts couple",
  flirty: "flirty kiss sexy",
  mood: "sensual mood lighting",
};

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
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

function clearSessionCookie(res) {
  res.clearCookie("velvet_session", { path: "/", httpOnly: true, secure: COOKIE_SECURE });
}

const DEVICE_COOKIE = "shhh_device";
const MAX_UPLOADS_PER_USER = 80;
const MAX_UPLOADS_PER_HOUR = 25;

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
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
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
        imgSrc: ["'self'", "blob:", "data:", "https:", "https://media.tenor.com", "https://media1.tenor.com"],
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
  });
});

app.get(
  "/api/auth/me",
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json({ username: req.user.username, userId: req.user.user_id });
  }),
);

app.get(
  "/api/health",
  asyncHandler(async (_req, res) => {
  if (!pool) {
    return res.json({ ok: false, db: false, message: "DATABASE_URL not configured" });
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
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
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
    storedKey = keyFromClient;
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
  const klipy = process.env.KLIPY_API_KEY;
  const tenor = process.env.TENOR_API_KEY;

  if (klipy) {
    const url = new URL(`https://api.klipy.com/api/v1/${encodeURIComponent(klipy)}/gifs/search`);
    url.searchParams.set("q", q);
    url.searchParams.set("page", "1");
    url.searchParams.set("per_page", "24");
    const r = await fetch(url);
    const data = await r.json();
    if (!data.result) {
      return res.status(502).json({ error: data.errors?.message?.[0] || "Klipy search failed" });
    }
    const list = data.data?.data || data.data?.gifs || data.data || [];
    const results = (Array.isArray(list) ? list : []).map((item) => {
      const files = item.files || item.media || {};
      const gif = files.gif || files.hd?.gif || item.url;
      const preview = files.preview?.gif?.url || files.tiny?.gif?.url || gif?.url || gif;
      const sendUrl = gif?.url || gif || preview;
      return {
        id: item.id || item.slug,
        title: item.title || item.slug || "gif",
        url: sendUrl,
        preview: preview?.url || preview || sendUrl,
      };
    });
    return res.json({ results, provider: "klipy" });
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
  "/api/messages",
  authMiddleware,
  asyncHandler(async (req, res) => {
  const all = req.query.all === "true";
  if (all) {
    const confirm = String(req.body?.confirmPassword || "");
    if (!timingSafeEqualString(confirm, CHAT_PASSWORD)) {
      return res.status(403).json({ error: "Room password required to delete all saved messages" });
    }
    await pool.query(`DELETE FROM chat_messages`);
  } else {
    const doomed = await pool.query(
      `SELECT media_key FROM chat_messages WHERE saved = false AND media_key IS NOT NULL`,
    );
    for (const row of doomed.rows) {
      const k = normalizeMediaKey(row.media_key);
      if (!k) continue;
      const p = resolveUploadPath(UPLOAD_DIR, k);
      if (p && fs.existsSync(p)) fs.unlink(p, () => {});
    }
    await pool.query(`DELETE FROM chat_messages WHERE saved = false`);
  }
  await pool.query(
    `UPDATE chat_meta SET ended_by = $1, ts = $2 WHERE id = 'chat'`,
    [req.user.user_id, Date.now()],
  );
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
    `SELECT COUNT(*)::int AS count FROM chat_presence
     WHERE last_seen > NOW() - INTERVAL '45 seconds'`,
  );
  res.json({ online: rows[0]?.count ?? 0 });
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
