# Fix “Chat unavailable” on sexychat.fun

Your domain shows **Velvet** but chat fails because **Meow? is still a Static Site** on Render.  
Static only serves `public/index.html` — there is **no** `/api/health` or database (curl returns `Not Found`).

## Fix (Render dashboard)

### Option A — New Web Service (recommended if you can’t change type)

1. **New → Web Service** → repo `astro-platform-starter`, branch `main`.
2. **Runtime:** Node  
3. **Build:** `npm install`  
4. **Start:** `npm start`  
5. **Health check path:** `/api/health`
6. **Environment:**
   - `DATABASE_URL` = Neon **vvvaaa** → Connect → **pooled** URL  
   - `CHAT_PASSWORD` = `safelife100` (or your password)
7. After **Live**, move **Custom Domains** `sexychat.fun` / `www` from the old Static service to this Web Service.
8. Delete or suspend the old **Static** **Meow?** service.

### Option B — Blueprint sync

1. **Blueprints** → sync repo (uses root `render.yaml` — **Node**, not static).
2. Confirm service is **Web Service** with **Start Command** `npm start`.
3. Set `DATABASE_URL` and `CHAT_PASSWORD` as above.

## Verify

- `https://meow-k3z3.onrender.com/api/health` → `{"ok":true,"db":true}`  
  (not `Not Found`)
- https://sexychat.fun — sign in with password `safelife100`
