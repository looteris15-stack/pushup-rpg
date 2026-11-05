import { createTracker, initAudio, sfx, say, hush, audio, trackingFiles, downSecsOf, canKeepAwake } from "./core.js";
import { ART, RULES, ZONES, DUNGEON, WANDERERS, MAX_LEVEL, xpForLevel, levelFromXp, titleFor, xpReward, findMonster, startZoneFor, slowSecs, artUrl } from "./data.js";

const DEBUG = new URLSearchParams(location.search).has("debug");
const SAVE_KEY = "pushupRPG.save.v1";
const SCREENS = ["camp", "map", "dungeon", "records", "settings", "fight"];
const TESTED_STRICTNESS = { depth: 63, top: 160, bend: 20, knee: 135 };
// bump when TESTED_STRICTNESS changes: old saves then get the new strictness once
const STRICT_V = 3;
const DEFAULT_SETTINGS = { ...TESTED_STRICTNESS, strictV: STRICT_V, voice: true, sound: true, camera: "user", model: "full" };
// the strictness sliders' ranges (index.html); a save with values outside them gets the tested ones
const SETTING_RANGES = { depth: [40, 120], top: [140, 178], bend: [8, 40], knee: [120, 175] };

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`; // "1 hit", "2 hits"
let timeOffset = 0; // debug only: pretend time has passed
const now = () => Date.now() + timeOffset;

// ---------- save ----------

function freshState(settings = DEFAULT_SETTINGS) {
  return {
    v: 1, rev: 0, savedAt: 0,
    xp: 0, restUntil: 0, dungeonLockedUntil: 0, dungeonFloor: 1, run: null, unlockedZones: 1,
    tested: false, testResult: 0, wandererDone: "",
    wanderToday: null, // { key, hp }: today's wandering monster keeps the HP it had when first seen
    lastBackupAt: 0, backupFights: 0, // when the last backup was made, and stats.fights at that time
    fightMark: null, // a fight that has started (see markFight), so closing the game still counts it
    kills: {}, losses: {}, history: [],
    stats: { pushups: 0, fights: 0, wins: 0, bestSet: 0, biggestKill: 0, deepestFloor: 0 },
    settings: { ...settings },
  };
}
let needsSave = false;
function normalize(s) {
  const f = freshState();
  const out = { ...f, ...s, stats: { ...f.stats, ...(s.stats || {}) }, settings: { ...f.settings, ...(s.settings || {}) } };
  if ((s.settings || {}).strictV !== STRICT_V) {
    Object.assign(out.settings, TESTED_STRICTNESS, { strictV: STRICT_V });
    needsSave = true;
  }
  return out;
}
function saveIfMigrated() {
  if (needsSave) { needsSave = false; save(); }
}
// a save that can't be read is kept under its own key, so starting over never destroys it
let brokenSave = false, saveFailed = false;
function loadLocal() {
  let raw = null;
  try {
    raw = localStorage.getItem(SAVE_KEY);
    return raw ? normalize(cleanSave(JSON.parse(raw), true)) : freshState();
  } catch {
    if (raw) {
      brokenSave = true;
      try { if (!localStorage.getItem(SAVE_KEY + ".broken")) localStorage.setItem(SAVE_KEY + ".broken", raw); } catch {}
    }
    return freshState();
  }
}
let state = loadLocal();
// returns whether the save really reached the phone's storage
function storeLocal() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); saveFailed = false; }
  catch { saveFailed = true; } // storage full or blocked: the camp shows a warning
  return !saveFailed;
}
function storedSave() {
  try { const raw = localStorage.getItem(SAVE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
// The installed app and a Chrome tab (or two tabs) share one save. When another window saves newer
// progress, this one takes it over, so an older window can never save over it.
function adoptIfNewer() {
  const s = storedSave();
  if (!s || !((s.rev || 0) > (state.rev || 0))) return false;
  state = normalize(s);
  needsSave = false;
  applySettings();
  if (current !== "fight") renderCurrent();
  // this window was in a mine fight or break, and the run is gone in the newer save
  if (!state.run && ((fight && !fight.over && fight.where === "dungeon") || (rest && !fight))) syncLost();
  return true;
}
window.addEventListener("storage", e => { if (e.key === SAVE_KEY) adoptIfNewer(); });
window.addEventListener("pageshow", e => { if (e.persisted) adoptIfNewer(); });
window.addEventListener("focus", () => adoptIfNewer());

// Run from the PC (start.ps1), the server keeps a copy in save\save.json, so progress survives a new phone link.
// On a fixed web address (GitHub Pages) there is no PC copy: the save lives on the phone, plus backup codes.
// rev counts saves: the copy with the higher rev wins. Nothing is sent before the PC copy was checked,
// so a fresh phone link can never overwrite real progress.
const PC_SAVE = !location.hostname.endsWith("github.io");
let pcChecked = false;
const asciiJson = s => JSON.stringify(s).replace(/[\u007f-￿]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
// returns true when the progress is really saved on the phone (result screens only say "saved" then)
function save() {
  // another window saved newer progress since this one last looked: take that instead of saving over it
  if (adoptIfNewer()) return false;
  state.rev = (state.rev || 0) + 1;
  state.savedAt = Date.now();
  const ok = storeLocal();
  pushToPc();
  return ok;
}
// shown on a victory screen when saving failed: the progress is only in this session until backed up
const NOT_SAVED = `<span class="chip bad">Not saved</span> Saving failed: the phone's storage is full or blocked, so this is only kept until you close the game. Make a backup now (button below, or Settings → Backup) before you close or reload it.`;
const BACKUP_NOW_BTN = `<button type="button" class="primary" data-action="backupNow">Back up now</button>`;
let saveTimer = 0;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 500); }

function pushToPc() {
  if (!PC_SAVE || !pcChecked) return;
  fetch("/api/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: asciiJson(state) })
    .then(r => setSync(r.ok), () => setSync(false));
}
async function syncFromPc() {
  if (!PC_SAVE) {
    // the camp shows where progress is saved and when the last backup was;
    // checkStorage asks Chrome not to clean this site's storage when space runs low
    checkStorage();
    return;
  }
  try {
    const r = await fetch("/api/save", { cache: "no-store" });
    pcChecked = true;
    if (r.status === 404) { pushToPc(); return; }
    if (!r.ok) throw new Error("status " + r.status);
    const remote = normalize(await r.json());
    setSync(true);
    if (remote.rev > state.rev) {
      state = remote;
      brokenSave = false; // the PC copy replaced a save that couldn't be read
      storeLocal();
      applySettings();
      renderCurrent();
      saveIfMigrated();
    } else if (state.rev > remote.rev) {
      pushToPc();
    }
  } catch {
    pcChecked = true;
    setSync(false);
  }
}
function setSync(ok) {
  $("syncStatus").textContent = ok
    ? "Progress is saved on your PC too, so a new phone link keeps it."
    : "Progress is saved on this phone only. The PC copy could not be reached.";
}

// ---------- time ----------

function fmtLeft(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min ${s % 60} s`;
  return `${s} s`;
}
function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
const fmtAt = ts => new Date(ts).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const until = ts => `<b data-until="${ts}">${fmtLeft(ts - now())}</b>`;

let modalRefresh = null;
function tickCountdowns() {
  let expired = false;
  document.querySelectorAll("[data-until]").forEach(el => {
    if (el.closest("[hidden]")) return;
    const left = Number(el.dataset.until) - now();
    if (left <= 0) expired = true;
    else el.textContent = fmtLeft(left);
  });
  if (expired) {
    renderCurrent();
    if (modalRefresh) modalRefresh();
  }
}
setInterval(tickCountdowns, 1000);

// ---------- special monsters ----------

const TEST = { id: "test", name: "Strength test", hp: 0 };
const champion = () => ({ id: "champion", name: "The Champion", hp: state.stats.bestSet + 1, boss: true });

const dayKey = () => { const d = new Date(now()); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// Shows up on about 2 of 3 days, the same one all day. HP comes from your highest open area.
function todaysWanderer() {
  const key = dayKey(), h = hash(key);
  if (h % 3 === 0) return null;
  const w = WANDERERS[(h >>> 4) % WANDERERS.length];
  let zi = 0;
  for (let i = 0; i < Math.min(state.unlockedZones, ZONES.length); i++) {
    if (ZONES[i].monsters.some(m => !m.slow && !m.rounds)) zi = i;
  }
  const hps = ZONES[zi].monsters.filter(m => !m.slow && !m.rounds).map(m => m.hp);
  const lo = Math.min(...hps), hi = Math.max(...hps);
  let hp = lo + ((h >>> 8) % (hi - lo + 1));
  // a slow-rep wanderer gets fewer HP, like the other slow monsters (3 s from Frost Peaks on)
  const slow = w.slow ? (zi >= 4 ? RULES.slowHardSec : RULES.slowDownSec) : 0;
  if (slow) hp = Math.round(hp * RULES.specialHpMult);
  // it keeps the HP it had when first seen today, even if a new area opens later that day
  const seen = state.wanderToday;
  if (seen && seen.key === key) hp = seen.hp;
  else { state.wanderToday = { key, hp }; saveSoon(); }
  return { ...w, id: `wanderer-${w.id}`, slow, hp, key };
}

// everything you can fight from the map: { m, where, label, zone }
function resolveMonster(id) {
  if (id === "test") return { m: TEST, where: "test", label: "Strength test" };
  if (id === "champion") return state.tested ? { m: champion(), where: "champion", label: "Champion's Ring" } : null;
  if (id.startsWith("wanderer-")) {
    const w = todaysWanderer();
    return w && w.id === id && state.wandererDone !== w.key ? { m: w, where: "wander", label: "Wandering monster" } : null;
  }
  const f = findMonster(id);
  return f && f.zone ? { m: f.m, where: "world", label: f.zone.name, zone: f.zone } : null;
}
// for the records table
function describeMonster(id) {
  const f = findMonster(id);
  if (f) return { name: f.m.name, where: f.zone ? f.zone.name : `Mine floor ${f.floor}`, hp: f.m.hp };
  if (id === "champion") return { name: "The Champion", where: "Champion's Ring", hp: "–" };
  const w = WANDERERS.find(x => `wanderer-${x.id}` === id);
  return w ? { name: w.name, where: "Wandering", hp: "–" } : null;
}

// a boss opens when every other monster in its area was beaten once
function bossLock(m, zone) {
  if (!m.boss || !zone) return null;
  const others = zone.monsters.filter(x => !x.boss);
  const done = others.filter(x => state.kills[x.id]).length;
  return done < others.length ? { done, total: others.length } : null;
}

function rewardFor(m, where) {
  if (where === "wander") return Math.round(m.hp * RULES.wandererXpMult * (m.slow ? RULES.specialXpMult : 1));
  if (where === "champion") return m.hp * RULES.championXpPerRep;
  return xpReward(m, where);
}

// ---------- screens ----------

let current = "camp";
function show(name) {
  for (const s of SCREENS) $(s).hidden = s !== name;
  current = name;
  if (name !== "fight") $(name).scrollTop = 0;
  renderCurrent();
}
function renderCurrent() {
  const render = { camp: renderCamp, map: renderMap, dungeon: renderDungeon, records: renderRecords, settings: renderSettings }[current];
  if (render) render();
}

function openModal(html, refresh = null) {
  $("modalCard").innerHTML = html;
  if ($("modal").hidden) $("modal").scrollTop = 0; // a new sheet starts at the top; a redraw keeps its place
  $("modal").hidden = false;
  modalRefresh = refresh;
  prefightId = null;
}
function closeModal() {
  $("modal").hidden = true;
  modalRefresh = null;
  prefightId = null;
}

function levelInfo() {
  const L = levelFromXp(state.xp), base = xpForLevel(L), next = xpForLevel(L + 1);
  if (L >= MAX_LEVEL) return { L, into: 1, need: 1, title: titleFor(L), max: true };
  return { L, into: state.xp - base, need: next - base, title: titleFor(L) };
}
const num = n => n.toLocaleString("en-US"); // 30690 -> "30,690"
const tile = ([label, value]) => `<div class="tile panel"><span class="label">${label}</span><b>${esc(value)}</b></div>`;
// small picture for lists; an empty tile keeps rows lined up when a monster has no picture yet
const thumb = id => {
  const url = artUrl(id, true);
  return url ? `<img class="mthumb" src="${url}" alt="">` : '<span class="mthumb" aria-hidden="true"></span>';
};
function setFightArt(m) {
  const url = artUrl(m.id);
  const img = $("fArt");
  img.hidden = !url;
  if (url && img.getAttribute("src") !== url) img.src = url;
}
const chips = m => [
  m.boss ? '<span class="chip boss">Boss</span>' : "",
  m.rounds ? `<span class="chip">${m.rounds.length} rounds</span>` : "",
  m.slow ? `<span class="chip slow">Slow reps · ${slowSecs(m)} s</span>` : "",
].join(" ");

function renderCamp() {
  const { L, into, need, title, max } = levelInfo();
  $("campLevel").textContent = L;
  $("campTitle").textContent = title;
  $("campXpFill").style.width = (into / need) * 100 + "%";
  $("campXpText").textContent = max
    ? `${num(state.xp)} XP · Max level`
    : `${num(state.xp)} XP · ${num(need - into)} XP to level ${L + 1}`;
  const t = now();
  const status =
    state.restUntil > t ? `<span class="chip warn">Recovering</span> Your muscles are resting after a hard set. Fights open in ${until(state.restUntil)} (${fmtAt(state.restUntil)}).`
    : state.run ? `<span class="chip warn">In the mine</span> Your run on floor ${esc(state.run.floor)} is not finished. Go to The Old Mine to continue it.`
    : `<span class="chip good">Ready</span> You are rested. Pick a fight.`;
  const test = state.tested ? ""
    : `<div class="row"><button type="button" class="primary" data-action="prefight" data-id="test">Take the strength test</button><span class="fine">It picks the area where you start.</span></div>`;
  $("campStatus").innerHTML = status + test;
  // problems with the save itself come first: they can cost progress
  const warn = saveFailed
    ? `<span class="chip bad">Not saving</span> Saving doesn't work right now (the phone's storage may be full or blocked). Free some space, then make a backup in Settings.`
    : brokenSave
    ? `<span class="chip bad">Save damaged</span> Your saved progress couldn't be read, so the game started fresh. A copy of it was kept. If you have a backup, restore it in Settings → Backup.`
    : "";
  $("saveWarn").hidden = !warn;
  $("saveWarn").innerHTML = warn;
  const b = backupInfo();
  $("backupNag").hidden = !b.overdue;
  if (b.overdue) {
    $("backupNag").innerHTML = `<span class="chip warn">Backup</span> ${b.days == null
      ? "Your progress has no backup yet."
      : `Last backup: ${b.when}, with ${plural(b.fightsSince, "fight")} since then.`} If Chrome's data gets cleared, a backup is the only way back.
      <div class="row"><button type="button" class="primary" data-action="backupNow">Back up now</button></div>`;
  }
  if (!PC_SAVE) $("syncStatus").textContent = `Progress is saved on this phone. Last backup: ${b.when}.`;
  const s = state.stats;
  $("campTiles").innerHTML = [["Pushups done", s.pushups], ["Best set", s.bestSet], ["Monsters slain", s.wins], ["Deepest floor", s.deepestFloor]].map(tile).join("");
}

