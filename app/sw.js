// Keeps a copy of the game on the phone so it starts fast and works with no signal.
// - Game files (the shell, SHELL_FILES): one saved release, used at once, even with a weak signal or a
//   broken server. A new release is saved as a whole in the background (if any file fails, it isn't
//   installed and the old one stays), then waits until every game window is closed, so an open fight
//   keeps the release it started with. The next launch uses the new one.
//   RELEASE RULE: raise SHELL_V whenever a release changes any of these files (or the list), otherwise
//   phones keep the old release.
// - Monster pictures: show the saved copy, refresh it in the background.
// - Body tracking library, its model and the font: these links never change, so save once, reuse forever.
//   Pictures and tracking files are kept across releases.
// The save (/api/save on the PC server) is never touched.
const SHELL_V = 2;
const SHELL = `rpg-shell-v${SHELL_V}`, IMG = "rpg-img-v1", LIB = "rpg-lib-v1";
const KEEP = [SHELL, IMG, LIB];
const SHELL_FILES = ["./", "index.html", "style.css", "game.js", "core.js", "data.js", "manifest.webmanifest", "icons/icon-192.png"];
const LIB_HOSTS = ["cdn.jsdelivr.net", "storage.googleapis.com", "fonts.googleapis.com", "fonts.gstatic.com"];
const BASE = new URL("./", self.location).pathname; // e.g. /pushup-rpg/app/
const MISS_MS = 5000; // a shell file missing from the saved release: the most it may wait for the network

// the whole release or nothing: addAll() fails (and this release isn't installed) if any file does
self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES.map(f => new Request(f, { cache: "reload" })))));
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
    else if (shellFile(url)) e.respondWith(fromRelease(shellFile(url), req));
    // any other file here isn't part of a release: the network, as without this helper
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

// which release file a link asks for ("./" for the folder itself), whatever its ?query; null if none
function shellFile(url) {
  const rel = url.pathname.slice(BASE.length);
  const f = rel === "" ? "./" : rel;
  return SHELL_FILES.includes(f) ? f : null;
}

// the saved file (a page keeps its own link, so launch flags like ?debug still work)
async function fromRelease(file, req) {
  return (await caches.match(new URL(file, self.location).href, { cacheName: SHELL })) || fromNetwork(req);
}

// not in the saved release (rare: storage cleared): the network, for at most MISS_MS. Nothing is saved
// from here, so a release is never mixed with files from another one.
async function fromNetwork(req) {
  const stop = new AbortController(), timer = setTimeout(() => stop.abort(), MISS_MS);
  try {
    const res = await fetch(req.url, { cache: "no-cache", credentials: "same-origin", signal: stop.signal });
    return new Response(await res.blob(), res);
  } catch {
    return new Response("Pushup RPG: this file could not be loaded (no connection).", { status: 504, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } finally {
    clearTimeout(timer);
  }
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
