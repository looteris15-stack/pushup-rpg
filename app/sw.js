// Keeps a copy of the game on the phone so it starts fast and works with no signal.
// - Game files (the shell, SHELL_FILES): one saved release, used at once, even with a weak signal or a
//   broken server. A new release is saved as a whole in the background (if any file fails, it isn't
//   installed and the old one stays), then waits until every game window is closed, so an open fight
//   keeps the release it started with. The next launch uses the new one.
//   Game files only ever come from this helper's own release, never one by one from elsewhere. If a saved
//   file goes missing (storage trouble), a launch gets a repair page instead of a broken game: a waiting
//   update takes over now, or the release is downloaded again as a whole. The save is never touched.
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
const SHELL_URLS = SHELL_FILES.map(f => new URL(f, self.location).href);
const NET_MS = 5000;     // the repair: the most each download step may take
const UPDATE_MS = 20000; // the repair: the most a newer release may take to install

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

self.addEventListener("message", e => {
  const d = e.data || {};
  // the page asks to save all monster pictures ahead of time, so the map has them offline
  if (d.type === "warm" && Array.isArray(d.urls)) e.waitUntil(warm(d.urls));
  // asked by an older release's repair (below) while this one waits: take over now
  else if (d.type === "takeOver") e.waitUntil(self.skipWaiting());
  // the repair page asks to repair this release; the answer goes back on its port
  else if (d.type === "repair" && e.ports[0]) e.waitUntil(repair().catch(() => ({ ok: false })).then(r => e.ports[0].postMessage(r)));
});

async function warm(urls) {
  const c = await caches.open(IMG);
  for (const u of urls) {
    try { if (!(await c.match(u))) { const r = await fetch(u); if (r.ok) await c.put(u, r); } } catch { /* offline: try next time */ }
  }
}

const key = req => new URL(req.url).href.split("#")[0];

// which release file a link asks for ("./" for the folder itself), whatever its ?query; null if none
function shellFile(url) {
  const rel = url.pathname.slice(BASE.length);
  const f = rel === "" ? "./" : rel;
  return SHELL_FILES.includes(f) ? f : null;
}

// a game file, only ever from this helper's own saved release (a page keeps its own link, so launch flags
// like ?debug still work). A launch while that release is missing a file gets the repair page instead, so
// the game never starts with a file missing or with files from two releases.
async function fromRelease(file, req) {
  if (req.mode === "navigate" && !(await complete())) return repairPage();
  return (await caches.match(new URL(file, self.location).href, { cacheName: SHELL })) || unavailable();
}

async function complete() {
  const have = new Set((await (await caches.open(SHELL)).keys()).map(r => r.url));
  return SHELL_URLS.every(u => have.has(u));
}

const unavailable = () => new Response("Pushup RPG: this game file is missing on this phone. Close the game and open it again.",
  { status: 504, headers: { "Content-Type": "text/plain; charset=utf-8" } });

// The repair, always to one whole release:
// 1. a newer release waiting for the game windows to close takes over now (it needs no network);
// 2. else, if the server still has this release (its sw.js has this SHELL_V before and after), all of this
//    release's files are downloaded again and saved together;
// 3. else (the server has another release) that one is installed as a whole, the normal update way, and
//    takes over. No signal: the repair page says so and offers to try again.
async function repair() {
  if (await complete()) return { ok: true, how: "repaired" };
  if (takeOver(await settled(self.registration.installing) || self.registration.waiting)) return { ok: true, how: "update" };
  const before = await serverRelease();
  if (before === null) return { ok: false };
  if (before === SHELL_V) {
    const files = await download();
    if (await serverRelease() === SHELL_V) {
      const c = await caches.open(SHELL);
      await Promise.all(files.map(([u, r]) => c.put(u, r)));
      return { ok: await complete(), how: "repaired" };
    }
  }
  await Promise.race([self.registration.update(), new Promise((_, no) => setTimeout(() => no(new Error("update took too long")), UPDATE_MS))]);
  return takeOver(await settled(self.registration.installing) || self.registration.waiting) ? { ok: true, how: "update" } : { ok: false };
}

// a release that is still installing: wait until it is installed (or failed)
function settled(w) {
  if (!w || w.state !== "installing") return Promise.resolve(w && w.state !== "redundant" ? w : null);
  return new Promise(done => {
    const t = setTimeout(() => done(null), UPDATE_MS);
    w.addEventListener("statechange", () => { if (w.state !== "installing") { clearTimeout(t); done(w.state === "redundant" ? null : w); } });
  });
}

function takeOver(w) {
  if (!w || w.state !== "installed") return false;
  w.postMessage({ type: "takeOver" });
  return true;
}

async function timed(work) {
  const stop = new AbortController(), timer = setTimeout(() => stop.abort(), NET_MS);
  try { return await work(stop.signal); } finally { clearTimeout(timer); }
}

// the SHELL_V of the release on the server now (null: no answer)
async function serverRelease() {
  try {
    const text = await timed(async signal => (await fetch(self.location.href, { cache: "no-store", signal })).text());
    return +(/const SHELL_V = (\d+);/.exec(text) || [])[1] || null;
  } catch { return null; }
}

// every file of the release, read to the end (fails if any file fails or it all takes too long)
function download() {
  return timed(signal => Promise.all(SHELL_FILES.map(async f => {
    const res = await fetch(new Request(f, { cache: "reload" }), { signal });
    if (!res.ok) throw new Error(`${f}: ${res.status}`);
    return [new URL(f, self.location).href, new Response(await res.blob(), res)];
  })));
}

// shown instead of the game while this phone's saved release is missing a file; it asks this helper to
// repair it, then loads the game again
function repairPage() {
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0b0f0d"><title>Pushup RPG</title>
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0f0d; color: #eef3ec; font: 17px/1.45 system-ui, sans-serif; }
main { max-width: 22rem; padding: 24px; text-align: center; }
button { font: inherit; font-weight: 700; padding: 12px 22px; border: 0; border-radius: 10px; background: #6fe08a; color: #0b0f0d; }
</style></head>
<body><main id="recovery">
<h1>Repairing the game</h1>
<p id="msg"></p>
<button id="again" type="button" hidden>Try again</button>
</main>
<script>
const msg = document.getElementById("msg"), again = document.getElementById("again"), sw = navigator.serviceWorker;
const SAFE = " Your progress is safe.";
async function repair() {
  again.hidden = true;
  msg.textContent = "Some game files are missing on this phone. Getting them again..." + SAFE;
  const changed = new Promise(r => sw.addEventListener("controllerchange", r, { once: true }));
  const reply = await new Promise(r => {
    if (!sw.controller) return r({ ok: false });
    const ch = new MessageChannel();
    ch.port1.onmessage = e => r(e.data || { ok: false });
    sw.controller.postMessage({ type: "repair" }, [ch.port2]);
    setTimeout(() => r({ ok: false }), 45000);
  });
  if (reply.ok && reply.how === "repaired") return location.reload();
  if (reply.ok && reply.how === "update" && await Promise.race([changed.then(() => true), new Promise(r => setTimeout(() => r(false), 10000))])) return location.reload();
  msg.textContent = "The game files could not be downloaded. Check the internet connection, then try again." + SAFE;
  again.hidden = false;
}
again.onclick = repair;
repair();
</script></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
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
