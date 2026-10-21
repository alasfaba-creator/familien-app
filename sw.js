// Service Worker: offline-fähige App-Hülle und Push-Benachrichtigungen.
const CACHE = "familie-v1";
const SHELL = [
  "./", "index.html", "styles.css", "app.js", "config.js", "products.js",
  "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Eigene Dateien: erst Netzwerk (damit Updates sofort ankommen), sonst Cache.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin === location.origin) {
    e.respondWith(fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })));
  } else if (url.hostname === "cdn.jsdelivr.net") {
    e.respondWith(caches.match(e.request).then((hit) => hit ?? fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    })));
  }
});

self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data.json(); } catch { data = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(data.title ?? "Familien-App", {
    body: data.body ?? "",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: data.tab || "familie",
    renotify: true,
    data: { tab: data.tab ?? "" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const tab = e.notification.data?.tab ?? "";
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if ("focus" in c) { c.postMessage({ tab }); return c.focus(); }
    }
    return self.clients.openWindow(tab ? `./?tab=${tab}` : "./");
  })());
});
