import { createTracker, initAudio, quietAudio, sfx, say, hush, audio, trackingFiles, downSecsOf, canKeepAwake, testHooks } from "./core.js";
import { ART, RULES, ZONES, DUNGEON, WANDERERS, MAX_LEVEL, xpForLevel, levelFromXp, titleFor, xpReward, findMonster, startZoneFor, wanderHpEver, slowSecs, pauseSecs, artUrl, RUCK_FEATS, ruckGrade, bestRuckRank, ruckTestText, RUCK_TEST, RUCK_TESTS, RANKS, SYSTEM_LATER, HEART, systemStatus, systemChanges } from "./data.js";
import { parseGpx, summarizeTrack, looksLikeCar, ruckProblem, ruckEntry, effortOf, ruckXp } from "./ruck.js";

const DEBUG = new URLSearchParams(location.search).has("debug");
const SAVE_KEY = "pushupRPG.save.v1";
const SCREENS = ["camp", "status", "map", "dungeon", "ruck", "records", "settings", "fight"];
const TESTED_STRICTNESS = { depth: 63, top: 160, bend: 20, knee: 135 };
// bump when TESTED_STRICTNESS changes: old saves then get the new strictness once
const STRICT_V = 3;
// ruckKg: your pack weight for rucks; bodyKg: your body weight (null = not given), for a ruck's rank.
// They are settings, so Reset all progress keeps them
const DEFAULT_SETTINGS = { ...TESTED_STRICTNESS, strictV: STRICT_V, voice: true, sound: true, camera: "user", model: "full", ruckKg: 15, bodyKg: null };
// the strictness sliders' ranges (index.html); a save with values outside them gets the tested ones
const SETTING_RANGES = { depth: [40, 120], top: [140, 178], bend: [8, 40], knee: [120, 175] };

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`; // "1 hit", "2 hits"
const the = name => (name.startsWith("The ") ? name : "the " + name); // "the Old Badger", but "The Burnt King"
let timeOffset = 0; // debug only: pretend time has passed
const now = () => Date.now() + timeOffset;

// ---------- save ----------

// Rucking (ruck.js): all-time totals (km and kg·km may have decimals), records, and the last RULES.ruckLogMax
// rucks, newest first. Only each ruck's summary is kept, never its map points. ruck.xp: the part of state.xp
// that came from rucks (the backup check needs it). best.rank: your best ruck rank ever (0 = F ... 6 = S),
// kept because old rucks fall out of the log.
const freshRuck = () => ({ count: 0, km: 0, kgkm: 0, xp: 0, mins: 0, climb: 0, best: { km: 0, kgkm: 0, kg: 0, rank: 0 }, log: [] });
function freshState(settings = DEFAULT_SETTINGS) {
  return {
    v: 1, rev: 0, savedAt: 0,
    xp: 0, restUntil: 0, dungeonLockedUntil: 0, dungeonFloor: 1, run: null, unlockedZones: 1,
    tested: false, testResult: 0, wandererDone: "",
    wanderToday: null, // { key, hp }: today's wandering monster keeps the HP it had when first seen
    lastBackupAt: 0, backupFights: 0, // when the last backup was made, and stats.fights at that time
    backupRucks: 0, // ruck.count at that time
    fightMark: null, // a fight that has started (see markFight), so closing the game still counts it
    kills: {}, losses: {}, history: [],
    stats: { pushups: 0, fights: 0, wins: 0, bestSet: 0, biggestKill: 0, deepestFloor: 0 },
    ruck: freshRuck(),
    settings: { ...settings },
  };
}
let needsSave = false;
const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
function normalize(s) {
  const f = freshState();
  const out = { ...f, ...s, stats: { ...f.stats, ...(s.stats || {}) }, settings: { ...f.settings, ...(s.settings || {}) } };
  // the ruck part is merged field by field, so a save with only some of it (a PC copy, another window) still works
  const r = isObj(s.ruck) ? s.ruck : {};
  out.ruck = { ...f.ruck, ...r, best: { ...f.ruck.best, ...(isObj(r.best) ? r.best : {}) }, log: Array.isArray(r.log) ? r.log : [] };
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
  const render = { camp: renderCamp, status: renderStatus, map: renderMap, dungeon: renderDungeon, ruck: renderRuck, records: renderRecords, settings: renderSettings }[current];
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
const fmtKm = km => `${num(Math.round(km * 10) / 10)}${Number.isInteger(Math.round(km * 10) / 10) ? ".0" : ""} km`; // "7.0 km", "1,234.5 km"
const fmtDur = mins => (mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`); // "1 h 12 min"
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
// a monster's HP as shown: "17 HP", or for one fought in rounds "2 × 16" ("20 + 25" when the rounds differ)
const hpText = m => (m.rounds && m.rounds.length > 1
  ? (m.rounds.every(r => r === m.rounds[0]) ? `${m.rounds.length} × ${m.rounds[0]}` : m.rounds.join(" + "))
  : `${m.hp} HP`);
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
      : `Last backup: ${b.when}, with ${b.sinceText} since then.`} If Chrome's data gets cleared, a backup is the only way back.
      <div class="row"><button type="button" class="primary" data-action="backupNow">Back up now</button></div>`;
  }
  if (!PC_SAVE) $("syncStatus").textContent = `Progress is saved on this phone. Last backup: ${b.when}.`;
  const s = state.stats;
  $("campTiles").innerHTML = [["Pushups done", s.pushups], ["Best set", s.bestSet], ["Monsters slain", s.wins], ["Deepest floor", s.deepestFloor]].map(tile).join("");
  const R = RANKS[systemStatus(state).overall];
  $("campRank").className = `hud-rank camp-rank rank-${R.toLowerCase()}`;
  $("campRank").querySelector("b").textContent = R;
}

// ---------- status: the System's window (data.js SYSTEM; only shown, never in a fight) ----------

const rankClass = r => `rank-${RANKS[r].toLowerCase()}`;
const rankMini = r => `<span class="rank-mini ${rankClass(r)}">${RANKS[r]}</span>`;
const statText = (id, v) => (id === "road" ? fmtKm(v).replace(" km", "") : id === "carry" ? RANKS[v] : num(v)); // ROAD: "14.0"; CARRY: a rank
const signed = v => (v > 0 ? `+${v}` : `${v}`);
function renderStatus() {
  const st = systemStatus(state), { L, title } = levelInfo(), n = st.cats.length;
  const lowest = st.cats.reduce((a, c) => (c.rank < a.rank ? c : a));
  const short = (st.overall + 1) * n - st.cats.reduce((a, c) => a + c.rank, 0); // rank-ups still needed
  const hint = st.overall >= RANKS.length - 1 ? "Top rank in everything. The System has nothing left to measure… for now."
    : `To reach overall ${RANKS[st.overall + 1]}: ${plural(short, "more rank-up")} in your categories. Your weakest is ${esc(lowest.name)} (${RANKS[lowest.rank]}).`;
  $("stHead").innerHTML = `<div class="hud-head">
      <div class="hud-title"><p class="eyebrow">The System</p><h2 class="big">Level ${L} · ${esc(title)}</h2>
        <p class="fine">${st.cats.map(c => `${esc(c.name)} ${RANKS[c.rank]}`).join(" · ")}</p></div>
      <div class="hud-rank ${rankClass(st.overall)}" title="Overall rank: your categories averaged, rounded down"><span>Overall</span><b>${RANKS[st.overall]}</b></div>
    </div>
    <p class="fine">${hint}</p>`;
  $("stCats").innerHTML = st.cats.map(c => `<section class="card-block panel sys-cat" data-cat="${c.id}">
      <div class="hud-head"><h2>${esc(c.name)}</h2><div class="hud-rank small ${rankClass(c.rank)}" title="${esc(c.name)} rank: its stats averaged, rounded down"><span>Rank</span><b>${RANKS[c.rank]}</b></div></div>
      ${c.stats.map(x => `<div class="sys-stat" data-stat="${x.id}">
        <div class="sys-top"><span class="sys-name" title="${esc(x.long)}">${x.name}</span><b class="sys-val">${statText(x.id, x.value)}</b><span class="fine">${esc(x.what)}</span>${rankMini(x.rank)}</div>
        <div class="sys-bar"><div style="width:${(x.share * 100).toFixed(1)}%"></div></div>
        <p class="fine">${x.next ? `Rank ${RANKS[x.next.rank]}: ${esc(x.next.text)} · ${esc(x.next.togo)}` : "Top rank."}</p>
      </div>`).join("")}
    </section>`).join("");
  const h = st.heart;
  $("stHeart").innerHTML = `<div class="sys-top"><span class="sys-name">HEART</span><b class="sys-val">${h.locked || h.value == null ? "???" : signed(h.value)}</b><span class="fine">beats a minute, compared with your older rucks</span></div>
    <p class="fine">${h.locked
      ? `Not enough data. The System needs ${HEART.need} rucks with heart rate (from a watch's GPX file) to measure your heart. You have ${h.have}.`
      : h.value == null
      ? `No rucks alike yet. HEART only compares rucks with a similar pack (±${HEART.kg} kg), pace (±${HEART.paceSec / 60} min/km) and hills. Do a ruck like an earlier one.`
      : h.value > 0 ? `On rucks like your older ones, your heart now beats ${h.value} a minute less. You got fitter.`
      : h.value < 0 ? `On rucks like your older ones, your heart now beats ${-h.value} a minute more. Tired, hot, or a break from training?`
      : "On rucks like your older ones, your heart beats the same as before."} HEART has no rank and can go down.</p>`;
  $("stLater").innerHTML = `<div class="sys-top">${SYSTEM_LATER.map(x => `<span class="sys-name">${esc(x.toUpperCase())}</span><b class="sys-val">???</b>`).join("")}</div>
    <p class="fine">Not in the game yet. They will count in the overall rank once they are.</p>`;
}

// The System's messages after a fight or a ruck: what went up since `before` (a systemStatus() from just
// before). Adds lines to a result; returns words to say out loud for a rank up ("" = none).
function systemLines(before, lines) {
  const ch = systemChanges(before, systemStatus(state));
  const v = (x, val) => `${statText(x.id, val)}${x.id === "road" ? " km" : ""}`;
  for (const x of ch.stats) {
    // CARRY's value is a rank already
    if (x.id === "carry") { lines.push(`<span class="sys">[CARRY: best ruck rank ${RANKS[x.wasRank]} → ${RANKS[x.rank]}]</span>`); continue; }
    lines.push(`<span class="sys">[${x.name} ${v(x, x.was)} → ${v(x, x.value)}${x.rank !== x.wasRank ? ` · rank ${RANKS[x.wasRank]} → ${RANKS[x.rank]}` : ""}]</span>`);
  }
  for (const c of ch.cats) lines.push(`<span class="sys up">[Rank up! ${esc(c.name.toUpperCase())} ${RANKS[c.was]} → ${RANKS[c.rank]}]</span>`);
  if (ch.overall) lines.push(`<span class="sys up">[Overall rank ${RANKS[ch.overall.was]} → ${RANKS[ch.overall.rank]}]</span>`);
  if (ch.heart) {
    const { was, now: h } = ch.heart;
    lines.push(`<span class="sys">[${h.locked ? `HEART: ${h.have} of ${HEART.need} rucks with heart rate`
      : was.locked ? `HEART unlocked${h.value == null ? ". No rucks alike yet" : `: ${signed(h.value)}`}`
      : h.value == null ? "HEART: no rucks alike yet"
      : `HEART ${was.value == null ? "???" : signed(was.value)} → ${signed(h.value)}`}]</span>`);
  }
  return ch.overall ? ` Overall rank ${RANKS[ch.overall.rank]}!`
    : ch.cats.length ? ` ${ch.cats.map(c => `${c.name} rank ${RANKS[c.rank]}`).join(", ")}!` : "";
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
      ${open ? `<div class="mlist">${z.monsters.map(m => monsterRow(m, z)).join("")}</div>` : `<p class="fine">Locked. Beat ${esc(the(prevBoss.name))} to open it.</p>`}
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
    rules.push(`The timer starts with your first strict rep. Then ${pauseSecs(m)} s without one, or standing up, and the monster wins.`);
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
    // a break that was on when the game was closed keeps its own end (continueRun): say what comes next
    const late = run.breakEndsAt + RULES.dungeonStartSec * 1000;
    const next = !run.breakEndsAt ? "You get a short break first."
      : run.breakEndsAt > t ? `The rest of your break comes first: ${until(run.breakEndsAt)}.`
      : late > t ? `Your break is over: continue within ${until(late)} and the next room starts right away.`
      : "You were away longer than the break, so the run counts as left.";
    status = run.replay
      ? `<span class="chip warn">Replay not finished</span> You are replaying floor ${run.floor}, room ${run.room + 1}. ${next}`
      : `<span class="chip warn">Run not finished</span> You are on floor ${run.floor}, room ${run.room + 1}. ${next}`;
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
  // rooms already beaten: those of the run, or all of them once the whole mine is conquered (no "next" room then)
  const done = run ? run.room : F > total ? rooms.length : 0;
  const sum = rooms.reduce((a, m) => a + m.hp, 0);
  $("dgFloor").innerHTML = `
    <div class="m-row"><h2>Floor ${shown} of ${total}</h2><span class="hp-range">${sum} pushups in total</span></div>
    <ol class="rooms">
      ${rooms.map((m, i) => `<li class="${i < done ? "done" : i === done ? "next" : ""}"><span class="beast">${thumb(m.id)}<span>Room ${i + 1}: <b>${esc(m.name)}</b> ${chips(m)}</span></span><span class="mhp">${hpText(m)}</span></li>`).join("")}
      <li class="safe"><span>Safe room</span><span>progress saved</span></li>
    </ol>
    ${button ? `<div class="row">${button}</div>` : ""}`;
  $("dgRules").innerHTML = `
    <li>Fight ${rooms.length} rooms in a row. Each monster is one set, except big ones in rounds (from floor 6): several sets with ${RULES.roundRestSec} seconds of rest between them.</li>
    <li>You get ${RULES.restBetweenRoomsSec} seconds of rest between rooms. Then do your first rep within ${RULES.dungeonStartSec} seconds.</li>
    <li>Reach the safe room to save the floor and get +${RULES.floorBonusXp} XP times the floor number.</li>
    <li>Lose or leave before the safe room: the mine closes for ${RULES.dungeonLockDays} days and you recover ${RULES.restHoursAfterLoss} hours.</li>
    <li>Floors you cleared can be played again (tap one below): 1 XP per rep, no floor bonus. Losing a replay means only the ${RULES.restHoursAfterLoss}-hour rest; the mine stays open.</li>
    <li><b>Stay in the game during the run.</b> Leaving the app for more than ${RULES.leaveAppSec} seconds in a room, or longer than a break, counts as leaving the mine.</li>`;
  const here = run ? run.floor : F;
  // a cleared floor can be replayed when a fresh run could start: the mine open, the rest over, no run going
  const canReplay = !run && state.dungeonLockedUntil <= t && state.restUntil <= t;
  $("dgLadder").innerHTML = DUNGEON.floors.map((_, i) => {
    const f = i + 1;
    if (f < F && canReplay) return `<button type="button" class="done" data-action="replayFloor" data-floor="${f}" title="Play floor ${f} again">${f}</button>`;
    // "here" also marks a cleared floor that is being replayed
    return `<span class="${[f < F ? "done" : "", f === here ? "here" : ""].filter(Boolean).join(" ")}" title="Floor ${f}">${f}</span>`;
  }).join("");
}

function renderRecords() {
  const s = state.stats, { L } = levelInfo();
  $("recTiles").innerHTML = [
    ["Level", L], ["Pushups done", s.pushups], ["Best set", s.bestSet], ["Strength test", state.tested ? state.testResult : "–"],
    ["Biggest kill", s.biggestKill ? `${s.biggestKill} HP` : "–"], ["Fights won", `${s.wins} / ${s.fights}`], ["Deepest floor", s.deepestFloor],
    ["Km rucked", fmtKm(state.ruck.km).replace(" km", "")], ["Load carried", `${num(Math.round(state.ruck.kgkm))} kg·km`],
    ["Longest ruck", state.ruck.best.km ? fmtKm(state.ruck.best.km) : "–"],
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

// ---------- rucking ----------
// Walk with a heavy pack, record it on your watch, then open its GPX file here (or type the ruck in by hand).
// Effort = pack kg × km (kg·km) gives XP for your level. Reading files and the rules: ruck.js; numbers: RULES.

function renderRuck() {
  const r = state.ruck;
  // the pack weight box isn't overwritten while you type in it
  if (document.activeElement !== $("ruckKg")) $("ruckKg").value = state.settings.ruckKg;
  if (document.activeElement !== $("ruckBody")) $("ruckBody").value = state.settings.bodyKg ?? "";
  const ex = effortOf(15, 6);
  $("ruckIntro").textContent = `Pack weight × distance = effort, in kg·km. Every ${num(1 / RULES.ruckXpPerKgKm)} kg·km is 1 XP for your level: 15 kg for 6 km = ${num(ex)} kg·km = +${ruckXp(ex)} XP. Rucks never hit monsters: fights stay pushups.`;
  $("ruckTests").innerHTML = RUCK_TESTS.map(t => `<li><span class="rank-mini rank-${t.rank.toLowerCase()}">${t.rank}</span> ${esc(ruckTestText(t, state.settings.bodyKg))} <span class="fine">· ${esc(t.like)}</span></li>`).join("");
  $("ruckTiles").innerHTML = [["Rucks", num(r.count)], ["Km rucked", fmtKm(r.km).replace(" km", "")], ["Load carried", `${num(Math.round(r.kgkm))} kg·km`], ["XP from rucks", num(r.xp)]].map(tile).join("");
  const b = r.best;
  $("ruckBest").textContent = r.count ? `Your records: longest ${fmtKm(b.km)}, heaviest pack ${b.kg} kg, biggest load ${num(b.kgkm)} kg·km.` : "";
  // each ruck opens its report
  $("ruckLog").innerHTML = r.log.length
    ? r.log.map(x => `<li class="won"><button type="button" class="ruck-row" data-action="ruckReport" data-t="${esc(x.t)}">
        <span>${(g => `<span class="rank-mini rank-${g.rank.toLowerCase()}">${g.rank}</span>`)(ruckGrade(x, state.settings.bodyKg))} <b>${esc(fmtKm(x.km))}</b> × ${esc(x.kg)} kg = ${esc(num(x.kgkm))} kg·km · +${esc(x.xp)} XP</span>
        <span class="fine">${esc(fmtAt(x.t))} · ${esc(fmtDur(x.mins))}${x.climb ? ` · ${esc(x.climb)} m up` : ""}${x.hrAvg ? ` · ♥ ${esc(x.hrAvg)}` : ""} · ${x.src === "gpx" ? "GPX file" : "by hand"}</span></button></li>`).join("")
    : `<li class="fine">No rucks yet.</li>`;
}

// ----- the ruck report: a game-style status window for one ruck -----
// e: a log entry (ruck.js ruckEntry). Everything in it is a measurement; the rank and feats are worked out
// here (data.js), so they can be changed any time. Heart rate, steps, splits and the lines only show when the
// watch recorded them (a ruck typed in by hand has none; older rucks keep their numbers but not their lines).
const fmtPace = secs => { const s = Math.round(secs); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }; // "11:32"
const fmtTimeOfDay = ts => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
// notes: plain-text warnings about the file (a hole in the recording, too little heart rate), check card only
function ruckReport(e, { eyebrow = "Ruck report", tone = "", lines = [], fastKm = 0, notes = [] } = {}) {
  const g = ruckGrade(e, state.settings.bodyKg), rank = g.rank, c = e.chart || {};
  // the rank test: what this ruck did, and what the next rank still needs
  const n = g.next, miss = n ? [
    e.km < n.km ? `${num(Math.round((n.km - e.km) * 10) / 10)} km more` : "",
    g.pct < n.pct ? `a pack of ${n.pct}% (${num(Math.round((g.bw * n.pct) / 10) / 10)} kg)` : "",
    g.pace > n.pace ? `${fmtPace(n.pace)} min/km or faster` : "",
  ].filter(Boolean) : [];
  const pace = e.mins && e.km ? (e.mins * 60) / e.km : null;
  const known = (c.splits || []).filter(s => s != null), best = known.length ? Math.min(...known) : null;
  // the test pace: start to end (breaks too) over the km, plus 1 km for every RUCK_TEST.climbM up
  const upKm = Math.round(((e.climb || 0) / RUCK_TEST.climbM) * 10) / 10;
  const rows = [
    ["Rank test", `pack <b>${esc(g.pct)}%</b> of ${g.guessed ? `${RUCK_TEST.refKg} kg <small>(set your body weight on the Rucking screen)</small>` : `your ${esc(g.bw)} kg`} · test pace <b>${fmtPace(Math.min(g.pace, 5999))}</b> <small>min/km</small>`
      + `<br><small>${esc(fmtDur(g.mins))} from start to end (breaks too) for ${esc(num(e.km))} km${upKm ? ` + ${esc(num(upKm))} km for ${esc(num(e.climb))} m up` : ""}</small>`
      + `<br>${n ? `Rank ${n.rank} needs ${esc(miss.join(", "))}.` : "Top rank."}`],
    e.hrAvg ? ["Heart", `<b>${esc(e.hrAvg)}</b> avg · <b>${esc(e.hrMax || "–")}</b> max <small>bpm</small>`] : null,
    ["Climb", `<b>${esc(num(e.climb || 0))}</b> <small>m up</small>`],
    pace ? ["Pace", `<b>${fmtPace(pace)}</b> <small>min/km</small>${best ? ` · best km <b>${fmtPace(best)}</b>` : ""}`] : null,
    e.steps ? ["Steps", `about <b>${esc(num(e.steps))}</b> · ${esc(e.spm)} <small>a minute</small>`] : null,
    ["Time", `<b>${esc(fmtDur(e.mins))}</b> moving · ${esc(fmtTimeOfDay(e.t))}–${esc(fmtTimeOfDay(e.end))}`],
  ].filter(Boolean);
  const feats = RUCK_FEATS.filter(([, , test]) => test(e));
  return `<div class="hud ${tone}">
    <div class="hud-head">
      <div class="hud-title"><p class="eyebrow">${esc(eyebrow)}</p><h2 class="big">${esc(fmtKm(e.km))} with ${esc(e.kg)} kg</h2>
        <p class="fine">${esc(fmtAt(e.t))} · ${e.src === "gpx" ? "from a GPX file" : "typed in by hand"}</p></div>
      <div class="hud-rank rank-${rank.toLowerCase()}" title="Rank: the hardest march test this ruck passed (distance, pack, pace)"><span>Rank</span><b>${rank}</b></div>
    </div>
    <div class="hud-main">
      <div><span class="label">Load</span><b>${esc(e.kg)}</b><small>kg</small></div>
      <div><span class="label">Distance</span><b>${esc(e.km)}</b><small>km</small></div>
      <div><span class="label">Effort</span><b>${esc(num(e.kgkm))}</b><small>kg·km</small></div>
    </div>
    <p class="hud-xp">+${esc(e.xp)} XP</p>
    ${lines.length ? `<ul class="lines">${lines.map(l => `<li>${l}</li>`).join("")}</ul>` : ""}
    <dl class="hud-rows">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>
    ${ruckLines(c)}
    ${ruckSplits(c.splits)}
    ${feats.length ? `<div class="hud-feats"><span class="label">Feats</span>${feats.map(([n, hint]) => `<span class="chip feat" title="${esc(hint)}">${esc(n)}</span>`).join("")}</div>` : ""}
    ${fastKm >= 0.05 ? `<p class="fine">${esc(fmtKm(fastKm))} faster than ${RULES.ruckMaxKmh} km/h didn't count (a car, or a GPS jump).</p>` : ""}
    ${notes.map(n => `<p class="fine warn">${esc(n)}</p>`).join("")}
  </div>`;
}
// heart rate (line) and height (shaded) over the whole ruck, left to right in time; gaps stay gaps
function ruckLines(c) {
  const has = v => Array.isArray(v) && v.length > 1 && v.some(x => x != null);
  if (!has(c.hr) && !has(c.ele)) return "";
  const W = 320, H = 96, pad = 6;
  const range = v => { const ok = v.filter(x => x != null); return [Math.min(...ok), Math.max(...ok)]; };
  const draw = (v, area) => {
    const [lo, hi] = range(v), n = v.length, runs = [];
    let run = [];
    v.forEach((x, i) => {
      if (x == null) { if (run.length) runs.push(run); run = []; return; }
      run.push([+((i / (n - 1)) * W).toFixed(1), +(H - pad - ((x - lo) / (hi - lo || 1)) * (H - 2 * pad)).toFixed(1)]);
    });
    if (run.length) runs.push(run);
    return runs.map(r => {
      const d = r.map((p, i) => `${i ? "L" : "M"}${p[0]} ${p[1]}`).join(" ");
      return area ? `<path class="hud-area" d="${d} L${r[r.length - 1][0]} ${H} L${r[0][0]} ${H} Z"/>` : `<path class="hud-line" d="${d}"/>`;
    }).join("");
  };
  return `<figure class="hud-chart">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Heart rate and height during the ruck">${has(c.ele) ? draw(c.ele, true) : ""}${has(c.hr) ? draw(c.hr, false) : ""}</svg>
    <figcaption>${has(c.hr) ? `<span class="k-hr">Heart rate</span>` : ""}${has(c.ele) ? `<span class="k-ele">Height ${range(c.ele).join("–")} m</span>` : ""}</figcaption>
  </figure>`;
}
// one bar a km: taller is faster, the fastest km is lit; a km with a hole in the recording (null) is a low
// empty bar
function ruckSplits(sp) {
  if (!Array.isArray(sp)) return "";
  const known = sp.filter(s => s != null);
  if (known.length < 2) return "";
  const W = 320, H = 48, n = sp.length, gap = n > 25 ? 1 : 2, bw = (W - gap * (n - 1)) / n;
  const fast = Math.min(...known), slow = Math.max(...known);
  const height = s => 8 + (slow === fast ? 1 : (1 / s - 1 / slow) / (1 / fast - 1 / slow)) * (H - 8);
  return `<figure class="hud-splits">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Time for each km">${sp.map((s, i) => {
      const x = (i * (bw + gap)).toFixed(1);
      if (s == null) return `<rect x="${x}" y="${H - 4}" width="${bw.toFixed(1)}" height="4" class="none"><title>km ${i + 1}: the watch lost the GPS here</title></rect>`;
      const h = height(s);
      return `<rect x="${x}" y="${(H - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}"${s === fast ? ' class="best"' : ""}><title>km ${i + 1}: ${fmtPace(s)}</title></rect>`;
    }).join("")}</svg>
    <figcaption><span>Each km: fastest ${fmtPace(fast)}, slowest ${fmtPace(slow)}</span><span>${n} km</span></figcaption>
  </figure>`;
}
function openRuckReport(t) {
  const e = state.ruck.log.find(x => String(x.t) === String(t));
  if (!e) { renderCurrent(); return; }
  openModal(`${ruckReport(e)}<div class="row actions"><button type="button" class="primary" data-action="closeModal">OK</button>
    <button type="button" class="danger-btn" data-action="ruckDelete" data-t="${esc(e.t)}">Delete ruck</button></div>`);
}

// ----- deleting a ruck: for a mistake (a wrong pack weight, a bad file). Everything it added comes off
// again: its XP (your level can go down), km, kg·km, time and climb. Then you can log it again the right way.
function askDeleteRuck(t) {
  const e = state.ruck.log.find(x => String(x.t) === String(t));
  if (!e) { closeModal(); renderCurrent(); return; }
  const L = levelFromXp(state.xp), L2 = levelFromXp(Math.max(0, state.xp - e.xp));
  openModal(`<p class="eyebrow">Delete this ruck?</p><h2 class="big">${esc(fmtKm(e.km))} with ${esc(e.kg)} kg</h2>
    <p class="fine">${esc(fmtAt(e.t))} · ${e.src === "gpx" ? "from a GPX file" : "typed in by hand"}</p>
    <p>Its <b>${esc(num(e.xp))} XP</b>${L2 < L ? ` (level ${L} → ${L2})` : ""}, ${esc(fmtKm(e.km))} and ${esc(num(e.kgkm))} kg·km come off your totals. This can't be undone, but you can log the ruck again: open its file or type it in.</p>
    <div class="row actions"><button type="button" class="primary danger" data-action="ruckDeleteYes" data-t="${esc(e.t)}">Delete ruck</button>
      <button type="button" data-action="ruckReport" data-t="${esc(e.t)}">Keep it</button></div>`);
}
function deleteRuck(t) {
  adoptIfNewer(); // another window may have changed the log since the report opened
  const r = state.ruck, e = r.log.find(x => String(x.t) === String(t));
  closeModal();
  if (!e) { renderCurrent(); return; }
  const allInLog = r.count <= r.log.length; // no older rucks have fallen out of the log yet
  r.log = r.log.filter(x => x !== e);
  r.count = Math.max(0, r.count - 1);
  r.km = Math.max(0, Math.round((r.km - e.km) * 100) / 100);
  r.kgkm = Math.max(0, Math.round((r.kgkm - e.kgkm) * 10) / 10);
  r.mins = Math.max(0, r.mins - e.mins);
  r.climb = Math.max(0, r.climb - e.climb);
  r.xp = Math.max(0, r.xp - e.xp);
  state.xp = Math.max(0, state.xp - e.xp);
  // records: worked out again from the log when this ruck held one (or when every ruck is still in the log);
  // a record from a ruck that already fell out of the log stays
  const b = r.best, most = k => Math.max(0, ...r.log.map(x => x[k] || 0));
  for (const k of ["km", "kgkm", "kg"]) if (allInLog || e[k] >= b[k]) b[k] = most(k);
  if (allInLog || ruckGrade(e, state.settings.bodyKg).idx >= (b.rank || 0)) b.rank = bestRuckRank(r.log, state.settings.bodyKg);
  state.backupRucks = Math.min(state.backupRucks || 0, r.count);
  const ok = save();
  renderCurrent();
  ruckMsg(ok ? `Ruck deleted: ${fmtKm(e.km)} with ${e.kg} kg, ${num(e.xp)} XP taken off.`
    : "The ruck is deleted here, but saving failed (the phone's storage is full or blocked). Make a backup before you close the game.");
}
const ruckMsg = text => { $("ruckMsg").textContent = text; };
const readNumber = v => parseFloat(String(v).replace(",", ".")); // "12,5" (a phone in another language) works too

$("ruckKg").addEventListener("change", e => {
  const kg = Math.round(readNumber(e.target.value) * 10) / 10, [lo, hi] = RULES.ruckKg;
  if (!(kg >= lo && kg <= hi)) { ruckMsg(`Pack weight must be ${lo} to ${hi} kg.`); e.target.value = state.settings.ruckKg; return; }
  state.settings.ruckKg = kg;
  e.target.value = kg;
  ruckMsg("");
  if (!$("ruckHand").hidden && !/no times/.test($("ruckHandNote").textContent)) $("ruckHandNote").textContent = handNote();
  saveSoon();
});
// body weight: empty = not given (ranks then use RUCK_TEST.refKg). Each new ruck keeps the one it was done with.
$("ruckBody").addEventListener("change", e => {
  const raw = String(e.target.value).trim(), kg = Math.round(readNumber(raw) * 10) / 10, [lo, hi] = RUCK_TEST.bodyKg;
  if (raw && !(kg >= lo && kg <= hi)) { ruckMsg(`Body weight must be ${lo} to ${hi} kg.`); e.target.value = state.settings.bodyKg ?? ""; return; }
  state.settings.bodyKg = raw ? kg : null;
  e.target.value = raw ? kg : "";
  // Rucks saved without a body weight are ranked with this one now, so the best rank is worked out again:
  // one earned with the guessed RUCK_TEST.refKg must not stay. Only while every ruck is still in the log
  // (once old rucks have fallen out, their rank can't be checked again, so the best can only go up).
  const r = state.ruck;
  if (r.count <= r.log.length) r.best.rank = bestRuckRank(r.log, state.settings.bodyKg);
  ruckMsg("");
  saveSoon();
  renderRuck(); // the tests' kg follow your weight
});

// No accept=".gpx" on the file input: some phones don't know the .gpx type and would grey the file out.
// Whatever is opened is checked by what is in it.
$("ruckFile").addEventListener("change", async e => {
  const f = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!f) return;
  hideHandForm();
  // checked before reading, so a wrong (huge) file is never loaded into memory
  if (f.size > RULES.ruckFileMaxMB * 1048576) { ruckMsg(`That file is over ${RULES.ruckFileMaxMB} MB, too big to be one ruck.`); return; }
  ruckMsg("Reading the file…");
  let s;
  try { s = summarizeTrack(parseGpx(await f.text())); } catch (err) { ruckMsg(err.friendly || "That file couldn't be read."); return; }
  ruckMsg("");
  if (!s.timed) {
    showHandForm({ km: s.km, climb: s.climb, src: "gpx", note: "This file has no times in it. Fill in when you started and how long it took, then tap Check ruck." });
    return;
  }
  if (looksLikeCar(s)) {
    ruckMsg(`Most of this file is faster than ${RULES.ruckMaxKmh} km/h (${fmtKm(s.fastKm)} of it), like a car ride, so it can't count as a ruck.`);
    return;
  }
  const r = { t: s.start, end: s.end, km: s.km, mins: s.mins, climb: s.climb, kg: state.settings.ruckKg,
    hrAvg: s.hrAvg, hrMax: s.hrMax, spm: s.spm, steps: s.steps, splits: s.splits, chart: s.chart };
  // a hole in the recording: its km can be fixed on the check card, from the file's km up to the hole's time
  // at the top speed allowed
  const holeMins = s.holes.reduce((a, h) => a + h.mins, 0);
  const fix = s.holes.length ? { lo: s.km, hi: Math.round((s.km + (holeMins / 60) * RULES.ruckMaxKmh) * 100) / 100 } : null;
  pendingFile = { r, fileKm: s.km, fastKm: s.fastKm, notes: fileNotes(s), fix };
  previewRuck(r, "gpx", pendingFile);
});
// what was wrong with a file, in words for the check card (not saved)
function fileNotes(s) {
  const notes = s.holes.map(h => `Your watch recorded nothing for ${fmtDur(h.mins)} (from ${fmtTimeOfDay(s.start + h.at)}), but you walked on. The game joined that part with a straight line of ${fmtKm(h.km)}, so the distance is probably a little short. If your watch app shows a longer distance, type it below.`);
  if (s.hrOnlyMins != null) notes.push(`Heart rate was recorded for only ${fmtDur(s.hrOnlyMins)} of ${fmtDur(s.mins)} moving: too little for this ruck's heart rate, so it is left out.`);
  if (s.cadOnlyMins != null) notes.push(`Steps were recorded for only ${fmtDur(s.cadOnlyMins)} of ${fmtDur(s.mins)} moving: too little to count them, so they are left out.`);
  return notes;
}
// "Use this km" on the check card of a file with a hole
let pendingFile = null; // the file being checked: { r, fileKm, fastKm, notes, fix }
function fixRuckKm() {
  const f = pendingFile;
  if (!f || !f.fix || !$("ruckFixKm")) return;
  const km = Math.round(readNumber($("ruckFixKm").value) * 100) / 100;
  if (!(km >= f.fix.lo && km <= f.fix.hi)) {
    $("ruckFixMsg").textContent = `The distance must be ${num(f.fix.lo)} to ${num(f.fix.hi)} km: at least what the file shows, and at most the missing part at ${RULES.ruckMaxKmh} km/h.`;
    return;
  }
  f.r = { ...f.r, km };
  previewRuck(f.r, "gpx", f);
}

