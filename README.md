# SexyChats (vvvaaa)

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

3. Deploy, then open **https://sexychat.fun/api/health** → must show `"ok":true,"db":true`.

Without `DATABASE_URL`, deploy still succeeds; `/api/health` shows `"db":false` until you add the Neon URL and **Manual Deploy**.

## Local

```bash
cp .env.example .env   # add DATABASE_URL
npm ci && npm start
```

## Domains

`sexychat.fun` and `www.sexychat.fun` are declared in `render.yaml` under **Vudhu → Production → Meow?**.
