# sexychat.fun → astro deploy (Render)

**Production service:** `astro-platform-starter` on Render  
**URL:** `https://astro-platform-starter-yjkk.onrender.com`  
**Custom domains:** `sexychat.fun`, `www.sexychat.fun` (already on this service)

## DNS (GoDaddy)

| Record | Value |
|--------|--------|
| `@` A | `216.24.57.1` |
| `www` CNAME | `astro-platform-starter-yjkk.onrender.com` |

Do **not** point www at `meow-k3z3` — that was a separate experimental service.

## After every push to `main`

1. Render → **astro deploy** / **astro-platform-starter** → confirm **Auto-Deploy** on `main`.
2. Wait for **Live** (or **Manual Deploy** → clear cache).
3. Verify:

```bash
curl -s https://sexychat.fun/ | grep '<title>'
# shhh — private whispers

curl -s https://sexychat.fun/api/health
# "app":"shhh" and "ok":true
```

If you still see **Velvet**, the running deploy is an **old build** — trigger a fresh deploy on this service (not Meow?).

## Blueprint sync

Repo `render.yaml` is aligned to **astro-platform-starter**. In Render → **Blueprints** → sync so domains and start command stay `npm start` / Web Service.

## Optional API automation

```bash
export RENDER_API_KEY=...
RENDER_TARGET_HOST=astro-platform-starter-yjkk.onrender.com \
  node scripts/render-domains.mjs --apply --deploy
```