// "Enter by hand", also used for a GPX file with no times (its km and climb are filled in already)
let handSrc = "hand", handFileKm = null;
const handNote = () => `Pack weight: ${state.settings.ruckKg} kg (change it above).`;
function showHandForm({ km = null, climb = null, src = "hand", note = "" } = {}) {
  handSrc = src;
  handFileKm = src === "gpx" ? km : null;
  const d = new Date(now()), p = n => String(n).padStart(2, "0");
  $("rhDate").value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  $("rhStart").value = "";
  $("rhKm").value = km == null ? "" : String(km);
  $("rhClimb").value = climb == null ? "" : String(climb);
  $("rhH").value = $("rhMin").value = "";
  $("ruckHandNote").textContent = note || handNote();
  $("ruckHand").hidden = false;
  ruckMsg("");
}
function hideHandForm() { $("ruckHand").hidden = true; }
$("btnRuckHand").addEventListener("click", () => showHandForm());
$("btnRuckHandCancel").addEventListener("click", () => { hideHandForm(); ruckMsg(""); });
$("ruckHand").addEventListener("submit", e => {
  e.preventDefault();
  const date = $("rhDate").value, start = $("rhStart").value;
  const t = date && start ? new Date(`${date}T${start}`).getTime() : NaN; // local time
  if (!Number.isFinite(t)) { ruckMsg("Fill in the date and the time you started."); return; }
  const km = readNumber($("rhKm").value), climb = readNumber($("rhClimb").value);
  const mins = Math.round((readNumber($("rhH").value) || 0) * 60 + (readNumber($("rhMin").value) || 0));
  // km from a file stays "from a GPX file" unless it was changed
  const src = handSrc === "gpx" && km === handFileKm ? "gpx" : "hand";
  pendingFile = null;
  previewRuck({ t, end: t + mins * 60000, km, mins, climb, kg: state.settings.ruckKg }, src);
});

