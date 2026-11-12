import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const CHAT_PASSWORD = process.env.CHAT_PASSWORD || "safelife100";
const DATABASE_URL = process.env.DATABASE_URL;
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
  `);
}

function sessionUser(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  return token;
}

async function authMiddleware(req, res, next) {
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
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const id = crypto.randomUUID();
      const ext = path.extname(file.originalname).slice(0, 12);
      cb(null, `${id}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", async (_req, res) => {
  if (!pool) {
    return res.json({ ok: false, db: false, message: "DATABASE_URL not configured" });
  }
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: true, backend: "neon" });
  } catch (e) {
    res.status(503).json({ ok: false, db: false, message: "Database unreachable" });
  }
});

app.post("/api/auth/enter", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database unavailable" });
  const username = String(req.body.username || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
  const password = String(req.body.password || "");
  if (username.length < 3) return res.status(400).json({ error: "Username too short" });
  if (password !== CHAT_PASSWORD) return res.status(403).json({ error: "Wrong password" });

  const existing = await pool.query(
    `SELECT username FROM chat_users WHERE username = $1`,
    [username],
  );
  const userId = crypto.randomUUID();
  if (!existing.rows[0]) {
    await pool.query(
      `INSERT INTO chat_users (username, owner_id, created_at) VALUES ($1, $2, $3)`,
      [username, userId, Date.now()],
    );
  }

  const token = crypto.randomUUID();
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO chat_sessions (token, username, user_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [token, username, userId, expires],
  );

  res.json({ token, username, userId });
});

app.post("/api/auth/leave", authMiddleware, async (req, res) => {
  const token = sessionUser(req);
  if (token) {
    await pool.query(`DELETE FROM chat_sessions WHERE token = $1`, [token]);
  }
  await pool.query(`DELETE FROM chat_presence WHERE user_id = $1`, [req.user.user_id]);
  res.json({ ok: true });
});

function publicMessage(row, viewer) {
  const isSender = row.user === viewer;
  const hasMedia = !!(row.media || row.media_key);
  const m = {
    id: row.id,
    user: row.user,
    uid: row.uid,
    ts: row.ts,
    text: row.text,
    kind: row.kind,
    fname: row.fname,
    saved: row.saved,
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

app.get("/api/messages", authMiddleware, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, user_name AS "user", user_id AS uid, ts, body_text AS text,
            media, kind, fname, saved, view_once, media_viewed, media_key
     FROM chat_messages ORDER BY ts DESC LIMIT 200`,
  );
  res.json({
    messages: rows.reverse().map((r) => publicMessage(r, req.user.username)),
  });
});

app.post("/api/messages", authMiddleware, async (req, res) => {
  const { text, media, kind, fname, viewOnce, mediaKey } = req.body || {};
  const ts = Date.now();
  const once = !!viewOnce;
  const mediaVal = once ? null : media || (mediaKey ? `/api/media/${mediaKey}` : null);
  const { rows } = await pool.query(
    `INSERT INTO chat_messages (user_name, user_id, ts, body_text, media, kind, fname, saved, view_once, media_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9)
     RETURNING id, user_name AS "user", user_id AS uid, ts, body_text AS text, media, kind, fname, saved,
               view_once, media_viewed, media_key`,
    [
      req.user.username,
      req.user.user_id,
      ts,
      text ? String(text).slice(0, 2000) : null,
      mediaVal,
      kind || null,
      fname || null,
      once,
      mediaKey || null,
    ],
  );
  res.status(201).json(publicMessage(rows[0], req.user.username));
});

app.post("/api/messages/:id/view-once", authMiddleware, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, user_name, media, kind, media_key, view_once, media_viewed
     FROM chat_messages WHERE id = $1`,
    [req.params.id],
  );
  const msg = rows[0];
  if (!msg?.view_once) return res.status(400).json({ error: "Not a view-once message" });
  if (msg.media_viewed) return res.status(410).json({ error: "Already viewed" });
  if (msg.user_name === req.user.username) {
    return res.status(403).json({ error: "Sender cannot open view-once" });
  }
  const key = msg.media_key || (msg.media && path.basename(String(msg.media)));
  if (!key) return res.status(404).json({ error: "Media gone" });
  const filePath = path.join(UPLOAD_DIR, key);
  if (!fs.existsSync(filePath)) {
    await pool.query(
      `UPDATE chat_messages SET media = NULL, media_viewed = true WHERE id = $1`,
      [req.params.id],
    );
    return res.status(410).json({ error: "Media expired" });
  }
  await pool.query(
    `UPDATE chat_messages SET media = NULL, media_viewed = true WHERE id = $1`,
    [req.params.id],
  );
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Content-Type", msg.kind || "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const stream = fs.createReadStream(filePath);
  stream.on("close", () => {
    fs.unlink(filePath, () => {});
  });
  stream.pipe(res);
});

app.patch("/api/messages/save-all", authMiddleware, async (_req, res) => {
  const { rowCount } = await pool.query(
    `UPDATE chat_messages SET saved = true WHERE saved = false`,
  );
  res.json({ saved: rowCount });
});

app.delete("/api/messages", authMiddleware, async (req, res) => {
  const all = req.query.all === "true";
  if (all) await pool.query(`DELETE FROM chat_messages`);
  else await pool.query(`DELETE FROM chat_messages WHERE saved = false`);
  await pool.query(
    `UPDATE chat_meta SET ended_by = $1, ts = $2 WHERE id = 'chat'`,
    [req.user.user_id, Date.now()],
  );
  res.json({ ok: true });
});

app.get("/api/meta", authMiddleware, async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT ended_by AS "endedBy", ts FROM chat_meta WHERE id = 'chat'`,
  );
  res.json(rows[0] || {});
});

app.post("/api/presence", authMiddleware, async (req, res) => {
  const name = String(req.body.name || req.user.username);
  await pool.query(
    `INSERT INTO chat_presence (user_id, username, last_seen)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET username = $2, last_seen = NOW()`,
    [req.user.user_id, name],
  );
  res.json({ ok: true });
});

app.get("/api/presence", authMiddleware, async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM chat_presence
     WHERE last_seen > NOW() - INTERVAL '45 seconds'`,
  );
  res.json({ online: rows[0]?.count ?? 0 });
});

app.post("/api/upload", authMiddleware, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  const viewOnce = req.body.viewOnce === "true" || req.body.viewOnce === true;
  const url = viewOnce ? null : `/api/media/${req.file.filename}`;
  res.json({
    id: req.file.filename,
    mediaKey: req.file.filename,
    url,
    kind: req.file.mimetype,
    viewOnce,
  });
});

app.get("/api/media/:filename", authMiddleware, (req, res) => {
  const safe = path.basename(req.params.filename);
  const filePath = path.join(UPLOAD_DIR, safe);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.sendFile(filePath);
});
app.use(express.static(path.join(__dirname, "public")));

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

await migrate();
app.listen(PORT, () => {
  console.log(`vvvaaa listening on ${PORT}, db=${pool ? "on" : "off"}`);
});
