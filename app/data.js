// Game content and rules. Change the numbers here to tune the game.
// HP is always real pushups, the same for everyone. It never grows with your level.

export const RULES = {
  restHoursAfterLoss: 10,   // lose any fight = no fights for this long
  dungeonLockDays: 7,       // lose or quit in the mine before the safe room = mine closed this long
  restBetweenRoomsSec: 90,  // break between rooms in the mine
  roundRestSec: 90,         // break between rounds of a big monster
  dungeonStartSec: 30,      // after a break, do the first rep within this time
  lateStartSec: 10,         // back in the game after the break already ended: at least this much of that time is left
  maxPauseSec: 15,          // after the first rep: no strict rep for this long = the monster gets you
  slowPauseSec: 20,         // ...in a fight with 2 s slow reps (each try takes longer)
  slowHardPauseSec: 23,     // ...in a fight with 3 s slow reps
  leavePlankSec: 3,         // stand up or sit back this long = you lose
  leaveAppSec: 10,          // a fight that has started: away from the app longer than this = you gave up
  slowDownSec: 2,           // "slow reps": going down must take this long (2 early, 3 in later areas)
  slowHardSec: 3,
  specialHpMult: 0.7,       // slow-rep monsters get fewer HP, because each rep is harder (map and mine set theirs by hand; wanderers use this)
  specialXpMult: 1.5,       // ...and more XP per HP
  bossXpMult: 2,
  dungeonXpMult: 1.5,
  wandererXpMult: 2,
  championXpPerRep: 2,
  floorBonusXp: 10,         // times the floor number, for reaching the safe room

  // Rucking (ruck.js): walking with a heavy pack. Effort = pack kg × km ("kg·km"). Rucks give XP for your
  // level, but never hit monsters or open areas: HP stays real pushups, checked by the camera.
  ruckXpPerKgKm: 0.5,       // 15 kg × 6 km = 90 kg·km = 45 XP, about a normal day of pushups. Only ever raise it:
                            // backups are checked with this rate, so a lower one would refuse older backups
  ruckKg: [1, 60],          // pack weight allowed
  ruckKm: [0.5, 80],        // one ruck's distance allowed
  ruckMaxHours: 24,         // one ruck's time allowed
  ruckMaxKmh: 12,           // faster is a car or a GPS jump: not counted
  ruckMinKmh: 1,            // slower is a break: no km, no time
  ruckFastShare: 0.25,      // more than this share of a file too fast = a car ride, refused
  ruckWindowSec: 20,        // speed is judged over this long, not point to point (GPS points wobble)
  ruckStepM: 5,             // a GPS point counts once it is this far from the last one that counted (wobble)
  ruckClimbStepM: 3,        // up-downs smaller than this don't count as climb (GPS height is noisy)
  ruckClimbSmoothSec: 60,   // the height is averaged over this long (half before, half after) before the climb is counted (noise)
  ruckHoleSec: 120,         // longer than this with nothing recorded while you moved = a hole (GPS lost)
  ruckSensorShare: 0.5,     // heart rate and steps count only when recorded for at least this share of the moving time
  ruckLogMax: 40,           // rucks kept in the log (the totals keep counting all of them)
  ruckFileMaxMB: 10,        // the biggest GPX file read (a 1-second track of 10 hours is about 6 MB)
  // the ruck report (heart rate, steps, km splits, lines): shown only, never XP
  ruckGapSec: 30,           // a gap in the recording longer than this doesn't count for heart rate or steps
  ruckChartPoints: 32,      // points in the report's heart rate and height lines
  ruckSplitsMax: 50,        // km splits kept (one per km)
  ruckChartsKept: 3,        // the newest rucks keep their lines and splits; older ones keep only their numbers
                            // (so the biggest backup stays under its size limit, test Item 1c)
};

