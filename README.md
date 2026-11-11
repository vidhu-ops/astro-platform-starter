# vvvaaa

Static deployment package for **SexyChats** (`velvet.html`): a single-page chat UI with TypeScript capability definitions under `types/` (Claude artifact platform APIs).

## Deploy on Render

### Option A — Blueprint (recommended)

1. Open [Render Dashboard](https://dashboard.render.com/) → **New** → **Blueprint**.
2. Connect GitHub repo **`vidhu-ops/vvvaaa`** (after this repo is renamed; see below).
3. Render reads `render.yaml` and creates a **Static Site** named `vvvaaa` with publish path `public/`.

### Option B — Manual static site

| Setting | Value |
|--------|--------|
| **Root Directory** | (repo root) |
| **Build Command** | *(leave empty)* |
| **Publish Directory** | `public` |

## Custom domain on Render

1. In Render: open the **vvvaaa** service → **Settings** → **Custom Domains** → **Add Custom Domain** (e.g. `vvvaaa.com` and `www.vvvaaa.com`).
2. Render shows DNS records. At your registrar (Cloudflare, Namecheap, etc.):
   - **Apex / root** (`vvvaaa.com`): use Render’s **A** records, **or** ALIAS/ANAME to the target Render gives you.
   - **WWW**: **CNAME** `www` → your service hostname (e.g. `vvvaaa.onrender.com`).
3. Wait for **Verified** in Render, then enable **Force HTTPS**.

## Local preview

```bash
npm start
```

Open http://localhost:3000

## Chat runtime note

The live chat uses `claude.use("db" | "assets" | "user" | "room")`, which is provided when this HTML runs as a **Claude artifact** on the Claude platform. On Render (plain static hosting), the page loads but signing in and messaging require that runtime. The `types/` folder documents those APIs for development.