function renderMap() {
  $("mapNote").innerHTML = state.restUntil > now()
    ? `<span class="chip warn">Recovering</span> You can look around, but fights open in ${until(state.restUntil)}.`
    : "1 strict pushup = 1 hit. Beat every monster in an area once to open its boss. The boss opens the next area.";

  const cards = [];
  if (!state.tested) {
    cards.push(`<button type="button" class="special panel" data-action="prefight" data-id="test">
      <span class="eyebrow">Start here</span><b>Strength test</b>
      <span>Do as many strict pushups as you can. It picks your starting area.</span></button>`);
  } else {
    cards.push(`<button type="button" class="special panel has-art" data-action="prefight" data-id="champion">
      ${thumb("champion")}<span class="stext">
      <span class="eyebrow">Champion's Ring</span><b>The Champion · ${state.stats.bestSet + 1} HP</b>
      <span>Your best set + 1. Beat it for a new record, then keep going.</span></span></button>`);
  }
  const w = todaysWanderer();
  if (w && state.wandererDone === w.key) {
    cards.push(`<div class="special panel done"><span class="eyebrow">Wandering monster</span><b>${esc(w.name)} is gone</b>
      <span>You already fought it today. Another one may come tomorrow.</span></div>`);
  } else if (w) {
    cards.push(`<button type="button" class="special panel has-art" data-action="prefight" data-id="${w.id}">
      ${thumb(w.id)}<span class="stext">
      <span class="eyebrow">Wandering monster · today only</span><b>${esc(w.name)} · ${w.hp} HP ${chips(w)}</b>
      <span>Double XP (${rewardFor(w, "wander")}). Gone at midnight.</span></span></button>`);
  }
  $("mapSpecial").innerHTML = cards.join("");

  $("mapZones").innerHTML = ZONES.map((z, zi) => {
    const hp = z.monsters.map(m => m.hp);
    const open = zi < state.unlockedZones;
    const prevBoss = zi > 0 ? ZONES[zi - 1].monsters.find(m => m.boss) : null;
    return `<section class="zone panel${open ? "" : " locked"}">
      <header><div><h2>${esc(z.name)}</h2><p class="fine">${esc(z.blurb)}</p></div><span class="hp-range">${Math.min(...hp)}–${Math.max(...hp)} HP</span></header>
      ${open ? `<div class="mlist">${z.monsters.map(m => monsterRow(m, z)).join("")}</div>` : `<p class="fine">Locked. Beat the ${esc(prevBoss.name)} to open it.</p>`}
    </section>`;
  }).join("");
}
function monsterRow(m, zone) {
  const k = state.kills[m.id] || 0;
  const lock = bossLock(m, zone);
  const note = lock ? `beat the others first (${lock.done}/${lock.total})` : k ? `✓ slain ×${k}` : "new";
  const tags = chips(m).trim();
  // name, note and tags stack in the middle so a long note can't push into the HP on narrow phones;
  // the note sits right under the name on every row, the tags go last
  return `<button type="button" class="mrow${lock ? " locked" : ""}" data-action="prefight" data-id="${m.id}">
    ${thumb(m.id)}
    <span class="mmain">
      <span class="mname">${esc(m.name)}</span>
      <span class="mkills">${note}</span>
      ${tags ? `<span class="mchips">${tags}</span>` : ""}
    </span>
    <span class="mhp">${m.hp} HP</span>
  </button>`;
}

function openPrefight(id) {
  const r = resolveMonster(id);
  if (!r) { closeModal(); renderCurrent(); return; }
  const { m, where, label, zone } = r;
  const recovering = state.restUntil > now();
  const lock = bossLock(m, zone);
  let body, start = "Fight";
  // the phone refused to keep the screen on: it could switch off mid-set, which counts as leaving
  const screenWarn = screenOk === false
    ? `<p class="callout leave"><b>Your screen may turn off:</b> the phone won't keep it on right now (often battery saver). Turn battery saver off or set the screen timeout to 2 minutes or more first.</p>`
    : "";
  if (where === "test") {
    start = "Start the test";
    body = `<p>Do <b>as many strict pushups as you can</b> in one set. Your result picks the area where you start.</p>
      ${screenWarn}
      <ul class="rules">
        <li>The timer starts with your first strict rep. Then it ends when you stop for ${RULES.maxPauseSec} s, stand up, or tap Finish.</li>
        <li>This is not a fight: no rest time afterwards.</li>
      </ul>`;
  } else {
    const rounds = m.rounds || [m.hp];
    // special rules go in highlighted boxes so nobody misses them (kept short: the Fight button must stay in reach)
    const special = [];
    if (m.slow) special.push(["slow", `<b>Slow reps:</b> at least <b>${slowSecs(m)} s going down</b>, from straight arms to the bottom. A pause at the bottom doesn't count. You see your time after each rep. Fewer HP, ${RULES.specialXpMult}× XP.`]);
    if (rounds.length > 1) special.push(["torch", `<b>${rounds.length} rounds:</b> ${rounds.join(" + ")} pushups, <b>${RULES.roundRestSec} s rest</b> between them. Each round is one set.`]);
    if (where === "champion") special.push(["torch", `<b>Record fight:</b> your best set + 1 HP. When it falls, <b>keep going</b> for a bigger record, then tap Finish.`]);
    if (where === "wander") special.push(["torch", `<b>Today only:</b> double XP. It's gone at midnight.`]);
    // everyone sees this one: leaving mid-fight used to dodge the rest time
    special.push(["leave", `<b>Stay in the game:</b> after your first rep, leaving the app for more than ${RULES.leaveAppSec} s (closing it, switching apps, locking the phone) counts as giving up.${where === "champion" ? " Once the Champion is down, leaving just ends your set." : ""}`]);
    const rules = [];
    if (rounds.length === 1) rules.push(`<b>${m.hp} strict pushups in one set</b> win. Each rep is 1 hit.`);
    rules.push(`The timer starts with your first strict rep. Then ${RULES.maxPauseSec} s without one, or standing up, and the monster wins.`);
    rules.push(`If it wins, you rest ${RULES.restHoursAfterLoss} hours.`);
    const xp = rewardFor(m, where) + (where === "champion" ? " or more" : "");
    body = `<p class="hpbig">${m.hp}<span>HP</span></p>
      ${screenWarn}
      ${special.map(([kind, text]) => `<p class="callout ${kind}">${text}</p>`).join("")}
      <ul class="rules">${rules.map(x => `<li>${x}</li>`).join("")}</ul>
      <p class="fine">Win: +${xp} XP. Your best set so far: ${state.stats.bestSet}.${state.kills[m.id] ? ` Slain ×${state.kills[m.id]}.` : ""}</p>`;
  }
  const button = state.run ? `<button type="button" disabled>Finish your mine run first</button>`
    : lock ? `<button type="button" disabled>Beat the other ${lock.total - lock.done} first</button>`
    : recovering && where !== "test" ? `<button type="button" disabled>Recovering: ${until(state.restUntil)}</button>`
    : `<button type="button" class="primary" data-action="fight" data-id="${m.id}">${start}</button>`;
  const art = artUrl(m.id);
  openModal(`
    ${art ? `<img class="portrait" src="${art}" alt="${esc(m.name)}">` : ""}
    <p class="eyebrow">${esc(label)}</p>
    <h2 class="big">${esc(m.name)}</h2>
    ${m.boss || m.slow || m.rounds ? `<p>${chips(m)}</p>` : ""}
    ${body}
    <div class="row actions">${button}<button type="button" data-action="closeModal">Back</button></div>`,
    () => openPrefight(id));
  prefightId = id;
  // ask the phone about keeping the screen on; show the warning if the answer changed
  canKeepAwake().then(ok => {
    if (ok === screenOk) return;
    screenOk = ok;
    if (prefightId === id && !$("modal").hidden) openPrefight(id);
  });
}
let screenOk = null, prefightId = null;