// A ruck's rank: the hardest test it passes, like a soldier's march test. Each test needs a distance, a pack
// (as a share of your body weight) and a pace. XP stays pack kg × km; the rank says how hard the ruck was.
// - Pace = time from start to end, breaks included (like a real test), over the km plus 1 km for every
//   `climbM` metres up (so a mountain ruck isn't "slow"). Moving time isn't used.
// - The pack's share: the body weight saved with the ruck (bw), else the one in settings, else `refKg`.
//   The tests in kg were made for a soldier of about 80 kg: S 20 kg, A 16 kg, B 15 kg, C 10 kg, D 5 kg
//   (B is 18%, a little under 15 kg, so a 15 kg pack passes it at 80 kg).
// - Roughly: A = the US Expert Infantry Badge march (19.3 km in 3 h with about 16 kg); S is harder but still
//   easier than special forces selection. Worked out when shown, so the tests can change any time.
// The System's CARRY stat is your best ruck rank ever (ruck.best.rank, and the rucks still in the log).
export const RUCK_TEST = { climbM: 100, refKg: 80, bodyKg: [30, 250] };
export const RUCK_TESTS = [ // hardest first; pace in seconds a km
  { rank: "S", km: 20, pct: 25, pace: 540, like: "just below special forces" },
  { rank: "A", km: 19, pct: 20, pace: 560, like: "above army standard" },
  { rank: "B", km: 12, pct: 18, pace: 600, like: "army standard" },
  { rank: "C", km: 8, pct: 12, pace: 660, like: "a fit, trained civilian" },
  { rank: "D", km: 5, pct: 6, pace: 750, like: "a regular rucker" },
  { rank: "E", km: 3, pct: 0, pace: 900, like: "you started" },
];
const okBody = v => Number.isFinite(v) && v >= RUCK_TEST.bodyKg[0] && v <= RUCK_TEST.bodyKg[1];
// e: a log entry; bodyKg: the body weight in settings (or null)
export function ruckGrade(e, bodyKg = null) {
  const bw = okBody(e.bw) ? e.bw : okBody(bodyKg) ? bodyKg : RUCK_TEST.refKg;
  const mins = Math.max(e.mins || 0, ((e.end || 0) - (e.t || 0)) / 60000); // start to end, breaks included
  const flatKm = (e.km || 0) + (e.climb || 0) / RUCK_TEST.climbM;
  const pct = Math.round(((e.kg || 0) / bw) * 1000) / 10, pace = flatKm > 0 ? Math.round((mins * 60) / flatKm) : Infinity;
  const passes = t => (e.km || 0) >= t.km && pct >= t.pct && pace <= t.pace;
  const i = RUCK_TESTS.findIndex(passes);
  const idx = i < 0 ? 0 : RUCK_TESTS.length - i; // 0 = F ... 6 = S (an index into RANKS)
  return { rank: i < 0 ? "F" : RUCK_TESTS[i].rank, idx, bw, guessed: !okBody(e.bw) && !okBody(bodyKg), pct, pace, mins: Math.round(mins), flatKm: Math.round(flatKm * 10) / 10,
    next: idx < RUCK_TESTS.length ? RUCK_TESTS[RUCK_TESTS.length - 1 - idx] : null };
}
// a test in words: "20 km+, pack 25% of your body weight (20 kg), 9:00 min/km or faster"
const paceText = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
export function ruckTestText(t, bodyKg = null) {
  const bw = okBody(bodyKg) ? bodyKg : RUCK_TEST.refKg;
  const pack = t.pct ? `pack ${t.pct}% of your body weight (${Math.round((bw * t.pct) / 10) / 10} kg)` : "any pack";
  return `${t.km} km+, ${pack}, ${paceText(t.pace)} min/km or faster`;
}
// the best rank of the rucks in the log (old rucks fall out of it, so ruck.best.rank keeps the best ever)
export const bestRuckRank = (log, bodyKg = null) => Math.max(0, ...(log || []).map(e => ruckGrade(e, bodyKg).idx));

