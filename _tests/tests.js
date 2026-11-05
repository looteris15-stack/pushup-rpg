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
  let pass = true, detail = "";
  try { await fn(); } catch (e) { pass = false; detail = e.message; }
  window.__results.push({ name, pass, detail, secs: +((performance.now() - t0) / 1000).toFixed(1) });
  log.insertAdjacentHTML("beforeend", `<span class="${pass ? "pass" : "fail"}">${pass ? "PASS" : "FAIL"}</span> ${name}${detail ? " — " + detail.replace(/</g, "&lt;") : ""}\n`);
}
await reset();
window.__done = true;