function renderDungeon() {
  const t = now(), F = state.dungeonFloor, run = state.run, total = DUNGEON.floors.length;
  let status, button = "";
  if (run) {
    status = `<span class="chip warn">Run not finished</span> You are on floor ${run.floor}, room ${run.room + 1}. You get a short break first.`;
    button = `<button type="button" class="primary" data-action="continueRun">Continue the run</button>`;
  } else if (state.dungeonLockedUntil > t) {
    status = `<span class="chip bad">Closed</span> The mine is closed after your last run. It opens again in ${until(state.dungeonLockedUntil)} (${fmtAt(state.dungeonLockedUntil)}).`;
  } else if (state.restUntil > t) {
    status = `<span class="chip warn">Recovering</span> Your muscles are resting. You can enter in ${until(state.restUntil)}.`;
  } else if (F > total) {
    status = `<span class="chip good">Conquered</span> You beat all ${total} floors.`;
  } else {
    status = `<span class="chip good">Open</span> Floor ${F} is waiting.`;
    button = `<button type="button" class="primary" data-action="enterFloor">Enter floor ${F}</button>`;
  }
  $("dgStatus").innerHTML = status;

  const shown = run ? run.floor : Math.min(F, total);
  const rooms = DUNGEON.floors[shown - 1];
  const done = run ? run.room : 0;
  const sum = rooms.reduce((a, m) => a + m.hp, 0);
  $("dgFloor").innerHTML = `
    <div class="m-row"><h2>Floor ${shown} of ${total}</h2><span class="hp-range">${sum} pushups in total</span></div>
    <ol class="rooms">
      ${rooms.map((m, i) => `<li class="${i < done ? "done" : i === done ? "next" : ""}"><span class="beast">${thumb(m.id)}<span>Room ${i + 1}: <b>${esc(m.name)}</b> ${chips(m)}</span></span><span class="mhp">${m.hp} HP</span></li>`).join("")}
      <li class="safe"><span>Safe room</span><span>progress saved</span></li>
    </ol>
    ${button ? `<div class="row">${button}</div>` : ""}`;
  $("dgRules").innerHTML = `
    <li>Fight ${rooms.length} rooms in a row. Each monster is one set.</li>
    <li>You get ${RULES.restBetweenRoomsSec} seconds of rest between rooms. Then do your first rep within ${RULES.dungeonStartSec} seconds.</li>
    <li>Reach the safe room to save the floor and get +${RULES.floorBonusXp} XP times the floor number.</li>
    <li>Lose or leave before the safe room: the mine closes for ${RULES.dungeonLockDays} days and you recover ${RULES.restHoursAfterLoss} hours.</li>
    <li><b>Stay in the game during the run.</b> Leaving the app for more than ${RULES.leaveAppSec} seconds in a room, or longer than a break, counts as leaving the mine.</li>`;
  const here = run ? run.floor : F;
  $("dgLadder").innerHTML = DUNGEON.floors.map((_, i) => {
    const f = i + 1;
    return `<span class="${f < F ? "done" : f === here ? "here" : ""}" title="Floor ${f}">${f}</span>`;
  }).join("");
}

function renderRecords() {
  const s = state.stats, { L } = levelInfo();
  $("recTiles").innerHTML = [
    ["Level", L], ["Pushups done", s.pushups], ["Best set", s.bestSet], ["Strength test", state.tested ? state.testResult : "–"],
    ["Biggest kill", s.biggestKill ? `${s.biggestKill} HP` : "–"], ["Fights won", `${s.wins} / ${s.fights}`], ["Deepest floor", s.deepestFloor],
  ].map(tile).join("");
  const ids = [...new Set([...Object.keys(state.kills), ...Object.keys(state.losses)])];
  const rows = ids.map(id => ({ id, d: describeMonster(id) })).filter(r => r.d)
    .sort((a, b) => (typeof a.d.hp === "number" ? a.d.hp : 999) - (typeof b.d.hp === "number" ? b.d.hp : 999));
  $("recBeasts").innerHTML = rows.length
    ? `<thead><tr><th>Monster</th><th>Where</th><th class="num">HP</th><th class="num">Slain</th><th class="num">Lost to</th></tr></thead>
       <tbody>${rows.map(({ id, d }) => `<tr><td><span class="beast">${thumb(id)}${esc(d.name)}</span></td><td>${esc(d.where)}</td><td class="num">${esc(d.hp)}</td><td class="num">${esc(state.kills[id] || 0)}</td><td class="num">${esc(state.losses[id] || 0)}</td></tr>`).join("")}</tbody>`
    : `<tbody><tr><td class="fine">No fights yet.</td></tr></tbody>`;
  $("recHistory").innerHTML = state.history.length
    ? state.history.map(h => h.id === "test"
      ? `<li class="won"><span><b>Strength test</b>: ${esc(plural(h.reps, "pushup"))}</span><span class="fine">${esc(fmtAt(h.t))}</span></li>`
      : `<li class="${h.won ? "won" : "lost"}"><span><b>${h.won ? "Won" : "Lost"}</b> vs ${esc(h.name)} (${esc(h.hp)} HP): ${esc(plural(h.reps, "hit"))}</span><span class="fine">${esc(h.where)} · ${esc(fmtAt(h.t))}</span></li>`).join("")
    : `<li class="fine">No fights yet.</li>`;
}

