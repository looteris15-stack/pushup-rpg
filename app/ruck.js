// Rucking: reading a GPX file and the effort math. No screens here, so all of it is easy to test.
// Effort = pack weight × distance, in kg·km. XP comes from effort (RULES.ruckXpPerKgKm).
// Only a ruck's summary is ever kept (start, end, km, time, kg, climb), never its map points: a GPX
// file shows where you walked, often starting at home.
import { RULES } from "./data.js";

const fail = msg => Object.assign(new Error(msg), { friendly: msg });
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

// distance in meters between two { lat, lon } points (haversine)
const R_EARTH = 6371008.8;
const rad = d => d * Math.PI / 180;
export function metersBetween(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

// GPX text -> [{ lat, lon, t, ele, seg }], in file order. t: ms (null when the file has no usable times),
// ele: meters or null, seg: which track segment the point is in (no distance is counted between segments).
// hr (heart rate, beats a minute) and cad (cadence: steps a minute with ONE foot, as watches write it) come
// from the point's extensions when the watch wrote them, else null. They are found by name at any depth,
// whatever prefix the app used (Zepp writes ns3:hr, other apps gpxtpx:hr or gpxdata:hr).
// A track (trk) is what Strava and watches export; a planned route (rte) is read too, but has no times.
export function parseGpx(text) {
  let doc = null;
  try { doc = new DOMParser().parseFromString(String(text || ""), "application/xml"); } catch {}
  if (!doc || doc.getElementsByTagName("parsererror").length || doc.documentElement?.localName !== "gpx") {
    throw fail("That file isn't a GPX file, or it is damaged.");
  }
  const childText = (el, name) => { for (const c of el.children) if (c.localName === name) return c.textContent.trim(); return null; };
  // a number from the extensions: the first tag with one of these names, at any depth
  const extNumber = (el, names, lo, hi) => {
    for (const n of names) {
      const x = el.getElementsByTagNameNS("*", n)[0];
      if (x) { const v = parseFloat(x.textContent); return v >= lo && v <= hi ? v : null; }
    }
    return null;
  };
  const points = [];
  const add = (el, seg) => {
    const lat = parseFloat(el.getAttribute("lat")), lon = parseFloat(el.getAttribute("lon"));
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return; // also drops NaN
    const ts = childText(el, "time"), es = childText(el, "ele");
    const t = ts ? Date.parse(ts) : NaN, ele = es ? parseFloat(es) : NaN;
    const ext = el.getElementsByTagNameNS("*", "extensions")[0];
    points.push({ lat, lon, t: Number.isFinite(t) ? t : null, ele: Number.isFinite(ele) ? ele : null, seg,
      hr: ext ? extNumber(ext, ["hr", "heartrate"], 25, 250) : null, cad: ext ? extNumber(ext, ["cad", "cadence"], 1, 150) : null });
  };
  const segs = [...doc.getElementsByTagNameNS("*", "trkseg")];
  if (segs.length) segs.forEach((s, i) => { for (const p of s.getElementsByTagNameNS("*", "trkpt")) add(p, i); });
  else for (const p of doc.getElementsByTagNameNS("*", "rtept")) add(p, 0);
  // times are used only when every point has one and they never go backwards; otherwise none are
  const timed = points.length > 0 && points.every((p, i) => p.t != null && (i === 0 || p.t >= points[i - 1].t));
  if (!timed) for (const p of points) p.t = null;
  return points;
}

// The walk in a list of points: { km, mins, start, end, climb, fastKm, timed }.
// - GPS points wobble a few meters even when you stand still, which adds up to a lot over an hour. So a
//   point only counts once it is RULES.ruckStepM away from the last point that counted.
// - Speed is judged over about RULES.ruckWindowSec, not point to point: one-second points wobble, and
//   normal walking would look "too fast" now and then.
// - Moving: between ruckMinKmh and ruckMaxKmh. Slower is a break (no km, no time). Faster is a car or a
//   GPS jump: not counted, but added up in fastKm so a car ride can be refused.
// - Climb: all the uphill, ignoring up-downs smaller than RULES.ruckClimbStepM. GPS height is noisy, so it is
//   first averaged over RULES.ruckClimbSmoothSec, half before and half after each point. A best guess, not
//   measured: two real Zepp walks of the same route read 369 and 347 m up without it, 210 and 208 m with 60 s
//   (the closest pair of the settings tried). The watch app's own climb would tell which is right.
// - Holes: a part longer than RULES.ruckHoleSec where the watch recorded nothing, but you moved (the GPS was
//   lost, or the watch stopped recording). Its km is the straight line across it (the real path was longer)
//   and its time counts as moving. holes: [{ at, mins, km }] (at: ms from the start), shown on the check card
//   so you can fix the km. A km with part of a hole in it has no split time (null).
// km and mins are null-free numbers; mins, start and end are null when the file has no times.
// For the ruck report (files with times only; each is null when the watch didn't record it):
// - hrAvg: average heart rate while moving, hrMax: the highest anywhere.
// - spm: steps a minute while moving. Watches write cadence for one foot, so it is doubled (checked on a real
//   Zepp file: 14.5 km in about 20,700 steps is 0.7 m a step). steps: spm × moving time, so a few points
//   without cadence don't lose steps.
// - Heart rate and steps count only when the watch recorded them for at least RULES.ruckSensorShare of the
//   moving time (a real Zepp file stopped both after 16 of 169 minutes). Otherwise they are null, and
//   hrOnlyMins / cadOnlyMins say for how many minutes they were recorded.
// - splits: seconds each full km took (moving time only, the same km as the total), at most RULES.ruckSplitsMax.
// - chart: { hr, ele }, RULES.ruckChartPoints averages over the whole time from start to end (null where
//   there was no data), for the heart rate and height lines of the report.
// Heart rate and steps are shown only: XP stays pack kg × km.
export function summarizeTrack(points) {
  if (!Array.isArray(points) || points.length < 2) throw fail("That file has fewer than 2 GPS points, so there is no walk in it.");
  const timed = points.every(p => p.t != null);
  const kept = [];
  for (const p of points) {
    const last = kept[kept.length - 1];
    if (!last || p.seg !== last.seg || metersBetween(last, p) >= RULES.ruckStepM) kept.push(p);
  }
  let km = 0, ms = 0, fastKm = 0;
  const moving = [], splits = [], holes = []; // moving: [from, to] times of the moving stretches, in order
  if (!timed) {
    for (let i = 1; i < kept.length; i++) if (kept[i].seg === kept[i - 1].seg) km += metersBetween(kept[i - 1], kept[i]) / 1000;
  } else {
    const windowMs = RULES.ruckWindowSec * 1000, holeMs = RULES.ruckHoleSec * 1000;
    // holes are found in the recording itself, not in the kept points: standing still on a break also leaves
    // no kept points for a while, but the watch still records
    const gaps = [];
    for (let n = 1; n < points.length; n++) if (points[n].seg === points[n - 1].seg && points[n].t - points[n - 1].t > holeMs) gaps.push([points[n - 1].t, points[n].t]);
    let i = 0, splitM = 0, splitMs = 0, splitHole = false; // meters and moving time since the last full km
    while (i < kept.length - 1) {
      // one stretch: from point i until about windowMs have passed (or the segment ends)
      let j = i, dist = 0;
      while (j < kept.length - 1 && kept[j + 1].seg === kept[i].seg) {
        dist += metersBetween(kept[j], kept[j + 1]);
        j++;
        if (kept[j].t - kept[i].t >= windowMs) break;
      }
      if (j === i) { i++; continue; } // the next point is in a new segment
      const hole = gaps.some(([a, b]) => a >= kept[i].t && b <= kept[j].t);
      const dt = kept[j].t - kept[i].t;
      const kmh = dt > 0 ? (dist / 1000) / (dt / 3600e3) : Infinity;
      if (kmh > RULES.ruckMaxKmh) fastKm += dist / 1000;
      else if (kmh >= RULES.ruckMinKmh) {
        km += dist / 1000; ms += dt;
        moving.push([kept[i].t, kept[j].t]);
        if (hole) holes.push({ at: kept[i].t - points[0].t, mins: Math.round(dt / 60000), km: round(dist / 1000, 2) });
        // km splits: a km that ends inside this stretch gets its share of the stretch's time
        // (a km with part of a hole in it has no real time: null)
        let d = dist, tt = dt;
        if (hole) splitHole = true;
        while (splitM + d >= 1000) {
          const part = tt * (1000 - splitM) / d;
          splits.push(splitHole ? null : Math.round((splitMs + part) / 1000));
          d -= 1000 - splitM; tt -= part; splitM = 0; splitMs = 0;
          splitHole = hole && d > 0;
        }
        splitM += d; splitMs += tt;
      }
      i = j;
    }
  }
  // climb from the height averaged over about ruckClimbSmoothSec (just the height itself in a file with no times)
  const withEle = points.filter(p => p.ele != null);
  let heights = withEle.map(p => p.ele);
  if (timed && withEle.length) {
    const half = RULES.ruckClimbSmoothSec * 500;
    let a = 0, b = 0, sum = 0;
    heights = withEle.map(p => {
      while (b < withEle.length && withEle[b].t <= p.t + half) sum += withEle[b++].ele;
      while (withEle[a].t < p.t - half) sum -= withEle[a++].ele;
      return sum / (b - a);
    });
  }
  let climb = null, ref = null;
  for (const h of heights) {
    if (ref == null) { ref = h; climb = 0; continue; }
    if (h - ref >= RULES.ruckClimbStepM) { climb += h - ref; ref = h; }
    else if (ref - h >= RULES.ruckClimbStepM) ref = h;
  }
  const out = {
    km: round(km, 2),
    mins: timed ? Math.round(ms / 60000) : null,
    start: timed ? points[0].t : null,
    end: timed ? points[points.length - 1].t : null,
    climb: climb == null ? null : Math.round(climb),
    fastKm: round(fastKm, 2),
    timed,
    holes,
    hrAvg: null, hrMax: null, spm: null, steps: null, hrOnlyMins: null, cadOnlyMins: null, splits: null, chart: null,
  };
  if (!timed) return out;
  // heart rate and cadence while moving: each point stands for the time since the one before it (long gaps
  // in the recording, and breaks, don't count). Covered: moving time with a reading in the last ruckGapSec
  // (some watches write heart rate only every few seconds).
  const gapMs = RULES.ruckGapSec * 1000;
  let hrSum = 0, hrMs = 0, hrMax = 0, cadSum = 0, cadMs = 0, k = 0, movMs = 0, hrCov = 0, cadCov = 0, lastHr = -Infinity, lastCad = -Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], dt = b.t - a.t;
    if (b.hr != null) { hrMax = Math.max(hrMax, b.hr); lastHr = b.t; }
    if (b.cad != null) lastCad = b.t;
    if (dt <= 0 || dt > gapMs) continue;
    const mid = (a.t + b.t) / 2;
    while (k < moving.length && moving[k][1] < mid) k++;
    if (k >= moving.length || moving[k][0] > mid) continue; // a break
    movMs += dt;
    if (b.t - lastHr <= gapMs) hrCov += dt;
    if (b.t - lastCad <= gapMs) cadCov += dt;
    if (b.hr != null) { hrSum += b.hr * dt; hrMs += dt; }
    if (b.cad != null) { cadSum += b.cad * dt; cadMs += dt; }
  }
  const enough = cov => movMs > 0 && cov >= RULES.ruckSensorShare * movMs;
  if (hrMs) {
    if (enough(hrCov)) { out.hrAvg = Math.round(hrSum / hrMs); out.hrMax = Math.round(hrMax); }
    else out.hrOnlyMins = Math.round(hrCov / 60000);
  }
  if (cadMs) {
    if (enough(cadCov)) { const spm = 2 * cadSum / cadMs; out.spm = Math.round(spm); out.steps = Math.round(spm * ms / 60000); }
    else out.cadOnlyMins = Math.round(cadCov / 60000);
  }
  out.splits = splits.some(s => s != null) ? splits.slice(0, RULES.ruckSplitsMax) : null;
  // the report's lines: averages over equal slices of the whole time
  const n = RULES.ruckChartPoints, span = Math.max(1, out.end - out.start);
  const acc = Array.from({ length: n }, () => ({ h: 0, hn: 0, e: 0, en: 0 }));
  for (const p of points) {
    const s = acc[Math.min(n - 1, Math.floor((p.t - out.start) / span * n))];
    if (p.hr != null) { s.h += p.hr; s.hn++; }
    if (p.ele != null) { s.e += p.ele; s.en++; }
  }
  const line = (sum, cnt) => (acc.some(s => s[cnt]) ? acc.map(s => (s[cnt] ? Math.round(s[sum] / s[cnt]) : null)) : null);
  const hrLine = out.hrAvg == null ? null : line("h", "hn"), eleLine = line("e", "en"); // too little heart rate: no line either
  if (hrLine || eleLine) out.chart = { hr: hrLine, ele: eleLine };
  return out;
}

