import path from "node:path";

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Upload filenames: UUID + optional short extension from multer */
export const SAFE_MEDIA_KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(\.[a-zA-Z0-9._-]{0,12})?$/i;

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "application/pdf",
  "text/plain",
]);

export function isUuid(id) {
  return typeof id === "string" && UUID_RE.test(id);
}

export function normalizeMediaKey(key) {
  if (key == null || key === "") return null;
  const base = path.basename(String(key));
  return SAFE_MEDIA_KEY.test(base) ? base : null;
}

export function resolveUploadPath(uploadDir, key) {
  const base = normalizeMediaKey(key);
  if (!base) return null;
  const filePath = path.join(uploadDir, base);
  const resolved = path.resolve(filePath);
  const root = path.resolve(uploadDir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  return resolved;
}

export function safeContentType(kind) {
  const k = String(kind || "")
    .toLowerCase()
    .split(";")[0]
    .trim();
  if (ALLOWED_MIME.has(k)) return k;
  return "application/octet-stream";
}

export function isAllowedPushEndpoint(endpoint) {
  try {
    const u = new URL(String(endpoint));
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1") {
      return false;
    }
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
    const allowed =
      host.endsWith(".googleapis.com") ||
      host.endsWith(".mozilla.com") ||
      host.endsWith(".push.apple.com") ||
      host === "web.push.apple.com" ||
      host.endsWith(".notify.windows.com") ||
      host.endsWith(".windows.com");
    return allowed;
  } catch {
    return false;
  }
}

export function sanitizeExternalMediaUrl(media) {
  if (media == null || media === "") return null;
  const s = String(media).trim().slice(0, 2048);
  if (/^https:\/\//i.test(s)) return s;
  return null;
}