const SLIDERS = [["sDepth", "oDepth", "depth"], ["sTop", "oTop", "top"], ["sBend", "oBend", "bend"], ["sKnee", "oKnee", "knee"]];
function renderSettings() {
  for (const [s, o, k] of SLIDERS) { $(s).value = state.settings[k]; $(o).textContent = state.settings[k] + "°"; }
  $("sVoice").checked = state.settings.voice;
  $("sCamera").value = state.settings.camera;
  $("sModel").value = state.settings.model;
  const b = backupInfo();
  $("backupWhen").innerHTML = `Last backup: <b>${b.when}</b>${b.days != null && b.fightsSince > 0 ? ` (${plural(b.fightsSince, "fight")} since)` : ""}`;
  $("storageNote").textContent = storageSafe == null ? ""
    : storageSafe ? "Chrome protects this game's storage from automatic cleanup. Clearing Chrome's data by hand still deletes it."
    : "Chrome may clean this game's storage if the phone runs low on space. Keep backups.";
}
// can Chrome clean up our storage by itself? (installed apps and often-used sites usually get protected)
let storageSafe = null;
async function checkStorage() {
  try {
    if (!PC_SAVE && !(await navigator.storage.persisted())) await navigator.storage.persist();
    storageSafe = await navigator.storage.persisted();
  } catch { storageSafe = null; }
  if (current === "settings") renderSettings();
}
function applySettings() {
  audio.voice = state.settings.voice;
  // the fight screen's Sound on/off button is remembered between fights
  audio.on = state.settings.sound !== false;
  $("btnSound").textContent = audio.on ? "Sound on" : "Sound off";
  $("btnSound").setAttribute("aria-pressed", String(audio.on));
}
for (const [s, o, k] of SLIDERS) {
  $(s).addEventListener("input", e => { state.settings[k] = Number(e.target.value); $(o).textContent = e.target.value + "°"; saveSoon(); });
}
$("sVoice").addEventListener("change", e => { state.settings.voice = e.target.checked; applySettings(); saveSoon(); });
$("sCamera").addEventListener("change", e => { state.settings.camera = e.target.value; saveSoon(); });
$("sModel").addEventListener("change", e => { state.settings.model = e.target.value; saveSoon(); tracker.ensureModel(e.target.value).catch(() => {}); });
$("btnDefaults").addEventListener("click", () => { Object.assign(state.settings, TESTED_STRICTNESS); renderSettings(); saveSoon(); });
// ---------- backups ----------
// The save lives in the phone's browser. If its data gets cleared, a backup is the only way back.
// backup code = the whole save as text, so progress can move to another link or phone.
// New codes: PRPG2.<save as base64>.<seal>. The seal is a fingerprint of the code, so a code changed by hand
// no longer matches it. It only stops casual edits: the recipe is in this file. Old PRPG1 codes have no seal,
// so they only get the sanity checks (still accepted, so an old backup is never useless).
const SEAL_SALT = "pushup-rpg/backup-seal/v2";
function cyrb53(str) { // small, well-known string hash
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
const seal = b64 => cyrb53(SEAL_SALT + b64).toString(36);
const backupCode = () => { const b64 = btoa(asciiJson(state)); return `PRPG2.${b64}.${seal(b64)}`; };
const backupName = () => {
  const d = new Date(now()), p = n => String(n).padStart(2, "0");
  return `pushup-rpg-backup-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.txt`; // local date, not UTC
};
const backupText = () =>
  `Pushup RPG backup · level ${levelFromXp(state.xp)} · ${plural(state.stats.pushups, "pushup")} · ${fmtAt(now())}\n` +
  `To restore: open the game, Settings → Backup → Open backup file, or paste this whole text there.\n\n${backupCode()}\n`;

// Read a backup out of any text: a pasted code, a whole message, or a backup file.
// Returns null (no code in it) or { save, problem }, where problem says why it can't be used.
function readBackup(text) {
  text = text || "";
  const m2 = /PRPG2\.([A-Za-z0-9+/=\s]+)\.([a-z0-9]+)/.exec(text);
  if (m2) {
    const b64 = m2[1].replace(/\s+/g, "");
    let save = null;
    try { save = JSON.parse(atob(b64)); } catch {}
    if (!save || typeof save !== "object" || !save.stats) return { save: null, problem: "The code is damaged. Copy the whole code and try again." };
    if (m2[2] !== seal(b64)) return { save, problem: "This backup was changed after it was made, so it can't be used." };
    const bad = checkSave(save);
    return { save, problem: bad && `This backup doesn't add up: ${bad}.` };
  }
  const m1 = /PRPG1\.([A-Za-z0-9+/=\s]+)/.exec(text);
  if (!m1) return null;
  const b64 = m1[1].replace(/\s+/g, "");
  // words after an old code (an email signature, "sent from my phone") stick to it once spaces are
  // removed, so cut letters off the end until it reads as a save again
  for (let end = b64.length; end > 0 && end > b64.length - 400; end--) {
    try {
      const save = JSON.parse(atob(b64.slice(0, end)));
      if (save && typeof save === "object" && save.stats) {
        const bad = checkSave(save);
        return { save, problem: bad && `This backup doesn't add up: ${bad}. It may have been changed by hand.` };
      }
    } catch {}
  }
  return { save: null, problem: "The code is damaged. Copy the whole code and try again." };
}

// Rules every real save follows. A backup that breaks one was changed by hand (or is broken).
// Returns what is wrong, or null when it all adds up.
const WANDER_HP_MAX = Math.max(...ZONES.flatMap(z => z.monsters.filter(m => !m.slow && !m.rounds).map(m => m.hp)));
function checkSave(s) {
  const whole = v => Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
  const st = s.stats || {};
  const kills = s.kills || {}, losses = s.losses || {};
  if (![s.xp, s.testResult ?? 0, s.unlockedZones ?? 1, s.dungeonFloor ?? 1].every(whole)) return "a number in it is not a normal number";
  if (!["pushups", "fights", "wins", "bestSet", "biggestKill", "deepestFloor"].every(k => whole(st[k] ?? 0))) return "a stat in it is not a normal number";
  if (![...Object.values(kills), ...Object.values(losses)].every(whole)) return "a monster count is not a normal number";
  const wander = id => WANDERERS.find(w => `wanderer-${w.id}` === id);
  const unknown = [...Object.keys(kills), ...Object.keys(losses)].find(id => id !== "champion" && !wander(id) && !findMonster(id));
  if (unknown) return `it has a monster the game doesn't know (${unknown})`;

  const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
  const wins = st.wins || 0, fights = st.fights || 0, pushups = st.pushups || 0, best = st.bestSet || 0;
  if (wins !== sum(kills)) return `${num(wins)} wins, but ${num(sum(kills))} monsters slain`;
  if (fights !== wins + sum(losses)) return `${num(fights)} fights, but ${num(wins)} wins and ${num(sum(losses))} losses`;

  const test = s.tested ? s.testResult || 0 : 0;
  // most reps one fight can give: the monster's HP (a lost fight gives fewer); the Champion: one set, so your best set
  const repsCap = id => id === "champion" ? best : wander(id) ? WANDER_HP_MAX : findMonster(id).m.hp;
  const fought = { ...losses };
  for (const [id, k] of Object.entries(kills)) fought[id] = (fought[id] || 0) + k;
  const maxPushups = test + Object.entries(fought).reduce((a, [id, k]) => a + k * repsCap(id), 0);
  if (pushups > maxPushups) return `${num(pushups)} pushups, but its fights could give at most ${num(maxPushups)}`;
  if (best > pushups || best < test) return `a best set of ${num(best)} doesn't fit ${num(pushups)} pushups in total`;

  // most XP: the strength test, every win at its full reward, and the bonus of each mine floor cleared
  const xpCap = id => {
    if (id === "champion") return best * RULES.championXpPerRep;
    const w = wander(id);
    if (w) return Math.round(WANDER_HP_MAX * RULES.wandererXpMult * (w.slow ? RULES.specialXpMult : 1));
    const f = findMonster(id);
    return xpReward(f.m, f.zone ? "world" : "dungeon");
  };
  const deepest = st.deepestFloor || 0;
  const maxXp = test + Object.entries(kills).reduce((a, [id, k]) => a + k * xpCap(id), 0) + RULES.floorBonusXp * deepest * (deepest + 1) / 2;
  if (s.xp > maxXp) return `${num(s.xp)} XP, but its wins could give at most ${num(maxXp)}`;

  // areas open only through the strength test and then each area's boss in turn
  let canOpen = s.tested ? startZoneFor(test) + 1 : 1;
  while (canOpen < ZONES.length && kills[ZONES[canOpen - 1].monsters.find(m => m.boss).id]) canOpen++;
  const open = s.unlockedZones ?? 1;
  if (open < 1 || open > canOpen) return `${open} areas open, but only ${canOpen} could be`;

  // the mine goes floor by floor
  const floor = s.dungeonFloor ?? 1;
  if (deepest > DUNGEON.floors.length || floor < 1 || floor > deepest + 1) return `mine floor ${floor} doesn't fit ${deepest} floors cleared`;
  const tooDeep = Object.keys({ ...kills, ...losses }).map(id => findMonster(id)).find(f => f && f.floor && f.floor > floor);
  if (tooDeep) return `it beat or met a monster on mine floor ${tooDeep.floor} without reaching it`;
  // a mine run in progress is always on the current floor, in one of its rooms
  const run = s.run;
  if (run != null) {
    const rooms = DUNGEON.floors[floor - 1];
    if (typeof run !== "object" || run.floor !== floor || !rooms || !whole(run.room) || run.room >= rooms.length) return "it has a mine run that can't exist";
  }
  if (!Array.isArray(s.history ?? [])) return "its fight list is broken";
  return null;
}

// Everything else in a restored save gets cleaned, so nothing in it can break a screen or put its own
// HTML into the page: text is cut short, numbers must be numbers, settings stay in their slider ranges.
// A half-finished fight (fightMark) is dropped: a backup is restored on purpose, not after a crash.
function cleanSave(s, keepMark = false) {
  const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
  const numOr = (v, d) => (Number.isFinite(v) ? v : d);
  const out = { ...s };
  out.history = (Array.isArray(s.history) ? s.history : []).slice(0, 40).map(h => ({
    t: numOr(h && h.t, 0), id: str(h && h.id, 40) || undefined, name: str(h && h.name, 60),
    hp: numOr(h && h.hp, 0), reps: numOr(h && h.reps, 0), won: !!(h && h.won), where: str(h && h.where, 60),
  }));
  const set = { ...DEFAULT_SETTINGS, ...(s.settings && typeof s.settings === "object" ? s.settings : {}) };
  for (const [k, [lo, hi]] of Object.entries(SETTING_RANGES)) {
    if (!(Number.isFinite(set[k]) && set[k] >= lo && set[k] <= hi)) set[k] = TESTED_STRICTNESS[k];
  }
  if (!["user", "environment"].includes(set.camera)) set.camera = DEFAULT_SETTINGS.camera;
  if (!["full", "lite"].includes(set.model)) set.model = DEFAULT_SETTINGS.model;
  set.voice = set.voice !== false;
  set.sound = set.sound !== false;
  out.settings = set;
  for (const k of ["restUntil", "dungeonLockedUntil", "lastBackupAt", "backupFights", "savedAt", "rev"]) out[k] = numOr(s[k], 0);
  out.wandererDone = str(s.wandererDone, 20);
  const w = s.wanderToday;
  out.wanderToday = w && typeof w === "object" && typeof w.key === "string" && Number.isFinite(w.hp) ? { key: w.key.slice(0, 20), hp: w.hp } : null;
  if (out.run) out.run = { floor: out.run.floor, room: out.run.room, ...(Number.isFinite(out.run.breakEndsAt) ? { breakEndsAt: out.run.breakEndsAt } : {}) };
  if (!keepMark) out.fightMark = null;
  return out;
}

function backupInfo() {
  const fightsSince = state.stats.fights - (state.backupFights || 0);
  const days = state.lastBackupAt ? Math.floor((now() - state.lastBackupAt) / 86400000) : null;
  const when = days == null ? "never" : days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  // nag only when there is something new to lose: never backed up, a week old, or many fights since
  const overdue = state.stats.fights > 0 && fightsSince > 0 && (days == null || days >= 7 || fightsSince >= 20);
  return { fightsSince, days, when, overdue };
}
function markBackedUp(msg) {
  state.lastBackupAt = now();
  state.backupFights = state.stats.fights;
  save();
  $("backupMsg").textContent = msg;
  renderCurrent();
}

// one tap: the phone's share menu, so the backup file goes to Google Drive, email, Messenger...
async function shareBackup() {
  const text = backupText();
  const file = new File([text], backupName(), { type: "text/plain" });
  try {
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: "Pushup RPG backup" });
    else if (navigator.share) await navigator.share({ title: "Pushup RPG backup", text });
    else { downloadBackup(); return; }
    markBackedUp("Backup sent. Keep it somewhere safe, like Google Drive or an email to yourself.");
  } catch (e) {
    if (e?.name === "AbortError") { $("backupMsg").textContent = "Backup not sent."; return; }
    downloadBackup();
  }
}
function downloadBackup() {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([backupText()], { type: "text/plain" }));
  a.download = backupName();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  markBackedUp(`Backup file saved (${backupName()}), usually in your Downloads folder.`);
}
$("btnShareBackup").addEventListener("click", shareBackup);
$("btnSaveBackup").addEventListener("click", downloadBackup);
$("btnBackup").addEventListener("click", () => {
  const code = backupCode();
  const box = $("backupText");
  const showBox = () => {
    box.value = code;
    box.hidden = false;
    box.select();
    $("backupMsg").textContent = "Select all of the code above and copy it.";
  };
  if (navigator.clipboard?.writeText) {
    // only copied, not kept anywhere yet, so this doesn't count as a backup (Send / Save as file do)
    navigator.clipboard.writeText(code).then(() => { $("backupMsg").textContent = "Backup code copied. Paste it somewhere safe now, like a note or an email to yourself."; }, showBox);
  } else {
    showBox();
  }
});
$("restoreFile").addEventListener("change", async e => {
  const f = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!f) return;
  const text = await f.text().catch(() => "");
  const r = readBackup(text);
  if (!r) { $("backupMsg").textContent = "That file has no Pushup RPG backup in it."; return; }
  if (r.problem) { $("backupMsg").textContent = r.problem; return; }
  $("restoreText").value = text;
  $("backupMsg").textContent = `Backup found: level ${levelFromXp(r.save.xp || 0)}, ${plural(r.save.stats.pushups || 0, "pushup")}. Tap Restore to use it.`;
});
$("btnRestore").addEventListener("click", e => {
  const r = readBackup($("restoreText").value);
  if (!r) {
    $("backupMsg").textContent = "That doesn't look like a backup code. Copy the whole code and try again.";
    return;
  }
  if (r.problem) { $("backupMsg").textContent = r.problem; return; }
  const saved = r.save;
  confirmTap(e.currentTarget, "Tap again to replace your progress", () => {
    const rev = state.rev;
    state = normalize(cleanSave(saved));
    needsSave = false;
    state.rev = Math.max(rev, state.rev || 0);
    applySettings();
    renderSettings();
    $("restoreText").value = "";
    // the progress now equals the backup it came from, so it counts as backed up
    markBackedUp(`Restored: level ${levelFromXp(state.xp)}, ${plural(state.stats.pushups, "pushup")} done.`);
  });
});

