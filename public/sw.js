/* Velvet PWA — push + offline shell */
const CACHE = "velvet-v2";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) =>
      c.addAll(["/", "/manifest.webmanifest", "/icons/icon.svg", "/icons/maskable.svg"]),
    ),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/")) return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request).then((r) => r || caches.match("/"))),
  );
});

self.addEventListener("push", (event) => {
  let data = { title: "Velvet", body: "New whisper", icon: "/icons/icon.svg", badge: "/icons/heart-badge.svg" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    /* ignore */
  }
  const isHeart = data.tag === "velvet-heart" || data.data?.kind === "heart";
  event.waitUntil(
    self.registration.showNotification(data.title || "Velvet", {
      body: data.body,
      icon: data.icon || "/icons/icon.svg",
      badge: data.badge || "/icons/heart-badge.svg",
      tag: data.tag || "velvet",
      renotify: true,
      vibrate: isHeart ? [80, 40, 80, 40, 120] : [60, 30, 60],
      data: data.data || { url: "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          c.focus();
          return;
        }
      }
      if (clients.openWindow) return clients.openWindow(target);
    }),
  );
});