// Feats a ruck can show in its report (worked out when shown, never saved): name, what it takes, test.
export const RUCK_FEATS = [
  ["Long haul", "10 km or more", e => e.km >= 10],
  ["Marathon mule", "a marathon, 42.2 km or more", e => e.km >= 42.2],
  ["Heavy hauler", "a pack of 20 kg or more", e => e.kg >= 20],
  ["Iron back", "300 kg·km or more", e => e.kgkm >= 300],
  ["Mountain goat", "300 m up or more", e => e.climb >= 300],
  ["Steady engine", "3 hours or more moving", e => e.mins >= 180],
  ["Expedition", "6 hours or more from start to end", e => e.end - e.t >= 6 * 3600e3],
  ["Early boots", "started before 7:00", e => new Date(e.t).getHours() < 7],
  ["Night march", "still going after 21:00", e => new Date(e.end).getHours() >= 21 || new Date(e.end).getDate() !== new Date(e.t).getDate()],
];

// slow: seconds each rep must take going down. rounds: several sets with a break between (hp = all rounds together).
// A new rule shows up on a normal monster first (practice), and only later on a boss (the test).
// hpBefore: a monster's HP before it was lowered. Wins from then gave more pushups and XP, so a backup is checked
// against the larger number (keep it when lowering HP again; use the highest it ever had).
// hpLow: a plain monster's lowest HP before it was raised. A strength test back then needed only that much
// to start in its area, so backups are checked with it (startZoneFor ... { before: true }).
// oneSetBefore: hpBefore was one set (not rounds), so wanderers back then could have that many HP (wanderHpEver).
// The world map is one set per fight (strength); fights in rounds belong in the mine (endurance).
// From Peat Bog on, each normal monster is 3-4 more than the one before, up to the Elder Dragon's 60.
export const ZONES = [
  {
    id: "meadow", name: "Meadow Edge", blurb: "Small beasts at the forest edge. Good for your first fights.",
    monsters: [
      { id: "field-mouse", name: "Field Mouse", hp: 3 },
      { id: "cave-rat", name: "Cave Rat", hp: 5 },
      { id: "thorn-sprite", name: "Thorn Sprite", hp: 6 },
      { id: "old-badger", name: "Old Badger", hp: 8, boss: true },
    ],
  },
  {
    id: "birch", name: "Birch Forest", blurb: "Goblins and wolves live between the white trees.",
    monsters: [
      { id: "forest-goblin", name: "Forest Goblin", hp: 7, hpBefore: 9 }, // 9 HP until Nov 2026
      { id: "moss-slime", name: "Moss Slime", hp: 5, slow: 2, hpBefore: 7 }, // 7 HP until Nov 2026
      { id: "grey-wolf", name: "Grey Wolf", hp: 12 },
      { id: "goblin-chief", name: "Goblin Chief", hp: 14, boss: true },
    ],
  },
  {
    id: "bog", name: "Peat Bog", blurb: "Soft ground, heavy monsters.",
    monsters: [
      // raised in Nov 2026 (were 15 / 11 / 18 / 14)
      { id: "bog-leech", name: "Bog Leech", hp: 17, hpLow: 15 },
      { id: "swamp-lurker", name: "Swamp Lurker", hp: 12, slow: 2 },
      { id: "bog-troll", name: "Bog Troll", hp: 20, hpLow: 18 },
      { id: "mire-king", name: "Mire King", hp: 15, boss: true, slow: 2 },
    ],
  },
  {
    id: "ridge", name: "Pine Ridge", blurb: "Steep paths. The big animals live here.",
    monsters: [
      // raised in Nov 2026 (were 21 / 23 / 26 / 30)
      { id: "ridge-boar", name: "Ridge Boar", hp: 24, hpLow: 21 },
      { id: "shadow-lynx", name: "Shadow Lynx", hp: 28, hpLow: 23 },
      { id: "stone-golem", name: "Stone Golem", hp: 32, hpLow: 26 },
      { id: "elder-bear", name: "Elder Bear", hp: 36, boss: true, hpLow: 30 },
    ],
  },
  {
    id: "peaks", name: "Frost Peaks", blurb: "Cold wind and giants.",
    monsters: [
      // raised in Nov 2026 (were 22 / 36 / 28)
      { id: "ice-wraith", name: "Ice Wraith", hp: 24, slow: 3 },
      { id: "frost-giant", name: "Frost Giant", hp: 40, hpLow: 36 },
      { id: "white-wyrm", name: "White Wyrm", hp: 31, boss: true, slow: 3 },
    ],
  },
  {
    id: "ash", name: "The Ashlands", blurb: "Burnt land. The biggest sets so far.",
    monsters: [
      // 44 / 50 / 60 until Nov 2026 (then two weeks in rounds: 2x16, 2x19, 3x16)
      { id: "ember-hound", name: "Ember Hound", hp: 44, hpBefore: 44, oneSetBefore: true },
      { id: "ash-knight", name: "Ash Knight", hp: 48, hpBefore: 50, oneSetBefore: true },
      { id: "burnt-king", name: "The Burnt King", hp: 52, boss: true, hpBefore: 60, oneSetBefore: true },
    ],
  },
  {
    id: "spine", name: "Dragon's Spine", blurb: "The end of the map. The dragon waits at the top: 60 in one set.",
    monsters: [
      // in rounds until Nov 2026: 30+30, 35x3, 40x4 (then 2x20, 3x20, 4x20)
      { id: "ash-drake", name: "Ash Drake", hp: 34, slow: 3, hpBefore: 60 },
      { id: "stone-colossus", name: "Stone Colossus", hp: 56, hpBefore: 105 },
      { id: "elder-dragon", name: "The Elder Dragon", hp: 60, boss: true, hpBefore: 160 },
    ],
  },
];
for (const z of ZONES) for (const m of z.monsters) if (m.rounds) m.hp = m.rounds.reduce((a, b) => a + b, 0);