// a track that is mostly too fast was a car ride (or the watch was left on in the car)
export const looksLikeCar = s => s.fastKm > RULES.ruckFastShare * (s.km + s.fastKm);

export const effortOf = (kg, km) => round(kg * km, 1); // kg·km
export const ruckXp = kgkm => Math.round(kgkm * RULES.ruckXpPerKgKm);

// Can this ruck go in the log? r: { t, end, km, kg, mins }. Returns what is wrong, or null.
// log: the rucks already logged (newest first). A ruck overlapping one of them in time is the same walk
// again (the same file twice, a Zepp and a Strava export of one walk, or typed by hand and then imported).
// When the log is full, a ruck older than its oldest can't be checked that way any more, so it is refused.
export function ruckProblem(r, log, nowMs) {
  const [kgLo, kgHi] = RULES.ruckKg, [kmLo, kmHi] = RULES.ruckKm;
  if (!(Number.isFinite(r.kg) && r.kg >= kgLo && r.kg <= kgHi)) return `Pack weight must be ${kgLo} to ${kgHi} kg.`;
  if (!(Number.isFinite(r.km) && r.km >= kmLo)) return `A ruck must be at least ${kmLo} km.`;
  if (r.km > kmHi) return `A ruck can be at most ${kmHi} km.`;
  if (!(Number.isFinite(r.mins) && r.mins >= 1)) return "How long did it take? It must be at least 1 minute.";
  if (r.mins > RULES.ruckMaxHours * 60) return `A ruck can take at most ${RULES.ruckMaxHours} hours.`;
  if (r.km / (r.mins / 60) > RULES.ruckMaxKmh) return `That is faster than ${RULES.ruckMaxKmh} km/h, too fast for a ruck.`;
  if (!(Number.isFinite(r.t) && Number.isFinite(r.end) && r.end > r.t)) return "The start and end time of the ruck are missing.";
  if (r.t > nowMs + 5 * 60000) return "That ruck starts in the future.";
  // a typo here can't be undone, and its time would then block the real ruck
  if (r.end > nowMs + 5 * 60000) return "That ruck ends in the future. Log it once you're back.";
  const same = log.find(x => r.t < x.end && x.t < r.end);
  if (same) return "You already logged a ruck at that time. The same walk can't count twice.";
  if (log.length >= RULES.ruckLogMax && r.t < Math.min(...log.map(x => x.t))) {
    return `Your log keeps your last ${RULES.ruckLogMax} rucks, and this one is older than all of them, so the game can't check it isn't one you already logged.`;
  }
  return null;
}

