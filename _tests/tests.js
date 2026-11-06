// Automated tests for the game. Two copies of the game (iframes A and B) share one save, like two
// tabs or the installed app plus a Chrome tab. Each test starts from the same small save.
// Results go to window.__results; window.__done = true when finished (read by run.ps1).

const GAME = "../app/?debug";
const SAVE = "pushupRPG.save.v1", ALIVE = "pushupRPG.alive";
const BASE = {
  v: 1, rev: 1, savedAt: 0, xp: 50, restUntil: 0, dungeonLockedUntil: 0, dungeonFloor: 1, run: null, unlockedZones: 2,
  tested: true, testResult: 15, wandererDone: "", wanderToday: null, lastBackupAt: Date.now(), backupFights: 0, fightMark: null,
  kills: {}, losses: {}, history: [],
  stats: { pushups: 15, fights: 0, wins: 0, bestSet: 15, biggestKill: 0, deepestFloor: 0 },
  settings: { depth: 63, top: 160, bend: 20, knee: 135, strictV: 3, voice: false, sound: false, camera: "user", model: "lite" },
};

const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000, what = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = fn(); if (v) return v; } catch {} await wait(50); }
  throw new Error("timed out waiting for " + what);
}
function check(cond, msg) { if (!cond) throw new Error(msg); }
const flat = s => (s || "").replace(/\s+/g, " ").trim();
const saved = () => JSON.parse(localStorage.getItem(SAVE));
const isPlainObject = v => !!v && typeof v === "object" && !Array.isArray(v);
// an old-style (PRPG1, no seal) backup code of a save, like ones made before the seal existed
const oldCode = save => "PRPG1." + btoa(JSON.stringify(save));
// a save that passes every backup check (15 pushups in the strength test = 15 XP), so a test changes one thing only
const GOOD = { ...BASE, xp: 15 };
// a new player who never took the strength test: lets number fields be null without breaking other checks
const NEWBIE = { ...BASE, xp: 0, tested: false, testResult: 0, unlockedZones: 1,
  stats: { pushups: 0, fights: 0, wins: 0, bestSet: 0, biggestKill: 0, deepestFloor: 0 } };

// a fresh start: both windows closed, the same save in the browser and on the test server
async function reset(save = BASE) {
  for (const id of ["A", "B"]) document.getElementById(id).src = "about:blank";
  await wait(150);
  localStorage.removeItem(SAVE);
  localStorage.removeItem(ALIVE);
  localStorage.setItem(SAVE, JSON.stringify(save));
  await fetch("/api/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(save) });
}

// opens the game in window A or B and returns helpers to play it
async function open(id) {
  const el = document.getElementById(id);
  el.src = `${GAME}&win=${id}${Date.now()}`;
  await until(() => el.contentWindow.PushupRPG && el.contentDocument.readyState === "complete", 15000, `game in ${id}`);
  await wait(600);
  const w = el.contentWindow, d = el.contentDocument, errors = [];
  w.addEventListener("error", e => errors.push(e.message));
  w.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
  const g = {
    id, w, d, errors,
    get api() { return w.PushupRPG; },
    get state() { return w.PushupRPG.state; },
    get fight() { return w.PushupRPG.fight; },
    text: sel => flat(d.querySelector(sel)?.textContent),
    modal: () => (d.querySelector("#modal").hidden ? "" : flat(d.querySelector("#modal").textContent)),
    closeModal() { const b = d.querySelector('#modal:not([hidden]) [data-action="closeModal"], #modal:not([hidden]) button'); if (b) b.click(); },
    async goto(screen) { g.closeModal(); d.querySelector(`[data-action="goto"][data-to="${screen}"]`).click(); await wait(200); },
    // taps Fight on a map monster; returns once a fight started or something else showed up
    // (not called "fight": that name is the current fight, above)
    async fightMonster(monsterId) {
      await g.goto("map");
      d.querySelector(`.mrow[data-id="${monsterId}"]`).click(); await wait(200);
      const b = [...d.querySelectorAll("#modal button")].find(x => /fight/i.test(x.textContent) && !x.disabled);
      check(b, `no Fight button for ${monsterId}: ${g.modal().slice(0, 80)}`);
      b.click(); await g.settled();
    },
    async enterFloor() { await g.goto("dungeon"); d.querySelector('[data-action="enterFloor"]').click(); await g.settled(); },
    async continueRun() { await g.goto("dungeon"); const b = d.querySelector('[data-action="continueRun"]'); check(b, "no Continue button"); b.click(); await g.settled(); },
    // after tapping: wait until a fight or break is running, or a message is on screen (camera start can take a moment)
    async settled() {
      await until(() => (w.PushupRPG.fight && !w.PushupRPG.fight.over) || w.PushupRPG.rest || g.modal(), 8000, `window ${id} to start or show a message`).catch(() => {});
      await wait(300);
    },
    // which screen is showing
    screen: () => ["camp", "map", "dungeon", "records", "settings", "fight"].find(s => !d.getElementById(s).hidden),
    // tap Fight / Enter floor / Continue without waiting for the start (for startup tests)
    async tapFight(monsterId) {
      await g.goto("map");
      d.querySelector(`.mrow[data-id="${monsterId}"]`).click(); await wait(200);
      [...d.querySelectorAll("#modal button")].find(x => /fight/i.test(x.textContent) && !x.disabled).click();
      await wait(300);
    },
    async tapEnterFloor() { await g.goto("dungeon"); d.querySelector('[data-action="enterFloor"]').click(); await wait(300); },
    async tapContinue() { await g.goto("dungeon"); d.querySelector('[data-action="continueRun"]').click(); await wait(300); },
    // a fake camera picture source (its tracks can be checked for "ended")
    fakeStream() { const c = d.createElement("canvas"); c.width = 64; c.height = 48; c.getContext("2d").fillRect(0, 0, 8, 8); return c.captureStream(5); },
    // the browser's camera question stays open until answer() is called; answer() returns the stream it gave
    slowCamera() {
      let give;
      w.navigator.mediaDevices.getUserMedia = () => new Promise(r => { give = r; });
      return () => { const s = g.fakeStream(); give(s); return s; };
    },
    // the camera starts at once with a fake stream
    fastCamera() { w.navigator.mediaDevices.getUserMedia = async () => g.fakeStream(); },
    // body tracking keeps loading until finish() is called
    slowModel() {
      let done;
      w.PushupRPG.hooks.setModelLoader(() => new Promise(r => { done = r; }));
      return () => done({ lm: { detectForVideo: () => ({ landmarks: [] }), close() {} }, used: "CPU" });
    },
    rep() { try { w.PushupRPG.repEvent({ type: "rep", count: 1, depth: true, downSecs: 3 }); } catch (e) { errors.push("thrown: " + e.message); } },
    async reps(n) { for (let i = 0; i < n; i++) { g.rep(); await wait(40); } await wait(300); },
    // from now on, saving in this window fails like a full or blocked phone storage
    breakStorage() { w.Storage.prototype.setItem = function () { throw new w.DOMException("full", "QuotaExceededError"); }; },
    // clears the current mine floor (3 rooms, skipping the breaks); onLastRep runs just before the final rep
    async clearFloor(onLastRep = () => {}) {
      await g.enterFloor();
      for (let room = 0; room < 3; room++) {
        await until(() => w.PushupRPG.fight && !w.PushupRPG.fight.over, 5000, `room ${room + 1}`);
        await g.reps(w.PushupRPG.fight.total - 1);
        if (room === 2) onLastRep();
        await g.reps(1);
        if (room < 2) { d.querySelector("#btnFightNow").click(); await wait(300); }
      }
    },
    // pastes a backup code in Settings and taps Restore (twice: it asks to confirm); returns the message
    async restoreCode(code) {
      await g.goto("settings");
      d.querySelector("#restoreText").value = code;
      const b = d.querySelector("#btnRestore");
      b.click(); await wait(80);
      if (b.dataset.armed) { b.click(); await wait(300); }
      return g.text("#backupMsg");
    },
    // opens World map, Records and The Old Mine; returns any errors and the screens' text
    async openScreens() {
      const before = errors.length, seen = {};
      for (const s of ["map", "records", "dungeon"]) {
        try { await g.goto(s); } catch (e) { errors.push(`${s}: ${e.message}`); }
        seen[s] = g.text("#" + s);
      }
      return { errors: errors.slice(before), seen };
    },
    // counts the game's atob() and JSON.parse() calls from now on (backup decoding work)
    countDecoding() {
      const atob = w.atob, parse = w.JSON.parse, n = { atob: 0, parse: 0 };
      w.atob = s => { n.atob++; return atob.call(w, s); };
      w.JSON.parse = (...a) => { n.parse++; return parse.apply(w.JSON, a); };
      return n;
    },
    // counts every way the game could read a file's contents (text, bytes, stream, FileReader)
    countFileReads() {
      const n = { reads: 0 };
      for (const k of ["text", "arrayBuffer", "stream", "bytes"]) {
        const f = w.Blob.prototype[k];
        if (f) w.Blob.prototype[k] = function (...a) { n.reads++; return f.apply(this, a); };
      }
      for (const k of ["readAsText", "readAsArrayBuffer", "readAsDataURL", "readAsBinaryString"]) {
        const f = w.FileReader.prototype[k];
        w.FileReader.prototype[k] = function (...a) { n.reads++; return f.apply(this, a); };
      }
      return n;
    },
    // body tracking loads at once (a fake model that never finds anyone; rec counts its frames)
    fastModel(rec) { w.PushupRPG.hooks.setModelLoader(async () => ({ lm: fakeModel(rec), used: "CPU" })); },
    // body tracking keeps loading until done() / fail(); the fake model it gives counts frames in rec
    heldModel(rec) {
      const h = {};
      w.PushupRPG.hooks.setModelLoader(() => new Promise((res, rej) => {
        h.done = () => res({ lm: fakeModel(rec), used: "CPU" }); h.fail = () => rej(new Error("network down"));
      }));
      return h;
    },
    // body tracking loads that wait: every load asked for is kept in ml.loads ({ name, give(used), fail() }).
    // give() hands out a counted fake model ({ id, name, frames, closes }), also kept in ml.models.
    // ml.auto = true: later loads give their model at once
    heldModels() {
      const ml = { loads: [], models: [], auto: false };
      w.PushupRPG.hooks.setModelLoader(name => new Promise((res, rej) => {
        const id = ml.loads.length + 1;
        const load = { name,
          give(used = "CPU") {
            const m = { id, name, frames: 0, closes: 0, detectForVideo() { this.frames++; return { landmarks: [] }; }, close() { this.closes++; } };
            ml.models.push(m); res({ lm: m, used }); return m;
          },
          fail() { rej(new Error("network down")); } };
        ml.loads.push(load);
        if (ml.auto) load.give();
      }));
      return ml;
    },
    // the camera: every request is counted (rec.gum) and every stream kept (rec.streams). hold = true:
    // the next request waits until give() or refuse(errorName); deny = "SomeError": the next request
    // fails at once with it; otherwise a fake stream comes at once
    camera(rec) {
      rec.gum = 0; rec.streams = []; rec.hold = false; rec.deny = "";
      w.navigator.mediaDevices.getUserMedia = () => {
        rec.gum++;
        const make = () => { const s = g.fakeStream(); rec.streams.push(s); return s; };
        if (rec.deny) { const n = rec.deny; rec.deny = ""; return Promise.reject(new w.DOMException(n, n)); }
        if (!rec.hold) return Promise.resolve(make());
        rec.hold = false;
        return new Promise((r, j) => { rec.give = () => r(make()); rec.refuse = n => j(new w.DOMException(n, n)); });
      };
    },
    // the next video.play() waits until rec.playGo() (like a slow camera picture), or fails at rec.playFail()
    holdPlay(rec) {
      const play = w.HTMLVideoElement.prototype.play;
      w.HTMLVideoElement.prototype.play = function () {
        w.HTMLVideoElement.prototype.play = play;
        const p = play.call(this);
        return new Promise((res, rej) => {
          rec.playGo = () => p.then(res, rej);
          rec.playFail = () => { p.catch(() => {}); rej(new w.DOMException("The picture can't play.", "NotAllowedError")); };
        });
      };
    },
    // a fake "keep the screen on" (wake lock). hold = true: answers wait until grantAll(). Records every
    // request (and whether the fight screen was showing then) and every lock handed out
    fakeWakeLock(hold) {
      const wl = { hold, calls: [], sentinels: [], waiting: [] };
      const give = () => { const s = { type: "screen", released: false, release() { this.released = true; return Promise.resolve(); }, addEventListener() {}, removeEventListener() {} }; wl.sentinels.push(s); return s; };
      wl.grantAll = () => { for (const r of wl.waiting.splice(0)) r(give()); };
      wl.grantOldest = () => { const r = wl.waiting.shift(); if (r) r(give()); }; // only the oldest waiting answer
      Object.defineProperty(w.navigator, "wakeLock", { configurable: true, value: {
        request() {
          wl.calls.push({ inFight: !d.getElementById("fight").hidden });
          return wl.hold ? new Promise(r => wl.waiting.push(r)) : Promise.resolve(give());
        },
      } });
      return wl;
    },
    // counts runs of the tracker's frame loop (core.js "loop") from now on, and its starts: a next
    // frame asked for from outside a loop run (startLoop() runs the loop once directly)
    countLoop() {
      const n = { runs: 0, starts: 0 }, raf = w.requestAnimationFrame.bind(w);
      let inLoop = false;
      w.requestAnimationFrame = cb => {
        if (cb.name !== "loop") return raf(cb);
        if (!inLoop) n.starts++;
        return raf(ts => { n.runs++; inLoop = true; try { cb(ts); } finally { inLoop = false; } });
      };
      return n;
    },
    // makes the game hidden (another app, phone locked) or visible again
    setVisible(v) {
      Object.defineProperty(d, "visibilityState", { configurable: true, value: v ? "visible" : "hidden" });
      Object.defineProperty(d, "hidden", { configurable: true, value: !v });
      d.dispatchEvent(new w.Event("visibilitychange"));
    },
    // lets the game's clock (performance.now) jump ahead, like time spent away
    shiftClock() {
      const real = w.performance.now.bind(w.performance), c = { off: 0, skip(ms) { c.off += ms; } };
      w.performance.now = () => real() + c.off;
      return c;
    },
    // records the game's audio engines (AudioContext) from now on: each one made, resume() and suspend()
    // calls, and every sound played (the engine's state then, and when the sound ends)
    trackAudio() {
      const Real = w.AudioContext, rec = { list: [], resumes: 0, suspends: [], tones: [] };
      w.AudioContext = class extends Real {
        constructor(...a) { super(...a); rec.list.push(this); }
        resume() { rec.resumes++; return super.resume(); }
        suspend() { rec.suspends.push({ clock: this.currentTime, wall: performance.now() }); return super.suspend(); }
        createOscillator() {
          const o = super.createOscillator(), ctx = this, stop = o.stop.bind(o);
          o.stop = when => { rec.tones.push({ state: ctx.state, end: when, wall: performance.now() }); return stop(when); };
          return o;
        }
      };
      return rec;
    },
    // picks a file in Settings → Backup → Open backup file; returns the message
    async openFile(parts, name = "backup.txt") {
      const input = d.querySelector("#restoreFile"), dt = new w.DataTransfer();
      dt.items.add(new w.File(parts, name, { type: "text/plain" }));
      input.files = dt.files;
      input.dispatchEvent(new w.Event("change", { bubbles: true }));
      await wait(300);
      return g.text("#backupMsg");
    },
    // taps a backup button and returns the backup text the share menu would get (no real share sheet)
    async backupText(selector) {
      let shared = null;
      w.navigator.canShare = () => true;
      w.navigator.share = async data => { shared = data; };
      d.querySelector(selector).click();
      await until(() => shared, 3000, "the backup to be shared");
      return shared.files ? await shared.files[0].text() : shared.text;
    },
  };
  return g;
}
const close = id => { document.getElementById(id).src = "about:blank"; return wait(200); };
// ---- the font (fonts.googleapis.com / fonts.gstatic.com): run.ps1 answers those requests. Modes:
// "block" (fail at once, the default), "fail" (as if offline), "hold" for ms, then "ok" (a stand-in
// Oxanium with other letter widths) or "fail". Each call also clears run.ps1's list of seen font
// requests and of console errors.
async function fontMode(mode, ms = 0, then = "fail") {
  const r = await fetch(`/__fonts/set?mode=${mode}&ms=${ms}&then=${then}&clear=1`).catch(() => null);
  check(r && r.ok && /json/.test(r.headers.get("content-type") || ""), "the font control is missing: run the tests with _tests\\run.ps1");
  return r.json();
}
const fontStatus = async () => (await fetch("/__fonts/status")).json();
const BLOCKED_HOSTS = /fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|storage\.googleapis\.com/;
// opens the game in a window without waiting for the page to finish loading, and with no offline
// helper in charge (so its requests go out where they can be watched); ready = ms until Camp works
async function openTimed(id, limit = 6000) {
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  const el = document.getElementById(id);
  const t0 = performance.now();
  el.src = `${GAME}&win=${id}${Date.now()}`;
  let ready = null;
  while (performance.now() - t0 < limit) {
    try {
      const d = el.contentDocument;
      if (el.contentWindow.PushupRPG && !d.getElementById("camp").hidden && d.getElementById("campTitle").textContent) { ready = performance.now() - t0; break; }
    } catch {}
    await wait(5);
  }
  return { w: el.contentWindow, d: el.contentDocument, ready };
}
// taps a Camp menu button and the Back button on that screen; false if either didn't work
function campTrip(d, to) {
  d.querySelector(`#camp [data-action="goto"][data-to="${to}"]`).click();
  const went = !d.getElementById(to).hidden;
  d.querySelector(`#${to} [data-action="goto"][data-to="camp"]`).click();
  return went && !d.getElementById("camp").hidden;
}
const frame = w => new Promise(r => w.requestAnimationFrame(() => w.requestAnimationFrame(r)));
// a fake body-tracking model that never finds anyone. rec (optional) counts the frames it was given,
// with what was true at each: was the fight already marked ready, and which camera stream was showing
const fakeModel = rec => ({
  detectForVideo(video) {
    if (rec) { rec.frames = (rec.frames || 0) + 1; (rec.seen ||= []).push({ ready: !!video.ownerDocument.defaultView.PushupRPG.fight, stream: video.srcObject }); }
    return { landmarks: [] };
  },
  close() {},
});
const A_video = d => d.querySelector("#video").srcObject;
const heldLocks = wl => wl.sentinels.filter(x => !x.released).length;
const inFightAsks = wl => wl.calls.filter(c => c.inFight).length;
// everything that is on or counted while the game is hidden, over ms
async function whileHidden(g, cam, wl, loop, inf, ms = 400) {
  const r0 = loop.runs, f0 = inf.frames || 0, a0 = inFightAsks(wl);
  await wait(ms);
  return { liveTracks: liveTracks(cam.streams), shown: !!A_video(g.d), locks: heldLocks(wl), lockAsks: inFightAsks(wl) - a0,
    loopRuns: loop.runs - r0, frames: (inf.frames || 0) - f0, fightReady: !!g.fight };
}
const liveTracks = streams => streams.filter(Boolean).flatMap(s => s.getTracks()).filter(t => t.readyState === "live").length;
// ---- body tracking: picks a model in Settings (this asks for it to load, like a player would)
function pickModel(g, v) { const s = g.d.querySelector("#sModel"); s.value = v; s.dispatchEvent(new g.w.Event("change")); }
// the game loads body tracking by itself 1.5 s after it opens (the warm-up). This lets that load fail
// at once (as if offline) and waits until it has happened, so a test's own loads are the only ones
async function skipWarmUp(g) {
  g.api.hooks.setModelLoader(() => Promise.reject(new Error("warm-up skipped")));
  await wait(1300);
}
const byModel = (ml, k) => Object.fromEntries(ml.models.map(m => [`${m.name}#${m.id}`, m[k]]));
// ---- the game's own model loading, with a stand-in library: run.ps1 answers the library link with
// fixtures/fake-vision.mjs while this is "fake" (and blocks it again with "block")
const LIB_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
async function libMode(mode) {
  const r = await fetch(`/__lib/set?mode=${mode}`).catch(() => null);
  check(r && r.ok && /json/.test(r.headers.get("content-type") || ""), "the library control is missing: run the tests with _tests\\run.ps1");
}
// opens the game with its warm-up load skipped and its own loading code on (with the stand-in library)
async function openRealLoader(id, fake) {
  const g = await open(id);
  await skipWarmUp(g);
  g.api.hooks.setModelLoader(null);
  g.w.__fakeVision = { log: [], ...fake };
  return g;
}
// model downloads by the page (fetch of a pose_landmarker_ link): each one recorded (url, start, end);
// it answers after ms with n bytes
function slowModelNet(g, ms = 400, n = 1000) {
  const net = { fetches: [] }, real = g.w.fetch;
  g.w.fetch = function (u, init) {
    const url = String((u && u.url) || u);
    if (!url.includes("pose_landmarker_")) return real.apply(this, arguments);
    const f = { url, start: g.w.performance.now(), end: null, init: init ? JSON.stringify(init) : "" };
    net.fetches.push(f);
    return new Promise(r => setTimeout(r, ms)).then(() => { f.end = g.w.performance.now(); return new g.w.Response(new Uint8Array(n)); });
  };
  return net;
}
const FULL = { ...BASE, settings: { ...BASE.settings, model: "full" } };
// ---- sound: the base save has sound off; this one has it on (voice stays off)
const SOUND_ON = { ...BASE, settings: { ...BASE.settings, sound: true } };
// does the audio engine's clock still move (it stops while the engine sleeps)?
async function clockMoves(ctx, ms = 300) { const a = ctx.currentTime; await wait(ms); return ctx.currentTime > a; }
const tapFlee = async (g, ms = 300) => { g.d.querySelector("#btnFlee").click(); await wait(ms); };
const tapSound = async (g, ms = 100) => { g.d.querySelector("#btnSound").click(); await wait(ms); };
// n characters of base64 made from random bytes (looks like a backup code, but holds no save)
function randomB64(n) {
  const bytes = new Uint8Array(Math.ceil(n * 3 / 4));
  for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536));
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin).slice(0, n);
}
// ---- body-tracking frames for the rep counter (30 frames per second, like a phone)
const FRAME_MS = 33;
const plank = elbow => ({ elbow, bodyBend: 5, bendDir: "sag", knee: 170, horizontal: true, visible: true });
const DOWN = [170, 168, 165, 160, 150, 140, 120, 100, 80, 65, 58, 55];      // from straight arms to the bottom
const UP = [55, 60, 75, 100, 130, 155, 165, 170];                           // back up to straight arms
const LOCKOUT = [170, 170, 171, 170];                                       // seen again with straight arms
const unseen = ms => Array.from({ length: Math.round(ms / FRAME_MS) }, () => null); // nobody seen for about ms
const hold = (elbow, ms) => Array.from({ length: Math.round(ms / FRAME_MS) }, () => elbow); // still for about ms
// straight arms, then down to the bottom in about secs, then back up (a "slow rep")
function slowRep(secs) {
  const n = Math.round(secs * 1000 / FRAME_MS);
  return [170, 170, 170, ...Array.from({ length: n + 1 }, (_, i) => 160 - 105 * i / n), ...UP];
}
const COUNTER_CFG = () => ({ depth: 63, top: 160, bend: 20, knee: 135 });
// feeds frames straight into a rep counter of its own (no game); returns its events and the next time
function feed(counter, frames, t = 0) {
  const out = [];
  for (const e of frames) { for (const ev of counter.update(e == null ? null : plank(e), t)) out.push({ ...ev, t }); t += FRAME_MS; }
  return { out, t };
}
// frames of an unfinished rep the game still keeps: the counter's rep in progress and the depth meter's copy
function keptFrames(g) {
  const held = new Set([g.api.counter.cycle, g.api.meterCycle].filter(Boolean));
  return [...held].reduce((n, c) => n + c.trace.length, 0);
}
// feeds frames (elbow angles, null = nobody seen) through the game's real counter; returns the next time
function playFrames(g, t, frames) {
  for (const e of frames) { g.api.frame(e == null ? null : plank(e), t); t += FRAME_MS; }
  return t;
}