// The mine (endurance): each floor is 3 rooms in a row, then a safe room. Balanced to the world map (Nov 2026):
// with 90 s breaks, every pushup already done on a floor costs about 1/4 rep in the next set (a slow rep counts
// 1/0.7), so floor 1 is like a ~10 HP map monster and floor 10 like the Elder Dragon (~60).
// From floor 6, the last room of a floor is fought in rounds (a break between, like between rooms).
// Each room: HP, [rounds], or { slow: HP } (2 s slow reps, 3 s from floor 6). All rooms only went up, so
// wins from before need no hpBefore.
const FLOOR_HP = [
  [5, 6, 7],
  [7, 8, 9],
  [9, { slow: 7 }, 11],
  [12, 13, 14],
  [{ slow: 10 }, 16, 17],
  [{ slow: 13 }, 20, [16, 16]],
  [22, 23, [20, 20]],
  [26, 27, { slow: 20 }],
  [30, 31, [22, 22, 22]],
  [32, 33, [25, 25, 25, 25]],
];
const FLOOR_NAMES = [
  ["Mine Rat", "Cave Bat", "Tunnel Goblin"],
  ["Bat Swarm", "Rock Crawler", "Goblin Guard"],
  ["Skeleton Miner", "Lantern Ghost", "Tunnel Ogre"],
  ["Deep Spider", "Bone Miner", "Mine Troll"],
  ["Crystal Slime", "Cave Stalker", "Crystal Golem"],
  ["Mine Wraith", "Cave Troll", "Rust Golem"],
  ["Lava Worm", "Ember Bat", "Magma Golem"],
  ["Shadow Miner", "Bone Drake", "Deep Wraith"],
  ["Abyss Crawler", "Night Golem", "Hollow Guard"],
  ["Stone Warden", "Elder Drake", "The Deep King"],
];
export const DUNGEON = {
  name: "The Old Mine",
  floors: FLOOR_NAMES.map((names, fi) => names.map((name, ri) => {
    const spec = FLOOR_HP[fi][ri];
    const rounds = Array.isArray(spec) ? spec : null;
    const slow = spec && spec.slow ? (fi + 1 >= 6 ? RULES.slowHardSec : RULES.slowDownSec) : 0;
    return {
      id: `mine-${fi + 1}-${ri + 1}`,
      name,
      hp: rounds ? rounds.reduce((a, b) => a + b, 0) : slow ? spec.slow : spec,
      ...(rounds ? { rounds } : {}),
      slow,
      boss: fi === FLOOR_NAMES.length - 1 && ri === names.length - 1,
    };
  })),
};