// the check card before a ruck is saved. fastKm: the part of a file that was too fast and didn't count;
// notes: what was wrong with the file; fix: { lo, hi } when its km can be fixed here (a hole in the recording)
let pendingRuck = null;
function previewRuck(r, src, { fastKm = 0, notes = [], fix = null, fileKm = null } = {}) {
  adoptIfNewer(); // another window may have logged rucks: check against those too
  const problem = ruckProblem(r, state.ruck.log, now());
  pendingRuck = null;
  if (problem) { closeModal(); ruckMsg(problem); return; }
  const e = ruckEntry({ ...r, bw: state.settings.bodyKg }, src); // the ruck keeps the body weight it was done with
  pendingRuck = e;
  ruckMsg("");
  const fixed = fix && fileKm != null && e.km !== fileKm ? [`Distance fixed by you: ${num(e.km)} km (the file read ${num(fileKm)} km).`] : [];
  openModal(`${ruckReport(e, { eyebrow: "Check your ruck", fastKm, notes: [...notes, ...fixed] })}
    ${fix ? `<div class="ruck-fix"><label for="ruckFixKm">Distance (km)</label><input type="number" id="ruckFixKm" min="${fix.lo}" max="${fix.hi}" step="0.01" inputmode="decimal" value="${esc(e.km)}"><button type="button" data-action="ruckFixKm">Use this km</button></div>
    <p class="fine warn" id="ruckFixMsg" role="status"></p>` : ""}
    <p class="fine">${esc(e.kg)} kg × ${esc(e.km)} km = ${esc(num(e.kgkm))} kg·km. Wrong pack or body weight? Tap Back, change it on the Rucking screen, and check the ruck again.</p>
    <div class="row actions"><button type="button" class="primary" data-action="saveRuck">Save ruck</button><button type="button" data-action="closeModal">Back</button></div>`);
}
function saveRuck() {
  const e = pendingRuck;
  pendingRuck = null;
  pendingFile = null;
  closeModal();
  if (!e) return;
  adoptIfNewer(); // checked again: another window may have logged the same ruck since the check card opened
  const problem = ruckProblem(e, state.ruck.log, now());
  if (problem) { ruckMsg(problem); renderCurrent(); return; }
  const r = state.ruck, prev = { ...r.best }, levelBefore = levelFromXp(state.xp), sysBefore = systemStatus(state);
  // only the newest rucks keep their lines and splits (the save, and so a backup, stays small)
  r.log = [...r.log, e].sort((a, b) => b.t - a.t).slice(0, RULES.ruckLogMax)
    .map((x, i) => { if (i < RULES.ruckChartsKept || !x.chart) return x; const { chart, ...rest } = x; return rest; });
  r.count++;
  r.km = Math.round((r.km + e.km) * 100) / 100;
  r.kgkm = Math.round((r.kgkm + e.kgkm) * 10) / 10;
  r.mins += e.mins;
  r.climb += e.climb;
  r.xp += e.xp;
  r.best = { km: Math.max(prev.km, e.km), kgkm: Math.max(prev.kgkm, e.kgkm), kg: Math.max(prev.kg, e.kg),
    rank: Math.max(prev.rank || 0, ...r.log.map(x => ruckGrade(x, state.settings.bodyKg).idx)) };
  state.xp += e.xp;
  const lines = [];
  if (prev.km && e.km > prev.km) lines.push(`New longest ruck: ${esc(fmtKm(e.km))}!`);
  if (prev.kgkm && e.kgkm > prev.kgkm) lines.push(`New biggest load: ${esc(num(e.kgkm))} kg·km!`);
  if (prev.kg && e.kg > prev.kg) lines.push(`New heaviest pack: ${esc(e.kg)} kg!`);
  lines.push(`All your rucks: ${esc(fmtKm(r.km))}, ${esc(num(Math.round(r.kgkm)))} kg·km carried.`);
  applySettings();
  initAudio(); // the Save tap wakes the sound, like a fight start does
  sfx.win();
  const sysSay = systemLines(sysBefore, lines);
  levelUpLine(levelBefore, lines);
  if (sysSay) say(sysSay.trim());
  quietAudio(1500);
  const ok = save();
  if (!ok) lines.push(NOT_SAVED);
  hideHandForm();
  ruckMsg("");
  renderCurrent();
  // the report again, now with what the ruck did: records, level up (the lines and splits from the file
  // show here even when this ruck is too old to keep them)
  openModal(`${ruckReport(e, { eyebrow: "Ruck logged", tone: "won", lines })}
    <div class="row actions">${ok ? "" : BACKUP_NOW_BTN}<button type="button"${ok ? ' class="primary"' : ""} data-action="closeModal">OK</button></div>`);
}

