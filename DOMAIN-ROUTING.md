# Domain routing check (Nov 2026)

| URL | Page title | Should use? |
|-----|------------|-------------|
| https://meow-k3z3.onrender.com/ | **shhh — private whispers** | **Yes** — current Meow? Web Service |
| https://sexychat.fun/ | Velvet — Private Chat | **No** — still on an old deploy |
| https://astro-platform-starter-yjkk.onrender.com/ | Velvet — Private Chat | **No** — retire / remove domains |

## Fix GoDaddy / Render

1. **Render** → service **Meow?** (hostname `meow-k3z3.onrender.com`) → **Settings → Custom Domains**.
2. Add **sexychat.fun** and **www.sexychat.fun** here if missing.
3. Open the **old** services (`yjkk`, or any showing Velvet in the browser) → **remove** both custom domains from them.
4. **Manual Deploy** on Meow? with **Clear build cache & deploy**.
5. Verify:  
   `curl -s https://sexychat.fun/ | grep '<title>'` → must contain **shhh**.  
   `curl -s https://sexychat.fun/api/health` → `"app":"shhh"`.

GoDaddy DNS should stay: apex **A** `216.24.57.1`, **www** **CNAME** → `meow-k3z3.onrender.com` (or the hostname Render shows for Meow?).