// One may show up on the map for a day. Its HP comes from your highest open area.
export const WANDERERS = [
  { id: "golden-boar", name: "Golden Boar" },
  { id: "lost-knight", name: "Lost Knight" },
  { id: "will-o-wisp", name: "Will-o'-the-Wisp", slow: true },
  { id: "night-stalker", name: "Night Stalker" },
  { id: "hermit-troll", name: "Hermit Troll" },
  { id: "storm-hawk", name: "Storm Hawk" },
];

// Monsters that have a picture: img/monsters/<id>.jpg (512 px) and <id>-s.jpg (160 px).
// Add new ones with tools\import-art.ps1, then list them here.
export const ART = new Set([
  "field-mouse", "cave-rat", "thorn-sprite", "old-badger",
  "forest-goblin", "moss-slime", "grey-wolf", "goblin-chief",
  "bog-leech", "swamp-lurker", "bog-troll", "mire-king",
  "ridge-boar", "shadow-lynx", "stone-golem", "elder-bear",
  "ice-wraith", "frost-giant", "white-wyrm",
  "ember-hound", "ash-knight", "burnt-king",
  "ash-drake", "stone-colossus", "elder-dragon",
  "champion",
  "wanderer-golden-boar", "wanderer-lost-knight", "wanderer-will-o-wisp",
  "wanderer-night-stalker", "wanderer-hermit-troll", "wanderer-storm-hawk",
  // every mine room, floors 1-10
  ...Array.from({ length: 10 }, (_, f) => [1, 2, 3].map(r => `mine-${f + 1}-${r}`)).flat(),
]);
export const artUrl = (id, small = false) => (ART.has(id) ? `img/monsters/${id}${small ? "-s" : ""}.jpg` : null);

// Levels are only for show: they never change how much damage a rep does.
export const TITLES = [
  [1, "Wanderer"],
  [2, "Firestarter"],
  [4, "Camp Hand"],
  [6, "Woodsman"],
  [9, "Tracker"],
  [12, "Ranger"],
  [16, "Beast Hunter"],
  [20, "Iron Arms"],
  [25, "Warden of the Wilds"],
  // later titles come about every 1-2 months at ~40 pushups a day
  [30, "Bog Strider"],
  [35, "Ridge Runner"],
  [40, "Stone Breaker"],
  [45, "Frost Walker"],
  [50, "Giant Slayer"],
  [55, "Ember Heart"],
  [60, "Ash Walker"],
  [66, "Deep Delver"],
  [72, "Wyrm Hunter"],
  [78, "Dragon Hunter"],
  [85, "Legend of the Forest"],
  [92, "Elder of the Wilds"],
  [99, "Master of the Wilds"],
];

// Levels stop at 99 (about 30,700 XP, roughly 25,000 pushups). XP keeps counting after that.
export const MAX_LEVEL = 99;

// total XP needed to reach level L
export const xpForLevel = L => (L <= 1 ? 0 : Math.round(20 * Math.pow(L - 1, 1.6)));

export function levelFromXp(xp) {
  let L = 1;
  while (L < MAX_LEVEL && xp >= xpForLevel(L + 1)) L++;
  return L;
}

export function titleFor(L) {
  let title = TITLES[0][1];
  for (const [lv, name] of TITLES) if (L >= lv) title = name;
  return title;
}

// seconds a rep must take going down, or 0 for normal reps
export const slowSecs = m => (m.slow === true ? RULES.slowDownSec : m.slow || 0);
// the longest pause between counted reps before the monster wins (longer with slow reps)
export const pauseSecs = m => (slowSecs(m) >= RULES.slowHardSec ? RULES.slowHardPauseSec : slowSecs(m) ? RULES.slowPauseSec : RULES.maxPauseSec);

export function xpReward(m, where) {
  return Math.round(m.hp
    * (m.boss ? RULES.bossXpMult : 1)
    * (where === "dungeon" ? RULES.dungeonXpMult : 1)
    * (m.slow ? RULES.specialXpMult : 1));
}