const SLIDERS = [["sDepth", "oDepth", "depth"], ["sTop", "oTop", "top"], ["sBend", "oBend", "bend"], ["sKnee", "oKnee", "knee"]];
function renderSettings() {
  for (const [s, o, k] of SLIDERS) { $(s).value = state.settings[k]; $(o).textContent = state.settings[k] + "°"; }
  $("sVoice").checked = state.settings.voice;
  $("sCamera").value = state.settings.camera;
  $("sModel").value = state.settings.model;
  const b = backupInfo();
  $("backupWhen").innerHTML = `Last backup: <b>${b.when}</b>${b.days != null && b.since > 0 ? ` (${b.sinceText} since)` : ""}`;
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
  `Pushup RPG backup · level ${levelFromXp(state.xp)} · ${plural(state.stats.pushups, "pushup")}${state.ruck.count ? ` · ${fmtKm(state.ruck.km)} rucked` : ""} · ${fmtAt(now())}\n` +
  `To restore: open the game, Settings → Backup → Open backup file, or paste this whole text there.\n\n${backupCode()}\n`;

// Read a backup out of any text: a pasted code, a whole message, or a backup file.
// Returns null (no code in it) or { save, problem }, where problem says why it can't be used.
// The biggest save the game can make gives a backup of about 29,000 characters (test Item 1c), so
// anything much longer is refused before any decoding: a huge paste can't freeze the phone.
const BACKUP_MAX_CHARS = 32768, BACKUP_MAX_FILE = 65536;
function readBackup(text) {
  text = text || "";
  if (text.length > BACKUP_MAX_CHARS) return { save: null, problem: "That text is too long to be a backup. Paste only the backup code, or open the backup file." };
  const m2 =/PRPG2\.([A-Za-z0-9+/=\s]+)\.([a-z0-9]+)/.exec(text);
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
  const save = readOldCode(m1[1].replace(/\s+/g, ""));
  if (!save) return { save: null, problem: "The code is damaged. Copy the whole code and try again." };
  const bad = checkSave(save);
  return { save, problem: bad && `This backup doesn't add up: ${bad}. It may have been changed by hand.` };
}
// Words after an old code (an email signature, "sent from my phone") stick to it once spaces are
// removed. Base64 is read left to right, so decoding the whole run gives the save first and the
// stuck-on words after it as junk bytes. So: decode once, then find where the save ends (it is JSON,
// so at a "}"), trying at most 16 of them from the end. A damaged code fails after a few cheap tries.
function readOldCode(b64) {
  const eq = b64.indexOf("=");
  let body = eq < 0 ? b64 : b64.slice(0, eq); // "=" (padding) can only come right after the code
  if (body.length % 4 === 1) body = body.slice(0, -1); // one letter left over can't be base64
  let bytes;
  try { bytes = atob(body); } catch { return null; }
  if (bytes[0] !== "{") return null;
  for (let end = bytes.lastIndexOf("}"), tries = 0; end > 0 && tries < 16; end = bytes.lastIndexOf("}", end - 1), tries++) {
    try {
      const save = JSON.parse(bytes.slice(0, end + 1));
      if (save && typeof save === "object" && save.stats) return save;
    } catch {}
  }
  return null;
}
// Reading depends only on the text, so the Restore taps (and an opened file) reuse the last result
// while the box holds exactly that text. Any edit, or another file, is read fresh.
let lastRead = null;
function readBackupOnce(text) {
  if (!lastRead || lastRead.text !== text) lastRead = { text, r: readBackup(text) };
  return lastRead.r;
}

// Rules every real save follows. A backup that breaks one was changed by hand (or is broken).
// Returns what is wrong, or null when it all adds up.
const WANDER_HP_MAX = wanderHpEver; // the most a wanderer ever had (60 until the Ashlands changed to rounds)
function checkSave(s) {
  const whole = v => Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
  // the monster lists may be missing or null (cleanSave repairs them), but never an array or a plain value
  const isMap = v => v == null || (typeof v === "object" && !Array.isArray(v));
  if (!isMap(s.kills) || !isMap(s.losses)) return "its monster list is broken";
  if (!s.stats || typeof s.stats !== "object" || Array.isArray(s.stats)) return "its stats are broken";
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
  // a monster as it was at its biggest (hpBefore: its HP before it was lowered; older wins were for that many)
  const biggest = m => m.hpBefore > m.hp ? { ...m, hp: m.hpBefore } : m;
  // most reps one fight can give: the monster's HP (a lost fight gives fewer); the Champion: one set, so your best set
  const repsCap = id => id === "champion" ? best : wander(id) ? WANDER_HP_MAX : biggest(findMonster(id).m).hp;
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
    return xpReward(biggest(f.m), f.zone ? "world" : "dungeon");
  };
  // Rucks (ruck.js). The pack weight is on your honor, but the numbers must fit each other: no more kg·km
  // than the km allow with the heaviest pack, and no more ruck XP than the kg·km give (each ruck's XP is
  // rounded on its own: up to half an XP more each). Saves from before rucking have no ruck part.
  const rk = s.ruck ?? {};
  if (!isObj(rk) || (rk.best != null && !isObj(rk.best))) return "its rucks are broken";
  if (rk.log != null && !Array.isArray(rk.log)) return "its ruck list is broken";
  const amount = v => v == null || (Number.isFinite(v) && v >= 0);
  if (![rk.count ?? 0, rk.xp ?? 0].every(whole) || ![rk.km, rk.kgkm, rk.mins, rk.climb].every(amount)) return "a ruck number in it is not a normal number";
  const rucks = rk.count || 0, ruckKm = rk.km || 0, ruckKgkm = rk.kgkm || 0, ruckXpAll = rk.xp || 0;
  if ((rk.log || []).length > Math.min(rucks, RULES.ruckLogMax)) return `${num(rucks)} rucks, but ${num(rk.log.length)} in its ruck list`;
  if (ruckKm > rucks * RULES.ruckKm[1] + 0.01) return `${num(ruckKm)} km doesn't fit ${num(rucks)} rucks`;
  if (ruckKgkm > ruckKm * RULES.ruckKg[1] + 0.1 * rucks + 0.01) return `${num(ruckKgkm)} kg·km doesn't fit ${num(ruckKm)} km of rucks`;
  const ruckXpMax = Math.floor(ruckKgkm * RULES.ruckXpPerKgKm + rucks / 2 + 1e-9);
  if (ruckXpAll > ruckXpMax) return `${num(ruckXpAll)} XP from rucks, but its rucks could give at most ${num(ruckXpMax)}`;

  const deepest = st.deepestFloor || 0;
  const maxXp = test + Object.entries(kills).reduce((a, [id, k]) => a + k * xpCap(id), 0) + RULES.floorBonusXp * deepest * (deepest + 1) / 2 + ruckXpAll;
  if (s.xp > maxXp) return `${num(s.xp)} XP, but its wins and rucks could give at most ${num(maxXp)}`;

  // areas open only through the strength test and then each area's boss in turn
  // (the test may be from before the Ashlands changed to rounds, when a big result could open them)
  let canOpen = s.tested ? Math.max(startZoneFor(test), startZoneFor(test, { before: true })) + 1 : 1;
  while (canOpen < ZONES.length && kills[ZONES[canOpen - 1].monsters.find(m => m.boss).id]) canOpen++;
  const open = s.unlockedZones ?? 1;
  if (open < 1 || open > canOpen) return `${open} areas open, but only ${canOpen} could be`;

  // the mine goes floor by floor
  const floor = s.dungeonFloor ?? 1;
  if (deepest > DUNGEON.floors.length || floor < 1 || floor > deepest + 1) return `mine floor ${floor} doesn't fit ${deepest} floors cleared`;
  const tooDeep = Object.keys({ ...kills, ...losses }).map(id => findMonster(id)).find(f => f && f.floor && f.floor > floor);
  if (tooDeep) return `it beat or met a monster on mine floor ${tooDeep.floor} without reaching it`;
  // a mine run in progress is on the current floor (a replay: on a floor already cleared), in one of its rooms
  const run = s.run;
  if (run != null) {
    const onFloor = typeof run === "object" && (run.replay === true ? whole(run.floor) && run.floor >= 1 && run.floor < floor : run.floor === floor);
    const rooms = onFloor ? DUNGEON.floors[run.floor - 1] : null;
    if (!rooms || !whole(run.room) || run.room >= rooms.length) return "it has a mine run that can't exist";
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
  const count = (v, d) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);
  const out = { ...s };
  // Fields the backup check treats as empty when null or missing get real values here, so a restored
  // backup and a save that is already broken both open every screen: monster lists become {}, numbers
  // become numbers. (On startup there is no check, so bad entries are simply dropped.)
  const counts = o => {
    const m = {};
    if (o && typeof o === "object" && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) if (Number.isFinite(v) && v >= 0) m[k] = Math.floor(v);
    return m;
  };
  out.kills = counts(s.kills);
  out.losses = counts(s.losses);
  out.xp = count(s.xp, 0);
  out.testResult = count(s.testResult, 0);
  out.unlockedZones = Math.min(ZONES.length, Math.max(1, count(s.unlockedZones, 1)));
  out.dungeonFloor = Math.min(DUNGEON.floors.length + 1, Math.max(1, count(s.dungeonFloor, 1)));
  const st = s.stats && typeof s.stats === "object" && !Array.isArray(s.stats) ? s.stats : {};
  out.stats = Object.fromEntries(["pushups", "fights", "wins", "bestSet", "biggestKill", "deepestFloor"].map(k => [k, count(st[k], 0)]));
  out.history = (Array.isArray(s.history) ? s.history : []).slice(0, 40).map(h => ({
    t: numOr(h && h.t, 0), id: str(h && h.id, 40) || undefined, name: str(h && h.name, 60),
    hp: numOr(h && h.hp, 0), reps: numOr(h && h.reps, 0), won: !!(h && h.won), where: str(h && h.where, 60),
  }));
  // rucks: only numbers (km, kg and kg·km may have decimals), and each logged ruck must have its times
  const amount = v => (Number.isFinite(v) && v >= 0 ? v : 0);
  const rk = isObj(s.ruck) ? s.ruck : {}, rb = isObj(rk.best) ? rk.best : {};
  out.ruck = {
    count: count(rk.count, 0), km: amount(rk.km), kgkm: amount(rk.kgkm), xp: count(rk.xp, 0), mins: count(rk.mins, 0), climb: count(rk.climb, 0),
    best: { km: amount(rb.km), kgkm: amount(rb.kgkm), kg: amount(rb.kg), rank: Math.min(RANKS.length - 1, count(rb.rank, 0)) },
    log: (Array.isArray(rk.log) ? rk.log : []).filter(x => isObj(x) && Number.isFinite(x.t) && Number.isFinite(x.end)).slice(0, RULES.ruckLogMax)
      .map(x => {
        const e = { t: x.t, end: x.end, km: amount(x.km), kg: amount(x.kg), kgkm: amount(x.kgkm), mins: count(x.mins, 0), climb: count(x.climb, 0), xp: count(x.xp, 0), src: x.src === "gpx" ? "gpx" : "hand" };
        // the report's numbers, when the watch recorded them (whole numbers, within what a body can do)
        for (const [k, hi] of [["hrAvg", 250], ["hrMax", 250], ["spm", 300], ["steps", 1e6]]) if (Number.isFinite(x[k]) && x[k] > 0 && x[k] <= hi) e[k] = Math.round(x[k]);
        if (Number.isFinite(x.bw) && x.bw >= RUCK_TEST.bodyKg[0] && x.bw <= RUCK_TEST.bodyKg[1]) e.bw = Math.round(x.bw * 10) / 10; // body weight, for its rank
        // its lines and splits: short lists of numbers (or gaps) only
        const list = (v, n, lo, hi, gaps) => (Array.isArray(v) && v.length <= n && v.length > 0 && v.every(y => (gaps && y === null) || (Number.isFinite(y) && y >= lo && y <= hi)) ? v.map(y => (y === null ? null : Math.round(y))) : null);
        if (isObj(x.chart)) {
          // (a split is null for a km with a hole in the recording)
          const c = { hr: list(x.chart.hr, RULES.ruckChartPoints, 0, 250, true), ele: list(x.chart.ele, RULES.ruckChartPoints, -500, 9000, true), splits: list(x.chart.splits, RULES.ruckSplitsMax, 1, 36000, true) };
          if (c.hr || c.ele || c.splits) e.chart = c;
        }
        return e;
      }),
  };
  const set = { ...DEFAULT_SETTINGS, ...(s.settings && typeof s.settings === "object" ? s.settings : {}) };
  for (const [k, [lo, hi]] of Object.entries(SETTING_RANGES)) {
    if (!(Number.isFinite(set[k]) && set[k] >= lo && set[k] <= hi)) set[k] = TESTED_STRICTNESS[k];
  }
  if (!(Number.isFinite(set.ruckKg) && set.ruckKg >= RULES.ruckKg[0] && set.ruckKg <= RULES.ruckKg[1])) set.ruckKg = DEFAULT_SETTINGS.ruckKg;
  if (!(Number.isFinite(set.bodyKg) && set.bodyKg >= RUCK_TEST.bodyKg[0] && set.bodyKg <= RUCK_TEST.bodyKg[1])) set.bodyKg = null;
  if (!["user", "environment"].includes(set.camera)) set.camera = DEFAULT_SETTINGS.camera;
  if (!["full", "lite"].includes(set.model)) set.model = DEFAULT_SETTINGS.model;
  set.voice = set.voice !== false;
  set.sound = set.sound !== false;
  out.settings = set;
  for (const k of ["restUntil", "dungeonLockedUntil", "lastBackupAt", "backupFights", "backupRucks", "savedAt", "rev"]) out[k] = numOr(s[k], 0);
  out.wandererDone = str(s.wandererDone, 20);
  const w = s.wanderToday;
  out.wanderToday = w && typeof w === "object" && typeof w.key === "string" && Number.isFinite(w.hp) ? { key: w.key.slice(0, 20), hp: w.hp } : null;
  // a restored run loses its break deadline too: it belonged to the day the backup was made, and would
  // count the run as left the moment the backup is used
  if (out.run) out.run = { floor: out.run.floor, room: out.run.room, ...(keepMark && Number.isFinite(out.run.breakEndsAt) ? { breakEndsAt: out.run.breakEndsAt } : {}),
    ...(out.run.replay === true ? { replay: true } : {}) };
  if (!keepMark) out.fightMark = null;
  return out;
}

