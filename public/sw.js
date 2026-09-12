// sw.js — service worker: network-first לקבצים סטטיים (כדי שעדכונים תמיד יגיעו),
// נפילה חזרה למטמון כשאין רשת. ה-API תמיד מהרשת.
const CACHE = "share-taxi-v4";
const SHELL = ["/", "/style.css", "/app.js", "/favicon.svg", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // ה-API תמיד מהרשת — מידע חי
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;

  // network-first: תמיד מנסים קודם את הרשת, ומעדכנים את המטמון
  e.respondWith(
    fetch(e.request).then((resp) => {
      if (resp.ok && url.origin === self.location.origin) {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return resp;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match("/")))
  );
});