// Strength test: you start in the highest area whose hardest plain fight (no special rules) you could win.
// Never in the last area: the dragon is always earned.
// before: also counts the lower HP some monsters had before (checks backups made back then).
export function startZoneFor(reps, { before = false } = {}) {
  let zi = 0;
  ZONES.forEach((z, i) => {
    if (i === ZONES.length - 1) return;
    const plain = z.monsters.filter(m => !m.slow && !m.rounds).map(m => (before && m.hpLow ? Math.min(m.hp, m.hpLow) : m.hp));
    if (plain.length && Math.max(...plain) <= reps) zi = i;
  });
  return zi;
}

// The most HP a wanderer ever had: they take the HP of plain monsters, including ones that were plain before.
export const wanderHpEver = Math.max(...ZONES.flatMap(z => z.monsters)
  .filter(m => !m.slow && (!m.rounds || m.oneSetBefore)).map(m => Math.max(m.hp, m.oneSetBefore ? m.hpBefore : 0)));

export function findMonster(id) {
  for (const [zi, zone] of ZONES.entries()) {
    const m = zone.monsters.find(x => x.id === id);
    if (m) return { m, zone, zi };
  }
  for (const [fi, rooms] of DUNGEON.floors.entries()) {
    const m = rooms.find(x => x.id === id);
    if (m) return { m, floor: fi + 1 };
  }
  return null;
}

// ---------- the System: stats and ranks (SYSTEM_PLAN.md, idea 1) ----------
// A status window that measures you. Every stat is a real number from your training ("STR 42" = your best set
// is 42). It is only shown: like levels, it never changes a fight, and there are no points to hand out.
// Nothing here is saved: it is all worked out from the save when shown, so the ladders can change any time.
// The stats come from bests and totals that only go up, so ranks never drop. HEART compares heart rates,
// can go down, and has no rank.
export const RANKS = ["F", "E", "D", "C", "B", "A", "S"];

// A stat's steps: the least for rank E, D, C, B, A, S (below the first is F). what: shown in the "next rank"
// hint. STR's steps are boss HP, so they follow the map if HP changes. goal / togo: the hint's words.
const STR_BOSSES = ["old-badger", "goblin-chief", "bog-troll", "elder-bear", "burnt-king", "elder-dragon"];
const round1 = v => Math.round(v * 10) / 10;
const en = n => n.toLocaleString("en-US");
export const SYSTEM = [
  { id: "pushups", name: "Pushups", stats: [
    { id: "str", name: "STR", long: "Strength", what: "best set",
      value: s => s.stats.bestSet || 0,
      steps: () => STR_BOSSES.map(id => { const { m } = findMonster(id); return { at: m.hp, what: m.name }; }),
      goal: (n, what) => `${n} in one set (${what})`, togo: n => `${n} more` },
    { id: "end", name: "END", long: "Endurance", what: `mine floors cleared, of ${DUNGEON.floors.length}`,
      value: s => s.stats.deepestFloor || 0,
      steps: () => [1, 3, 5, 7, 9, DUNGEON.floors.length].map(at => ({ at })),
      goal: n => `clear floor ${n}`, togo: n => `${n} more floor${n === 1 ? "" : "s"}` },
  ] },
  { id: "rucking", name: "Rucking", stats: [
    // value: a rank (0 = F ... 6 = S), so its steps are 1 to 6; a step's `what` is its test
    { id: "carry", name: "CARRY", long: "Carry", what: "your best ruck's rank",
      value: s => { const r = s.ruck || {}, bodyKg = (s.settings || {}).bodyKg; return Math.max((r.best && r.best.rank) || 0, bestRuckRank(r.log, bodyKg)); },
      steps: s => [...RUCK_TESTS].reverse().map((t, i) => ({ at: i + 1, what: ruckTestText(t, ((s && s.settings) || {}).bodyKg) })),
      goal: (n, what) => `one ruck of ${what}`, togo: () => "pass it once" },
    { id: "road", name: "ROAD", long: "Road", what: "km rucked in all",
      value: s => round1((s.ruck && s.ruck.km) || 0),
      steps: () => [10, 50, 150, 300, 600, 1000].map(at => ({ at })),
      goal: n => `${en(n)} km in all`, togo: n => `${en(n)} km more` },
  ] },
];
// workouts the System will measure once the game has them; they don't count in the overall rank before that
export const SYSTEM_LATER = ["Running", "Pullups"];