// Restoring a backup or starting over never cancels a penalty, otherwise either would undo a loss: a rest or
// mine closure that is still running stays, and a mine run that is on the line (past its first room, or in
// a break) counts as left, like "Leave the mine". Call it before the progress is replaced; the function it
// returns puts the penalties into the new progress and says what it kept ("" = nothing).
const runOnTheLine = () => !!state.run && (state.run.room > 0 || !!state.run.breakEndsAt);
function penaltiesToKeep() {
  const t = now(), run = state.run;
  let rest = state.restUntil || 0, lock = state.dungeonLockedUntil || 0;
  const leftRun = runOnTheLine();
  if (leftRun) {
    rest = Math.max(rest, t + RULES.restHoursAfterLoss * 3600e3);
    if (!run.replay) lock = Math.max(lock, t + RULES.dungeonLockDays * 86400e3);
  }
  return s => {
    const kept = (rest > t && rest > (s.restUntil || 0)) || (lock > t && lock > (s.dungeonLockedUntil || 0));
    s.restUntil = Math.max(s.restUntil || 0, rest);
    s.dungeonLockedUntil = Math.max(s.dungeonLockedUntil || 0, lock);
    return !kept ? "" : leftRun ? " Your unfinished mine run counts as left." : " The rest or mine closure you had still runs.";
  };
}