$("btnWipe").addEventListener("click", e => confirmTap(e.currentTarget, "Tap again to reset everything", () => {
  state = { ...freshState(state.settings), rev: state.rev };
  save();
  show("camp");
}));

// two taps for anything that cannot be undone
function confirmTap(btn, armedText, fn) {
  if (btn.dataset.armed) { disarm(btn); fn(); return; }
  btn.dataset.text = btn.textContent;
  btn.textContent = armedText;
  btn.dataset.armed = String(setTimeout(() => disarm(btn), 3000));
}
function disarm(btn) {
  if (!btn.dataset.armed) return;
  clearTimeout(Number(btn.dataset.armed));
  delete btn.dataset.armed;
  btn.textContent = btn.dataset.text;
}

// ---------- fight ----------

const tracker = createTracker({
  video: $("video"), canvas: $("overlay"), frame: $("frame"),
  getCfg: () => state.settings,
  onEvent: ev => onRepEvent(ev),
  onFrame: (m, now) => onTrackFrame(m, now),
});

// fight.where: "world" | "wander" | "champion" | "test" | "dungeon"
let fight = null;  // the fight going on right now
let rest = null;   // a break: between mine rooms, or between rounds of a big monster
let hiddenAt = 0, flashUntil = 0, flashTimer = 0, lastBeep = 0;

const fakeReps = () => DEBUG && !tracker.running;
const plankState = () => (fakeReps() ? "up" : tracker.counter.state);

async function openFightScreen(backTo) {
  initAudio();
  applySettings();
  closeModal();
  show("fight");
  $("restPanel").hidden = true;
  $("banner").hidden = false;
  $("btnFlee").hidden = true;
  updateThreat(null);
  setBanner("Starting camera…", "");
  $("debug").textContent = "Starting camera…";
  $("dbgRep").hidden = $("dbgNoRep").hidden = !DEBUG;
  beat(); // other windows see a fight starting here, even while the camera is still starting
  try {
    await tracker.startCamera(state.settings.camera, state.settings.model);
    return true;
  } catch (e) {
    if (DEBUG) { $("debug").textContent = "debug: no camera, use the fake buttons"; return true; }
    tracker.stop();
    stopBeat();
    show(backTo);
    openModal(`<p class="eyebrow">Camera</p><h2>The fight can't start</h2><p>${esc(e.friendly || "Could not start the camera.")}</p>
      <div class="row"><button type="button" class="primary" data-action="closeModal">OK</button></div>`);
    return false;
  }
}

function beginFight(m, where, timedStart, label) {
  const t = performance.now();
  const rounds = m.rounds || [m.hp];
  rest = null;
  beat();
  fight = {
    m, where, label, rounds, round: 0, total: m.hp, hpLeft: m.hp, roundLeft: rounds[0],
    reps: 0, roundReps: 0, maxSet: 0,
    started: false, timedStart, waitSince: t, lastRepAt: t, leftSince: 0, over: false,
    openEnded: where === "test", overkill: false,
  };
  tracker.counter.reset();
  resetDepthMeter();
  lastBeep = 0;
  if (where === "dungeon" && state.run) delete state.run.breakEndsAt;
  if (timedStart) markFight(); else if (where === "dungeon") save();
  $("fMonster").classList.toggle("test", where === "test");
  showFightHud();
  renderFightHud();
  renderBanner();
  // the phone refused to keep the screen on: say it now, before the first rep
  if (tracker.awake === false) flash("Your screen may turn off (battery saver?). That would end the fight.", "warn", 6000);
  const secsWord = { 2: "two", 3: "three", 4: "four" }[slowSecs(m)] || String(slowSecs(m));
  say(`${timedStart ? `${m.name}. Get into plank. ` : ""}${m.slow ? `Slow reps. Take ${secsWord} seconds going down.` : ""}`);
}

function showFightHud() {
  flashUntil = 0;
  $("restPanel").hidden = true;
  $("banner").hidden = false;
  $("btnFlee").hidden = false;
  resetFleeBtn();
  updateThreat(null);
}

const canLeaveFree = () => fight && !fight.started && !fight.timedStart;
// a fight is on the line once your first rep counted, or when it has a start timer (mine rooms, later rounds).
// The strength test never is.
const committed = f => !!f && !f.over && !f.openEnded && (f.started || f.timedStart);
// A fight on the line is written into the save, so closing the game can't make it disappear:
// the next time the game opens, settleLeftFight() counts it as given up.
function markFight() {
  const f = fight;
  if (!committed(f)) return;
  state.fightMark = {
    at: now(), // updated every rep: a fresh mark may still be in use by another window
    id: f.m.id, name: f.m.name, hp: f.m.hp, key: f.m.key || "", boss: !!f.m.boss,
    where: f.where, label: f.label, reps: f.reps, maxSet: f.maxSet, total: f.total,
    rounds: f.rounds, round: f.round, overkill: !!f.overkill,
  };
  save();
}
// ---------- one fight at a time across windows ----------
// The installed app and Chrome tabs share one save. A window with a fight or break running writes an
// "alive" signal every 2 s, in its own small entry (not the save, so the save isn't rewritten all the time).
// Other windows treat the fight as still going while that signal is under 10 s old: they don't start a
// fight of their own and don't count it as given up. Once it stops (the game was closed, or left for more
// than 10 s, which the leaving rule counts as giving up anyway), the unfinished fight is settled.
// A plain timer drives it, not the camera loop, so a slow camera start or dropped frames can't stall it.
const ALIVE_KEY = "pushupRPG.alive", ALIVE_EVERY = 2000, ALIVE_FRESH = 10000;
const WINDOW_ID = Math.random().toString(36).slice(2);
function readAlive() { try { return JSON.parse(localStorage.getItem(ALIVE_KEY) || "null"); } catch { return null; } }
function beat() { try { localStorage.setItem(ALIVE_KEY, JSON.stringify({ id: WINDOW_ID, at: Date.now() })); } catch {} }
function stopBeat() { try { const a = readAlive(); if (a && a.id === WINDOW_ID) localStorage.removeItem(ALIVE_KEY); } catch {} }
setInterval(() => { if (fight || rest) beat(); }, ALIVE_EVERY);
// a fight or break is running in ANOTHER window right now
function otherWindowBusy() {
  const a = readAlive();
  return !!a && a.id !== WINDOW_ID && Date.now() - a.at < ALIVE_FRESH;
}
// shown instead of starting a second fight (or settling one that is still going)
function blockedByOtherWindow() {
  if (!otherWindowBusy()) return false;
  openModal(`<p class="eyebrow">One fight at a time</p><h2>Fight is still active in another tab</h2>
    <p>The game is open in another tab or window, and a fight or mine break is running there. Finish it there first.</p>
    <p class="fine">If you just closed that one, wait about 10 seconds and try again.</p>
    <div class="row"><button type="button" class="primary" data-action="closeModal">OK</button></div>`);
  return true;
}
// the mine run this window was fighting in was changed or ended in another window: stop without counting
function syncLost() {
  if (fight) fight.over = true;
  rest = null;
  endFight("dungeon");
  resultModal({ tone: "info", eyebrow: "Changed in another window", title: "This fight was stopped",
    lines: ["Your mine run was changed in another tab or window, so this fight can't go on here. Nothing was counted for it."],
    buttons: `<button type="button" class="primary" data-action="closeModal">OK</button>` });
}

let settleTimer = 0;
function settleLeftFight() {
  if (fight) return; // this window is the one fighting
  const mk = state.fightMark;
  const br = !mk && state.run && state.run.breakEndsAt;
  if (!mk && !br) return;
  // still going in another window: look again later instead of ending a fight that isn't over
  if (otherWindowBusy()) {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { adoptIfNewer(); settleLeftFight(); }, ALIVE_FRESH / 2);
    return;
  }
  if (mk) {
    state.fightMark = null;
    fight = {
      m: { id: mk.id, name: mk.name, hp: mk.hp, key: mk.key, boss: mk.boss }, where: mk.where, label: mk.label,
      rounds: mk.rounds || [mk.total], round: mk.round || 0, total: mk.total, hpLeft: mk.total - mk.reps, roundLeft: 0,
      reps: mk.reps, roundReps: 0, maxSet: mk.maxSet, over: false, openEnded: false, overkill: !!mk.overkill,
    };
    if (fight.overkill) win(); // the Champion was already down: the record counts
    else lose("The game was closed during the fight.");
    return;
  }
  // closed during a break in the mine and gone longer than the break plus the start time
  if (now() > br + RULES.dungeonStartSec * 1000) {
    fight = null;
    lose("The game was closed during a break in the mine, longer than the break.");
  }
}
function resetFleeBtn() {
  const b = $("btnFlee");
  disarm(b);
  b.textContent = canLeaveFree() ? (fight.where === "test" ? "Cancel" : "Run away")
    : fight && (fight.openEnded || fight.overkill) ? "Finish"
    : "Give up";
}

