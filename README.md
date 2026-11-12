# Velvet — Private Chat (vvvaaa)

One Node app: **Render** hosts it, **Neon** stores messages. Every send is saved; **Leave** only logs you out. **Clear** wipes the room.

## Deploy (3 steps)

1. **Render** → **Meow?** → **Settings**: set **Language = Node** (not Static Site).  
   - Build: `npm install` (or `yarn install && yarn build` if still on yarn — both work now)  
   - Start Command: `npm start`  
   - Health: `/api/health`  
   - Repo: `main` (this project’s `render.yaml` has the rest).

2. **Environment** on Meow? (required):
   - `DATABASE_URL` = Neon Console → project **vvvaaa** → Connect → **pooled** URI  
   - `CHAT_PASSWORD` = room password (default `safelife100` if unset)
   - `MESSAGE_ENCRYPTION_KEY` = `openssl rand -base64 32` (encrypts message text in Postgres)
   - `KLIPY_API_KEY` = free test key from [partner.klipy.com](https://partner.klipy.com/) (GIF browser; Tenor no longer issues new keys)
   - `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` = generate with `npx web-push generate-vapid-keys` (installable app + push: messages & **Thinking of you** hearts)
   - Optional: `VAPID_SUBJECT` = `mailto:you@yourdomain.com`

3. Deploy, then open **https://sexychat.fun/api/health** → must show `"ok":true,"db":true`.

## Install as an app (PWA)

On **https://sexychat.fun**, use **Install** in the header (Chrome/Edge/Android) or **Add to Home Screen** (iOS Safari). Allow notifications when prompted so **💗 Thinking of you** and new messages can appear in the system tray. iOS limits background push; keep the installed app for the best experience.

Without `DATABASE_URL`, deploy still succeeds; `/api/health` shows `"db":false` until you add the Neon URL and **Manual Deploy**.

## Local

```bash
cp .env.example .env   # add DATABASE_URL
npm ci && npm start
```

## Domains

`sexychat.fun` and `www.sexychat.fun` are declared in `render.yaml` under **Vudhu → Production → Meow?**.