function backupInfo() {
  const fightsSince = state.stats.fights - (state.backupFights || 0);
  const rucksSince = state.ruck.count - (state.backupRucks || 0);
  const days = state.lastBackupAt ? Math.floor((now() - state.lastBackupAt) / 86400000) : null;
  const when = days == null ? "never" : days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  // nag only when there is something new to lose: never backed up, a week old, or many fights (or rucks) since
  const since = Math.max(0, fightsSince) + Math.max(0, rucksSince);
  const overdue = state.stats.fights + state.ruck.count > 0 && since > 0 && (days == null || days >= 7 || since >= 20);
  // "3 fights", "1 ruck", "3 fights and 1 ruck"
  const sinceText = [fightsSince > 0 ? plural(fightsSince, "fight") : "", rucksSince > 0 ? plural(rucksSince, "ruck") : ""].filter(Boolean).join(" and ");
  return { fightsSince, rucksSince, since, sinceText, days, when, overdue };
}
function markBackedUp(msg) {
  state.lastBackupAt = now();
  state.backupFights = state.stats.fights;
  state.backupRucks = state.ruck.count;
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
  // checked before reading, so a wrong (huge) file is never loaded into memory
  if (f.size > BACKUP_MAX_FILE) { $("backupMsg").textContent = "That file is too big to be a Pushup RPG backup."; return; }
  const text = await f.text().catch(() => "");
  const r = readBackupOnce(text);
  if (!r) { $("backupMsg").textContent = "That file has no Pushup RPG backup in it."; return; }
  if (r.problem) { $("backupMsg").textContent = r.problem; return; }
  $("restoreText").value = text;
  $("backupMsg").textContent = `Backup found: level ${levelFromXp(r.save.xp || 0)}, ${plural(r.save.stats.pushups || 0, "pushup")}. Tap Restore to use it.`;
});
let restoreArmedText = null; // the exact text the first Restore tap checked
$("btnRestore").addEventListener("click", e => {
  const btn = e.currentTarget, text = $("restoreText").value;
  // the confirm tap restores only what the first tap checked; after an edit (or another file) start over
  if (btn.dataset.armed && text !== restoreArmedText) disarm(btn);
  const r = readBackupOnce(text);
  if (!r) {
    $("backupMsg").textContent = "That doesn't look like a backup code. Copy the whole code and try again.";
    return;
  }
  if (r.problem) { $("backupMsg").textContent = r.problem; return; }
  const saved = r.save;
  if (!btn.dataset.armed) {
    restoreArmedText = text;
    $("backupMsg").textContent = `Backup found: level ${levelFromXp(saved.xp || 0)}, ${plural(saved.stats.pushups || 0, "pushup")}.`
      + (runOnTheLine() ? " Restoring it counts as leaving your unfinished mine run." : "");
  }
  confirmTap(btn, "Tap again to replace your progress", () => {
    lastRead = restoreArmedText = null;
    const rev = state.rev, keep = penaltiesToKeep();
    state = normalize(cleanSave(saved));
    needsSave = false;
    state.rev = Math.max(rev, state.rev || 0);
    const kept = keep(state);
    applySettings();
    renderSettings();
    $("restoreText").value = "";
    // the progress now equals the backup it came from, so it counts as backed up
    markBackedUp(`Restored: level ${levelFromXp(state.xp)}, ${plural(state.stats.pushups, "pushup")} done.${kept}`);
  });
});