function renderFightHud() {
  const f = fight;
  if (!f) return;
  $("fHits").textContent = f.reps;
  $("fName").textContent = f.m.name;
  setFightArt(f.m);
  $("fHp").textContent = f.openEnded ? "as many as you can"
    : f.overkill ? `defeated · +${f.reps - f.total} extra`
    : `${f.hpLeft} / ${f.total} HP`;
  $("fHpFill").style.width = f.openEnded ? "100%" : (f.hpLeft / f.total) * 100 + "%";
  const bits = [f.where === "dungeon" && state.run
    ? `${DUNGEON.name} · floor ${state.run.floor} · room ${state.run.room + 1} of ${DUNGEON.floors[state.run.floor - 1].length}`
    : f.label];
  if (f.rounds.length > 1) bits.push(`round ${f.round + 1} of ${f.rounds.length}`);
  $("fWhere").innerHTML = esc(bits.join(" · ")) + (f.m.slow ? ` <span class="chip slow">Slow reps · ${slowSecs(f.m)} s down</span>` : "");
  $("downTime").hidden = !slowSecs(f.m);
  $("stayNote").hidden = !committed(f);
  if (f.overkill) $("stayNote").textContent = "Leaving now ends your set. The record counts.";
  else $("stayNote").textContent = "Stay in the app: leaving now counts as giving up.";
  // the line on the depth bar sits where counting depth is
  $("depthBox").style.setProperty("--line-at", ((state.settings.top - state.settings.depth) / (state.settings.top - depthFloor())) * 100 + "%");
}

// ---------- live depth meter ----------
// The bar runs from straight arms (top angle) to a bit below counting depth, so a deep rep
// visibly passes the line. On slow monsters it also shows the seconds of the way down, measured
// exactly like the rule (core.js downSecsOf), so the number you see is the number that's judged.
const depthFloor = () => state.settings.depth - 18;
let meter = { cycle: null, okPlayed: false, last: null, lastAt: 0 };
function resetDepthMeter() {
  meter = { cycle: null, okPlayed: false, last: null, lastAt: 0 };
  $("depthFill").style.height = "0%";
  $("depthBox").classList.remove("reached");
  $("depthBox").classList.add("off");
  $("downTime").textContent = "0.0 s";
  $("downTime").classList.remove("ok");
}
function renderDepth(m, now) {
  if (!fight || fight.over || rest) return;
  const { top, depth } = state.settings;
  const st = tracker.counter.state, c = tracker.counter.cycle;
  const inPlank = !!m && m.visible && (st === "up" || st === "down");
  const frac = inPlank ? Math.min(1, Math.max(0, (top - m.elbow) / (top - depthFloor()))) : 0;
  $("depthFill").style.height = frac * 100 + "%";
  $("depthBox").classList.toggle("off", !inPlank);
  $("depthBox").classList.toggle("reached", inPlank && !!c && c.depth);

  const need = slowSecs(fight.m);
  if (!need) return;
  if (c !== meter.cycle) {
    // a rep just ended: keep its time on screen; a new one started: fresh sound
    if (meter.cycle && !c) { meter.last = downSecsOf(meter.cycle); meter.lastAt = now; }
    meter.cycle = c;
    meter.okPlayed = false;
  }
  let secs;
  if (c) secs = downSecsOf(c);                                     // going down (or at the bottom)
  else if (st === "up" && m && m.elbow < top) secs = +((now - tracker.counter.topAt) / 1000).toFixed(1); // just left the top
  else if (meter.last != null && now - meter.lastAt < 3000) secs = meter.last;                         // show the last rep a moment
  else secs = 0;
  secs = secs || 0;
  $("downTime").textContent = secs.toFixed(1) + " s";
  $("downTime").classList.toggle("ok", secs >= need);
  if (c && st === "down" && secs >= need && !meter.okPlayed) { meter.okPlayed = true; sfx.slowOk(); }
}

const STATE_TEXT = {
  lost: ["Can't see you. Show your whole body from the side.", "warn"],
  idle: ["Back into plank!", "warn"],
  up: ["Go down", ""],
  down: ["Lower…", ""],
  depth: ["Push up!", "good"],
};
function setBanner(text, kind) {
  const b = $("banner");
  if (b.textContent !== text) b.textContent = text;
  const cls = "panel " + (kind || "");
  if (b.className !== cls) b.className = cls;
}
function renderBanner() {
  if (!fight || fight.over || rest || performance.now() < flashUntil) return;
  const st = plankState();
  const slow = fight.m.slow ? ` Slow reps: ${slowSecs(fight.m)} s going down.` : "";
  if (!fight.started && (st === "idle" || st === "lost")) {
    if (st === "lost") setBanner(STATE_TEXT.lost[0], "warn");
    else if (fight.timedStart) setBanner("Get into plank! The monster is coming." + slow, "");
    else setBanner("Get into plank. The timer starts with your first rep." + slow, "");
    return;
  }
  const key = st === "down" && tracker.counter.cycle?.depth ? "depth" : st;
  if (fight.m.slow && (key === "up" || key === "down")) {
    setBanner(`Go down slowly · ${slowSecs(fight.m)} s`, "");
    return;
  }
  const [text, kind] = STATE_TEXT[key] || STATE_TEXT.up;
  setBanner(text, kind);
}
function flash(text, kind, ms) {
  flashUntil = performance.now() + ms;
  setBanner(text, kind);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flashUntil = 0; renderBanner(); }, ms);
}
function replay(el, cls) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }

function updateThreat(left, total, label = "Attack in") {
  const el = $("threat");
  if (left == null) { el.hidden = true; return; }
  el.hidden = false;
  const secs = Math.ceil(left / 1000);
  $("threatFill").style.width = Math.max(0, (left / total) * 100) + "%";
  $("threatText").textContent = `${label} ${secs} s`;
  const danger = left < 5000;
  el.classList.toggle("danger", danger);
  if (danger && secs !== lastBeep) { lastBeep = secs; sfx.tick(); }
}

// the set is over: a loss, except in the strength test or after the Champion is already down
function stopSet(reason) {
  if (fight.openEnded) finishTest();
  else if (fight.overkill) win();
  else lose(reason);
}

function fightTick() {
  if (hiddenAt) return;
  const t = performance.now();
  if (rest) { restTick(t); return; }
  if (!fight || fight.over) return;
  // the timer only starts with the first counted rep, so getting into position never costs you the fight
  if (!fight.started) {
    if (fight.timedStart) {
      const left = RULES.dungeonStartSec * 1000 - (t - fight.waitSince);
      if (left <= 0) { lose("No rep in time after the break."); return; }
      updateThreat(left, RULES.dungeonStartSec * 1000);
    }
    renderBanner();
    return;
  }
  if (fight.leftSince && t - fight.leftSince > RULES.leavePlankSec * 1000) { stopSet("You left the plank position."); return; }
  const left = RULES.maxPauseSec * 1000 - (t - fight.lastRepAt);
  if (left <= 0) { stopSet(`No strict rep for ${RULES.maxPauseSec} seconds.`); return; }
  updateThreat(left, RULES.maxPauseSec * 1000, fight.openEnded || fight.overkill ? "Set ends in" : "Attack in");
  renderBanner();
}
setInterval(fightTick, 200);

function onTrackFrame(m, now = performance.now()) {
  renderDepth(m, now);
  $("debug").textContent = m
    ? `elbow ${Math.round(m.elbow)}° · body ${Math.round(m.bodyBend)}° · knee ${Math.round(m.knee)}° · ${tracker.fps} fps`
    : `no body found · ${tracker.fps} fps`;
  // standing up or sitting back (seen clearly) for a few seconds ends the set
  if (fight && fight.started && !fight.over && !rest && m && m.visible) {
    fight.leftSince = m.horizontal ? 0 : fight.leftSince || performance.now();
  }
  renderBanner();
}

function noRep(reasons, spoken = reasons[0], ms = 1800) {
  sfx.norep();
  say(spoken);
  flash("No rep: " + reasons.join(" · "), "bad", ms);
}

function onRepEvent(ev) {
  if (rest || !fight || fight.over) return;
  if (ev.type === "depth") { sfx.depth(); return; }
  if (ev.type === "rep") {
    const need = slowSecs(fight.m);
    // slow monsters: tell the player how long the way down took, so they know how much slower to go
    if (need && ev.downSecs != null && ev.downSecs < need) {
      noRep([`Too fast: ${ev.downSecs.toFixed(1)} s down, need ${need} s`], `Too fast. ${ev.downSecs} seconds.`, 2600);
      return;
    }
    hit(need ? ev.downSecs : null);
  } else if (ev.type === "norep") {
    // before the first counted rep, moves that never reached the bottom are just getting into
    // position (dropping to the knees, shifting the hands), so they don't buzz
    if (!fight.started && ev.depth === false) return;
    noRep(ev.reasons);
  }
}

// downSecs: how long the way down took, shown on slow monsters
function hit(downSecs = null) {
  const f = fight;
  // the mine run vanished (changed in another window): stop cleanly instead of crashing
  if (f.where === "dungeon" && !state.run) { syncLost(); return; }
  if (!f.started) {
    f.started = true;
    resetFleeBtn();
  }
  f.reps++;
  f.roundReps++;
  f.maxSet = Math.max(f.maxSet, f.roundReps);
  f.lastRepAt = performance.now();
  lastBeep = 0;
  markFight();
  sfx.hit();
  replay($("fMonster"), "hit");
  replay($("fHits"), "bump");
  if (f.openEnded || f.overkill) {
    renderFightHud();
    say(String(f.reps));
    flash(f.overkill ? `New record: ${f.reps}!` : `${f.reps}!`, "good", 900);
    return;
  }
  f.hpLeft--;
  f.roundLeft--;
  renderFightHud();
  if (f.hpLeft <= 0) {
    if (f.where === "champion") {
      f.overkill = true;
      markFight(); // from here on, leaving keeps the record instead of losing
      renderFightHud();
      resetFleeBtn();
      sfx.win();
      say("Champion down! Keep going!");
      flash("Champion down! Keep going for a bigger record", "good", 2200);
      return;
    }
    win();
    return;
  }
  if (f.roundLeft <= 0) { roundBreak(); return; }
  say(String(f.reps));
  const took = downSecs != null ? ` ${downSecs.toFixed(1)} s down ·` : "";
  flash(f.rounds.length > 1 ? `Hit!${took} ${f.roundLeft} left this round` : `Hit!${took} ${f.hpLeft} HP left`, "good", downSecs != null ? 1600 : 1000);
}

function recordFight(f, won) {
  const s = state.stats;
  s.pushups += f.reps;
  s.fights++;
  s.bestSet = Math.max(s.bestSet, f.maxSet);
  if (won) {
    s.wins++;
    s.biggestKill = Math.max(s.biggestKill, f.where === "champion" ? f.reps : f.m.hp);
    state.kills[f.m.id] = (state.kills[f.m.id] || 0) + 1;
  } else {
    state.losses[f.m.id] = (state.losses[f.m.id] || 0) + 1;
  }
  state.history.unshift({
    t: now(), id: f.m.id, name: f.m.name, hp: f.m.hp, reps: f.reps, won,
    where: f.where === "dungeon" ? `Mine floor ${state.run ? state.run.floor : "?"}` : f.label,
  });
  state.history.length = Math.min(state.history.length, 40);
}

