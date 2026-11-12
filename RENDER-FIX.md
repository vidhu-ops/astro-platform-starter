# Fix “Chat unavailable” or old **Velvet** UI on sexychat.fun

If the mobile site still says **Velvet** or looks old, the custom domain is not on the latest **Meow?** Node deploy (or the phone is caching an old PWA).

1. **Render** → open the **Web Service** that runs `npm start` (not Static Site).
2. Confirm latest commit on `main` is **Live** (look for `shhh` in deploy logs).
3. **Settings → Custom Domains**: `sexychat.fun` and `www.sexychat.fun` must point to **this** service (remove them from any old Static service).
4. **Manual Deploy** → Clear build cache & deploy.
5. On the phone: delete the old home-screen app → Safari/Chrome → open https://sexychat.fun → hard refresh → Add to Home Screen again (name should be **shhh**).

Quick check: `curl -s https://sexychat.fun/ | grep -o '<title>[^<]*'` should show `shhh — private whispers`.  
Right now **sexychat.fun** often still serves **Velvet** from an old service; the good build is **meow-k3z3.onrender.com** — see [DOMAIN-ROUTING.md](./DOMAIN-ROUTING.md).

---

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
6. **Environment** (Meow? → **Environment** → paste each key):
   - `DATABASE_URL` = Neon **vvvaaa** → Connect → **pooled** URL  
   - `CHAT_PASSWORD` = your private room password (required; not stored in this repo)
   - `MESSAGE_ENCRYPTION_KEY` = same base64 32-byte key you already use in production
   - `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` = from `npx web-push generate-vapid-keys` (PWA + **Thinking of you** + message push)
   - `VAPID_SUBJECT` = `mailto:vidhugupta1996@gmail.com`
   - `KLIPY_API_KEY` = free test key from [partner.klipy.com](https://partner.klipy.com/) (GIF picker; Google Tenor no longer issues new API keys)
7. After **Live**, move **Custom Domains** `sexychat.fun` / `www` from the old Static service to this Web Service.
8. Delete or suspend the old **Static** **Meow?** service.

### Option B — Blueprint sync

1. **Blueprints** → sync repo (uses root `render.yaml` — **Node**, not static).
2. Confirm service is **Web Service** with **Start Command** `npm start`.
3. Set `DATABASE_URL` and `CHAT_PASSWORD` as above.

## Verify

- `https://meow-k3z3.onrender.com/api/health` → `{"ok":true,"db":true}`  
  (not `Not Found`)
- https://sexychat.fun — sign in with the password you set in `CHAT_PASSWORD`
- https://sexychat.fun/api/config → `"pushEnabled":true` when VAPID keys are set; `"gifEnabled":true` when `KLIPY_API_KEY` is set

## After deploy from `main` (PWA + GIF + push)

Render **Meow?** auto-deploys on every push to `main`. When a deploy finishes:

1. Open **Environment** and add any missing vars above (especially **VAPID** and **KLIPY**).
2. Click **Manual Deploy** → **Clear build cache & deploy** once after adding env vars.
3. On your phone/desktop: open **https://sexychat.fun**, allow **notifications**, use **Install** / Add to Home Screen.
4. Confirm **💗 Thinking of you** and the in-app **GIF** button work.

GIF search stays off until you add `KLIPY_API_KEY`; pasting GIF/video URLs in chat still works.