$("btnWipe").addEventListener("click", e => confirmTap(e.currentTarget, "Tap again to reset everything", () => {
  const keep = penaltiesToKeep();
  state = { ...freshState(state.settings), rev: state.rev };
  keep(state);
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
let fedFrames = false; // tests (?debug): frames fed through the real counter, so the fight text follows them
const plankState = () => (fakeReps() && !fedFrames ? "up" : tracker.counter.state);

// Fight startup (camera question, then body tracking) can take a while. A Back button works the whole
// time; going back counts for nothing, because no fight has begun yet. Returns true when the fight can begin.
let startup = null; // { token, backTo, cancel } while the camera and body tracking start
let strictCamera = false; // tests (?debug): a camera problem shows the real error instead of fake-rep mode
let retryStart = null; // the "Try again" button of a start that ran out of time: does the same start again
async function openFightScreen(backTo, again = null) {
  applySettings();
  initAudio(); // after applySettings: with sound off, the audio engine isn't made or woken
  closeModal();
  show("fight");
  $("restPanel").hidden = true;
  $("banner").hidden = false;
  $("btnFlee").hidden = false;
  disarm($("btnFlee"));
  $("btnFlee").textContent = "Back";
  updateThreat(null);
  setBanner("Starting camera…", "");
  $("debug").textContent = "Starting camera…";
  $("dbgRep").hidden = $("dbgNoRep").hidden = !DEBUG;
  beat(); // other windows see a fight starting here, even while the camera is still starting
  const token = { cancelled: false };
  let onCancel;
  const backTapped = new Promise(r => { onCancel = r; });
  startup = { token, backTo, cancel: () => { token.cancelled = true; onCancel("back"); } };
  const slowNote = setTimeout(() => {
    if (startup && startup.token === token) setBanner("Taking longer than usual: waiting for the camera permission question, or downloading body tracking on a slow connection. Tap Back to leave.", "warn");
  }, 8000);
  const camera = tracker.startCamera(state.settings.camera, state.settings.model, token);
  camera.catch(() => {}); // after Back, its late "cancelled" error is expected
  try {
    if ((await Promise.race([camera.then(() => "ready"), backTapped])) === "back") return false;
    return true;
  } catch (e) {
    if (token.cancelled) return false;
    if (DEBUG && !strictCamera) { $("debug").textContent = "debug: no camera, use the fake buttons"; return true; }
    tracker.stop();
    quietAudio(); // no fight, no sound to finish
    stopBeat();
    show(backTo);
    retryStart = e.retry && again ? again : null; // ran out of time: nothing was lost, so offer the same start again
    openModal(`<p class="eyebrow">Camera</p><h2>The fight can't start</h2><p>${esc(e.friendly || "Could not start the camera.")}</p>
      <div class="row">${retryStart ? `<button type="button" class="primary" data-action="retryStart">Try again</button>` : ""}<button type="button"${retryStart ? "" : ' class="primary"'} data-action="closeModal">OK</button></div>`);
    return false;
  } finally {
    clearTimeout(slowNote);
    if (startup && startup.token === token) startup = null;
  }
}
// Back during startup: switch off whatever already started, go back, and leave no trace of a fight
function cancelStartup() {
  const s = startup;
  if (!s) return;
  startup = null;
  s.cancel();
  tracker.stop(); // stops a camera that is already on (body tracking was still loading)
  quietAudio(); // no fight, no sound to finish
  stopBeat();
  show(s.backTo);
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
    ? `${DUNGEON.name} · floor ${state.run.floor}${state.run.replay ? " (replay)" : ""} · room ${state.run.room + 1} of ${DUNGEON.floors[state.run.floor - 1].length}`
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

// A slow rep at the bottom: its time so far (the same number the meter shows and the rule judges), and
// whether that clock has stopped. It stops at the lowest point (core.js downSecsOf), so after a short time
// without sinking any further, staying down can't make this rep slow enough. Frame times, like the rule.
const STALL_MS = 800;
function slowBottom(c) {
  const low = c.trace.find(p => p.e <= c.minElbow + 3);
  const last = c.trace[c.trace.length - 1];
  return { secs: downSecsOf(c) || 0, stalled: !!low && last.t - low.t >= STALL_MS };
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
  // slow monsters: at depth, "Push up!" only once the way down took long enough (the green meter + chime)
  if (fight.m.slow && key === "depth") {
    const need = slowSecs(fight.m), b = slowBottom(tracker.counter.cycle);
    if (b.secs < need) {
      if (b.stalled) setBanner("Too fast this time. Push up, then go slower.", "warn");
      else setBanner(`Lower, slowly… ${b.secs.toFixed(1)} / ${need} s`, "");
      return;
    }
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
  const pause = pauseSecs(fight.m); // longer with slow reps
  const left = pause * 1000 - (t - fight.lastRepAt);
  if (left <= 0) { stopSet(`No strict rep for ${pause} seconds.`); return; }
  updateThreat(left, pause * 1000, fight.openEnded || fight.overkill ? "Set ends in" : "Attack in");
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
    if (ev.expired) resetDepthMeter(); // a rep held over 60 s was dropped: so is its slow-rep time
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
    where: f.where === "dungeon" ? `Mine floor ${state.run ? state.run.floor : "?"}${state.run && state.run.replay ? " (replay)" : ""}` : f.label,
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
  const levelBefore = levelFromXp(state.xp), sysBefore = systemStatus(state);
  const prevBest = state.stats.bestSet;
  // a replayed mine floor: 1 XP per counted rep
  const gain = f.where === "champion" ? f.reps * RULES.championXpPerRep
    : f.where === "dungeon" && state.run && state.run.replay ? f.reps
    : rewardFor(f.m, f.where);
  state.xp += gain;
  recordFight(f, true);
  const lines = [`+${gain} XP for ${esc(the(f.m.name))}.`];
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
    const sysSay = systemLines(sysBefore, lines);
    levelUpLine(levelBefore, lines);
    const ok = save();
    if (!ok) lines.push(NOT_SAVED);
    say((f.where === "champion" ? `New record. ${f.reps}!` : `${f.m.name} defeated!`) + sysSay);
    endFight("map");
    resultModal({ tone: "won", eyebrow: "Victory", title: `${f.m.name} defeated`, lines,
      buttons: (ok ? "" : BACKUP_NOW_BTN) + `<button type="button"${ok ? ' class="primary"' : ""} data-action="closeModal">Back to the map</button>` });
    return;
  }

  const run = state.run;
  run.room++;
  const rooms = DUNGEON.floors[run.floor - 1];
  if (run.room < rooms.length) {
    const sysSay = systemLines(sysBefore, lines);
    levelUpLine(levelBefore, lines);
    save();
    say(`${f.m.name} defeated!${sysSay} Rest.`);
    mineBreak(RULES.restBetweenRoomsSec, `Room ${run.room} cleared`, lines);
    return;
  }

  // last room of a replay: no floor bonus, and the mine progress stays (both are for first clears)
  if (run.replay) {
    state.run = null;
    const sysSay = systemLines(sysBefore, lines);
    levelUpLine(levelBefore, lines);
    lines.push(`Floor ${run.floor} replayed. The floor bonus and mine progress are only for first clears.`);
    const ok = save();
    if (!ok) lines.push(NOT_SAVED);
    say(`Floor ${run.floor} replayed!${sysSay}`);
    endFight("dungeon");
    resultModal({ tone: "won", eyebrow: "Replay", title: `Floor ${run.floor} replayed`, lines,
      buttons: (ok ? "" : BACKUP_NOW_BTN) + `<button type="button"${ok ? ' class="primary"' : ""} data-action="closeModal">Leave the mine</button>` });
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
  const sysSay = systemLines(sysBefore, lines);
  levelUpLine(levelBefore, lines);
  // only say the floor is saved when it really is; the progress stays in this session either way
  const ok = save();
  lines.splice(safeAt, 0, ok
    ? `Safe room reached! Floor ${cleared} is saved. +${bonus} XP.`
    : `Safe room reached! Floor ${cleared} cleared, +${bonus} XP.`);
  if (!ok) lines.push(NOT_SAVED);
  say(`Safe room reached!${sysSay}`);
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
  const prevBest = state.stats.bestSet, sysBefore = systemStatus(state);
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
  const sysSay = systemLines(sysBefore, lines); // a loss can still bring a new best set
  if (where === "dungeon") {
    // a lost replay: only the normal rest (the mine stays open, the progress is kept)
    if (state.run && state.run.replay) lines.push(`It was a replay of floor ${state.run.floor}, so the mine stays open and your progress is kept.`);
    else {
      state.dungeonLockedUntil = t + RULES.dungeonLockDays * 86400e3;
      lines.push(`${DUNGEON.name} is closed for ${RULES.dungeonLockDays} days, until ${fmtAt(state.dungeonLockedUntil)}. Then you start floor ${state.dungeonFloor} again.`);
    }
    state.run = null;
  }
  lines.push(`Your muscles need rest. Fights open again in ${RULES.restHoursAfterLoss} hours (${fmtAt(state.restUntil)}).`);
  save();
  sfx.lose();
  say(`Time to recover.${sysSay}`);
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
  const levelBefore = levelFromXp(state.xp), sysBefore = systemStatus(state);
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
  const sysSay = systemLines(sysBefore, lines);
  levelUpLine(levelBefore, lines);
  save();
  sfx.win();
  say(`${plural(reps, "pushup")}. Well done.${sysSay}`);
  endFight("map");
  resultModal({ tone: "won", eyebrow: "Strength test", title: `${reps} pushup${reps === 1 ? "" : "s"}`, lines,
    buttons: `<button type="button" class="primary" data-action="closeModal">See the map</button>` });
}

function endFight(screen) {
  fight = null;
  rest = null;
  if (state.fightMark) { state.fightMark = null; save(); }
  stopBeat(); // a clean end frees the other windows right away
  tracker.stop(); // also clears the rep counter
  resetDepthMeter(); // and the meter's copy of the last rep
  quietAudio(600); // the audio engine sleeps once the win or loss sound has played out
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
  // no body tracking in a break (the camera picture and the screen lock stay on), and a rep in progress
  // is dropped now (the next fight or round starts fresh anyway)
  tracker.hold(true);
  tracker.counter.reset();
  resetDepthMeter();
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
  tracker.hold(false); // the next room or round (set up fresh by onDone) is tracked again from its first frame
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
  // in the mine, giving up between rounds is leaving the mine (closed for days, unless it's a replay)
  const run = f.where === "dungeon" ? state.run : null;
  startRest({
    sec: RULES.roundRestSec,
    title: `Round ${f.round} of ${f.rounds.length} done`,
    next: `Next: round ${f.round + 1}, <b>${f.roundLeft} pushups</b>. ${f.hpLeft} HP left in total.`,
    quitLabel: run ? "Leave the mine" : "Give up",
    quitReason: "You gave up between rounds.",
    warn: !run ? "Giving up counts as a loss. Leaving the app longer than the break does too."
      : run.replay ? `Leaving now counts as a loss: ${RULES.restHoursAfterLoss} hours of rest (the mine stays open). Leaving the app longer than the break does too.`
      : `Leaving now closes the mine for ${RULES.dungeonLockDays} days. Leaving the app longer than the break does too.`,
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

// endsAt: a break that was already on (back after the game was closed) keeps the end it had
function mineBreak(sec, title, lines, endsAt = now() + sec * 1000) {
  fight = null;
  const run = state.run;
  // remembered in the save: closing the game can't stretch a break (see settleLeftFight and continueRun)
  run.breakEndsAt = endsAt;
  save();
  const rooms = DUNGEON.floors[run.floor - 1];
  const next = rooms[run.room];
  startRest({
    sec,
    title,
    next: `${lines.length ? lines.join("<br>") + "<br>" : ""}Next: <b>${esc(next.name)}</b>, ${hpText(next)} (room ${run.room + 1} of ${rooms.length})${next.slow ? `<br><span class="chip slow">Slow reps · ${slowSecs(next)} s down</span>` : ""}${next.rounds && next.rounds.length > 1 ? `<br>${next.rounds.length} rounds with ${RULES.roundRestSec} s of rest between them.` : ""}`,
    quitLabel: "Leave the mine",
    quitReason: run.replay ? "You left the replay before the safe room." : "You left the mine before the safe room.",
    warn: run.replay
      ? `Leaving now counts as a loss: ${RULES.restHoursAfterLoss} hours of rest (the mine stays open). Leaving the app longer than the break does too.`
      : `Leaving now closes the mine for ${RULES.dungeonLockDays} days. Leaving the app longer than the break does too.`,
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
  if (!(await openFightScreen("map", () => startFight(id)))) return;
  beginFight(r.m, r.where, false, r.label);
}
async function enterFloor() {
  if (!mayStartHere()) return;
  const t = now();
  if (fight || state.run || state.restUntil > t || state.dungeonLockedUntil > t || state.dungeonFloor > DUNGEON.floors.length) return;
  state.run = { floor: state.dungeonFloor, room: 0 };
  save();
  if (!(await openFightScreen("dungeon", enterFloor))) { state.run = null; save(); renderCurrent(); return; }
  beginFight(DUNGEON.floors[state.run.floor - 1][0], "dungeon", false, DUNGEON.name);
}
// a floor already cleared, played again: 1 XP per rep, no floor bonus, no progress; losing it means only the
// normal rest. It can start when a fresh run could: the mine open, the rest over, no run going.
async function replayFloor(floor) {
  if (!mayStartHere()) return;
  const t = now();
  if (fight || state.run || state.restUntil > t || state.dungeonLockedUntil > t || !(floor >= 1 && floor < state.dungeonFloor)) return;
  state.run = { floor, room: 0, replay: true };
  save();
  if (!(await openFightScreen("dungeon", () => replayFloor(floor)))) { state.run = null; save(); renderCurrent(); return; }
  beginFight(DUNGEON.floors[floor - 1][0], "dungeon", false, DUNGEON.name);
}
async function continueRun() {
  if (!mayStartHere()) return;
  if (!state.run) return;
  if (!(await openFightScreen("dungeon", continueRun))) return;
  const run = state.run;
  if (!run) { syncLost(); return; } // the run was ended in another window while the camera started
  // Back after the game was closed. No break was on: a full minute. A break that was on keeps its own end,
  // and one that is over isn't given again, so closing and reopening the game can't stretch a break.
  const endsAt = run.breakEndsAt;
  if (!endsAt) { mineBreak(60, "Back in the mine", []); return; }
  const left = endsAt - now();
  if (left > 0) { mineBreak(left / 1000, "Back in the mine", [], endsAt); return; }
  // The break is over: the next room starts at once, and its start timer counts from the end of the break
  // (with at least lateStartSec left, to get into plank). From here the fight is on the line (markFight in
  // beginFight), so closing the game again loses it.
  beginFight(DUNGEON.floors[run.floor - 1][run.room], "dungeon", true, DUNGEON.name);
  fight.waitSince -= Math.min(-left, (RULES.dungeonStartSec - RULES.lateStartSec) * 1000);
}

// ---------- controls ----------

document.addEventListener("click", e => {
  const b = e.target.closest("[data-action]");
  if (!b || b.disabled) return;
  const { action, to, id } = b.dataset;
  if (action === "goto") { closeModal(); show(to); }
  else if (action === "prefight") openPrefight(id);
  else if (action === "fight") startFight(id);
  else if (action === "closeModal") { retryStart = null; closeModal(); renderCurrent(); }
  else if (action === "retryStart") { const again = retryStart; retryStart = null; closeModal(); if (again) again(); }
  else if (action === "enterFloor") enterFloor();
  else if (action === "deeper") { closeModal(); enterFloor(); }
  else if (action === "replayFloor") replayFloor(Number(b.dataset.floor));
  else if (action === "continueRun") continueRun();
  else if (action === "backupNow") shareBackup();
  else if (action === "saveRuck") saveRuck();
  else if (action === "ruckFixKm") fixRuckKm();
  else if (action === "ruckDelete") askDeleteRuck(b.dataset.t);
  else if (action === "ruckDeleteYes") deleteRuck(b.dataset.t);
  else if (action === "ruckReport") openRuckReport(b.dataset.t);
});

$("btnFlee").addEventListener("click", e => {
  if (startup) { cancelStartup(); return; } // still starting: Back, free of charge
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
  if (audio.on) initAudio(); else { hush(); quietAudio(); }
});
$("dbgRep").addEventListener("click", () => { if (fight && !fight.over && !rest) hit(); });
$("dbgNoRep").addEventListener("click", () => onRepEvent({ type: "norep", reasons: ["Go lower"] }));

// Leaving the app doesn't pause anything: the clock keeps running while you're away.
// A quick look at a notification is fine, but leaving a fight that has started counts as giving up,
// otherwise you could rest in another app (or close the game) to dodge a loss.
// The camera is off while the game is hidden. Coming back, the game first decides whether the fight
// (or break) goes on; only then does the tracker switch the camera and screen lock back on. After a
// loss the tracker is already stopped, so nothing is switched on for a fight that is over.
document.addEventListener("visibilitychange", () => {
  const t = performance.now();
  if (document.hidden) {
    tracker.pause();
    if (fight || rest) hiddenAt = t;
    return;
  }
  adoptIfNewer(); // another window may have saved while this one was in the background
  settleAway(t);
  tracker.resume();
});
function settleAway(t) {
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
}
// a closed or reloaded page can't be stopped on a phone, but on a computer the browser can ask first
window.addEventListener("beforeunload", e => {
  if ((fight && committed(fight)) || rest) { e.preventDefault(); e.returnValue = ""; }
});
// A page that is really going away (closed or reloaded) takes its "fight running" signal with it, so the
// game opened again right after isn't told a fight is active in another tab. When the phone kills the app
// without telling the page, the signal just gets old (ALIVE_FRESH), as before.
window.addEventListener("pagehide", stopBeat);

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
    frame: (m, t) => { fedFrames = true; tracker.counter.update(m, t).forEach(onRepEvent); onTrackFrame(m, t); },
    get counter() { return tracker.counter; },
    get meterCycle() { return meter.cycle; }, // the rep the live depth meter is following
    get trackerRunning() { return tracker.running; },
    get delegate() { return tracker.delegate; }, // GPU or CPU: how the installed body-tracking model runs
    set strictCamera(v) { strictCamera = !!v; },
    hooks: testHooks,
    wanderer: () => todaysWanderer(),
  };
}
