# vvvaaa

**SexyChats** — single-page chat with **Neon Postgres** on Render (and optional Claude artifact mode).

## Stack

| Piece | Role |
|--------|------|
| `server.js` | Express API, uploads, static `public/` |
| **Neon** project `vvvaaa` (`red-sky-25826530`) | Postgres messages, sessions, presence |
| `render.yaml` | Node web service blueprint |

## Deploy on Render

1. **New → Blueprint** → connect this repo.
2. Set environment variables:
   - **`DATABASE_URL`** — pooled connection string from [Neon Console](https://console.neon.tech) → project **vvvaaa** → Connect.
   - **`CHAT_PASSWORD`** — room password (default `safelife100` if unset).
3. Deploy. Health check: `GET /api/health` → `{ "ok": true, "db": true }`.

### Custom domain

Render → **vvvaaa** → **Settings → Custom Domains** → add your domain; point DNS (CNAME `www` to `*.onrender.com`, or apex A records per Render).

## Local dev

```bash
cp .env.example .env   # add DATABASE_URL from Neon
npm install
npm start
```

Open http://localhost:3000 — login badge should show **Database connected · Neon**.

## API

- `GET /api/health` — DB status
- `POST /api/auth/enter` — `{ username, password }` → `{ token, username, userId }`
- Bearer token on all other `/api/*` routes

## Claude artifact mode

If opened on claude.ai with capabilities enabled, the app still uses `claude.use("db")` when `/api/health` is unavailable.