// how many steps of a ladder a value has reached: 0 = F ... 6 = S (an index into RANKS)
export const rankOf = (value, steps) => steps.filter(st => value >= st.at).length;
const meanDown = rs => Math.floor(rs.reduce((a, b) => a + b, 0) / rs.length + 1e-9);

// Everything the status window shows, from a save. A category's rank is its stats' ranks averaged and rounded
// down; the overall rank is the categories' ranks averaged and rounded down. A category never done counts as
// F, so a weak one pulls the overall rank down: S pushups and F rucking = C overall.
export function systemStatus(s) {
  const cats = SYSTEM.map(c => {
    const stats = c.stats.map(st => {
      const steps = st.steps(s), value = st.value(s), rank = rankOf(value, steps);
      const from = rank ? steps[rank - 1].at : 0, next = steps[rank] || null;
      return {
        id: st.id, name: st.name, long: st.long, what: st.what, value, rank,
        next: next && { rank: rank + 1, at: next.at, text: st.goal(next.at, next.what), togo: st.togo(round1(next.at - value)) },
        share: next ? Math.max(0, Math.min(1, (value - from) / (next.at - from))) : 1,
      };
    });
    return { id: c.id, name: c.name, rank: meanDown(stats.map(x => x.rank)), stats };
  });
  return { cats, overall: meanDown(cats.map(c => c.rank)), heart: heartOf((s.ruck && s.ruck.log) || []) };
}

// HEART: does the same work cost your heart less than before? A heart rate alone means little (a heavier
// pack, hills or a faster pace all raise it), so each ruck with heart rate is only compared with OLDER rucks
// like it: a pack within `kg`, a pace within `paceSec` a km, hills within `climbPerKm`, and at most `kmTimes`
// as long or short. HEART = how many beats a minute lower the newest `recent` such rucks were than the older
// ones like them (+6 = 6 beats less now). Locked until `need` rucks have heart rate (only rucks from a watch's
// GPX file have it). Every ruck in the log keeps its average heart rate, so nothing new is saved for this.
export const HEART = { need: 5, kg: 3, paceSec: 60, climbPerKm: 15, kmTimes: 2, recent: 5 };
export function heartOf(log) {
  const rucks = log.filter(x => x && x.hrAvg > 0 && x.km > 0 && x.mins > 0).sort((a, b) => a.t - b.t);
  if (rucks.length < HEART.need) return { locked: true, have: rucks.length, value: null };
  const pace = x => (x.mins * 60) / x.km, hills = x => (x.climb || 0) / x.km;
  const alike = (a, b) => Math.abs(a.kg - b.kg) <= HEART.kg && Math.abs(pace(a) - pace(b)) <= HEART.paceSec
    && Math.abs(hills(a) - hills(b)) <= HEART.climbPerKm && Math.max(a.km, b.km) <= HEART.kmTimes * Math.min(a.km, b.km);
  const better = [];
  rucks.forEach((e, i) => {
    const older = rucks.slice(0, i).filter(o => alike(o, e));
    if (older.length) better.push(older.reduce((a, o) => a + o.hrAvg, 0) / older.length - e.hrAvg);
  });
  const recent = better.slice(-HEART.recent);
  return { locked: false, have: rucks.length, value: recent.length ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length) : null };
}

// what changed between two systemStatus() results (before and after a fight or a ruck), for the System's messages
export function systemChanges(a, b) {
  const out = { stats: [], cats: [], overall: null, heart: null };
  b.cats.forEach((c, ci) => {
    c.stats.forEach((st, si) => {
      const was = a.cats[ci].stats[si];
      if (st.value !== was.value) out.stats.push({ ...st, was: was.value, wasRank: was.rank });
    });
    if (c.rank !== a.cats[ci].rank) out.cats.push({ name: c.name, was: a.cats[ci].rank, rank: c.rank });
  });
  if (b.overall !== a.overall) out.overall = { was: a.overall, rank: b.overall };
  const h0 = a.heart, h1 = b.heart;
  if (h1.have !== h0.have || h1.value !== h0.value || h1.locked !== h0.locked) out.heart = { was: h0, now: h1 };
  return out;
}