// the log entry for a ruck that passed ruckProblem; src: "gpx" (from a file) or "hand" (typed in)
// (effort from the rounded km and kg, so the sum on the check card adds up)
// From a file, the report's numbers come along when the watch recorded them: hrAvg, hrMax, spm, steps
// (always), and chart: { hr, ele, splits } (the game keeps charts only for the newest RULES.ruckChartsKept).
// Only measurements are kept: ranks and feats are worked out when the report is shown.
export function ruckEntry(r, src) {
  const km = round(r.km, 2), kg = round(r.kg, 1), kgkm = effortOf(kg, km);
  const e = {
    t: r.t, end: r.end, km, kg, kgkm, mins: Math.round(r.mins),
    climb: Number.isFinite(r.climb) && r.climb > 0 ? Math.round(r.climb) : 0, xp: ruckXp(kgkm), src: src === "gpx" ? "gpx" : "hand",
  };
  for (const k of ["hrAvg", "hrMax", "spm", "steps"]) if (Number.isFinite(r[k]) && r[k] > 0) e[k] = Math.round(r[k]);
  // bw: your body weight then (kg), for the ruck's rank (data.js ruckGrade); kept only when you gave it
  if (Number.isFinite(r.bw) && r.bw > 0) e.bw = round(r.bw, 1);
  const c = r.chart || {};
  const chart = { hr: c.hr || null, ele: c.ele || null, splits: r.splits || null };
  if (chart.hr || chart.ele || chart.splits) e.chart = chart;
  return e;
}
