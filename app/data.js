// Game content and rules. Change the numbers here to tune the game.
// HP is always real pushups, the same for everyone. It never grows with your level.

export const RULES = {
  restHoursAfterLoss: 10,   // lose any fight = no fights for this long
  dungeonLockDays: 7,       // lose or quit in the mine before the safe room = mine closed this long
  restBetweenRoomsSec: 90,  // break between rooms in the mine
  roundRestSec: 90,         // break between rounds of a big monster
  dungeonStartSec: 30,      // after a break, do the first rep within this time
  maxPauseSec: 15,          // after the first rep: no strict rep for this long = the monster gets you
  slowPauseSec: 20,         // ...in a fight with 2 s slow reps (each try takes longer)
  slowHardPauseSec: 23,     // ...in a fight with 3 s slow reps
  leavePlankSec: 3,         // stand up or sit back this long = you lose
  leaveAppSec: 10,          // a fight that has started: away from the app longer than this = you gave up
  slowDownSec: 2,           // "slow reps": going down must take this long (2 early, 3 in later areas)
  slowHardSec: 3,
  specialHpMult: 0.7,       // slow-rep monsters get fewer HP, because each rep is harder
  specialXpMult: 1.5,       // ...and more XP per HP
  bossXpMult: 2,
  dungeonXpMult: 1.5,
  wandererXpMult: 2,
  championXpPerRep: 2,
  floorBonusXp: 10,         // times the floor number, for reaching the safe room
};

// slow: seconds each rep must take going down. rounds: several sets with a break between (hp = all rounds together).
// A new rule shows up on a normal monster first (practice), and only later on a boss (the test).
// hpBefore: a monster's HP before it was lowered. Wins from then gave more pushups and XP, so a backup is checked
// against the larger number (keep it when lowering HP again; use the highest it ever had).
// oneSetBefore: it was one set (no rounds) of hpBefore HP. Backups from then can have a strength test that
// opened its area, and wanderers with that many HP (startZoneFor ... { before: true }, wanderHpEver).
// Late game (Nov 2026): the Frost Giant (36) is the biggest single set. After it, fights come in rounds:
// the Ashlands teach them, Dragon's Spine has 20-rep rounds, more of them each fight.
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
      { id: "bog-leech", name: "Bog Leech", hp: 15 },
      { id: "swamp-lurker", name: "Swamp Lurker", hp: 11, slow: 2 },
      { id: "bog-troll", name: "Bog Troll", hp: 18 },
      { id: "mire-king", name: "Mire King", hp: 14, boss: true, slow: 2 },
    ],
  },
  {
    id: "ridge", name: "Pine Ridge", blurb: "Steep paths. The big animals live here.",
    monsters: [
      { id: "ridge-boar", name: "Ridge Boar", hp: 21 },
      { id: "shadow-lynx", name: "Shadow Lynx", hp: 23 },
      { id: "stone-golem", name: "Stone Golem", hp: 26 },
      { id: "elder-bear", name: "Elder Bear", hp: 30, boss: true },
    ],
  },
  {
    id: "peaks", name: "Frost Peaks", blurb: "Cold wind and giants.",
    monsters: [
      { id: "ice-wraith", name: "Ice Wraith", hp: 22, slow: 3 },
      { id: "frost-giant", name: "Frost Giant", hp: 36 },
      { id: "white-wyrm", name: "White Wyrm", hp: 28, boss: true, slow: 3 },
    ],
  },
  {
    id: "ash", name: "The Ashlands", blurb: "Burnt land. Here the fights come in rounds: a set, a break, then the next set.",
    monsters: [
      // one set of 44 / 50 / 60 until Nov 2026
      { id: "ember-hound", name: "Ember Hound", rounds: [16, 16], hpBefore: 44, oneSetBefore: true },
      { id: "ash-knight", name: "Ash Knight", rounds: [19, 19], hpBefore: 50, oneSetBefore: true },
      { id: "burnt-king", name: "The Burnt King", rounds: [16, 16, 16], boss: true, hpBefore: 60, oneSetBefore: true },
    ],
  },
  {
    id: "spine", name: "Dragon's Spine", blurb: "The end of the map. The longest fights: up to four rounds of 20.",
    monsters: [
      // 30+30, 35x3 and 40x4 until Nov 2026
      { id: "ash-drake", name: "Ash Drake", rounds: [20, 20], hpBefore: 60 },
      { id: "stone-colossus", name: "Stone Colossus", rounds: [20, 20, 20], hpBefore: 105 },
      { id: "elder-dragon", name: "The Elder Dragon", rounds: [20, 20, 20, 20], boss: true, hpBefore: 160 },
    ],
  },
];
for (const z of ZONES) for (const m of z.monsters) if (m.rounds) m.hp = m.rounds.reduce((a, b) => a + b, 0);

// The mine: each floor is 3 rooms in a row, then a safe room. HP = 3 + 2 x floor + room.
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
const SLOW_IN_MINE = new Set(["Lantern Ghost", "Crystal Slime", "Mine Wraith", "Deep Wraith"]);
export const DUNGEON = {
  name: "The Old Mine",
  floors: FLOOR_NAMES.map((names, fi) => names.map((name, ri) => {
    const hp = 3 + 2 * (fi + 1) + ri;
    const slow = SLOW_IN_MINE.has(name) && (fi + 1 >= 6 ? RULES.slowHardSec : RULES.slowDownSec);
    return {
      id: `mine-${fi + 1}-${ri + 1}`,
      name,
      hp: slow ? Math.round(hp * RULES.specialHpMult) : hp,
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
// before: the rule as it was before areas changed to rounds (checks backups made back then).
export function startZoneFor(reps, { before = false } = {}) {
  let zi = 0;
  ZONES.forEach((z, i) => {
    const plain = z.monsters.filter(m => !m.slow && (!m.rounds || (before && m.oneSetBefore)))
      .map(m => (before && m.oneSetBefore ? m.hpBefore : m.hp));
    if (plain.length && Math.max(...plain) <= reps) zi = i;
  });
  return zi;
}

// The most HP a wanderer ever had: they take the HP of plain monsters, including ones that were plain before.
export const wanderHpEver = Math.max(...ZONES.flatMap(z => z.monsters)
  .filter(m => !m.slow && (!m.rounds || m.oneSetBefore)).map(m => Math.max(m.hp, m.hpBefore || 0)));

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