// leaving before a fight really began must cost nothing: no loss, no rest, no mine lock, no leftover fight
function noPenalty(g, { run = false } = {}) {
  const s = saved();
  check(Object.keys(s.losses || {}).length === 0, "a loss was recorded");
  check(!(s.restUntil > Date.now()), "a 10-hour rest started");
  check(!(s.dungeonLockedUntil > Date.now()), "the mine got locked");
  check(!s.fightMark, "an unfinished fight was left in the save");
  if (!run) check(!s.run, "a mine run was left behind");
  check(!localStorage.getItem(ALIVE), "the 'fight running' signal was left on (other windows would be blocked)");
  check(g.errors.length === 0, "errors: " + g.errors.join(" | "));
}

// ---------------------------------------------------------------- Bug #1: a second window
const tests = [
  ["#1a A second window can't end a mine fight that is still going", async () => {
    await reset();
    const A = await open("A");
    await A.enterFloor();
    check(A.fight, "A did not start the mine fight");
    await A.reps(1);
    const B = await open("B");
    await B.continueRun();
    check(/still active in another/i.test(B.modal()), `B should be blocked, it showed: "${B.modal().slice(0, 90)}"`);
    check(!B.fight, "B started a fight");
    const s = saved();
    check(s.run && s.run.floor === 1, "the mine run was cleared");
    check(!(s.dungeonLockedUntil > Date.now()), "the mine got locked");
    check(!(s.restUntil > Date.now()), "a rest timer started");
    check(Object.keys(s.losses || {}).length === 0, "a loss was recorded");
    await A.reps(1);
    check(A.errors.length === 0, "A had errors: " + A.errors.join(" | "));
    check(A.fight && A.fight.reps === 2, "A's fight did not go on");
  }],
  ["#1b A second window can't start any fight while one is open", async () => {
    await reset();
    const A = await open("A");
    await A.fightMonster("field-mouse");
    check(A.fight, "A did not start");
    await A.reps(1);
    const B = await open("B");
    await B.fightMonster("cave-rat");
    check(/still active in another/i.test(B.modal()), `Fight in B should be blocked, it showed: "${B.modal().slice(0, 90)}"`);
    check(!B.fight, "B started a fight");
    await B.enterFloor();
    check(/still active in another/i.test(B.modal()), "Enter floor in B should be blocked");
    check(Object.keys(saved().losses || {}).length === 0, "a loss was recorded");
    check(!saved().run, "B created a mine run");
  }],
  ["#1c A second window can't take over a mine break", async () => {
    await reset();
    const A = await open("A");
    await A.enterFloor();
    const hp = A.fight.total;
    await A.reps(hp); // room 1 won: the 90 s break starts
    check(A.api.rest, `A is not on a break (room HP ${hp}; fight now: ${A.fight ? A.fight.m.name + " " + A.fight.reps + " reps, over " + A.fight.over : "none"}; screen text: "${A.modal().slice(0, 70)}"; errors: ${A.errors.join(" | ")})`);
    const B = await open("B");
    await B.continueRun();
    check(/still active in another/i.test(B.modal()), `B should be blocked, it showed: "${B.modal().slice(0, 90)}"`);
    check(!B.fight && !B.api.rest, "B started the run too");
    check(saved().run && saved().run.room === 1, "the run changed");
  }],
  ["#1d A really closed game still counts as given up", async () => {
    await reset();
    const A = await open("A");
    await A.fightMonster("forest-goblin");
    await A.reps(2);
    await close("A");
    // the closed window's alive signal stops; pretend 11 s have passed
    const alive = JSON.parse(localStorage.getItem(ALIVE) || "null");
    if (alive) localStorage.setItem(ALIVE, JSON.stringify({ ...alive, at: Date.now() - 11000 }));
    const B = await open("B");
    await until(() => /closed during the fight/i.test(B.modal()), 4000, "the loss for the closed fight");
    check(saved().losses["forest-goblin"] === 1, "the loss was not recorded");
    check(saved().restUntil > Date.now(), "no rest timer");
  }],
  ["#1e If the mine run disappears mid-fight, the fight stops cleanly", async () => {
    await reset();
    const A = await open("A");
    await A.enterFloor();
    await A.reps(1);
    // another window (or device) cleared the run: a newer save without it
    const s = saved();
    localStorage.setItem(SAVE, JSON.stringify({ ...s, rev: s.rev + 5, run: null, fightMark: null })); // A hears about it
    await wait(500);
    A.rep();
    await wait(400);
    check(A.errors.length === 0, "A crashed: " + A.errors.join(" | "));
    check(!A.fight || A.fight.over, "A's fight is still running");
    check(/another window|changed in another/i.test(A.modal()), `A should explain what happened, it showed: "${A.modal().slice(0, 90)}"`);
  }],
  ["#1f A finished fight frees the other window right away", async () => {
    await reset();
    const A = await open("A");
    await A.fightMonster("field-mouse");
    await A.reps(3); // win
    check(/defeated/i.test(A.modal()), "A did not win");
    const B = await open("B");
    await B.fightMonster("cave-rat");
    check(B.fight && !B.fight.over, `B could not start: "${B.modal().slice(0, 90)}"`);
  }],
  // ---------------------------------------------------------------- Bug #2: saving fails
  ["#2a Safe room: when saving fails, it says so and keeps the floor in this session", async () => {
    await reset();
    const A = await open("A");
    const xp0 = A.state.xp;
    await A.clearFloor(() => A.breakStorage());
    const text = A.modal();
    check(/floor 1 cleared/i.test(text), `no safe-room screen: "${text.slice(0, 80)}"`);
    check(!/is saved/i.test(text), `it still claims the floor was saved: "${text.slice(0, 160)}"`);
    check(/not saved|saving failed|could not save/i.test(text), `no clear saving warning: "${text.slice(0, 160)}"`);
    check(/backup/i.test(text), "it doesn't tell the player to make a backup");
    // the progress stays in this session
    check(A.state.dungeonFloor === 2 && A.state.stats.deepestFloor === 1, "the cleared floor was dropped from memory");
    check(A.state.xp > xp0, "the XP was dropped from memory");
    check(saved().dungeonFloor === 1, "test setup: storage should really have failed");
    // ...and a backup made now carries it
    const backup = await A.backupText('#modal [data-action="backupNow"]');
    const code = backup.match(/PRPG2\.([A-Za-z0-9+/=]+)\./);
    check(code, "the warning has no working backup button");
    const inBackup = JSON.parse(atob(code[1]));
    check(inBackup.dungeonFloor === 2 && inBackup.xp === A.state.xp, "the backup doesn't have the cleared floor");
  }],
  ["#2b A normal win says so too when saving fails", async () => {
    await reset();
    const A = await open("A");
    await A.fightMonster("field-mouse");
    await A.reps(2);
    A.breakStorage();
    await A.reps(1);
    const text = A.modal();
    check(/defeated/i.test(text), `no victory screen: "${text.slice(0, 80)}"`);
    check(/not saved|saving failed|could not save/i.test(text), `no saving warning on the victory screen: "${text.slice(0, 160)}"`);
    check(A.state.stats.wins === 1, "the win was dropped from memory");
  }],
  ["#2c When saving works, the safe room still says the floor is saved", async () => {
    await reset();
    const A = await open("A");
    await A.clearFloor();
    const text = A.modal();
    check(/floor 1 is saved/i.test(text), `missing "Floor 1 is saved": "${text.slice(0, 160)}"`);
    check(!/not saved|saving failed|could not save/i.test(text), "a saving warning showed although saving worked");
    check(saved().dungeonFloor === 2, "the floor was not saved");
  }],
  // ---------------------------------------------------------------- Bug #3: null fields in backups and saves
  ["#3a A backup with kills: null restores, and World map + Records open", async () => {
    await reset();
    const A = await open("A");
    const msg = await A.restoreCode(oldCode({ ...GOOD, kills: null }));
    check(/restored/i.test(msg), `the backup was refused: "${msg}"`);
    check(isPlainObject(A.state.kills) && isPlainObject(saved().kills), `kills was not repaired: ${JSON.stringify(A.state.kills)}`);
    const r = await A.openScreens();
    check(r.errors.length === 0, "a screen crashed: " + r.errors.join(" | "));
    check(A.d.querySelectorAll("#mapZones .mrow").length > 0, "the World map shows no monsters");
  }],
  ["#3b The same null fields in a backup are all repaired (losses, areas, mine floor, numbers)", async () => {
    await reset();
    const A = await open("A");
    const broken = { ...NEWBIE, kills: null, losses: null, unlockedZones: null, dungeonFloor: null, testResult: null,
      stats: { pushups: null, fights: null, wins: null, bestSet: null, biggestKill: null, deepestFloor: null } };
    const msg = await A.restoreCode(oldCode(broken));
    check(/restored/i.test(msg), `the backup was refused: "${msg}"`);
    const s = saved();
    check(isPlainObject(s.losses), "losses was not repaired");
    check(s.unlockedZones >= 1 && s.dungeonFloor >= 1, `areas/floor not repaired: ${s.unlockedZones} / ${s.dungeonFloor}`);
    check(Number.isFinite(s.testResult) && Number.isFinite(s.stats.deepestFloor) && Number.isFinite(s.stats.biggestKill), "a number was left as null");
    const r = await A.openScreens();
    check(r.errors.length === 0, "a screen crashed: " + r.errors.join(" | "));
    check(A.d.querySelectorAll("#mapZones .zone:not(.locked)").length >= 1, "every area shows as locked");
    check(!Object.values(r.seen).some(t => /\bnull\b/.test(t)), "a screen shows the word null");
  }],
  ["#3c A save that is already broken opens cleanly when the game starts", async () => {
    await reset({ ...BASE, kills: null, losses: null, unlockedZones: null, dungeonFloor: null, testResult: null, stats: { ...BASE.stats, deepestFloor: null } });
    const A = await open("A");
    const r = await A.openScreens();
    check(r.errors.length === 0, "a screen crashed: " + r.errors.join(" | "));
    check(isPlainObject(A.state.kills) && isPlainObject(A.state.losses), "kills/losses were not repaired in memory");
    check(A.d.querySelectorAll("#mapZones .zone:not(.locked)").length >= 1, "every area shows as locked");
    check(!Object.values(r.seen).some(t => /\bnull\b/.test(t)), "a screen shows the word null");
  }],
  ["#3d Malformed kills are refused before anything is written", async () => {
    await reset();
    const A = await open("A");
    for (const kills of [[], "abc", 123, { "field-mouse": -1 }, { "field-mouse": 1.5 }, { "field-mouse": "3" }, { "field-mouse": null }]) {
      const before = localStorage.getItem(SAVE);
      const msg = await A.restoreCode(oldCode({ ...GOOD, kills }));
      check(!/restored/i.test(msg), `kills = ${JSON.stringify(kills)} was accepted: "${msg}"`);
      check(localStorage.getItem(SAVE) === before, `kills = ${JSON.stringify(kills)}: the save changed`);
    }
    for (const losses of [[], 7]) {
      const msg = await A.restoreCode(oldCode({ ...GOOD, losses }));
      check(!/restored/i.test(msg), `losses = ${JSON.stringify(losses)} was accepted`);
    }
    // the good save itself is accepted, so the refusals above are about kills / losses only
    check(/restored/i.test(await A.restoreCode(oldCode(GOOD))), "test setup: the good save was refused");
  }],
  // ---------------------------------------------------------------- Bug #4: stuck while the fight starts
  ["#4a Back works while the camera question is unanswered, and a late camera is switched off", async () => {
    await reset();
    const A = await open("A");
    const answer = A.slowCamera();
    await A.tapFight("field-mouse");
    check(A.screen() === "fight" && /starting camera/i.test(A.text("#banner")), "test setup: not on the starting screen");
    const back = A.d.querySelector("#btnFlee");
    check(!back.hidden && /back|cancel/i.test(back.textContent), `no Back button while the camera starts ("${back.hidden ? "hidden" : back.textContent}")`);
    back.click(); await wait(300);
    check(A.screen() === "map", `Back did not return to the map (on ${A.screen()})`);
    const stream = answer(); // the browser answers the camera question late
    await wait(600);
    check(stream.getTracks().every(t => t.readyState === "ended"), "the late camera was left on");
    check(!A.fight && A.screen() === "map", "the fight started in the background");
    noPenalty(A);
  }],
  ["#4b After 8 s of waiting, a note says why", async () => {
    await reset();
    const A = await open("A");
    const answer = A.slowCamera();
    await A.tapFight("field-mouse");
    await wait(8700);
    const t = A.text("#banner");
    check(/taking longer/i.test(t) && /camera/i.test(t) && /slow connection|download/i.test(t), `no slow-start note after 8 s: "${t}"`);
    A.d.querySelector("#btnFlee").click(); await wait(200);
    answer();
  }],
  ["#4c Back while body tracking loads stops the camera; the model is ignored when it arrives", async () => {
    await reset();
    const A = await open("A");
    A.fastCamera();
    const finishModel = A.slowModel();
    await A.tapFight("field-mouse");
    const stream = await until(() => A.d.querySelector("#video").srcObject, 3000, "the camera to start");
    const back = A.d.querySelector("#btnFlee");
    check(!back.hidden && /back|cancel/i.test(back.textContent), "no Back button while body tracking loads");
    back.click(); await wait(200);
    check(stream.getTracks().every(t => t.readyState === "ended"), "the camera stayed on after Back");
    finishModel(); // body tracking finishes loading after the player left
    await wait(600);
    check(!A.fight && !A.api.trackerRunning && A.screen() === "map", "the fight started after the model loaded");
    noPenalty(A);
  }],
  ["#4d Backing out of a mine start costs nothing (new run and continued run)", async () => {
    await reset();
    let A = await open("A");
    let answer = A.slowCamera();
    await A.tapEnterFloor();
    check(A.screen() === "fight", "test setup: not on the starting screen");
    A.d.querySelector("#btnFlee").click(); await wait(300);
    check(A.screen() === "dungeon", `Back did not return to the mine (on ${A.screen()})`);
    check(saved().run === null && saved().dungeonFloor === 1, "the new run was not cancelled");
    answer(); await wait(400);
    check(!A.fight && !A.api.rest, "the run started in the background");
    noPenalty(A);
    // a run that was going on: Continue, then Back, leaves it exactly as it was
    const run = { floor: 1, room: 1, breakEndsAt: Date.now() + 60000 };
    await reset({ ...BASE, run });
    A = await open("A");
    answer = A.slowCamera();
    await A.tapContinue();
    A.d.querySelector("#btnFlee").click(); await wait(300);
    check(A.screen() === "dungeon", `Back did not return to the mine (on ${A.screen()})`);
    check(JSON.stringify(saved().run) === JSON.stringify(run), `the run changed: ${JSON.stringify(saved().run)}`);
    answer(); await wait(400);
    check(!A.fight && !A.api.rest, "the run started in the background");
    noPenalty(A, { run: true });
  }],
  ["#4e A normal start (camera and body tracking both fine) still begins the fight", async () => {
    await reset();
    const A = await open("A");
    A.fastCamera();
    A.api.hooks.setModelLoader(async () => ({ lm: { detectForVideo: () => ({ landmarks: [] }), close() {} }, used: "CPU" }));
    await A.tapFight("field-mouse");
    await until(() => A.fight && !A.fight.over, 3000, "the fight to begin");
    check(A.api.trackerRunning, "body tracking is not running");
    check(/run away/i.test(A.text("#btnFlee")), `the button should be Run away now, it says "${A.text("#btnFlee")}"`);
    A.d.querySelector("#btnFlee").click(); await wait(300); // Run away before the first rep: free
    check(A.screen() === "map" && !A.api.trackerRunning, "Run away did not end it cleanly");
    noPenalty(A);
  }],
  // ---------------------------------------------------------------- Bug #5: tracking gaps inside a rep
  ["#5a Depth, then 400 ms unseen, then lockout: no hit, and it says why", async () => {
    await reset();
    const A = await open("A");
    await A.fightMonster("field-mouse");
    let t = 1e8;
    t = playFrames(A, t, [...DOWN, ...unseen(400), ...LOCKOUT]);
    await wait(100);
    check(A.fight.reps === 0, `the rep counted (${A.fight.reps} hit)`);
    check(/keep (your )?body in view/i.test(A.text("#banner")), `no feedback message: "${A.text("#banner")}"`);
  }],
  ["#5b Depth, then a 180 ms camera hitch, then lockout: still a hit", async () => {
    await reset();
    const A = await open("A");
    await A.fightMonster("field-mouse");
    playFrames(A, 1e8, [...DOWN, ...unseen(180), ...UP]);
    await wait(100);
    check(A.fight.reps === 1, `a short hitch cost the rep (${A.fight.reps} hits)`);
  }],
  ["#5c After a cancelled rep, the next clean pushup counts right away", async () => {
    await reset();
    const A = await open("A");
    await A.fightMonster("field-mouse");
    let t = playFrames(A, 1e8, [...DOWN, ...unseen(400), ...LOCKOUT]); // cancelled (as in #5a)
    t = playFrames(A, t, [...DOWN, ...UP]);                            // one honest pushup from that plank
    await wait(100);
    check(A.fight.reps === 1, `expected exactly 1 hit, got ${A.fight.reps}`);
  }],
  ["#5d Your two recorded fights: every honest rep still counts exactly as before", async () => {
    const { createRepCounter } = await import(`../app/core.js?t=${Date.now()}`);
    for (const name of ["normal", "slow"]) {
      const fx = await (await fetch(`fixtures/${name}.json`)).json();
      const counter = createRepCounter(() => ({ depth: 63, top: 160, bend: 20, knee: 135 }));
      const reps = [];
      for (const [t, e] of fx.frames) {
        for (const ev of counter.update(e == null ? null : plank(e), t)) if (ev.type === "rep") reps.push(t);
      }
      check(JSON.stringify(reps) === JSON.stringify(fx.expectedRepTimes),
        `${fx.video}: reps at ${JSON.stringify(reps)}, expected ${JSON.stringify(fx.expectedRepTimes)}`);
    }
  }],
  // ------------------------------------------- Item 1 (audit finding #7): backup input bounds
  ["Item 1a A huge or damaged old code (PRPG1) fails at once, with little decoding", async () => {
    await reset();
    const A = await open("A");
    await A.goto("settings");
    const before = localStorage.getItem(SAVE);
    const box = A.d.querySelector("#restoreText"), b = A.d.querySelector("#btnRestore");
    const junk = randomB64(512 * 1024);
    const cases = [
      ["512 KiB of junk", "PRPG1." + junk],
      ["30 KB of junk (under the size limit)", "PRPG1." + junk.slice(0, 30000)],
      // decodes to "{" and then thousands of "}": every one is a place where a save could end
      ["30 KB that starts like a save", "PRPG1." + btoa("{" + "}".repeat(22000))],
    ];
    const notes = [];
    for (const [what, code] of cases) {
      box.value = code;
      const n = A.countDecoding();
      const t0 = performance.now();
      b.click();
      const ms = performance.now() - t0;
      await wait(50);
      const msg = A.text("#backupMsg");
      check(ms < 20, `${what}: Restore took ${ms.toFixed(1)} ms (limit 20)`);
      check(n.atob <= 16, `${what}: decoded ${n.atob} times`);
      check(n.parse <= 16, `${what}: JSON.parse ran ${n.parse} times`);
      check(/damaged|too long/i.test(msg), `${what}: no clear error: "${msg}"`);
      check(!b.dataset.armed, `${what}: Restore asks to confirm a broken code`);
      notes.push(`${what}: ${ms.toFixed(2)} ms, atob ${n.atob}, parse ${n.parse}`);
    }
    check(localStorage.getItem(SAVE) === before, "the save changed");
    check(A.errors.length === 0, "errors: " + A.errors.join(" | "));
    return notes.join("; ");
  }],
  ["Item 1b A backup file over 64 KiB is refused before it is read", async () => {
    await reset();
    const A = await open("A");
    await A.goto("settings");
    const n = A.countFileReads();
    // a real code, padded past 64 KiB: refused for its size alone
    const msg = await A.openFile([`Pushup RPG backup\n\n${oldCode(GOOD)}\n`, " ".repeat(65 * 1024)]);
    check(n.reads === 0, `the file was read ${n.reads} time(s) before it was refused`);
    check(/too big/i.test(msg), `no "too big" message: "${msg}"`);
    check(A.d.querySelector("#restoreText").value === "", "the file's text was put in the restore box");
    // a normal backup file still opens (and the read counter does see reads)
    const ok = await A.openFile([`Pushup RPG backup\n\n${oldCode(GOOD)}\n`]);
    check(/backup found/i.test(ok), `a normal backup file was refused: "${ok}"`);
    check(n.reads >= 1, "test setup: the read counter saw no read of the normal file");
  }],
  ["Item 1c Old codes with chat text after them still restore exactly; the biggest real backup fits", async () => {
    await reset();
    const A = await open("A");
    const tails = [
      " Sent from my phone",
      "\n\nThanks see you tomorrow",
      ". Keep this safe!",
      "\nHere is the backup code you asked for yesterday evening keep it somewhere safe please ok bye",
    ];
    const pads = new Set(), notes = [];
    let k = 0;
    for (const tail of tails) for (let extra = 0; extra < 3; extra++) {
      const xp = 14 - (k++ % 10); // a different XP each time, so each restore is told apart from the last
      const src = { ...GOOD, xp, wandererDone: "x".repeat(extra) };
      const code = oldCode(src);
      pads.add((code.match(/=*$/)[0] || "").length);
      const msg = await A.restoreCode("My backup: " + code + tail);
      check(/restored/i.test(msg), `tail ${JSON.stringify(tail)} (pad ${extra}): refused: "${msg}"`);
      const s = saved();
      check(s.xp === xp && A.state.xp === xp, `tail ${JSON.stringify(tail)}: XP ${s.xp}, expected ${xp}`);
      check(s.testResult === src.testResult && s.unlockedZones === src.unlockedZones &&
        JSON.stringify(s.stats) === JSON.stringify(src.stats), `tail ${JSON.stringify(tail)}: restored save differs`);
    }
    check(pads.size === 3, `test setup: codes ended with only ${[...pads]} "=" (need 0, 1 and 2)`);
    // the biggest save the game can make: 40 fights in the list (longest texts it keeps), a count for every monster
    const { ZONES, DUNGEON, WANDERERS } = await import("../app/data.js");
    const ids = [...ZONES.flatMap(z => z.monsters), ...DUNGEON.floors.flat()].map(m => m.id)
      .concat(WANDERERS.map(x => `wanderer-${x.id}`));
    const st = A.state;
    st.history = Array.from({ length: 40 }, (_, i) => ({ t: Date.now(), id: "m".repeat(40), name: "N".repeat(60), hp: 999, reps: 999, won: i % 2 === 0, where: "W".repeat(60) }));
    st.kills = Object.fromEntries([...ids, "champion"].map(id => [id, 99999]));
    st.losses = { ...st.kills };
    const text = await A.backupText("#btnShareBackup");
    check(text.length < 32768, `the biggest backup is ${text.length} characters, over the 32,768 limit`);
    notes.push(`biggest backup ${text.length} chars (${ids.length + 1} monsters)`);
    check(A.errors.length === 0, "errors: " + A.errors.join(" | "));
    return notes.join("; ");
  }],
  ["Item 1d Editing the code after the first Restore tap means it is checked (and confirmed) again", async () => {
    await reset();
    const A = await open("A");
    await A.goto("settings");
    const box = A.d.querySelector("#restoreText"), b = A.d.querySelector("#btnRestore");
    const X = oldCode({ ...GOOD, xp: 11 }), Y = oldCode({ ...GOOD, xp: 7 });
    const tap = async (ms = 100) => { b.click(); await wait(ms); };
    const before = localStorage.getItem(SAVE);
    // 1. X checked, then damaged in the box: the second tap must not restore X
    box.value = X; await tap();
    check(b.dataset.armed, "the first tap did not ask to confirm");
    const mid = X.length >> 1;
    box.value = X.slice(0, mid) + "////////" + X.slice(mid + 8);
    await tap(300);
    check(localStorage.getItem(SAVE) === before && A.state.xp !== 11, "the code from before the edit was restored");
    check(/damaged/i.test(A.text("#backupMsg")), `the edited code wasn't checked: "${A.text("#backupMsg")}"`);
    check(!b.dataset.armed, "Restore still waits for a confirm tap after the edited code failed");
    // 2. X checked, then replaced by another good code Y: Y needs its own confirm tap
    box.value = X; await tap();
    box.value = Y; await tap(300);
    check(localStorage.getItem(SAVE) === before, "a code was restored without its own confirm tap");
    check(b.dataset.armed, "the new code wasn't offered for confirming");
    await tap(300);
    check(saved().xp === 7 && A.state.xp === 7, `the new code wasn't restored (XP ${A.state.xp})`);
    // 3. another file opened between the taps counts as an edit too
    box.value = Y; await tap();
    await A.openFile([X]);
    await tap(300);
    check(A.state.xp === 7, "the first code was restored after another file was opened");
    check(b.dataset.armed, "the opened file wasn't offered for confirming");
    await tap(300);
    check(A.state.xp === 11, `the opened file wasn't restored (XP ${A.state.xp})`);
    // 4. no edit: the confirm tap uses what the first tap read, without decoding again
    box.value = Y; await tap();
    const n = A.countDecoding();
    await tap(300);
    check(A.state.xp === 7, "the unchanged code was not restored");
    check(n.atob === 0, `the confirm tap decoded the code again (${n.atob} atob calls)`);
    check(A.errors.length === 0, "errors: " + A.errors.join(" | "));
  }],
  // ------------------------------------------- Item 2 (audit finding #5): the font must not hold up Camp
  ["Item 2a A font server that hangs for 3.5 s doesn't hold up Camp (paint, buttons, page load)", async () => {
    await reset();
    try {
      await fontMode("hold", 3500, "fail");
      const g = await openTimed("A");
      check(g.ready != null, "Camp didn't work within 6 s");
      const usable = campTrip(g.d, "settings");
      // Camp can be working before the browser has painted it: wait for the first paint's record
      const fcp = await until(() => g.w.performance.getEntriesByName("first-contentful-paint")[0], 1500, "first paint").catch(() => null);
      const st = await fontStatus();
      check(g.ready < 1000, `Camp took ${g.ready.toFixed(0)} ms to work (limit 1,000)`);
      check(fcp && fcp.startTime < 1000, `first paint at ${fcp ? fcp.startTime.toFixed(0) + " ms" : "never"} (limit 1,000)`);
      check(usable, "Settings → Back didn't work");
      check(st.held >= 1 && st.seen.some(u => /fonts\.googleapis\.com/.test(u)), `test setup: the font request wasn't held: ${JSON.stringify(st).slice(0, 200)}`);
      // the page counts as loaded although the font is still on its way (nothing waits on it)
      await until(() => g.d.readyState === "complete", 2000, "the page to finish loading").catch(() => {});
      const loaded = g.d.readyState === "complete", stillHeld = (await fontStatus()).held >= 1;
      check(loaded && stillHeld, `the page load waited for the font (readyState ${g.d.readyState}, font still held: ${stillHeld})`);
      return `Camp working at ${g.ready.toFixed(0)} ms, first paint ${fcp.startTime.toFixed(0)} ms, page loaded while the font was still held`;
    } finally { await fontMode("block"); }
  }],
  ["Item 2b With the font failing (offline), Camp loads cleanly and works", async () => {
    await reset();
    try {
      await fontMode("fail");
      const g = await openTimed("A");
      check(g.ready != null && g.ready < 1000, `Camp took ${g.ready == null ? "over 6,000" : g.ready.toFixed(0)} ms to work`);
      await until(() => g.d.readyState === "complete", 3000, "the page to finish loading");
      for (const to of ["settings", "map", "records", "dungeon"]) check(campTrip(g.d, to), `Camp → ${to} → Back didn't work`);
      const menu = [...g.d.querySelectorAll("#camp .menu button")];
      check(menu.length === 4 && menu.every(b => b.getBoundingClientRect().height >= 42), "the Camp buttons lost their size");
      await wait(300);
      const st = await fontStatus();
      check(st.seen.some(u => /fonts\.googleapis\.com/.test(u)), "test setup: the font was never asked for");
      // only the blocked outside servers may show up as failed requests (and the monster pictures,
      // which run.ps1 doesn't copy); nothing else may complain
      const bad = st.log.filter(l => !BLOCKED_HOSTS.test(l) && !/404 \(Not Found\) \S+\/app\/img\//.test(l));
      check(bad.length === 0, "console errors: " + bad.join(" | "));
      return `Camp working at ${g.ready.toFixed(0)} ms; browser log: ${st.log.filter(l => BLOCKED_HOSTS.test(l)).length} failed outside request(s) ` +
        `(${st.log.filter(l => /fonts\.g/.test(l)).length} of them the font), ${st.log.length - bad.length - st.log.filter(l => BLOCKED_HOSTS.test(l)).length} missing test pictures, nothing else`;
    } finally { await fontMode("block"); }
  }],
  ["Item 2c core.js + data.js load alongside game.js, once each; a late font doesn't move Camp's buttons", async () => {
    // 1. index.html asks for game.js's imports itself, at the same addresses game.js uses
    const base = new URL("../app/", location.href).href;
    const html = await (await fetch(base + "index.html", { cache: "no-store" })).text();
    const pre = [...new DOMParser().parseFromString(html, "text/html").querySelectorAll('link[rel="modulepreload"]')]
      .map(l => new URL(l.getAttribute("href"), base).href);
    const src = await (await fetch(base + "game.js", { cache: "no-store" })).text();
    const imports = [...src.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map(m => new URL(m[1], base + "game.js").href);
    check(imports.length >= 2, "test setup: game.js's imports weren't found");
    for (const u of imports) check(pre.includes(u), `index.html doesn't preload ${u.slice(base.length)} (it preloads: ${pre.map(p => p.slice(base.length)).join(", ") || "nothing"})`);
    await reset();
    try {
      // 2. open with the font arriving after 1.5 s (a stand-in with other letter widths)
      await fontMode("hold", 1500, "ok");
      const g = await openTimed("A"), d = g.d, w = g.w;
      check(g.ready != null && g.ready < 1000, `Camp took ${g.ready == null ? "over 6,000" : g.ready.toFixed(0)} ms to work`);
      const res = f => w.performance.getEntriesByType("resource").filter(e => new URL(e.name).pathname.endsWith("/app/" + f));
      for (const f of ["game.js", "core.js", "data.js"]) check(res(f).length === 1, `${f} was fetched ${res(f).length} times`);
      const game = res("game.js")[0];
      for (const f of ["core.js", "data.js"]) {
        check(res(f)[0].startTime < game.responseEnd, `${f} was only asked for after game.js arrived (${res(f)[0].startTime.toFixed(1)} ms vs ${game.responseEnd.toFixed(1)} ms)`);
      }
      // 3. Camp's boxes before and after the font swaps in
      const boxes = () => [...d.querySelectorAll("#camp .hero, #camp .menu button, #campTiles .tile")].map(e => {
        const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(v => +v.toFixed(1));
      });
      const textW = () => { const r = d.createRange(); r.selectNodeContents(d.querySelector("#camp .menu b")); return r.getBoundingClientRect().width; };
      await frame(w);
      const before = boxes(), w0 = textW();
      check((await fontStatus()).held >= 1, "test setup: the font arrived before Camp could be measured");
      await until(() => Math.abs(textW() - w0) > 1, 5000, "the stand-in font to swap in");
      await frame(w);
      const after = boxes();
      const moved = before.map((b, i) => [i, b, after[i]]).filter(([, b, a]) => b.some((v, k) => Math.abs(v - a[k]) > 0.5));
      check(before.length >= 5, `test setup: only ${before.length} Camp boxes found`);
      check(moved.length === 0, `Camp boxes moved when the font swapped in ([index, before, after]): ${JSON.stringify(moved)}`);
      return `core.js/data.js asked for at ${res("core.js")[0].startTime.toFixed(0)}/${res("data.js")[0].startTime.toFixed(0)} ms, game.js arrived ${game.responseEnd.toFixed(0)} ms; ` +
        `"World map" ${w0.toFixed(1)} → ${textW().toFixed(1)} px wide, ${before.length} Camp boxes unchanged`;
    } finally { await fontMode("block"); }
  }],
  // ------------------------------- Item 3 (audit finding #9): an unfinished rep is never kept around
  ["Item 3a Leaving a fight, or a break starting, drops the rep in progress at once (0 frames kept)", async () => {
    await reset();
    const A = await open("A");
    // 1. a slow monster (its depth meter follows the rep), 10 s held at the bottom, then Back to the map
    await A.fightMonster("moss-slime");
    let t = playFrames(A, 1e8, [...LOCKOUT, ...DOWN, ...hold(55, 10000)]);
    const c = A.api.counter.cycle;
    check(c && c.trace.length >= 300, `test setup: no rep in progress (${c ? c.trace.length : 0} frames)`);
    const before = keptFrames(A);
    A.d.querySelector("#btnFlee").click(); await wait(300);
    check(A.screen() === "map", `Back didn't go to the map (${A.screen()})`);
    const afterExit = keptFrames(A);
    check(afterExit === 0, `after Back, ${afterExit} frames of the unfinished rep are still kept ` +
      `(counter ${A.api.counter.cycle?.trace.length ?? 0}, depth meter ${A.api.meterCycle?.trace.length ?? 0})`);
    check(A.api.counter.state === "idle", `the counter is still "${A.api.counter.state}" after leaving`);
    // 2. a mine room cleared (fake hits) while a rep is in progress: the break starts with nothing kept
    await A.enterFloor();
    check(A.fight, "the mine fight didn't start");
    t = playFrames(A, t + 1000, [...LOCKOUT, ...DOWN, ...hold(55, 10000)]);
    const inMine = keptFrames(A);
    check(inMine >= 300, `test setup: no rep in progress in the mine (${inMine} frames)`);
    await A.reps(A.fight.total);
    check(A.api.rest, "the break after the room didn't start");
    const inRest = keptFrames(A);
    check(inRest === 0, `when the break started, ${inRest} frames of the unfinished rep were still kept`);
    check(A.errors.length === 0, "errors: " + A.errors.join(" | "));
    return `kept frames: ${before} in the fight → ${afterExit} after Back; ${inMine} in the mine → ${inRest} in the break`;
  }],
  ["Item 3b 10 minutes held at the bottom: the rep is dropped after 60 s, no hit, and nothing builds up again", async () => {
    const { createRepCounter } = await import(`../app/core.js?t=${Date.now()}`);
    const counter = createRepCounter(COUNTER_CFG);
    let { out: evs, t } = feed(counter, [...LOCKOUT, ...DOWN]);
    const start = t;
    let peak = 0, droppedAt = null;
    for (let i = 0; i < 18000; i++) {               // 30 frames a second for 10 minutes
      evs.push(...feed(counter, [55], t).out);
      const n = counter.cycle ? counter.cycle.trace.length : 0;
      peak = Math.max(peak, n);
      if (droppedAt == null && n === 0) droppedAt = t - start;
      t += FRAME_MS;
    }
    const end = counter.cycle ? counter.cycle.trace.length : 0;
    check(end === 0, `${end} frames kept after 10 minutes at the bottom`);
    check(peak <= 1850, `the rep in progress grew to ${peak} frames (60 s is about 1,800)`);
    check(droppedAt != null && droppedAt <= 61000, `the hold was dropped only after ${droppedAt == null ? "never" : (droppedAt / 1000).toFixed(1) + " s"}`);
    check(!evs.some(e => e.type === "rep"), "a rep was counted");
    // still at the bottom after it was dropped: no new rep starts until the arms are straight again
    const starts = evs.filter(e => e.type === "state" && e.state === "down").length;
    check(starts === 1 && counter.state !== "down", `a rep in progress started ${starts} times (once expected); state now "${counter.state}"`);
    const dropped = evs.filter(e => e.type === "norep");
    check(dropped.length === 1 && dropped[0].expired, `expected one "took too long" no-rep, got ${JSON.stringify(dropped.map(e => e.reasons))}`);
    // in the game: the slow-rep meter is cleared too, and no hit
    await reset();
    const A = await open("A");
    await A.fightMonster("moss-slime");
    let gt = playFrames(A, 1e8, [...LOCKOUT, ...DOWN, ...hold(55, 30000)]);
    check(A.api.counter.cycle && A.api.meterCycle === A.api.counter.cycle, "test setup: the slow-rep meter doesn't follow the rep");
    playFrames(A, gt, hold(55, 35000));
    check(keptFrames(A) === 0 && A.text("#downTime") === "0.0 s", `after 65 s the slow-rep meter still shows ${A.text("#downTime")} (${keptFrames(A)} frames kept)`);
    check(A.fight.reps === 0, "a hit was counted");
    check(A.errors.length === 0, "errors: " + A.errors.join(" | "));
    return `peak ${peak} frames, dropped at ${(droppedAt / 1000).toFixed(1)} s, ${end} frames after 10 min (18,000 frames fed)`;
  }],
  ["Item 3c After a dropped hold: straight arms, then a normal rep and a 6 s slow rep count with the right times", async () => {
    const { createRepCounter } = await import(`../app/core.js?t=${Date.now()}`);
    const reps = out => out.filter(e => e.type === "rep");
    // the same two reps on a fresh counter: what they must give after the dropped hold too
    const fresh = reps(feed(createRepCounter(COUNTER_CFG), [...LOCKOUT, ...DOWN, ...UP, ...slowRep(6)]).out);
    check(fresh.length === 2 && fresh[1].downSecs >= 5.5, `test setup: fresh counter gave ${JSON.stringify(fresh.map(r => r.downSecs))}`);
    const a = createRepCounter(COUNTER_CFG);
    let r = feed(a, [...LOCKOUT, ...DOWN, ...hold(55, 65000)]);
    check(!a.cycle, "test setup: the hold wasn't dropped after 65 s");
    const back = reps(feed(a, [...UP, ...LOCKOUT, ...DOWN, ...UP, ...slowRep(6)], r.t).out);
    check(back.length === 2, `${back.length} reps counted after coming back up (2 expected)`);
    for (const [i, k] of [[0, "downSecs"], [1, "downSecs"], [0, "secs"], [1, "secs"], [1, "minElbow"]]) {
      check(back[i][k] === fresh[i][k], `rep ${i + 1} ${k}: ${back[i][k]}, a fresh counter gives ${fresh[i][k]}`);
    }
    // in the game, on the slow monster: the normal rep is "too fast", the slow one hits, both with the right time
    await reset();
    const A = await open("A");
    await A.fightMonster("moss-slime");
    let t = playFrames(A, 1e8, [...LOCKOUT, ...DOWN, ...hold(55, 65000)]);
    t = playFrames(A, t, [...UP, ...LOCKOUT, ...DOWN, ...UP]);
    check(A.fight.reps === 0 && A.text("#banner").includes(`Too fast: ${fresh[0].downSecs.toFixed(1)} s down`), `normal rep: "${A.text("#banner")}"`);
    playFrames(A, t, slowRep(6));
    check(A.fight.reps === 1 && A.text("#banner").includes(`${fresh[1].downSecs.toFixed(1)} s down`), `slow rep: ${A.fight.reps} hits, "${A.text("#banner")}"`);
    check(A.errors.length === 0, "errors: " + A.errors.join(" | "));
    return `after the drop: normal rep ${back[0].downSecs} s, slow rep ${back[1].downSecs} s down (fresh counter: ${fresh[0].downSecs} / ${fresh[1].downSecs} s)`;
  }],
  ["Item 3d A slow rep that wins the fight is judged and paid in full before the fight is cleared away", async () => {
    await reset();
    const A = await open("A");
    const { ZONES, xpReward } = await import("../app/data.js");
    const m = ZONES.flatMap(z => z.monsters).find(x => x.id === "moss-slime");
    const xp0 = A.state.xp, gain = xpReward(m, "world");
    await A.fightMonster("moss-slime");
    await A.reps(m.hp - 1);
    check(A.fight && A.fight.hpLeft === 1, `test setup: ${A.fight ? A.fight.hpLeft : "no fight"} HP left`);
    // a too-fast last rep: its time is read, and it doesn't win
    let t = playFrames(A, 1e8, [...LOCKOUT, ...DOWN, ...UP]);
    check(A.fight && !A.fight.over && A.fight.hpLeft === 1 && /too fast/i.test(A.text("#banner")), `a too-fast last rep: "${A.text("#banner")}"`);
    // the slow last rep wins (frames end on the one that counts it: after that a real camera stops)
    playFrames(A, t, slowRep(3).slice(0, -1));
    await wait(300);
    check(!A.fight && /defeated/i.test(A.modal()), `no victory: "${A.modal().slice(0, 80)}"`);
    check(A.state.xp === xp0 + gain && saved().xp === xp0 + gain, `XP ${A.state.xp}, expected ${xp0} + ${gain} (with the slow-rep bonus)`);
    check(A.modal().includes(`+${gain} XP`), `the victory doesn't say +${gain} XP: "${A.modal().slice(0, 120)}"`);
    const h = saved().history[0];
    check(h && h.id === "moss-slime" && h.won && h.reps === m.hp, `history: ${JSON.stringify(h)}`);
    // and only then is the rep counter cleared
    check(!A.api.counter.cycle && !A.api.meterCycle && A.api.counter.state === "idle",
      `after the win: counter "${A.api.counter.state}", ${keptFrames(A)} frames kept`);
    check(A.errors.length === 0, "errors: " + A.errors.join(" | "));
    return `won with the slow rep: +${gain} XP, ${h.reps} reps in the history, counter cleared afterwards`;
  }],
  // ------------------------ Item 4 (audit finding #10): the audio engine only runs while sound can play
  ["Item 4a Sound off: fights start and end without starting (or waking) the audio engine", async () => {
    await reset();
    const A = await open("A");
    const au = A.trackAudio();
    for (let i = 0; i < 3; i++) {
      await A.fightMonster("field-mouse");
      await A.reps(3);
      check(/defeated/i.test(A.modal()), `fight ${i + 1}: no win`);
      await A.fightMonster("field-mouse");
      await tapFlee(A);
      check(A.screen() === "map", `fight ${i + 1}: Back didn't go to the map`);
    }
    const made = au.list.length, woken = au.resumes;
    check(made === 0 && woken === 0, `with sound off, ${made} audio engine(s) were made and woken ${woken} time(s)`);
    // an engine made earlier (Sound on in one fight, then off again): later muted fights don't wake it
    await A.fightMonster("field-mouse");
    await tapSound(A);
    const ctx = au.list[0];
    check(ctx && ctx.state === "running", `test setup: Sound on didn't start the engine (${ctx ? ctx.state : "none made"})`);
    await tapSound(A);
    await tapFlee(A);
    const r0 = au.resumes;
    for (let i = 0; i < 3; i++) { await A.fightMonster("field-mouse"); await A.reps(3); }
    await A.goto("camp");
    const moving = await clockMoves(ctx);
    check(au.resumes === r0, `muted fights woke the engine ${au.resumes - r0} time(s)`);
    check(ctx.state !== "running" && !moving, `on Camp the engine is "${ctx.state}" (clock ${moving ? "moving" : "still"})`);
    check(A.errors.length === 0, "errors: " + A.errors.join(" | "));
    return `6 muted fights: ${made} engines made, woken ${woken} times; after Sound on/off, 3 more muted fights: woken ${au.resumes - r0} times, engine "${ctx.state}", clock still`;
  }],
  ["Item 4b Sound on: the win or loss sound plays out on a running engine, then the engine sleeps", async () => {
    await reset(SOUND_ON);
    const A = await open("A");
    const au = A.trackAudio();
    const notes = [];
    for (const kind of ["win", "loss"]) {
      await A.fightMonster(kind === "win" ? "field-mouse" : "cave-rat");
      const ctx = au.list[0];
      check(ctx && ctx.state === "running", `${kind}: the fight's audio engine isn't running (${ctx ? ctx.state : "none made"})`);
      const n0 = au.tones.length, s0 = au.suspends.length;
      if (kind === "win") await A.reps(3);
      else { A.rep(); await wait(100); await tapFlee(A, 50); await tapFlee(A, 300); } // give up: tap twice
      check(kind === "win" ? /defeated/i.test(A.modal()) : /won this time/i.test(A.modal()), `${kind}: the fight didn't end that way: "${A.modal().slice(0, 60)}"`);
      const cue = au.tones.slice(n0).slice(-4); // the last sound: 4 notes
      const endWall = cue[0].wall, cueEnd = Math.max(...cue.map(t => t.end));
      check(cue.length === 4 && cue.every(t => t.state === "running"), `${kind}: the end sound was played on a "${cue.map(t => t.state)}" engine`);
      check(ctx.state === "running", `${kind}: the engine slept ${(performance.now() - endWall).toFixed(0)} ms after the end, before its sound had finished`);
      await until(() => ctx.state === "suspended", 2500, "the engine to sleep").catch(() => {});
      const s = au.suspends[s0];
      check(ctx.state === "suspended" && s, `${kind}: 2.5 s after the end the engine is still "${ctx.state}"`);
      check(s.clock >= cueEnd, `${kind}: the engine slept at ${s.clock.toFixed(2)} s, before its sound ended (${cueEnd.toFixed(2)} s)`);
      check(!(await clockMoves(ctx)), `${kind}: the sleeping engine's clock still moves`);
      const clockAtEnd = s.clock - (s.wall - endWall) / 1000; // the engine's clock when the end sound started
      notes.push(`${kind}: sound ${((cueEnd - clockAtEnd) * 1000).toFixed(0)} ms long, engine asleep ${(s.wall - endWall).toFixed(0)} ms after the end`);
      A.closeModal();
    }
    check(A.errors.length === 0, "errors: " + A.errors.join(" | "));
    return notes.join("; ");
  }],
  ["Item 4c Sound on: Back during startup, or Sound off, puts the audio engine to sleep at once", async () => {
    await reset(SOUND_ON);
    const A = await open("A");
    const au = A.trackAudio();
    // 1. Back while the camera question is still open
    const answer = A.slowCamera();
    await A.tapFight("field-mouse");
    const ctx = au.list[0];
    check(ctx && ctx.state === "running", `test setup: the engine didn't start with the fight (${ctx ? ctx.state : "none made"})`);
    const t0 = performance.now();
    A.d.querySelector("#btnFlee").click();
    await until(() => ctx.state === "suspended", 400, "sleep").catch(() => {});
    const msBack = performance.now() - t0;
    check(ctx.state === "suspended", `400 ms after Back during startup the engine is "${ctx.state}"`);
    check(A.screen() === "map" && !(await clockMoves(ctx)), `after Back: screen ${A.screen()}, clock still moving`);
    answer();
    await wait(200);
    // 2. Sound off in a fight
    A.fastCamera();
    await A.fightMonster("field-mouse");
    check(ctx.state === "running", `the next fight didn't wake the engine (${ctx.state})`);
    const t1 = performance.now();
    A.d.querySelector("#btnSound").click();
    await until(() => ctx.state === "suspended", 400, "sleep").catch(() => {});
    const msOff = performance.now() - t1;
    check(ctx.state === "suspended" && !(await clockMoves(ctx)), `400 ms after Sound off the engine is "${ctx.state}"`);
    // and Sound on wakes it again
    await tapSound(A);
    check(ctx.state === "running", `Sound on didn't wake the engine (${ctx.state})`);
    await tapFlee(A);
    check(A.errors.length === 0, "errors: " + A.errors.join(" | "));
    return `asleep ${msBack.toFixed(0)} ms after Back during startup, ${msOff.toFixed(0)} ms after Sound off`;
  }],
  ["Item 4d Sound on: a fight started right after one ends keeps its sound, and its own end still sleeps", async () => {
    await reset(SOUND_ON);
    const A = await open("A");
    const au = A.trackAudio();
    await A.fightMonster("field-mouse");
    const ctx = au.list[0];
    check(ctx && ctx.state === "running", `test setup: the engine isn't running (${ctx ? ctx.state : "none made"})`);
    // the winning rep, and right away (same moment) Fight on the Cave Rat from the map
    A.rep(); A.rep(); A.rep();
    const tEnd = performance.now();
    check(/defeated/i.test(A.modal()), "test setup: the first fight didn't end");
    A.d.querySelector('.mrow[data-id="cave-rat"]').click();
    [...A.d.querySelectorAll("#modal button")].find(b => /fight/i.test(b.textContent) && !b.disabled).click();
    const startedIn = performance.now() - tEnd;
    check(startedIn < 100, `test setup: the new fight was started ${startedIn.toFixed(0)} ms after the first ended`);
    await until(() => A.fight && !A.fight.over && A.fight.m.id === "cave-rat", 3000, "the new fight");
    await wait(Math.max(0, 1000 - (performance.now() - tEnd)));
    const at = performance.now() - tEnd, moving = await clockMoves(ctx);
    check(ctx.state === "running" && moving && au.suspends.length === 0,
      `${at.toFixed(0)} ms after the first fight ended, the new fight's engine is "${ctx.state}" (slept ${au.suspends.length} time(s))`);
    A.rep(); await wait(50);
    check(au.tones.at(-1).state === "running", "a hit in the new fight played on a sleeping engine");
    // the new fight ends: now the engine does go to sleep
    await A.reps(A.fight.total - A.fight.reps);
    await until(() => ctx.state === "suspended", 2500, "sleep").catch(() => {});
    check(ctx.state === "suspended", `after the second fight ended, the engine is still "${ctx.state}"`);
    check(A.errors.length === 0, "errors: " + A.errors.join(" | "));
    return `new fight ${startedIn.toFixed(0)} ms after the end: engine running at ${at.toFixed(0)} ms, 0 sleeps; asleep after the second fight`;
  }],
  // --------------- Item 5 (audit finding #4): a start or a screen lock that comes back late is let go
  ["Item 5a 12× Fight → Back while the screen-lock answer is pending: all 12 late locks released, camera and loop off", async () => {
    await reset();
    const A = await open("A");
    A.fastCamera(); A.fastModel();
    const wl = A.fakeWakeLock(true), loop = A.countLoop(), streams = [];
    for (let i = 0; i < 12; i++) {
      const asked = wl.calls.filter(c => c.inFight).length;
      await A.tapFight("field-mouse");
      await until(() => wl.calls.filter(c => c.inFight).length > asked, 3000, `fight ${i + 1}'s screen-lock request`);
      streams.push(A.d.querySelector("#video").srcObject);
      await tapFlee(A, 150);
      check(A.screen() === "map", `cycle ${i + 1}: Back didn't go to the map (${A.screen()})`);
    }
    wl.grantAll(); // the phone answers all of them now, after the player left
    await wait(150);
    const r0 = loop.runs;
    await wait(600);
    const held = wl.sentinels.filter(s => !s.released).length, live = liveTracks(streams), runs = loop.runs - r0;
    check(held === 0, `${held} of ${wl.sentinels.length} screen locks are still held`);
    check(live === 0, `${live} camera track(s) still on`);
    check(runs === 0 && !A.api.trackerRunning, `the tracking loop ran ${runs} times in 600 ms after leaving`);
    noPenalty(A);
    return `12 cycles, ${wl.sentinels.length} late locks: ${held} held, ${live} live camera tracks, ${runs} loop runs in 600 ms`;
  }],
  ["Item 5b Back while body tracking loads, then a new fight at once: the old start can't stop the new camera", async () => {
    const notes = [];
    for (const outcome of ["loads", "fails"]) {
      await reset();
      const A = await open("A");
      A.fastCamera();
      const loop = A.countLoop();
      let finish, fail;
      A.api.hooks.setModelLoader(() => new Promise((res, rej) => { finish = res; fail = rej; }));
      await A.tapFight("field-mouse");
      const s1 = await until(() => A.d.querySelector("#video").srcObject, 3000, "fight 1's camera");
      await tapFlee(A, 100);
      // fight 2 right away, with the other model setting so it loads its own (at once) instead of waiting
      A.state.settings.model = A.state.settings.model === "lite" ? "full" : "lite";
      A.fastModel();
      await A.fightMonster("field-mouse");
      const s2 = A.d.querySelector("#video").srcObject;
      check(A.fight && A.api.trackerRunning && s2 && s2 !== s1 && liveTracks([s2]) > 0, `${outcome}: test setup: fight 2 isn't tracking with its own camera`);
      // now fight 1's model load ends
      if (outcome === "loads") finish({ lm: fakeModel(), used: "CPU" }); else fail(new Error("network down"));
      await wait(300);
      const r0 = loop.runs;
      await wait(500);
      const runs = loop.runs - r0, still = A.d.querySelector("#video").srcObject === s2 && liveTracks([s2]) > 0;
      check(still, `${outcome}: fight 1's late model ${outcome === "loads" ? "arriving" : "failing"} switched off fight 2's camera`);
      check(A.api.trackerRunning && runs > 0 && A.fight && !A.fight.over, `${outcome}: fight 2's tracking stopped (loop ran ${runs} times in 500 ms)`);
      check(liveTracks([s1]) === 0, `${outcome}: fight 1's camera is still on`);
      notes.push(`${outcome}: fight 2's camera live, loop ran ${runs} times in 500 ms`);
      await tapFlee(A);
      check(A.errors.length === 0, "errors: " + A.errors.join(" | "));
    }
    return notes.join("; ");
  }],
  ["Item 5c Hidden mid-fight: camera off at once; back after 2 s it goes on; back after 11 s: lost once, nothing left on", async () => {
    await reset();
    const A = await open("A");
    A.fastCamera(); A.fastModel();
    const wl = A.fakeWakeLock(false), loop = A.countLoop(), clock = A.shiftClock();
    await A.fightMonster("cave-rat");
    const s1 = A.d.querySelector("#video").srcObject;
    check(A.api.trackerRunning && s1 && wl.sentinels.length >= 1, "test setup: tracking or the screen lock didn't start");
    A.rep(); await wait(100); // the fight is on: first rep counted
    // 1. a quick look elsewhere (2 s): the camera is off while hidden, and back on afterwards
    A.setVisible(false); await wait(200);
    const r0 = loop.runs; await wait(300);
    const hiddenRuns = loop.runs - r0, hiddenLive = liveTracks([s1]);
    check(hiddenLive === 0, "the camera stayed on while the game was hidden");
    check(hiddenRuns === 0, `the tracking loop ran ${hiddenRuns} times while hidden`);
    clock.skip(2000); A.setVisible(true);
    const s2 = await until(() => { const s = A.d.querySelector("#video").srcObject; return s && s !== s1 && liveTracks([s]) && s; }, 3000, "the camera to come back").catch(() => null);
    check(s2 && A.fight && !A.fight.over && A.api.trackerRunning, "after a 2 s look away the fight didn't go on with the camera");
    check(wl.sentinels.filter(x => !x.released).length === 1, `screen locks held after coming back: ${wl.sentinels.filter(x => !x.released).length} (1 expected)`);
    // 2. away 11 s, and the phone's screen-lock answer comes late (after coming back)
    wl.hold = true;
    A.setVisible(false); await wait(200);
    check(liveTracks([s2]) === 0, "the camera stayed on while hidden (second time)");
    clock.skip(11000); A.setVisible(true); await wait(300);
    wl.grantAll(); await wait(300);
    check(/won this time/i.test(A.modal()), `no loss for leaving: "${A.modal().slice(0, 80)}"`);
    // and once more: hidden and back, still only one loss
    A.setVisible(false); await wait(100); clock.skip(11000); A.setVisible(true); await wait(300);
    const st = saved(), losses = st.losses["cave-rat"] || 0, lostFights = st.history.filter(h => !h.won).length;
    check(losses === 1 && lostFights === 1, `the loss was recorded ${losses} time(s) (${lostFights} in the history)`);
    const held = wl.sentinels.filter(x => !x.released).length, r1 = loop.runs;
    await wait(400);
    check(held === 0, `${held} screen lock(s) still held after the loss`);
    check(loop.runs === r1 && !A.api.trackerRunning && liveTracks([s1, s2]) === 0, `after the loss: loop ran ${loop.runs - r1} times, camera tracks on: ${liveTracks([s1, s2])}`);
    check(A.errors.length === 0, "errors: " + A.errors.join(" | "));
    return `hidden: 0 live tracks, ${hiddenRuns} loop runs; back after 2 s: camera on again; back after 11 s: 1 loss, ${held} locks held, 0 loop runs`;
  }],
  ["Item 5d Back while the camera or body tracking starts: no loss, and camera, screen lock, loop and sound all off", async () => {
    await reset(SOUND_ON);
    const A = await open("A");
    const au = A.trackAudio(), wl = A.fakeWakeLock(false), loop = A.countLoop(), streams = [];
    // 1. Back while the camera question is open; the camera comes late
    const answer = A.slowCamera();
    await A.tapFight("field-mouse");
    await tapFlee(A);
    streams.push(answer());
    await wait(300);
    // 2. Back while body tracking loads; it finishes late
    A.fastCamera();
    const finish = A.slowModel();
    await A.tapFight("field-mouse");
    streams.push(await until(() => A.d.querySelector("#video").srcObject, 3000, "the camera"));
    await tapFlee(A);
    finish();
    await wait(300);
    const r0 = loop.runs;
    await wait(400);
    const runs = loop.runs - r0, held = wl.sentinels.filter(x => !x.released).length, live = liveTracks(streams), ctx = au.list[0];
    noPenalty(A);
    check(saved().history.length === 0, `${saved().history.length} fight(s) in the history`);
    check(live === 0 && held === 0 && runs === 0 && !A.api.trackerRunning, `left on: ${live} camera tracks, ${held} screen locks, loop ran ${runs} times`);
    check(ctx && ctx.state === "suspended", `the audio engine is "${ctx ? ctx.state : "none made"}"`);
    return `0 losses, 0 history; ${live} live tracks, ${held} locks held, ${runs} loop runs, audio "${ctx.state}"`;
  }],
  // ---- Item 5 follow-up: hidden (another app, screen locked) while the fight is still starting.
  // These run the normal startup path: a camera problem shows the real error, not fake-rep mode.
  ["Item 5e Hidden while the camera question is open: the late camera is switched off unseen; back, a fresh one starts the fight", async () => {
    await reset();
    const A = await open("A");
    A.api.strictCamera = true;
    const cam = {}, inf = {};
    A.camera(cam);
    const model = A.heldModel(inf), wl = A.fakeWakeLock(false), loop = A.countLoop();
    // body tracking is already loading (like the warm-up when the game opens)
    const sel = A.d.querySelector("#sModel");
    sel.value = A.state.settings.model; sel.dispatchEvent(new A.w.Event("change"));
    cam.hold = true;
    await A.tapFight("field-mouse");
    check(cam.gum === 1 && cam.give, "test setup: the camera question isn't open");
    A.setVisible(false); await wait(100);
    cam.give(); // the camera arrives while hidden; body tracking still loading
    const late = await until(() => cam.streams[0], 1000, "the late camera");
    const h = await whileHidden(A, cam, wl, loop, inf);
    check(!h.liveTracks && !h.shown && !h.locks && !h.lockAsks && !h.loopRuns && !h.frames && !h.fightReady, `while hidden: ${JSON.stringify(h)}`);
    // back, then body tracking finishes: the start completes, with a fresh camera
    A.setVisible(true); await wait(100);
    model.done();
    await until(() => A.fight, 3000, "the fight").catch(() => {});
    const fresh = A_video(A.d), first = inf.seen && inf.seen[0];
    const after = { fightReady: !!A.fight, error: /can't start/i.test(A.modal()), freshLive: !!fresh && fresh !== late && liveTracks([fresh]) > 0,
      cameraAsks: cam.gum, firstFrameBeforeReady: !!first && !first.ready, firstFrameFromFresh: !!first && first.stream === fresh, locks: heldLocks(wl) };
    check(after.fightReady && !after.error && after.freshLive && after.firstFrameBeforeReady && after.firstFrameFromFresh && after.locks === 1, `after coming back: ${JSON.stringify(after)}`);
    await tapFlee(A);
    check(A.errors.length === 0, "errors: " + A.errors.join(" | "));
    return `hidden: ${JSON.stringify(h)}; back: ${JSON.stringify(after)}`;
  }],
  ["Item 5f Hidden while body tracking loads (camera on), back after 2 s, then it loads: one start, fresh camera, tracking works first", async () => {
    await reset();
    const A = await open("A");
    A.api.strictCamera = true;
    const cam = {}, inf = {};
    A.camera(cam);
    const model = A.heldModel(inf), wl = A.fakeWakeLock(false), loop = A.countLoop(), clock = A.shiftClock();
    await A.tapFight("field-mouse");
    const first = await until(() => liveTracks(cam.streams) && A_video(A.d), 3000, "the camera");
    A.setVisible(false);
    const h = await whileHidden(A, cam, wl, loop, inf);
    check(!h.liveTracks && !h.locks && !h.loopRuns && !h.fightReady, `while hidden: ${JSON.stringify(h)}`);
    clock.skip(2000); A.setVisible(true); await wait(200);
    model.done();
    const fights = new Set();
    await until(() => { if (A.fight) fights.add(A.fight); return A.fight; }, 3000, "the fight").catch(() => {});
    for (let i = 0; i < 10; i++) { if (A.fight) fights.add(A.fight); await wait(50); }
    const fresh = A_video(A.d), f1 = inf.seen && inf.seen[0];
    const r0 = loop.runs, f0 = inf.frames || 0;
    await wait(500);
    const after = { fightsStarted: fights.size, error: /can't start/i.test(A.modal()), cameraAsks: cam.gum,
      freshLive: !!fresh && fresh !== first && liveTracks([fresh]) > 0, firstFrameBeforeReady: !!f1 && !f1.ready, firstFrameFromFresh: !!f1 && f1.stream === fresh,
      loopRuns500ms: loop.runs - r0, frames500ms: (inf.frames || 0) - f0, locks: heldLocks(wl), liveTracks: liveTracks(cam.streams) };
    check(after.fightsStarted === 1 && !after.error && after.cameraAsks === 2 && after.freshLive && after.firstFrameBeforeReady && after.firstFrameFromFresh
      && after.loopRuns500ms > 0 && after.frames500ms > 0 && after.locks === 1 && after.liveTracks === 1, `after coming back: ${JSON.stringify(after)}`);
    await tapFlee(A);
    check(A.errors.length === 0, "errors: " + A.errors.join(" | "));
    return `hidden: ${JSON.stringify(h)}; back: ${JSON.stringify(after)}`;
  }],
  ["Item 5g The start's screen-lock answer comes after a hide and return: it is let go; the fresh camera and loop keep going", async () => {
    await reset();
    const A = await open("A");
    A.api.strictCamera = true;
    const cam = {}, inf = {};
    A.camera(cam); A.fastModel(inf);
    const wl = A.fakeWakeLock(true), loop = A.countLoop(), clock = A.shiftClock();
    await A.tapFight("field-mouse");
    await until(() => inFightAsks(wl) === 1, 3000, "the start's screen-lock request");
    A.setVisible(false); await wait(200);
    clock.skip(2000);
    wl.hold = false; // from now on the phone answers at once (the start's answer stays waiting)
    A.setVisible(true);
    const fresh = await until(() => { const s = A_video(A.d); return s && s !== cam.streams[0] && liveTracks([s]) && s; }, 3000, "a fresh camera").catch(() => null);
    await wait(300);
    const readyBeforeOldAnswer = !!A.fight;
    const n0 = wl.sentinels.length;
    wl.grantAll(); // the start's old answer arrives now
    await wait(400);
    const lateLocks = wl.sentinels.slice(n0), r0 = loop.runs, f0 = inf.frames || 0;
    await wait(500);
    const after = { freshCamera: !!fresh, error: /can't start/i.test(A.modal()), onFightScreen: A.screen() === "fight", fightReady: !!A.fight, readyBeforeOldAnswer,
      lateLocksKept: lateLocks.filter(s => !s.released).length, locks: heldLocks(wl), freshStillShown: !!fresh && A_video(A.d) === fresh && liveTracks([fresh]) > 0,
      loopRuns500ms: loop.runs - r0, frames500ms: (inf.frames || 0) - f0 };
    check(after.freshCamera && !after.error && after.onFightScreen && after.fightReady && after.readyBeforeOldAnswer && after.lateLocksKept === 0 && after.locks === 1
      && after.freshStillShown && after.loopRuns500ms > 0 && after.frames500ms > 0, `after the old answer: ${JSON.stringify(after)}`);
    await tapFlee(A);
    check(A.errors.length === 0, "errors: " + A.errors.join(" | "));
    return JSON.stringify(after);
  }],
  ["Item 5h Hidden during video.play(), and Back after a hidden start: no fight while hidden, no penalty; a fight still recovers or is lost once", async () => {
    // 1. hidden while the camera picture is starting (video.play() pending)
    await reset();
    let A = await open("A");
    A.api.strictCamera = true;
    let cam = {}, inf = {}, pl = {};
    A.camera(cam); A.fastModel(inf);
    let wl = A.fakeWakeLock(false), loop = A.countLoop();
    A.holdPlay(pl);
    await A.tapFight("field-mouse");
    await until(() => pl.playGo, 3000, "video.play() to wait");
    A.setVisible(false); await wait(100);
    pl.playGo();
    const h1 = await whileHidden(A, cam, wl, loop, inf);
    check(!h1.liveTracks && !h1.shown && !h1.locks && !h1.lockAsks && !h1.loopRuns && !h1.frames && !h1.fightReady, `hidden during play(): ${JSON.stringify(h1)}`);
    A.setVisible(true);
    await until(() => A.fight, 3000, "the fight").catch(() => {});
    const fresh = A_video(A.d), s1 = inf.seen && inf.seen[0];
    const back1 = { fightReady: !!A.fight, error: /can't start/i.test(A.modal()), freshLive: !!fresh && fresh !== cam.streams[0] && liveTracks([fresh]) > 0,
      firstFrameBeforeReady: !!s1 && !s1.ready, firstFrameFromFresh: !!s1 && s1.stream === fresh };
    check(back1.fightReady && !back1.error && back1.freshLive && back1.firstFrameBeforeReady && back1.firstFrameFromFresh, `back after play(): ${JSON.stringify(back1)}`);
    await tapFlee(A);
    noPenalty(A);
    // 2. Back after a start that was interrupted by hiding (body tracking still loading); it loads late
    await reset();
    A = await open("A");
    A.api.strictCamera = true;
    cam = {}; inf = {};
    A.camera(cam);
    const model = A.heldModel(inf);
    wl = A.fakeWakeLock(false); loop = A.countLoop();
    let clock = A.shiftClock();
    await A.tapFight("field-mouse");
    await until(() => liveTracks(cam.streams), 3000, "the camera");
    A.setVisible(false); await wait(200); clock.skip(2000); A.setVisible(true); await wait(200);
    await tapFlee(A);
    model.done();
    const b = await whileHidden(A, cam, wl, loop, inf); // (visible now; same counts)
    const st = saved();
    const back2 = { screen: A.screen(), liveTracks: b.liveTracks, locks: b.locks, loopRuns: b.loopRuns, frames: b.frames, fight: b.fightReady,
      trackerRunning: A.api.trackerRunning, losses: Object.keys(st.losses || {}).length, history: (st.history || []).length };
    check(back2.screen === "map" && !back2.liveTracks && !back2.locks && !back2.loopRuns && !back2.frames && !back2.fight && !back2.trackerRunning
      && !back2.losses && !back2.history, `Back after a hidden start: ${JSON.stringify(back2)}`);
    noPenalty(A);
    // 3. a fight that has begun: a 2 s look away recovers; 11 s away is one loss (and only one)
    await reset();
    A = await open("A");
    A.api.strictCamera = true;
    cam = {}; inf = {};
    A.camera(cam); A.fastModel(inf);
    wl = A.fakeWakeLock(false); loop = A.countLoop(); clock = A.shiftClock();
    await A.fightMonster("cave-rat");
    A.rep(); await wait(100);
    A.setVisible(false); await wait(200); clock.skip(2000); A.setVisible(true);
    await until(() => liveTracks(cam.streams) && A_video(A.d) !== cam.streams[0], 3000, "the camera after 2 s away").catch(() => {});
    const r0 = loop.runs, f0 = inf.frames || 0; await wait(400);
    const short = { fightGoesOn: !!A.fight && !A.fight.over, liveTracks: liveTracks(cam.streams), loopRuns: loop.runs - r0, frames: (inf.frames || 0) - f0, locks: heldLocks(wl) };
    check(short.fightGoesOn && short.liveTracks === 1 && short.loopRuns > 0 && short.frames > 0 && short.locks === 1, `after 2 s away: ${JSON.stringify(short)}`);
    A.setVisible(false); await wait(200); clock.skip(11000); A.setVisible(true); await wait(400);
    A.setVisible(false); await wait(100); clock.skip(11000); A.setVisible(true); await wait(400);
    const st3 = saved();
    const long = { lostModal: /won this time/i.test(A.modal()), losses: st3.losses["cave-rat"] || 0, lostInHistory: st3.history.filter(x => !x.won).length,
      liveTracks: liveTracks(cam.streams), locks: heldLocks(wl), trackerRunning: A.api.trackerRunning };
    check(long.lostModal && long.losses === 1 && long.lostInHistory === 1 && !long.liveTracks && !long.locks && !long.trackerRunning, `after 11 s away: ${JSON.stringify(long)}`);
    check(A.errors.length === 0, "errors: " + A.errors.join(" | "));
    return `play(): hidden ${JSON.stringify(h1)}, back ${JSON.stringify(back1)}; Back: ${JSON.stringify(back2)}; 2 s: ${JSON.stringify(short)}; 11 s: ${JSON.stringify(long)}`;
  }],
  ["Item 5i The camera request from before a hide fails late (AbortError): back, a fresh camera starts the fight; a refused current request still shows the error", async () => {
    const bad = [], notes = [];
    const setup = async () => {
      await reset();
      const A = await open("A");
      A.api.strictCamera = true;
      const cam = {}, inf = {};
      A.camera(cam); A.fastModel(inf);
      return { A, cam, inf, wl: A.fakeWakeLock(false), loop: A.countLoop() };
    };
    // 1. held camera request; hidden and back; then that (retired) request fails with AbortError
    let { A, cam, inf, wl, loop } = await setup();
    cam.hold = true;
    await A.tapFight("field-mouse");
    check(cam.gum === 1 && cam.refuse, "test setup: the camera question isn't open");
    A.setVisible(false); await wait(200); A.setVisible(true); await wait(200);
    cam.refuse("AbortError");
    await until(() => A.fight || A.modal(), 3000, "the fight or a message").catch(() => {});
    const fresh = A_video(A.d), f1 = inf.seen && inf.seen[0];
    const retired = { fightReady: !!A.fight, error: A.modal().slice(0, 70), cameraAsks: cam.gum, freshLive: !!fresh && liveTracks([fresh]) > 0,
      firstFrameBeforeReady: !!f1 && !f1.ready, firstFrameFromFresh: !!f1 && f1.stream === fresh, locks: heldLocks(wl) };
    if (!(retired.fightReady && !retired.error && retired.cameraAsks === 2 && retired.freshLive && retired.firstFrameBeforeReady && retired.firstFrameFromFresh && retired.locks === 1))
      bad.push(`old request failed after coming back: ${JSON.stringify(retired)}`);
    notes.push(`old request failed: ${JSON.stringify(retired)}`);
    await tapFlee(A);
    if (A.errors.length) bad.push("errors: " + A.errors.join(" | "));
    // 2. the same, but the fresh (current) request is refused: the permission error shows
    ({ A, cam, inf, wl, loop } = await setup());
    cam.hold = true;
    await A.tapFight("field-mouse");
    A.setVisible(false); await wait(200); A.setVisible(true); await wait(200);
    cam.deny = "NotAllowedError";
    cam.refuse("AbortError");
    await until(() => A.modal(), 3000, "a message").catch(() => {});
    let r0 = loop.runs; await wait(300);
    const deniedFresh = { permissionError: /permission was blocked/i.test(A.modal()), cameraAsks: cam.gum, fightReady: !!A.fight, liveTracks: liveTracks(cam.streams),
      locks: heldLocks(wl), loopRuns: loop.runs - r0, trackerRunning: A.api.trackerRunning };
    if (!(deniedFresh.permissionError && deniedFresh.cameraAsks === 2 && !deniedFresh.fightReady && !deniedFresh.liveTracks && !deniedFresh.locks && !deniedFresh.loopRuns && !deniedFresh.trackerRunning))
      bad.push(`fresh request refused: ${JSON.stringify(deniedFresh)} / "${A.modal().slice(0, 70)}"`);
    notes.push(`fresh request refused: ${JSON.stringify(deniedFresh)}`);
    try { noPenalty(A); } catch (e) { bad.push("fresh request refused: " + e.message); }
    // 3. no hiding: the first (current) request is refused: the permission error shows
    ({ A, cam, inf, wl, loop } = await setup());
    cam.hold = true;
    await A.tapFight("field-mouse");
    cam.refuse("NotAllowedError");
    await until(() => A.modal(), 3000, "a message").catch(() => {});
    r0 = loop.runs; await wait(300);
    const deniedNow = { permissionError: /permission was blocked/i.test(A.modal()), cameraAsks: cam.gum, fightReady: !!A.fight, locks: heldLocks(wl),
      loopRuns: loop.runs - r0, trackerRunning: A.api.trackerRunning };
    if (!(deniedNow.permissionError && deniedNow.cameraAsks === 1 && !deniedNow.fightReady && !deniedNow.locks && !deniedNow.loopRuns && !deniedNow.trackerRunning))
      bad.push(`current request refused: ${JSON.stringify(deniedNow)} / "${A.modal().slice(0, 70)}"`);
    notes.push(`current request refused: ${JSON.stringify(deniedNow)}`);
    try { noPenalty(A); } catch (e) { bad.push("current request refused: " + e.message); }
    check(!bad.length, bad.join(" || "));
    return notes.join("; ");
  }],
  ["Item 5j Two quick looks away in a fight: the first return's late screen-lock answer is let go and starts nothing; the newer one starts one loop", async () => {
    await reset();
    const A = await open("A");
    A.api.strictCamera = true;
    const cam = {}, inf = {};
    A.camera(cam); A.fastModel(inf);
    const wl = A.fakeWakeLock(false), loop = A.countLoop(), clock = A.shiftClock();
    await A.fightMonster("cave-rat");
    A.rep(); await wait(100); // the fight is on
    check(A.fight && !A.fight.over && A.api.trackerRunning, "test setup: the fight isn't on");
    wl.hold = true; // from now on the phone's screen-lock answers wait
    A.setVisible(false); await wait(200); clock.skip(1000); A.setVisible(true);
    await until(() => wl.waiting.length === 1, 3000, "the first return's screen-lock request");
    const s2 = A_video(A.d);
    A.setVisible(false); await wait(200); clock.skip(1000); A.setVisible(true);
    await until(() => wl.waiting.length === 2, 3000, "the second return's screen-lock request");
    const s3 = A_video(A.d);
    check(s2 && s3 && s3 !== s2 && liveTracks([s3]) === 1 && liveTracks([s2]) === 0, "test setup: the second return has no camera of its own");
    // the first return's (old) answer comes now; the newer one is still waiting
    const n0 = wl.sentinels.length, st0 = loop.starts, r0 = loop.runs, f0 = inf.frames || 0;
    wl.grantOldest();
    await wait(400);
    const old = { oldReleased: wl.sentinels.length === n0 + 1 && wl.sentinels[n0].released, loopStarts: loop.starts - st0, loopRuns: loop.runs - r0,
      frames: (inf.frames || 0) - f0, locks: heldLocks(wl) };
    // the newer answer
    const st1 = loop.starts, n1 = wl.sentinels.length;
    wl.grantAll();
    await wait(200);
    const r1 = loop.runs, f1 = inf.frames || 0, k = (inf.seen || []).length;
    await wait(500);
    const seen = (inf.seen || []).slice(k);
    const now = { loopStarts: loop.starts - st1, loopRuns500ms: loop.runs - r1, frames500ms: (inf.frames || 0) - f1, allFramesFromCurrent: seen.length > 0 && seen.every(x => x.stream === s3),
      currentShown: A_video(A.d) === s3 && liveTracks([s3]) === 1, newerKept: !!wl.sentinels[n1] && !wl.sentinels[n1].released, locks: heldLocks(wl), liveTracks: liveTracks(cam.streams) };
    check(old.oldReleased && old.loopStarts === 0 && old.loopRuns === 0 && old.frames === 0 && old.locks === 0
      && now.loopStarts === 1 && now.loopRuns500ms > 0 && now.frames500ms > 0 && now.allFramesFromCurrent && now.currentShown && now.newerKept && now.locks === 1 && now.liveTracks === 1,
      `old answer: ${JSON.stringify(old)}; newer answer: ${JSON.stringify(now)}`);
    check(A.errors.length === 0, "errors: " + A.errors.join(" | "));
    return `old answer: ${JSON.stringify(old)}; newer answer: ${JSON.stringify(now)}`;
  }],
  ["Item 5k Only one usable camera frame time: the first tracked frame, run right inside the loop start, still completes the start", async () => {
    await reset();
    const A = await open("A");
    A.api.strictCamera = true;
    const cam = {}, calls = [];
    A.camera(cam);
    const wl = A.fakeWakeLock(false), loop = A.countLoop();
    A.api.hooks.setModelLoader(async () => ({ lm: {
      detectForVideo(v) { calls.push({ loopRuns: loop.runs, ready: !!A.fight, stream: v.srcObject }); return { landmarks: [] }; }, close() {},
    }, used: "CPU" }));
    // the camera picture is ready and always reports the same time: only one frame can be tracked
    const v = A.d.querySelector("#video");
    Object.defineProperty(v, "currentTime", { configurable: true, get: () => 1, set() {} });
    Object.defineProperty(v, "readyState", { configurable: true, get: () => 4 });
    await A.tapFight("field-mouse");
    await until(() => A.fight || A.modal(), 3000, "the fight").catch(() => {});
    const r0 = loop.runs; await wait(300);
    const c = calls[0];
    const res = { fightReady: !!A.fight, error: A.modal().slice(0, 70), inferences: calls.length, firstInsideLoopStart: !!c && c.loopRuns === 0,
      firstBeforeReady: !!c && !c.ready, firstFromShown: !!c && !!c.stream && c.stream === A_video(A.d), loopStarts: loop.starts, loopRuns300ms: loop.runs - r0, locks: heldLocks(wl) };
    check(res.fightReady && !res.error && res.inferences === 1 && res.firstInsideLoopStart && res.firstBeforeReady && res.firstFromShown
      && res.loopStarts === 1 && res.loopRuns300ms > 0 && res.locks === 1, JSON.stringify(res));
    await tapFlee(A);
    check(A.errors.length === 0, "errors: " + A.errors.join(" | "));
    return JSON.stringify(res);
  }],
  ["Item 5l Back from a short look away, but the camera picture fails to play: that camera is let go and switched off; no screen lock, no loop", async () => {
    await reset();
    const A = await open("A");
    A.api.strictCamera = true;
    const cam = {}, inf = {}, pl = {};
    A.camera(cam); A.fastModel(inf);
    const wl = A.fakeWakeLock(false), loop = A.countLoop(), clock = A.shiftClock();
    await A.fightMonster("cave-rat");
    A.rep(); await wait(100); // the fight is on
    check(A.fight && !A.fight.over && A.api.trackerRunning, "test setup: the fight isn't on");
    A.setVisible(false); await wait(200); clock.skip(2000);
    A.holdPlay(pl);
    const a0 = inFightAsks(wl), st0 = loop.starts;
    A.setVisible(true);
    await until(() => pl.playFail, 3000, "the return's video.play()");
    const s2 = A_video(A.d);
    pl.playFail(); // this return's picture can't start
    await wait(150);
    const h = await whileHidden(A, cam, wl, loop, inf); // (visible now; counts over 400 ms)
    const res = { returnCamera: !!s2 && s2 !== cam.streams[0], stillShown: h.shown, returnCameraLive: liveTracks([s2]), liveTracks: h.liveTracks, locks: h.locks,
      lockAsks: inFightAsks(wl) - a0, loopStarts: loop.starts - st0, loopRuns: h.loopRuns, frames: h.frames, fightGoesOn: !!A.fight && !A.fight.over };
    check(res.returnCamera && !res.stillShown && !res.returnCameraLive && !res.liveTracks && !res.locks && !res.lockAsks && !res.loopStarts && !res.loopRuns && !res.frames,
      JSON.stringify(res));
    check(A.errors.length === 0, "errors: " + A.errors.join(" | "));
    return JSON.stringify(res);
  }],
  // ---------------- Item 6 (audit finding #6): one body-tracking model at a time, kept between fights
  ["Item 6a Body tracking asked Full → Lite → Full, answered newest first: the newest Full tracks; each old model is closed once", async () => {
    await reset();
    const A = await open("A");
    await skipWarmUp(A);
    A.api.strictCamera = true;
    const ml = A.heldModels(), cam = {};
    A.camera(cam); A.fakeWakeLock(false);
    for (const m of ["full", "lite", "full"]) pickModel(A, m);
    check(ml.loads.map(l => l.name).join() === "full,lite,full", `test setup: loads asked: ${ml.loads.map(l => l.name).join()}`);
    ml.loads[2].give("GPU"); await wait(50); // the newest answers first
    ml.loads[1].give("CPU"); await wait(50);
    ml.loads[0].give("CPU"); await wait(50);
    const afterAnswers = { closes: byModel(ml, "closes"), delegate: A.api.delegate };
    await A.fightMonster("field-mouse"); // Full is the setting now
    await wait(500);
    const fight = { fightReady: !!A.fight, error: A.modal().slice(0, 70), loads: ml.loads.length, frames: byModel(ml, "frames"), delegate: A.api.delegate };
    await tapFlee(A);
    const end = { closes: byModel(ml, "closes") };
    const [m1, m2, m3] = ml.models.slice().sort((a, b) => a.id - b.id);
    check(fight.fightReady && !fight.error && fight.loads === 3 && m3.frames > 0 && m1.frames === 0 && m2.frames === 0 && fight.delegate === "GPU"
      && m1.closes === 1 && m2.closes === 1 && m3.closes === 0,
      `after the answers: ${JSON.stringify(afterAnswers)}; fight: ${JSON.stringify(fight)}; after the fight: ${JSON.stringify(end)}`);
    noPenalty(A);
    return `after the answers: ${JSON.stringify(afterAnswers)}; fight: ${JSON.stringify(fight)}; after the fight: ${JSON.stringify(end)}`;
  }],
  ["Item 6b An old body-tracking load fails while the current one is still loading: a fight for the current type shares that load", async () => {
    await reset();
    const A = await open("A");
    await skipWarmUp(A);
    A.api.strictCamera = true;
    const ml = A.heldModels(), cam = {};
    A.camera(cam); A.fakeWakeLock(false);
    pickModel(A, "full"); pickModel(A, "lite"); // Lite is the current request (and the setting)
    check(ml.loads.map(l => l.name).join() === "full,lite", `test setup: loads asked: ${ml.loads.map(l => l.name).join()}`);
    ml.loads[0].fail(); await wait(100); // the old Full load fails
    await A.tapFight("field-mouse"); // a second caller for Lite
    const loadsWhileWaiting = ml.loads.length;
    ml.loads[1].give();
    await until(() => A.fight || A.modal(), 3000, "the fight").catch(() => {});
    await wait(300);
    const res = { loadsWhileWaiting, loads: ml.loads.length, fightReady: !!A.fight, error: A.modal().slice(0, 70), frames: byModel(ml, "frames"), closes: byModel(ml, "closes") };
    const lite = ml.models.find(m => m.id === 2);
    for (const l of ml.loads.slice(2)) l.give(); // let any extra load end
    await tapFlee(A);
    check(res.loadsWhileWaiting === 2 && res.loads === 2 && res.fightReady && !res.error && lite && lite.frames > 0 && lite.closes === 0, JSON.stringify(res));
    noPenalty(A);
    return JSON.stringify(res);
  }],
  ["Item 6c The current body-tracking load fails, then the same type is asked again: the retry loads, and later fights reuse it", async () => {
    await reset();
    const A = await open("A");
    await skipWarmUp(A);
    A.api.strictCamera = true;
    const ml = A.heldModels(), cam = {};
    A.camera(cam); A.fakeWakeLock(false);
    // 1. the fight's load fails
    await A.tapFight("field-mouse");
    await until(() => ml.loads.length === 1, 3000, "the fight's load");
    ml.loads[0].fail();
    await until(() => A.modal(), 3000, "a message").catch(() => {});
    const failed = { error: /could not load body tracking/i.test(A.modal()), fightReady: !!A.fight, trackerRunning: A.api.trackerRunning };
    // 2. the same fight again: a retry load (it answers at once), then two more fights
    ml.auto = true;
    const fights = [];
    for (let i = 0; i < 3; i++) {
      await A.fightMonster("field-mouse");
      const m = ml.models[0], f0 = m ? m.frames : 0;
      await wait(400);
      fights.push({ ready: !!A.fight, error: A.modal().slice(0, 50), loads: ml.loads.length, framesThisFight: m ? m.frames - f0 : 0, closes: m ? m.closes : null });
      await tapFlee(A);
    }
    const res = { failed, fights, models: ml.models.length, closes: byModel(ml, "closes") };
    check(failed.error && !failed.fightReady && !failed.trackerRunning
      && fights.every(f => f.ready && !f.error && f.loads === 2 && f.framesThisFight > 0 && f.closes === 0) && ml.models.length === 1, JSON.stringify(res));
    noPenalty(A);
    return JSON.stringify(res);
  }],
  // ---------------- Item 7 (audit finding #1): fight startup with body tracking
  ["Item 7a A fight waits for Lite, a newer Full request fails, Lite answers last: the error shows at once, Lite is closed, nothing is left on", async () => {
    await reset();
    const A = await open("A");
    await skipWarmUp(A);
    A.api.strictCamera = true;
    const ml = A.heldModels(), cam = {};
    A.camera(cam);
    const wl = A.fakeWakeLock(false), loop = A.countLoop();
    await A.tapFight("field-mouse");
    await until(() => ml.loads.length === 1, 3000, "the fight's Lite load");
    pickModel(A, "full"); // a newer request
    check(ml.loads.map(l => l.name).join() === "lite,full", `test setup: loads asked: ${ml.loads.map(l => l.name).join()}`);
    const t0 = performance.now();
    ml.loads[1].fail(); // the newer Full load fails
    await until(() => /could not load body tracking/i.test(A.modal()), 1500, "the body-tracking error").catch(() => {});
    const errorMs = /could not load body tracking/i.test(A.modal()) ? Math.round(performance.now() - t0) : null;
    const lite = ml.loads[0].give(); // the fight's own Lite load answers last
    await wait(300);
    const r0 = loop.runs, f0 = lite.frames;
    await wait(400);
    const st = saved();
    const res = { errorMs, errorBeforeLiteAnswered: errorMs !== null, liteCloses: lite.closes, liteFrames: lite.frames, liveTracks: liveTracks(cam.streams), locks: heldLocks(wl),
      loopRuns400ms: loop.runs - r0, framesAfter: lite.frames - f0, trackerRunning: A.api.trackerRunning, screen: A.screen(),
      losses: Object.keys(st.losses || {}).length, history: (st.history || []).length };
    check(res.errorBeforeLiteAnswered && res.errorMs < 500 && res.liteCloses === 1 && res.liteFrames === 0 && !res.liveTracks && !res.locks && !res.loopRuns400ms
      && !res.trackerRunning && !res.losses && !res.history, `${JSON.stringify(res)} / "${A.modal().slice(0, 80)}"`);
    noPenalty(A);
    return JSON.stringify(res);
  }],
  ["Item 7b The model download starts with the library and its WASM start-up, and runs once (shared, and for the CPU fallback); chosen model; reuse", async () => {
    await libMode("fake");
    try {
      await reset(FULL);
      const A = await openRealLoader("A", { wasmMs: 300 });
      A.api.strictCamera = true;
      const fv = A.w.__fakeVision, net = slowModelNet(A, 400), cam = {};
      A.camera(cam); A.fakeWakeLock(false);
      const ev = (n, from = 0) => fv.log.slice(from).find(e => e.ev === n);
      // 1. Full: a fight, and Settings asking for Full again while it loads (one shared load)
      await A.tapFight("field-mouse");
      pickModel(A, "full");
      await until(() => A.fight || A.modal(), 5000, "the fight").catch(() => {});
      const f = net.fetches[0], cr = ev("create"), wr = ev("wasmReady"), rd = ev("modelRead");
      const full = { ready: !!A.fight, error: A.modal().slice(0, 60), modelDownloads: net.fetches.length, model: f ? f.url.split("/").pop() : null,
        downloadStartedBeforeWasmReady: !!f && !!wr && f.start < wr.t, downloadRunningAtCreate: !!f && !!cr && f.end > cr.t,
        createToModelReadMs: cr && rd ? Math.round(rd.t - cr.t) : null, creates: fv.log.filter(e => e.ev === "create").length, delegate: A.api.delegate };
      await tapFlee(A);
      // 2. the next fight reuses the ready model
      const n0 = net.fetches.length, c0 = fv.log.filter(e => e.ev === "create").length;
      await A.fightMonster("field-mouse");
      const reuse = { ready: !!A.fight, newDownloads: net.fetches.length - n0, newCreates: fv.log.filter(e => e.ev === "create").length - c0 };
      await tapFlee(A);
      // 3. Lite with the GPU failing: the CPU fallback uses the same download
      fv.failGpu = true;
      const k = fv.log.length, n1 = net.fetches.length;
      pickModel(A, "lite");
      await A.fightMonster("field-mouse");
      const tries = fv.log.slice(k).filter(e => e.ev === "create").map(e => e.delegate).join("+");
      const lite = { ready: !!A.fight, error: A.modal().slice(0, 60), downloads: net.fetches.length - n1, model: net.fetches[n1] ? net.fetches[n1].url.split("/").pop() : null,
        tries, delegate: A.api.delegate };
      await tapFlee(A);
      const res = { full, reuse, lite };
      check(full.ready && !full.error && full.modelDownloads === 1 && full.model === "pose_landmarker_full.task" && full.downloadStartedBeforeWasmReady && full.downloadRunningAtCreate
        && full.delegate === "GPU" && reuse.ready && reuse.newDownloads === 0 && reuse.newCreates === 0
        && lite.ready && !lite.error && lite.downloads === 1 && lite.model === "pose_landmarker_lite.task" && lite.tries === "GPU+CPU" && lite.delegate === "CPU", JSON.stringify(res));
      check(A.errors.length === 0, "errors: " + A.errors.join(" | "));
      return JSON.stringify(res);
    } finally { await libMode("block"); }
  }],
  ["Item 7c Offline copies still answer: the loader asks only for links the offline helper saves, the model as a plain download, and its bytes are used", async () => {
    await libMode("fake");
    try {
      await reset(FULL);
      const A = await openRealLoader("A", { wasmMs: 50 });
      A.api.strictCamera = true;
      const net = slowModelNet(A, 50, 4321), cam = {};
      A.camera(cam); A.fakeWakeLock(false);
      const core = await A.w.eval(`import(${JSON.stringify(new URL("core.js", A.w.location.href).href)})`); // the game's own module (same one)
      const saves = await core.trackingFiles("full");     // what the offline helper downloads and keeps
      await A.fightMonster("field-mouse");
      const made = A.w.__fakeVision.made || [];
      const res = { ready: !!A.fight, error: A.modal().slice(0, 70), savedList: saves.map(u => u.split("/").pop()), libInList: saves.includes(LIB_URL),
        modelDownloads: net.fetches.length, modelInList: net.fetches.length > 0 && net.fetches.every(f => saves.includes(f.url)), plainDownload: net.fetches.every(f => !f.init),
        bytesUsed: made[0] ? made[0].bytes === 4321 : false };
      await tapFlee(A);
      check(res.ready && !res.error && res.libInList && res.modelDownloads === 1 && res.modelInList && res.plainDownload && res.bytesUsed, JSON.stringify(res));
      check(A.errors.length === 0, "errors: " + A.errors.join(" | "));
      return JSON.stringify(res);
    } finally { await libMode("block"); }
  }],
  ["Item 7d The startup screen gets a frame before the first inference; that one frame makes the fight ready, before its clock (map and mine)", async () => {
    await reset();
    const A = await open("A");
    await skipWarmUp(A);
    A.api.strictCamera = true;
    const cam = {}, calls = [], fr = { n: 0 };
    A.camera(cam);
    const raf = A.w.requestAnimationFrame.bind(A.w), tick = () => { fr.n++; raf(tick); };
    raf(tick);
    const wl = A.fakeWakeLock(false), ask = A.w.navigator.wakeLock.request;
    const lock = { frame: null };
    A.w.navigator.wakeLock.request = function (...a) { lock.frame = fr.n; return ask.apply(this, a); };
    // a ready model whose first inference holds the page for 300 ms
    A.api.hooks.setModelLoader(async () => ({ lm: { n: 0, detectForVideo() {
      const c = { frame: fr.n, start: A.w.performance.now(), ready: !!A.fight };
      if (this.n++ === 0) { const end = A.w.performance.now() + 300; while (A.w.performance.now() < end) {} }
      c.end = A.w.performance.now(); calls.push(c); return { landmarks: [] };
    }, close() {} }, used: "GPU" }));
    pickModel(A, A.state.settings.model);
    await wait(100);
    const runs = [];
    for (const where of ["map", "mine"]) {
      const k = calls.length;
      if (where === "map") await A.fightMonster("field-mouse"); else await A.enterFloor();
      const first = calls[k], f = A.fight;
      runs.push({ where, ready: !!f, framesAfterLockAnswer: first && lock.frame !== null ? first.frame - lock.frame : null, firstInferMs: first ? Math.round(first.end - first.start) : null,
        firstBeforeReady: !!first && !first.ready, clockAfterFirst: !!f && !!first && f.waitSince >= first.end,
        inferencesBeforeClock: f ? calls.slice(k).filter(c => c.start <= f.waitSince).length : null });
      await tapFlee(A);
    }
    check(runs.every(r => r.ready && r.framesAfterLockAnswer >= 1 && r.firstBeforeReady && r.clockAfterFirst && r.inferencesBeforeClock === 1), JSON.stringify(runs));
    check(A.errors.length === 0, "errors: " + A.errors.join(" | "));
    return JSON.stringify(runs);
  }],
  ["Item 7e Stuck after the camera permission: a retryable error when time is up, nothing left on, no penalty; a same-model retry works first; the old model closes once", async () => {
    await reset();
    const A = await open("A");
    await skipWarmUp(A);
    A.api.strictCamera = true;
    const LIMIT = 1500;
    const hasLimit = typeof A.api.hooks.setStartBudget === "function";
    if (hasLimit) A.api.hooks.setStartBudget(LIMIT);
    const cam = {}, bad = [], notes = [];
    A.camera(cam);
    const ml = A.heldModels(), wl = A.fakeWakeLock(false), loop = A.countLoop();
    // 1. the camera permission question stays open longer than the time limit: no time-out, Back works
    cam.hold = true;
    await A.tapFight("field-mouse");
    await wait(LIMIT + 700);
    const permission = { timedOut: /too long/i.test(A.modal()), stillStarting: A.screen() === "fight" && !A.fight };
    await tapFlee(A);
    permission.backToMap = A.screen() === "map";
    cam.give();
    if (permission.timedOut || !permission.stillStarting || !permission.backToMap) bad.push(`while the permission question was open: ${JSON.stringify(permission)}`);
    notes.push(`permission open ${LIMIT + 700} ms: ${JSON.stringify(permission)}`);
    try { noPenalty(A); } catch (e) { bad.push("after Back: " + e.message); }
    // 2. camera allowed at once, body tracking stuck: after the limit, a retryable error and nothing on
    await A.tapFight("field-mouse");
    const t0 = performance.now();
    await until(() => /too long/i.test(A.modal()), LIMIT + 1500, "the time-out").catch(() => {});
    const r0 = loop.runs; await wait(300);
    const st = saved();
    const stuck = { timedOutAfterMs: /too long/i.test(A.modal()) ? Math.round(performance.now() - 300 - t0) : null, retryButton: !!A.d.querySelector('#modal [data-action="retryStart"]'),
      liveTracks: liveTracks(cam.streams), locks: heldLocks(wl), loopRuns300ms: loop.runs - r0, trackerRunning: A.api.trackerRunning, screen: A.screen(),
      losses: Object.keys(st.losses || {}).length, history: (st.history || []).length, loads: ml.loads.length };
    if (!(stuck.timedOutAfterMs !== null && stuck.retryButton && !stuck.liveTracks && !stuck.locks && !stuck.loopRuns300ms && !stuck.trackerRunning && !stuck.losses && !stuck.history))
      bad.push(`body tracking stuck: ${JSON.stringify(stuck)}${hasLimit ? "" : " (no time limit in this version)"} / "${A.modal().slice(0, 80)}"`);
    notes.push(`stuck: ${JSON.stringify(stuck)}`);
    try { noPenalty(A); } catch (e) { bad.push("after the time-out: " + e.message); }
    // 3. Try again with the same model, before the stuck load ends: a new load, and the fight starts
    if (stuck.retryButton) {
      A.d.querySelector('#modal [data-action="retryStart"]').click();
      await until(() => ml.loads.length === 2, 3000, "the retry's load").catch(() => {});
      const m2 = ml.loads[1] && ml.loads[1].give();
      await until(() => A.fight || /can't start/i.test(A.modal()), 3000, "the retry's fight").catch(() => {});
      const retry = { ready: !!A.fight, error: A.modal().slice(0, 60), loads: ml.loads.length, sameModel: ml.loads.length === 2 && ml.loads[0].name === ml.loads[1].name,
        retryTracks: !!m2 && m2.frames > 0 };
      // 4. now the old, stuck load answers: it is closed once and the retry's model keeps going
      const m1 = ml.loads[0].give();
      await wait(300);
      const f2 = m2 ? m2.frames : 0; await wait(400);
      const old = { oldCloses: m1.closes, oldFrames: m1.frames, retryCloses: m2 ? m2.closes : null, retryStillTracking: !!m2 && m2.frames > f2, fightGoesOn: !!A.fight && !A.fight.over,
        liveTracks: liveTracks(cam.streams), locks: heldLocks(wl) };
      if (!(retry.ready && !retry.error && retry.loads === 2 && retry.sameModel && retry.retryTracks)) bad.push(`retry: ${JSON.stringify(retry)}`);
      if (!(old.oldCloses === 1 && old.oldFrames === 0 && old.retryCloses === 0 && old.retryStillTracking && old.fightGoesOn && old.liveTracks === 1 && old.locks === 1)) bad.push(`old load answering late: ${JSON.stringify(old)}`);
      notes.push(`retry: ${JSON.stringify(retry)}; old load answers: ${JSON.stringify(old)}`);
      await tapFlee(A);
    }
    if (A.errors.length) bad.push("errors: " + A.errors.join(" | "));
    check(!bad.length, bad.join(" || "));
    return notes.join("; ");
  }],
  // ------------------------------------------------------------ earlier fixes keep working
  ["Two windows still never save over each other", async () => {
    await reset();
    const A = await open("A");
    const B = await open("B");
    await A.fightMonster("field-mouse");
    await A.reps(3);
    const wins = saved().stats.wins;
    check(wins === 1, "A's win was not saved");
    await B.goto("settings");
    B.d.querySelector("#sVoice").click(); await wait(800);
    check(saved().stats.wins === 1, "B's setting change erased A's win");
  }],
];

// ---------------------------------------------------------------- runner
const log = document.getElementById("log");
window.__results = [];
const only = new URLSearchParams(location.search).get("only"); // run.ps1 -Only "Item 2": just those tests
for (const [name, fn] of tests) {
  if (only && !name.includes(only)) continue;
  const t0 = performance.now();
  let pass = true, detail = "", note = "";
  try { note = (await fn()) || ""; } catch (e) { pass = false; detail = e.message; }
  window.__results.push({ name, pass, detail, note, secs: +((performance.now() - t0) / 1000).toFixed(1) });
  log.insertAdjacentHTML("beforeend", `<span class="${pass ? "pass" : "fail"}">${pass ? "PASS" : "FAIL"}</span> ${name}${(detail || note) ? " — " + (detail || note).replace(/</g, "&lt;") : ""}\n`);
}
await reset();
window.__done = true;
