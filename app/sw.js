// Keeps a copy of the game on the phone so it starts fast and works with no signal.
// - Game files: always try the internet first (so updates show right away), fall back to the copy
//   when offline or when the signal is so weak it takes over 3 s.
// - Monster pictures: show the saved copy, refresh it in the background.
// - Body tracking library, its model and the font: these links never change, so save once, reuse forever.
// The save (/api/save on the PC server) is never touched.
const V = 1;
const SHELL = `rpg-shell-v${V}`, IMG = `rpg-img-v${V}`, LIB = `rpg-lib-v${V}`;
const KEEP = [SHELL, IMG, LIB];
const SHELL_FILES = ["./", "index.html", "style.css", "game.js", "core.js", "data.js", "manifest.webmanifest", "icons/icon-192.png"];
const LIB_HOSTS = ["cdn.jsdelivr.net", "storage.googleapis.com", "fonts.googleapis.com", "fonts.gstatic.com"];
const BASE = new URL("./", self.location).pathname; // e.g. /pushup-rpg/app/

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL)
    .then(c => c.addAll(SHELL_FILES.map(f => new Request(f, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith("rpg-") && !KEEP.includes(k)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (!url.pathname.startsWith(BASE) || url.pathname.includes("/api/")) return;
    if (url.pathname.startsWith(BASE + "img/")) e.respondWith(savedThenRefresh(e, req, IMG));
    else e.respondWith(internetFirst(req));
  } else if (LIB_HOSTS.includes(url.host)) {
    e.respondWith(savedForever(req));
  }
});

// the page asks to save all monster pictures ahead of time, so the map has them offline
self.addEventListener("message", e => {
  if (!e.data || e.data.type !== "warm" || !Array.isArray(e.data.urls)) return;
  e.waitUntil(caches.open(IMG).then(async c => {
    for (const u of e.data.urls) {
      try { if (!(await c.match(u))) { const r = await fetch(u); if (r.ok) await c.put(u, r); } } catch { /* offline: try next time */ }
    }
  }));
});

const key = req => new URL(req.url).href.split("#")[0];

async function internetFirst(req) {
  const cache = await caches.open(SHELL);
  const net = fetch(req.url, { cache: "no-cache", credentials: "same-origin" }).then(res => {
    if (res.ok) cache.put(key(req), res.clone());
    return res;
  });
  const saved = await cache.match(key(req), { ignoreSearch: true });
  if (!saved) return net;
  // weak signal: don't make the player wait more than 3 s when a copy is ready
  const slow = new Promise(r => setTimeout(() => r(saved), 3000));
  return Promise.race([net.catch(() => saved), slow]);
}

async function savedThenRefresh(e, req, name) {
  const cache = await caches.open(name);
  const saved = await cache.match(key(req), { ignoreSearch: true });
  const net = fetch(req).then(res => { if (res.ok) cache.put(key(req), res.clone()); return res; });
  if (saved) { e.waitUntil(net.catch(() => {})); return saved; }
  return net;
}

async function savedForever(req) {
  const cache = await caches.open(LIB);
  const saved = await cache.match(req, { ignoreVary: true });
  // a copy saved without CORS can't answer a CORS request, so fetch that one again
  if (saved && !(saved.type === "opaque" && req.mode === "cors")) return saved;
  const res = await fetch(req);
  // opaque = a cross-site file loaded without CORS (still fine to reuse)
  if (res.ok || res.type === "opaque") cache.put(req, res.clone());
  return res;
}