function levelUpLine(before, lines) {
  const after = levelFromXp(state.xp);
  if (after > before) {
    const newTitle = titleFor(after) !== titleFor(before);
    const top = after >= MAX_LEVEL ? " Max level reached!" : newTitle ? " New title!" : "";
    lines.push(`<span class="levelup">Level up! You are level ${after}: ${esc(titleFor(after))}.${top}</span>`);
    sfx.levelUp();
  }
}

function win() {
  const f = fight;
  f.over = true;
  state.fightMark = null;
  updateThreat(null);
  const levelBefore = levelFromXp(state.xp);
  const prevBest = state.stats.bestSet;
  const gain = f.where === "champion" ? f.reps * RULES.championXpPerRep : rewardFor(f.m, f.where);
  state.xp += gain;
  recordFight(f, true);
  const lines = [`+${gain} XP for ${f.m.name.startsWith("The ") ? "" : "the "}${esc(f.m.name)}.`];
  if (f.maxSet > prevBest) lines.push(`New best set: ${plural(f.maxSet, "pushup")}!`);
  sfx.win();

  if (f.where !== "dungeon") {
    if (f.where === "world") {
      const { zi } = findMonster(f.m.id);
      if (f.m.boss && zi + 1 === state.unlockedZones && zi + 1 < ZONES.length) {
        state.unlockedZones++;
        lines.push(`New area open: ${esc(ZONES[zi + 1].name)}.`);
      }
    }
    if (f.where === "wander") { state.wandererDone = f.m.key; lines.push("It wanders off. Another one may come tomorrow."); }
    if (f.where === "champion") lines.push(`The next Champion will have ${state.stats.bestSet + 1} HP.`);
    levelUpLine(levelBefore, lines);
    const ok = save();
    if (!ok) lines.push(NOT_SAVED);
    say(f.where === "champion" ? `New record. ${f.reps}!` : `${f.m.name} defeated!`);
    endFight("map");
    resultModal({ tone: "won", eyebrow: "Victory", title: `${f.m.name} defeated`, lines,
      buttons: (ok ? "" : BACKUP_NOW_BTN) + `<button type="button"${ok ? ' class="primary"' : ""} data-action="closeModal">Back to the map</button>` });
    return;
  }

  const run = state.run;
  run.room++;
  const rooms = DUNGEON.floors[run.floor - 1];
  if (run.room < rooms.length) {
    levelUpLine(levelBefore, lines);
    save();
    say(`${f.m.name} defeated! Rest.`);
    mineBreak(RULES.restBetweenRoomsSec, `Room ${run.room} cleared`, lines);
    return;
  }

  // last room done: safe room
  const cleared = run.floor;
  const bonus = RULES.floorBonusXp * cleared;
  state.xp += bonus;
  state.stats.deepestFloor = Math.max(state.stats.deepestFloor, cleared);
  state.dungeonFloor = cleared + 1;
  state.run = null;
  const safeAt = lines.length;
  levelUpLine(levelBefore, lines);
  // only say the floor is saved when it really is; the progress stays in this session either way
  const ok = save();
  lines.splice(safeAt, 0, ok
    ? `Safe room reached! Floor ${cleared} is saved. +${bonus} XP.`
    : `Safe room reached! Floor ${cleared} cleared, +${bonus} XP.`);
  if (!ok) lines.push(NOT_SAVED);
  say("Safe room reached!");
  endFight("dungeon");
  const more = state.dungeonFloor <= DUNGEON.floors.length;
  resultModal({ tone: "won", eyebrow: "Victory", title: `Floor ${cleared} cleared`, lines,
    buttons: (ok ? "" : BACKUP_NOW_BTN)
      + (more ? `<button type="button"${ok ? ' class="primary"' : ""} data-action="deeper">Go deeper: floor ${state.dungeonFloor}</button>` : "")
      + `<button type="button"${more || !ok ? "" : ' class="primary"'} data-action="closeModal">Leave the mine</button>` });
}

function lose(reason) {
  const f = fight;
  const where = f ? f.where : "dungeon";
  const prevBest = state.stats.bestSet;
  state.fightMark = null;
  let prev = null;
  if (f) {
    prev = state.history.find(h => h.id === f.m.id || (!h.id && h.name === f.m.name));
    f.over = true;
    recordFight(f, false);
  }
  if (where === "wander") state.wandererDone = f.m.key;
  rest = null;
  updateThreat(null);
  const t = now();
  state.restUntil = t + RULES.restHoursAfterLoss * 3600e3;

  const lines = [esc(reason)];
  if (f) {
    lines.push(f.rounds.length > 1
      ? `You did ${f.reps} of ${f.total} (round ${f.round + 1} of ${f.rounds.length}).`
      : `You did ${f.reps} of ${f.total}.`);
    if (f.maxSet > prevBest) lines.push(`New best set: ${f.maxSet}! You got stronger, even in a loss.`);
    else if (prev && f.reps > prev.reps) lines.push(`That's ${f.reps - prev.reps} more than your last try against it.`);
    else if (f.total - f.reps <= 3) lines.push(`Only ${f.total - f.reps} short. Next time.`);
    if (where === "champion") lines.push(`Your record stays at ${state.stats.bestSet}.`);
  }
  if (where === "dungeon") {
    state.dungeonLockedUntil = t + RULES.dungeonLockDays * 86400e3;
    lines.push(`${DUNGEON.name} is closed for ${RULES.dungeonLockDays} days, until ${fmtAt(state.dungeonLockedUntil)}. Then you start floor ${state.dungeonFloor} again.`);
    state.run = null;
  }
  lines.push(`Your muscles need rest. Fights open again in ${RULES.restHoursAfterLoss} hours (${fmtAt(state.restUntil)}).`);
  save();
  sfx.lose();
  say("Time to recover.");
  endFight(where === "dungeon" ? "dungeon" : "map");
  resultModal({ tone: "lost", eyebrow: "Recovering", title: f ? `${f.m.name} won this time` : "You left the mine", lines,
    buttons: `<button type="button" class="primary" data-action="goto" data-to="camp">Back to camp</button>` });
}

function finishTest() {
  const f = fight;
  f.over = true;
  state.fightMark = null;
  updateThreat(null);
  const reps = f.reps;
  if (!reps) {
    endFight("map");
    resultModal({ tone: "info", eyebrow: "Strength test", title: "No reps counted",
      lines: ["No strict pushup was counted. Check that the camera sees your whole body from the side, then try again."],
      buttons: `<button type="button" class="primary" data-action="closeModal">OK</button>` });
    return;
  }
  const levelBefore = levelFromXp(state.xp);
  const s = state.stats;
  s.pushups += reps;
  s.bestSet = Math.max(s.bestSet, reps);
  state.tested = true;
  state.testResult = reps;
  state.xp += reps;
  const zi = startZoneFor(reps);
  state.unlockedZones = Math.max(state.unlockedZones, zi + 1);
  state.history.unshift({ t: now(), id: "test", name: "Strength test", hp: 0, reps, won: true, where: "Strength test" });
  state.history.length = Math.min(state.history.length, 40);
  const z = ZONES[zi], hps = z.monsters.map(m => m.hp);
  const lines = [
    `You did <b>${reps} strict pushup${reps === 1 ? "" : "s"}</b> in one set. +${reps} XP.`,
    `Your starting area: <b>${esc(z.name)}</b> (${Math.min(...hps)}–${Math.max(...hps)} HP).`,
    zi > 0 ? "The areas before it stay open for warm-ups and easy XP." : "Beat the monsters here, then the boss, to open the next area.",
    `The Champion on the map now has your best set + 1: ${s.bestSet + 1} HP.`,
  ];
  levelUpLine(levelBefore, lines);
  save();
  sfx.win();
  say(`${plural(reps, "pushup")}. Well done.`);
  endFight("map");
  resultModal({ tone: "won", eyebrow: "Strength test", title: `${reps} pushup${reps === 1 ? "" : "s"}`, lines,
    buttons: `<button type="button" class="primary" data-action="closeModal">See the map</button>` });
}

function endFight(screen) {
  fight = null;
  rest = null;
  if (state.fightMark) { state.fightMark = null; save(); }
  stopBeat(); // a clean end frees the other windows right away
  tracker.stop();
  $("restPanel").hidden = true;
  show(screen);
}

function resultModal({ tone, eyebrow, title, lines, buttons }) {
  openModal(`
    <div class="result ${tone}">
      <p class="eyebrow">${esc(eyebrow)}</p>
      <h2 class="big">${esc(title)}</h2>
    </div>
    <ul class="lines">${lines.map(l => `<li>${l}</li>`).join("")}</ul>
    <div class="row">${buttons}</div>`);
}

// ----- breaks: between rounds, or between mine rooms -----

function startRest(o) {
  rest = { endsAt: performance.now() + o.sec * 1000, beeped: 0, onDone: o.onDone, quitReason: o.quitReason };
  beat(); // a break counts as busy too: no other window may take over the run
  $("restTitle").textContent = o.title;
  $("restNext").innerHTML = o.next;
  $("restWarn").textContent = o.warn;
  const q = $("btnQuitRun");
  disarm(q);
  q.textContent = o.quitLabel;
  $("restPanel").hidden = false;
  $("banner").hidden = true;
  $("btnFlee").hidden = true;
  updateThreat(null);
  restTick(performance.now());
}
function restTick(t) {
  const left = rest.endsAt - t;
  $("restTime").textContent = fmtClock(left);
  const secs = Math.ceil(left / 1000);
  if (left > 0 && secs <= 3 && secs !== rest.beeped) { rest.beeped = secs; sfx.tick(); }
  if (left <= 0) endRest();
}
function endRest() {
  if (!rest) return;
  const { onDone, endsAt } = rest;
  rest = null;
  onDone();
  // a break that ran out while you were away: the start timer counts from the end of the break
  if (fight && fight.timedStart && !fight.started) fight.waitSince = Math.min(fight.waitSince, endsAt);
}

