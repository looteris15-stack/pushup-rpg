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
for (const [name, fn] of tests) {
  const t0 = performance.now();
  let pass = true, detail = "", note = "";
  try { note = (await fn()) || ""; } catch (e) { pass = false; detail = e.message; }
  window.__results.push({ name, pass, detail, note, secs: +((performance.now() - t0) / 1000).toFixed(1) });
  log.insertAdjacentHTML("beforeend", `<span class="${pass ? "pass" : "fail"}">${pass ? "PASS" : "FAIL"}</span> ${name}${(detail || note) ? " — " + (detail || note).replace(/</g, "&lt;") : ""}\n`);
}
await reset();
window.__done = true;
