/* shhh PWA — network-first HTML so rebrands reach mobile */
const CACHE = "shhh-v41";
const PREFS_CACHE = "shhh-prefs";
const PREFS_URL = "/__alert-prefs";
let alertPrefs = { master: true };

async function loadAlertPrefs() {
  try {
    const cache = await caches.open(PREFS_CACHE);
    const res = await cache.match(PREFS_URL);
    if (res) {
      const data = await res.json();
      if (typeof data.master === "boolean") alertPrefs.master = data.master;
    }
  } catch {
    /* ignore */
  }
  return alertPrefs;
}

async function saveAlertPrefs(next) {
  if (typeof next?.master === "boolean") alertPrefs.master = next.master;
  try {
    const cache = await caches.open(PREFS_CACHE);
    await cache.put(
      PREFS_URL,
      new Response(JSON.stringify(alertPrefs), { headers: { "Content-Type": "application/json" } }),
    );
  } catch {
    /* ignore */
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) =>
      c.addAll(["/manifest.webmanifest", "/icons/icon.svg", "/icons/maskable.svg"]),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE && k !== PREFS_CACHE).map((k) => caches.delete(k)));
      await loadAlertPrefs();
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data?.type === "CLEAR_BADGE") {
    event.waitUntil(clearBadge());
  }
  if (event.data?.type === "ALERT_PREFS") {
    event.waitUntil(saveAlertPrefs(event.data));
  }
});

async function setBadge(n) {
  try {
    if (self.registration && "setAppBadge" in self.registration) {
      await self.registration.setAppBadge(n);
    }
  } catch {
    /* ignore */
  }
}

async function clearBadge() {
  try {
    if (self.registration && "clearAppBadge" in self.registration) {
      await self.registration.clearAppBadge();
    }
  } catch {
    /* ignore */
  }
}

function isDocumentRequest(request, url) {
  return (
    request.mode === "navigate" ||
    url.pathname === "/" ||
    url.pathname === "/index.html"
  );
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (isDocumentRequest(event.request, url)) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((c) => c.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then((r) => r || caches.match("/"))),
    );
    return;
  }

  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request)),
  );
});

function shouldRequireInteraction(data) {
  const kind = data?.data?.kind;
  return kind === "mood" || kind === "message" || kind === "note" || kind === "heart";
}

self.addEventListener("push", (event) => {
  let data = { title: "shhh", body: "New whisper", icon: "/icons/icon.svg", badge: "/icons/heart-badge.svg" };
  try {
    if (event.data) {
      try {
        data = { ...data, ...event.data.json() };
      } catch {
        const t = event.data.text();
        if (t) data = { ...data, ...JSON.parse(t) };
      }
    }
  } catch {
    /* ignore */
  }
  const payload = data.data || { url: "/" };
  const requireInteraction = shouldRequireInteraction(data);
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of list) {
        try {
          c.postMessage({ type: "PARTNER_SIGNAL", payload });
        } catch {
          /* ignore */
        }
      }
      const prefs = await loadAlertPrefs();
      const visible = list.some((c) => c.visibilityState === "visible");
      const kind = payload.kind || data.data?.kind || "";
      const tag =
        payload.chatHeadKey ||
        (payload.msgId ? "msg:" + payload.msgId : payload.noteId ? "note:" + payload.noteId : data.tag) ||
        "shhh";
      const skipOs = prefs.master === false || (visible && kind === "message");
      if (!skipOs) {
        const existing = await self.registration.getNotifications({ tag });
        if (!existing.length) {
          const icon = new URL(data.icon || "/icons/icon.svg", self.location.origin).href;
          const badge = new URL(data.badge || "/icons/heart-badge.svg", self.location.origin).href;
          await self.registration.showNotification(data.title || "shhh", {
            body: data.body || "New activity",
            icon,
            badge,
            tag,
            renotify: false,
            requireInteraction,
            silent: false,
            vibrate: requireInteraction ? [80, 40, 80, 40, 140] : [60, 30, 80],
            timestamp: Date.now(),
            data: payload,
          });
        }
      }
      await setBadge(1);
    })(),
  );
});

async function focusClientWithPayload(payload) {
  const list = await clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const c of list) {
    if ("focus" in c) {
      await c.focus();
      c.postMessage({ type: "PARTNER_SIGNAL", payload });
      return true;
    }
  }
  return false;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const payload = event.notification.data || { url: "/" };
  event.waitUntil(
    (async () => {
      const focused = await focusClientWithPayload(payload);
      if (!focused && clients.openWindow) {
        const enc = encodeURIComponent(btoa(JSON.stringify(payload)));
        const url = new URL("/#ch=" + enc, self.location.origin).href;
        await clients.openWindow(url);
      }
      await clearBadge();
    })(),
  );
});