function roundBreak() {
  const f = fight;
  f.round++;
  f.roundLeft = f.rounds[f.round];
  sfx.win();
  say(`Round ${f.round} done. Rest.`);
  renderFightHud();
  startRest({
    sec: RULES.roundRestSec,
    title: `Round ${f.round} of ${f.rounds.length} done`,
    next: `Next: round ${f.round + 1}, <b>${f.roundLeft} pushups</b>. ${f.hpLeft} HP left in total.`,
    quitLabel: "Give up",
    quitReason: "You gave up between rounds.",
    warn: "Giving up counts as a loss. Leaving the app longer than the break does too.",
    onDone: resumeRound,
  });
}
function resumeRound() {
  const f = fight;
  const t = performance.now();
  Object.assign(f, { started: false, timedStart: true, waitSince: t, lastRepAt: t, leftSince: 0, roundReps: 0 });
  markFight();
  tracker.counter.reset();
  resetDepthMeter();
  showFightHud();
  renderFightHud();
  renderBanner();
  say(`Round ${f.round + 1}. Get into plank.`);
}

function mineBreak(sec, title, lines) {
  fight = null;
  const run = state.run;
  // remembered in the save: closing the game can't stretch a break (see settleLeftFight)
  run.breakEndsAt = now() + sec * 1000;
  save();
  const rooms = DUNGEON.floors[run.floor - 1];
  const next = rooms[run.room];
  startRest({
    sec,
    title,
    next: `${lines.length ? lines.join("<br>") + "<br>" : ""}Next: <b>${esc(next.name)}</b>, ${next.hp} HP (room ${run.room + 1} of ${rooms.length})${next.slow ? `<br><span class="chip slow">Slow reps · ${slowSecs(next)} s down</span>` : ""}`,
    quitLabel: "Leave the mine",
    quitReason: "You left the mine before the safe room.",
    warn: `Leaving now closes the mine for ${RULES.dungeonLockDays} days. Leaving the app longer than the break does too.`,
    onDone: () => beginFight(next, "dungeon", true, DUNGEON.name),
  });
  // show the next monster in the HUD during the break
  $("fHits").textContent = "0";
  $("fName").textContent = next.name;
  setFightArt(next);
  $("fHp").textContent = `${next.hp} / ${next.hp} HP`;
  $("fHpFill").style.width = "100%";
  $("fWhere").textContent = `${DUNGEON.name} · floor ${run.floor} · next room`;
}

// ----- starting fights -----

// Before any fight starts: a fight or break running in another window blocks it, and an unfinished
// fight from a closed game is settled first, so a new fight can't wipe it away.
function mayStartHere() {
  if (fight || rest) return false;
  if (blockedByOtherWindow()) return false;
  if (state.fightMark || (state.run && state.run.breakEndsAt && now() > state.run.breakEndsAt + RULES.dungeonStartSec * 1000)) {
    closeModal();
    settleLeftFight();
    return false;
  }
  return true;
}
async function startFight(id) {
  if (!mayStartHere()) return;
  const r = resolveMonster(id);
  if (!r || fight || state.run) return;
  if (r.where !== "test" && (state.restUntil > now() || bossLock(r.m, r.zone))) return;
  if (!(await openFightScreen("map"))) return;
  beginFight(r.m, r.where, false, r.label);
}
async function enterFloor() {
  if (!mayStartHere()) return;
  const t = now();
  if (fight || state.run || state.restUntil > t || state.dungeonLockedUntil > t || state.dungeonFloor > DUNGEON.floors.length) return;
  state.run = { floor: state.dungeonFloor, room: 0 };
  save();
  if (!(await openFightScreen("dungeon"))) { state.run = null; save(); renderCurrent(); return; }
  beginFight(DUNGEON.floors[state.run.floor - 1][0], "dungeon", false, DUNGEON.name);
}
async function continueRun() {
  if (!mayStartHere()) return;
  if (!state.run) return;
  if (!(await openFightScreen("dungeon"))) return;
  // back after the game was closed: only what was left of the break (a full minute if no break was on)
  const left = state.run.breakEndsAt ? Math.ceil((state.run.breakEndsAt - now()) / 1000) : 60;
  mineBreak(Math.max(5, left), "Back in the mine", []);
}

// ---------- controls ----------

document.addEventListener("click", e => {
  const b = e.target.closest("[data-action]");
  if (!b || b.disabled) return;
  const { action, to, id } = b.dataset;
  if (action === "goto") { closeModal(); show(to); }
  else if (action === "prefight") openPrefight(id);
  else if (action === "fight") startFight(id);
  else if (action === "closeModal") { closeModal(); renderCurrent(); }
  else if (action === "enterFloor") enterFloor();
  else if (action === "deeper") { closeModal(); enterFloor(); }
  else if (action === "continueRun") continueRun();
  else if (action === "backupNow") shareBackup();
});

$("btnFlee").addEventListener("click", e => {
  if (!fight || fight.over) return;
  if (canLeaveFree()) {
    // not started yet: no penalty
    const backTo = fight.where === "dungeon" ? "dungeon" : "map";
    if (fight.where === "dungeon") { state.run = null; save(); }
    endFight(backTo);
    return;
  }
  if (fight.openEnded || fight.overkill) { stopSet("You finished."); return; }
  confirmTap(e.currentTarget, "Tap again to give up", () => lose("You gave up."));
});
$("btnFightNow").addEventListener("click", endRest);
$("btnQuitRun").addEventListener("click", e => confirmTap(e.currentTarget, "Tap again to confirm", () => {
  const reason = rest ? rest.quitReason : "You gave up.";
  rest = null;
  lose(reason);
}));
$("btnSound").addEventListener("click", () => {
  state.settings.sound = !audio.on;
  applySettings();
  saveSoon();
  if (audio.on) initAudio(); else hush();
});
$("dbgRep").addEventListener("click", () => { if (fight && !fight.over && !rest) hit(); });
$("dbgNoRep").addEventListener("click", () => onRepEvent({ type: "norep", reasons: ["Go lower"] }));

// Leaving the app doesn't pause anything: the clock keeps running while you're away.
// A quick look at a notification is fine, but leaving a fight that has started counts as giving up,
// otherwise you could rest in another app (or close the game) to dodge a loss.
document.addEventListener("visibilitychange", () => {
  const t = performance.now();
  if (document.hidden) { if (fight || rest) hiddenAt = t; return; }
  adoptIfNewer(); // another window may have saved while this one was in the background
  if (!hiddenAt) return;
  const away = t - hiddenAt;
  hiddenAt = 0;
  if (rest) {
    // a break keeps going while you're away; gone longer than the break plus the start time = you left
    if (t > rest.endsAt + RULES.dungeonStartSec * 1000) {
      rest = null;
      lose(fight ? "You were away longer than the break." : "You were away longer than the break between rooms.");
    }
    return;
  }
  if (fight && !fight.over && committed(fight) && away > RULES.leaveAppSec * 1000) {
    if (fight.overkill) stopSet("You left the app. Your record counts."); // the Champion is already down
    else lose("You left the app during the fight.");
  }
});
// a closed or reloaded page can't be stopped on a phone, but on a computer the browser can ask first
window.addEventListener("beforeunload", e => {
  if ((fight && committed(fight)) || rest) { e.preventDefault(); e.returnValue = ""; }
});

// ---------- installable app + offline ----------

const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
let installEvent = null, offlineReady = false;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvent = e; renderAppStatus(); });
window.addEventListener("appinstalled", () => { installEvent = null; renderAppStatus("Installed. Open Pushup RPG from your home screen."); });
async function askInstall() {
  if (!installEvent) return;
  const ev = installEvent;
  installEvent = null;
  ev.prompt();
  const { outcome } = await ev.userChoice.catch(() => ({}));
  renderAppStatus(outcome === "accepted" ? "Installing. Look for the Pushup RPG icon on your home screen." : null);
}
$("btnInstall").addEventListener("click", askInstall);
$("btnInstallCamp").addEventListener("click", askInstall);

function renderAppStatus(msg) {
  const canInstall = !!installEvent && !standalone();
  $("btnInstall").hidden = $("installRow").hidden = !canInstall;
  const lines = [msg || (standalone() ? "You're using the installed app."
    : canInstall ? "Install it for a home-screen icon and a full-screen game."
    : "To install: open Chrome's menu (⋮) and tap \"Install app\" or \"Add to Home screen\".")];
  lines.push(offlineReady ? "Works without internet: yes, the game is saved on this phone."
    : "Works without internet: getting ready. Keep the game open for a minute while online.");
  $("appStatus").textContent = lines.join(" ");
}

// is everything needed for a fight saved on the phone?
async function checkOffline() {
  try {
    const want = [/\/game\.js$/, /\/core\.js$/, /\.wasm$/, new RegExp(`pose_landmarker_${state.settings.model}`)];
    const urls = [];
    for (const n of (await caches.keys()).filter(n => n.startsWith("rpg-"))) urls.push(...(await (await caches.open(n)).keys()).map(r => r.url));
    return want.every(re => urls.some(u => re.test(u)));
  } catch { return false; }
}

async function makeOffline(reg) {
  // on the very first visit the offline helper starts after the page, so wait until it's in charge
  if (!navigator.serviceWorker.controller) {
    await new Promise(r => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }));
  }
  // fetch the tracking files once through the helper so it keeps a copy (instant if already saved);
  // read each one to the end, because the helper saves it only after the whole file has arrived
  for (const u of await trackingFiles(state.settings.model).catch(() => [])) await fetch(u).then(r => r.arrayBuffer()).catch(() => {});
  for (let i = 0; i < 10 && !(offlineReady = await checkOffline()); i++) await new Promise(r => setTimeout(r, 2000));
  renderAppStatus();
  // then all monster pictures, so the map has them offline too
  const urls = [...ART].flatMap(id => [artUrl(id, true), artUrl(id)]).map(u => new URL(u, location.href).href);
  (reg.active || navigator.serviceWorker.controller)?.postMessage({ type: "warm", urls });
}

if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("sw.js")
    .then(() => navigator.serviceWorker.ready)
    .then(reg => setTimeout(() => makeOffline(reg).catch(() => {}), 4000))
    .catch(err => console.warn("Offline helper failed", err));
}

// ---------- start ----------

applySettings();
renderAppStatus();
show("camp");
settleLeftFight();
saveIfMigrated();
syncFromPc();
// load body tracking early so the first fight starts fast
setTimeout(() => tracker.ensureModel(state.settings.model).catch(() => {}), 1500);

if (DEBUG) {
  window.PushupRPG = {
    get state() { return state; },
    get fight() { return fight; },
    get rest() { return rest; },
    timeTravel(hours) { timeOffset += hours * 3600e3; renderCurrent(); },
    skipRest() { if (rest) rest.endsAt = performance.now(); },
    repEvent: ev => onRepEvent(ev),
    // feed one body measurement through the real rep counter and the HUD, like a camera frame would
    frame: (m, t) => { tracker.counter.update(m, t).forEach(onRepEvent); onTrackFrame(m, t); },
    get counter() { return tracker.counter; },
    wanderer: () => todaysWanderer(),
  };
}
