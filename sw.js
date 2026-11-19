const CACHE = "zerkaltse-v2";
const SHELL = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest", "apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png"];
const CLIPS = Array.from({ length: 18 }, (_, i) => "audio/" + String(i + 1).padStart(2, "0") + ".m4a");
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll([...SHELL, ...CLIPS])).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then((r) => { if (r.status === 200) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); } return r; })
      .catch(() => caches.match(e.request))
  );
});
