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
    rep() { try { w.PushupRPG.repEvent({ type: "rep", count: 1, depth: true, downSecs: 3 }); } catch (e) { errors.push("thrown: " + e.message); } },
    async reps(n) { for (let i = 0; i < n; i++) { g.rep(); await wait(40); } await wait(300); },
  };
  return g;
}
const close = id => { document.getElementById(id).src = "about:blank"; return wait(200); };

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
