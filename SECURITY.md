# Velvet security model

## What we protect

| Layer | Control |
|--------|---------|
| **In transit** | HTTPS (Render + Neon), TLS to Postgres |
| **Sessions** | `httpOnly`, `Secure`, `SameSite=Strict` cookie — not in JavaScript storage |
| **Room password** | Checked only on the server (`CHAT_PASSWORD`); not embedded for API mode |
| **Message text** | AES-256-GCM at rest in Postgres (`MESSAGE_ENCRYPTION_KEY` or derived from `CHAT_PASSWORD`) |
| **Media files** | Encrypted on disk; served only after session auth; view-once deleted after open |
| **API** | Auth required; rate limits; `no-store` cache; Helmet security headers + CSP |
| **Browser** | `sessionStorage` for display name only (clears when tab ends); `no-referrer` |

Set on Render:

```bash
# 32-byte key: openssl rand -base64 32
MESSAGE_ENCRYPTION_KEY=<base64>
CHAT_PASSWORD=<strong room password>
DATABASE_URL=<Neon pooled URL>
```

## What we cannot guarantee

Any chat member who can **see** a message can copy it (screenshot, screen recorder, another device, browser devtools, network on a compromised device). **No website can promise “zero extraction.”**

Velvet reduces casual leakage: encrypted DB dumps, no public upload URLs, view-once media, server-only secrets, and no long-lived tokens in `localStorage`.

## Operator duties

- Use a **strong** `CHAT_PASSWORD` and unique `MESSAGE_ENCRYPTION_KEY`.
- Rotate keys if the room password is shared widely (re-encrypt requires migration).
- Keep Render and Neon access limited to you.
