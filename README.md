# shhh — private whispers (vvvaaa)

One Node app: **Render** hosts it, **Neon** stores messages. Every send is saved; **Leave** only logs you out. **Clear** wipes the room.

## Deploy (3 steps)

1. **Render** → **astro-platform-starter** (astro deploy) → **Settings**: **Language = Node**, Web Service (not Static Site).  
   - Build: `npm install` (or `yarn install && yarn build` if still on yarn — both work now)  
   - Start Command: `npm start`  
   - Health: `/api/health`  
   - Repo: `main` on service **astro-platform-starter** (astro deploy) — see `render.yaml`.

2. **Environment** on **astro-platform-starter** (required):
   - `DATABASE_URL` = Neon Console → project **vvvaaa** → Connect → **pooled** URI  
   - `CHAT_PASSWORD` = room password (**required** — set only in the host environment, never in repo)
   - `MESSAGE_ENCRYPTION_KEY` = `openssl rand -base64 32` (encrypts message text in Postgres)
   - `KLIPY_API_KEY` = free test key from [partner.klipy.com](https://partner.klipy.com/) (GIF browser; Tenor no longer issues new keys)
   - `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` = generate with `npx web-push generate-vapid-keys` (installable app + push: messages & **Thinking of you** hearts)
   - `VAPID_SUBJECT` is preset to `mailto:vidhugupta1996@gmail.com` in `render.yaml` (override only if you change contact email)

3. Deploy, then open **https://sexychat.fun/api/health** → must show `"ok":true,"db":true`.

## Deploy status

- **Render (production):** push to `main` → **astro deploy** (`astro-platform-starter-yjkk`) auto-deploys → https://sexychat.fun  
- **Cursor Publish:** optional hosted copy with bound secrets (`KLIPY_API_KEY`, VAPID keys; add `TENOR_API_KEY` when ready).

## Install as an app (PWA)

On **https://sexychat.fun**, use **Install** in the header (Chrome/Edge/Android) or **Add to Home Screen** (iOS Safari). Allow notifications when prompted so **💗 Thinking of you** and new messages can appear in the system tray. iOS limits background push; keep the installed app for the best experience.

Without `DATABASE_URL`, deploy still succeeds; `/api/health` shows `"db":false` until you add the Neon URL and **Manual Deploy**.

## Local

```bash
cp .env.example .env   # add DATABASE_URL
npm ci && npm start
```

## Domains

`sexychat.fun` and `www.sexychat.fun` are on **astro-platform-starter** in `render.yaml` (Vudhu → Production).

To force a deploy without the API: set `RENDER_DEPLOY_HOOK` from Render → astro deploy → Deploy Hook, then `bash scripts/trigger-astro-deploy.sh`.
