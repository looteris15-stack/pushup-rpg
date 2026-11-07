// Body tracking, strict rep counting, camera and sounds.
// The pose math and rep rules are the same ones tuned in ../counter-test.

const LIB = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODELS = {
  full: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
  lite: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
};

// MediaPipe pose landmark indexes for each body side
export const IDX = {
  L: { sh: 11, el: 13, wr: 15, hip: 23, kn: 25, an: 27 },
  R: { sh: 12, el: 14, wr: 16, hip: 24, kn: 26, an: 28 },
};
const CONN = [[11,12],[11,23],[12,24],[23,24],[11,13],[13,15],[12,14],[14,16],[23,25],[25,27],[24,26],[26,28],[27,31],[28,32]];

// ---------- pose math (pure) ----------

function angleAt(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
  const d = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (!d) return 180;
  return Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / d))) * 180 / Math.PI;
}

// lm: normalized landmarks, w/h: video size in pixels (angles must be measured in pixels)
export function analyzePose(lm, w, h, prevSide) {
  const vis = l => l.visibility ?? 1;
  const sideVis = s => { const i = IDX[s]; return (vis(lm[i.sh]) + vis(lm[i.el]) + vis(lm[i.wr]) + vis(lm[i.hip]) + vis(lm[i.kn]) + vis(lm[i.an])) / 6; };
  const vL = sideVis("L"), vR = sideVis("R");
  // use the side facing the camera; only switch when the other side is clearly better
  let side = prevSide || (vL >= vR ? "L" : "R");
  if (side === "L" && vR > vL + 0.15) side = "R";
  else if (side === "R" && vL > vR + 0.15) side = "L";
  const i = IDX[side];
  const P = k => ({ x: lm[i[k]].x * w, y: lm[i[k]].y * h });
  const sh = P("sh"), el = P("el"), wr = P("wr"), hip = P("hip"), kn = P("kn"), an = P("an");

  const elbow = angleAt(sh, el, wr);
  const bodyBend = 180 - angleAt(sh, hip, an);
  // is the hip below (sag) or above (pike) the shoulder–ankle line? image y grows downward
  const t = an.x === sh.x ? 0.5 : (hip.x - sh.x) / (an.x - sh.x);
  const bendDir = hip.y > sh.y + (an.y - sh.y) * t ? "sag" : "pike";
  const knee = angleAt(hip, kn, an);
  const tilt = Math.abs(Math.atan2(an.y - sh.y, an.x - sh.x) * 180 / Math.PI);
  const fromHorizontal = Math.min(tilt, 180 - tilt);
  return {
    side, elbow, bodyBend, bendDir, knee, fromHorizontal,
    horizontal: fromHorizontal < 40,
    visible: (side === "L" ? vL : vR) >= 0.5,
  };
}

// "Slow reps" time of a rep (or of one still going down): from straight arms to arriving at the bottom
// (first moment within 3° of the lowest angle so far), so a pause at the bottom doesn't count.
// Measuring only the middle of the way down timed about half of a real rep and turned honest 2 s reps
// into "too fast". The live depth meter uses this too, so what it shows is what gets judged.
export function downSecsOf(c) {
  const low = c.trace.find(p => p.e <= c.minElbow + 3);
  return low ? +((low.t - c.topAt) / 1000).toFixed(1) : null;
}

// Unseen for longer than this in the middle of a rep (after leaving the top), and that rep doesn't count:
// the bad part (knees down, hips up) could be hidden in the gap. Honest reps in the user's two recorded
// fights had no gap at all; brief camera hitches (up to ~260 ms seen while setting up) still pass.
// Outside a rep, the 800 ms "lost" limit below is unchanged.
const GAP_IN_REP_MS = 300;

// A rep still going down (or held at the bottom) after this long is dropped: it would only keep collecting
// frames (lying on the floor, or the phone left on). Real slow reps take a few seconds. After that the arms
// must be straight again before a new rep can start, so staying down doesn't start the next 60 s at once.
const MAX_REP_MS = 60000;

// Rep = arms locked out -> elbows at depth -> locked out again, with body and legs straight the whole way.
export function createRepCounter(getCfg) {
  // topAt: last moment the arms were straight (elbow >= top), where a slow rep's clock starts
  let state = "idle", cycle = null, count = 0, lostSince = 0, topAt = 0;
  const summary = (c, t) => ({
    minElbow: Math.round(c.minElbow), maxBend: Math.round(c.maxBend), bendDir: c.bendDir,
    minKnee: Math.round(c.minKnee), secs: +((t - c.t0) / 1000).toFixed(1),
    depth: c.depth, downSecs: downSecsOf(c),
  });

  function update(m, t) {
    const cfg = getCfg();
    const ev = [];
    const setState = s => { state = s; ev.push({ type: "state", state: s }); };
    // a rep in progress was unseen too long: cancel it. The player starts again from "idle", so the very
    // next frame with straight arms in plank is ready for a new rep (no need to stand up or reset).
    const cancelForGap = () => {
      ev.push({ type: "norep", reasons: ["Keep your body in view"], gap: true, ...summary(cycle, t) });
      cycle = null;
      setState("idle");
    };

    if (!m || !m.visible) {
      if (!lostSince) lostSince = t;
      if (state === "down" && cycle && t - lostSince > GAP_IN_REP_MS) cancelForGap();
      if (t - lostSince > 800 && state !== "lost") {
        if (cycle && cycle.depth) ev.push({ type: "norep", reasons: ["Lost sight of you"], ...summary(cycle, t) });
        cycle = null;
        setState("lost");
      }
      return ev;
    }
    // seen again: a gap longer than the limit inside a rep (even if no unseen frame was late enough to
    // notice it, e.g. at a low frame rate) also cancels that rep
    if (lostSince && state === "down" && cycle && t - lostSince > GAP_IN_REP_MS) cancelForGap();
    lostSince = 0;
    if (state === "lost") setState("idle");

    if (state === "idle") {
      if (m.horizontal && m.knee >= cfg.knee && m.elbow >= cfg.top) { topAt = t; setState("up"); }
    } else if (state === "up") {
      if (m.elbow >= cfg.top) topAt = t;
      if (!m.horizontal) setState("idle");
      else if (m.elbow < cfg.top - 15) {
        cycle = { t0: t, topAt: topAt || t, trace: [{ t, e: m.elbow }], minElbow: m.elbow, maxBend: m.bodyBend, bendDir: m.bendDir, minKnee: m.knee, depth: false };
        setState("down");
      }
    } else if (state === "down") {
      const c = cycle;
      if (t - c.t0 > MAX_REP_MS) {
        ev.push({ type: "norep", reasons: ["Took too long"], expired: true, ...summary(c, t) });
        cycle = null;
        setState("idle");
        return ev;
      }
      c.trace.push({ t, e: m.elbow });
      c.minElbow = Math.min(c.minElbow, m.elbow);
      if (m.bodyBend > c.maxBend) { c.maxBend = m.bodyBend; c.bendDir = m.bendDir; }
      c.minKnee = Math.min(c.minKnee, m.knee);
      if (!c.depth && m.elbow <= cfg.depth) { c.depth = true; c.depthAt = t; ev.push({ type: "depth" }); }

      if (!m.horizontal) {
        if (c.depth) ev.push({ type: "norep", reasons: ["Left plank position"], ...summary(c, t) });
        cycle = null;
        setState("idle");
      } else if (m.elbow >= cfg.top) {
        const reasons = [];
        if (!c.depth) reasons.push("Go lower");
        if (c.maxBend > cfg.bend) reasons.push(c.bendDir === "sag" ? "Hips sagging" : "Hips too high");
        if (c.minKnee < cfg.knee) reasons.push("Keep legs straight");
        const s = summary(c, t);
        if (!c.depth && c.minElbow > cfg.top - 30) {
          // small wobble at the top, not a rep attempt
        } else if (reasons.length === 0) {
          count++;
          ev.push({ type: "rep", count, ...s });
        } else {
          ev.push({ type: "norep", reasons, ...s });
        }
        cycle = null;
        topAt = t;
        setState("up");
      }
    }
    return ev;
  }

  return {
    update,
    reset() { state = "idle"; cycle = null; count = 0; lostSince = 0; topAt = 0; },
    get count() { return count; },
    get state() { return state; },
    get cycle() { return cycle; },
    get topAt() { return topAt; },
  };
}

// ---------- sound ----------

export const audio = { on: true, voice: true };
// The browser's audio engine keeps working (and using battery) while it is awake, even in silence.
// So it is only made or woken when sound is on, and put to sleep when the game goes quiet.
let actx = null;
let sleepTimer = 0, sleepMin = 0; // a sleep waiting for the last sound to finish
let soundsEnd = 0;                // engine time when the last sound played so far ends

export function initAudio() {
  if (!audio.on) { quietAudio(); return; }
  clearTimeout(sleepTimer); sleepTimer = 0; // a new fight right after the last one: keep the engine awake
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state !== "running") actx.resume().catch(() => {});
  } catch {}
}

// Puts the audio engine to sleep: at once (ms = 0: Back before the fight, Sound off), or after at least
// ms and only once the last sound has played out (the end of a fight: the win or loss sound).
export function quietAudio(ms = 0) {
  clearTimeout(sleepTimer); sleepTimer = 0;
  if (!actx) return;
  const sleep = () => { sleepTimer = 0; if (actx.state === "running") actx.suspend().catch(() => {}); };
  if (ms <= 0) { sleep(); return; }
  sleepMin = ms;
  sleepTimer = setTimeout(sleep, Math.max(ms, (soundsEnd - actx.currentTime) * 1000 + 100));
}

function tone(freq, dur, type = "sine", gain = 0.25, when = 0, slideTo = 0) {
  if (!actx || !audio.on) return;
  const t = actx.currentTime + when;
  soundsEnd = Math.max(soundsEnd, t + dur + 0.02);
  if (sleepTimer) quietAudio(sleepMin); // a sound while a sleep waits: sleep only after it has played
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(actx.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

export const sfx = {
  hit() { tone(190, 0.18, "square", 0.2, 0, 55); tone(950, 0.06, "triangle", 0.14); },
  depth() { tone(1500, 0.05, "sine", 0.12); },
  // slow monsters: you've gone down long enough, reaching the bottom now counts
  slowOk() { tone(660, 0.07, "sine", 0.12); tone(990, 0.09, "sine", 0.12, 0.07); },
  norep() { tone(140, 0.16, "sawtooth", 0.16); tone(105, 0.24, "sawtooth", 0.16, 0.17); },
  tick() { tone(880, 0.07, "square", 0.1); },
  start() { tone(330, 0.12, "triangle", 0.2); tone(660, 0.18, "triangle", 0.2, 0.12); },
  win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.2, "triangle", 0.2, i * 0.11)); },
  levelUp() { [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.22, "sine", 0.18, 0.5 + i * 0.09)); },
  lose() { [392, 330, 262, 196].forEach((f, i) => tone(f, 0.3, "sawtooth", 0.14, i * 0.18)); },
};

export function say(text) {
  if (!text || !audio.on || !audio.voice || !("speechSynthesis" in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.15;
    u.lang = "en-US";
    speechSynthesis.speak(u);
  } catch {}
}

export function hush() {
  try { speechSynthesis.cancel(); } catch {}
}

// ---------- camera + tracking ----------

const friendly = msg => Object.assign(new Error(msg), { friendly: msg });

// Can the phone keep the screen on? Asks once and lets go right away. false = refused (often battery
// saver), null = this browser can't say. Asked before a fight, because a screen that turns off mid-set
// now counts as leaving the game.
export async function canKeepAwake() {
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return null;
  try { const l = await navigator.wakeLock.request("screen"); l.release().catch(() => {}); return true; }
  catch { return false; }
}

// every outside file that body tracking needs, so the installed app can keep them for offline use
export async function trackingFiles(name) {
  const { FilesetResolver } = await import(LIB);
  const files = await FilesetResolver.forVisionTasks(WASM);
  return [LIB, files.wasmLoaderPath, files.wasmBinaryPath, MODELS[name] || MODELS.full];
}

// Time limit for the app's own part of a fight start: from the moment the camera is allowed (the
// permission question is the player's part, no limit: Back works the whole time) until the fight is
// ready. Measured cold starts (Full model, nothing saved yet, _tests\bench.ps1) took 11-19 s on a PC
// and 22-26 s with a phone-like 4x slower CPU and 9 Mbit/s; 60 s covers that more than twice, or the
// ~11 MB first download (WASM + Full model) on about 2 Mbit/s. The first inference can't be cut short
// (it blocks the page), so the clock is checked when it returns: past the limit, the start fails too.
const START_BUDGET_MS = 60000;
let startBudget = START_BUDGET_MS;

// automated tests (game.js ?debug) can swap in a slow fake model loader or a short time limit;
// players always get the real ones
let modelLoader = name => loadPoseLandmarker(name);
export const testHooks = {
  setModelLoader(fn) { modelLoader = fn || (name => loadPoseLandmarker(name)); },
  setStartBudget(ms) { startBudget = ms > 0 ? ms : START_BUDGET_MS; },
};

async function loadPoseLandmarker(name) {
  const url = MODELS[name] || MODELS.full;
  // the model download starts at once, alongside the library and its WASM start-up, and is read once:
  // the GPU try and the CPU fallback both get these same bytes
  let failed = null;
  const bytes = fetch(url)
    .then(r => { if (!r.ok) throw new Error(`Failed to fetch model: ${url} (${r.status})`); return r.arrayBuffer(); })
    .then(b => new Uint8Array(b));
  bytes.catch(e => { failed = e; });
  const { PoseLandmarker, FilesetResolver } = await import(LIB);
  const files = await FilesetResolver.forVisionTasks(WASM);
  // the library asks for the model only once its WASM is up; this hands it the downloaded bytes then
  const model = () => {
    let given = false;
    return { async read() { if (given) return { done: true, value: undefined }; given = true; return { done: false, value: await bytes }; }, releaseLock() {}, cancel() {} };
  };
  const opts = d => ({
    baseOptions: { modelAssetBuffer: model(), delegate: d },
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    return { lm: await PoseLandmarker.createFromOptions(files, opts("GPU")), used: "GPU" };
  } catch (e) {
    if (failed) throw failed; // the download failed: the CPU can't help
    console.warn("GPU tracking failed, using CPU", e);
    return { lm: await PoseLandmarker.createFromOptions(files, opts("CPU")), used: "CPU" };
  }
}

// onEvent(ev): rep counter events. onFrame(m): pose measurements each frame (null = no body found).
export function createTracker({ video, canvas, frame, getCfg, onEvent, onFrame }) {
  const ctx = canvas.getContext("2d");
  const counter = createRepCounter(getCfg);
  const css = getComputedStyle(document.documentElement);
  const C = Object.fromEntries(["fg", "good", "bad", "warn"].map(k => [k, css.getPropertyValue("--" + k).trim()]));
  let landmarker = null, loading = null, modelName = "", delegate = "";
  let stream = null, rafId = 0, lastVideoTime = -1, side = null, running = false, wakeLock = null;
  let frames = 0, fpsT = 0, fps = 0;
  const sm = {};

  // Body tracking: a load of the asked type that is still going is shared, and a ready model is kept for
  // later fights. modelGen: the newest request. Only it may install its model (and its delegate) or end
  // the pending load. Whoever still waits for an older request gets the newest one's answer instead (its
  // model, or its error at once). A model that arrives for an older request is closed; so is the
  // installed model when another type is asked for.
  let modelGen = 0;
  const closeModel = lm => { try { lm?.close(); } catch {} };
  function ensureModel(name) {
    if (name === modelName && landmarker) return Promise.resolve(landmarker);
    if (name === modelName && loading) return loading.promise;
    const g = ++modelGen;
    modelName = name;
    closeModel(landmarker);
    landmarker = null;
    const older = loading;
    const mine = {};
    mine.promise = new Promise((res, rej) => { mine.res = res; mine.rej = rej; });
    loading = mine;
    older?.res(mine.promise); // those waiting for the older request now wait for this one
    modelLoader(name).then(({ lm, used }) => {
      if (g !== modelGen) { closeModel(lm); return; } // too late: a newer request counts
      landmarker = lm; delegate = used; loading = null;
      mine.res(lm);
    }, err => {
      console.error(err);
      if (g !== modelGen) return;
      loading = null;
      mine.rej(err);
    });
    return mine.promise;
  }
  // a start that ran out of time lets go of a load still going: the retry starts a fresh one, and the
  // late model is closed when it comes
  function dropPendingModel(err) {
    const l = loading;
    if (!l) return;
    loading = null; modelGen++; modelName = "";
    l.rej(err);
  }

  function setDims() {
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return;
    canvas.width = w;
    canvas.height = h;
    frame.style.setProperty("--ar", `${w} / ${h}`);
    frame.style.setProperty("--ar-num", String(w / h));
  }
  video.addEventListener("loadedmetadata", setDims);
  video.addEventListener("resize", setDims);

  // Who owns what, so nothing that arrives late is used by the wrong fight or kept on by mistake:
  // - session: one startCamera() until stop(). A start whose session ended (Back) gives up.
  // - camGen: one camera request. Hiding the app or stop() makes it old: a camera that arrives for an old
  //   request (or while hidden) is switched off without being shown.
  // - lockGen: one screen-lock request, made old the same way: a lock that arrives late is let go.
  // paused: the app is hidden (camera, loop and lock all off). Hiding and coming back don't end the session,
  // so a start that was interrupted carries on and opens a fresh camera when the app is visible again.
  let session = 0, camGen = 0, lockGen = 0, paused = false, starting = false, facingNow = "user";
  const tracking = () => running && !paused;
  const liveStream = () => !!stream && stream.getTracks().some(t => t.readyState === "live");
  // waits for the next hide, return or stop()
  let waiters = [];
  const changed = () => new Promise(r => waiters.push(r));
  function notify() { const w = waiters; waiters = []; w.forEach(r => r(false)); }
  let onFirstFrame = null; // set while a start waits for its first frame through body tracking

  // awake: did the phone agree to keep the screen on? (battery saver can refuse; null = not asked yet)
  let awake = null;
  function letGoAwake() { const l = wakeLock; wakeLock = null; try { l?.release().catch(() => {}); } catch {} }
  async function keepAwake() {
    const visible = () => tracking() && document.visibilityState === "visible";
    if (!visible()) return awake; // no fight being tracked on a visible screen: don't ask
    const g = ++lockGen;
    let lock;
    try { lock = await navigator.wakeLock.request("screen"); }
    catch { if (g === lockGen) awake = "wakeLock" in navigator ? false : null; return awake; }
    // a newer request, a hide or the end of the fight came while the phone was answering: let it go
    if (g !== lockGen || !visible()) { try { lock.release().catch(() => {}); } catch {} return awake; }
    letGoAwake();
    wakeLock = lock;
    awake = true;
    return awake;
  }

  function stopStream() {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    video.pause();
    video.srcObject = null;
  }
  // switches off one camera stream; the video lets go of it only if it is still showing that one
  function stopOwn(s) {
    if (!s) return;
    s.getTracks().forEach(t => t.stop());
    if (stream === s) stopStream();
  }
  function openCamera(facing) {
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  }
  function showStream(s) {
    stopStream();
    stream = s;
    video.srcObject = s;
    video.muted = true;
  }
  // The pace: at most 30 inferences a second, each on a camera frame not tracked yet. requestVideoFrameCallback
  // says when a new frame has arrived (a live camera's currentTime moves on every screen frame, so it can't
  // tell); without it, currentTime is the only check. Two inferences are never closer than about 1/30 s, so a
  // faster camera's extra frames are skipped and a late frame is never followed by a quick catch-up; a 30 fps
  // camera still gets every frame tracked.
  const STEP_MS = 1000 / 30;
  const watchesFrames = typeof video.requestVideoFrameCallback === "function";
  let lastRun = -Infinity, frameNo = 0, doneFrame = -1;
  if (watchesFrames) { const seen = () => { frameNo++; video.requestVideoFrameCallback(seen); }; video.requestVideoFrameCallback(seen); }
  const newFrame = () => video.currentTime !== lastVideoTime && (!watchesFrames || frameNo !== doneFrame);
  function startLoop() {
    cancelAnimationFrame(rafId);
    fpsT = performance.now();
    frames = 0;
    lastRun = -Infinity; // the first frame goes at once (a start waits for it)
    doneFrame = -1;      // even if no new frame has been seen yet: the picture there now
    loop();
  }

  // Opens the camera for this session and shows it. Returns null (and never shows it) when the camera
  // arrives after a hide, a newer request or stop(); the same if that happens while the picture starts.
  // A request made old that fails (e.g. AbortError after a hide) isn't this start's error: null too.
  // A picture that can't play is switched off and let go before the error goes on.
  async function attachCamera(my, granted = null) {
    const g = ++camGen;
    const mine = () => g === camGen && my === session && !paused;
    let s;
    try { s = await openCamera(facingNow); } catch (e) { if (mine()) throw e; return null; }
    if (my === session) granted?.(); // the camera was allowed: from here on it's the app's own time
    if (!mine()) { s.getTracks().forEach(t => t.stop()); return null; }
    showStream(s);
    try { await video.play(); } catch (e) { stopOwn(s); if (mine()) throw e; return null; }
    if (!mine()) { stopOwn(s); return null; }
    lastVideoTime = -1;
    resetSmooth();
    return s;
  }
  const cameraError = e => e.friendly ? e
    : e.name === "NotAllowedError" ? friendly("Camera permission was blocked. Allow the camera for this site in the browser settings, then try again.")
    : e.name === "NotFoundError" || e.name === "OverconstrainedError" ? friendly("No camera found.")
    : friendly("Could not start the camera: " + (e.message || e.name));

  // token: { cancelled } set by the game when the player taps Back during startup. Whatever arrives
  // after that (a late camera, a finished model, a screen lock) is switched off and ignored instead of
  // starting a fight. Resolves only when the fight can really begin: visible, a live camera, and one
  // frame already through body tracking. Once the camera is allowed the start has startBudget ms (the
  // picture starting, body tracking, the first inference); when they run out it fails with a "try again"
  // error (retry: true) and leaves nothing on.
  const cancelled = () => Object.assign(new Error("Startup was cancelled."), { cancelled: true });
  const tooSlow = () => Object.assign(friendly("Body tracking took too long to start. Check the internet connection, then try again."), { retry: true });
  // after the next frame is painted (a timer set in a frame callback runs once that frame is on screen)
  const afterPaint = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
  async function startCamera(facing, model, token = null) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw friendly(window.isSecureContext
        ? "This browser cannot use the camera. Try Chrome."
        : "The camera only works on an https:// link. Open the https address.");
    }
    stop();
    const my = ++session;
    const stale = () => my !== session || !!token?.cancelled;
    starting = true;
    paused = document.visibilityState === "hidden";
    facingNow = facing;
    frame.classList.toggle("mirror", facing === "user");
    // the time limit starts when the camera is allowed (the permission question is the player's time)
    let timer = 0, clockAt = -1, timeUp = null;
    const late = new Promise((_, rej) => { timeUp = () => rej(tooSlow()); });
    late.catch(() => {});
    const startClock = () => { if (clockAt < 0) { clockAt = performance.now(); timer = setTimeout(timeUp, startBudget); } };
    const inTime = p => Promise.race([p, late]);
    try {
      // 1. the camera first, so its permission question comes before body tracking downloads. Stay here
      //    until the camera is allowed (that starts the clock): a request made old by a hide that fails
      //    is followed by a fresh one once the app is visible.
      while (clockAt < 0) {
        if (stale()) throw cancelled();
        if (paused) { await changed(); continue; }
        try { await inTime(attachCamera(my, startClock)); } // the grant starts the clock: play() is timed
        catch (e) { if (stale()) throw cancelled(); if (e.retry) throw e; throw cameraError(e); }
      }
      if (stale()) throw cancelled();
      // 2. body tracking
      try { await inTime(ensureModel(model)); }
      catch (e) {
        if (stale()) throw cancelled();
        if (e.retry) { dropPendingModel(e); throw e; }
        throw friendly("Could not load body tracking. Check the internet connection and try again.");
      }
      if (stale()) throw cancelled();
      counter.reset();
      side = null;
      running = true;
      // 3. ready when visible, with a live camera, the screen lock asked for, and one frame tracked.
      //    Hidden on the way: wait for the app to come back, then open a fresh camera.
      for (;;) {
        if (stale()) throw cancelled();
        if (paused) { await inTime(changed()); continue; }
        if (!liveStream()) {
          try { await inTime(attachCamera(my, startClock)); } catch (e) { if (stale()) throw cancelled(); if (e.retry) throw e; throw cameraError(e); }
          continue;
        }
        await inTime(Promise.race([keepAwake(), changed()]));
        if (stale()) throw cancelled();
        if (paused || !liveStream()) continue;
        // let the startup screen and the camera picture show first: the first inference can hold the page
        // for seconds (the GPU getting ready), and nothing can interrupt it once it runs
        await inTime(Promise.race([afterPaint(), changed()]));
        if (stale()) throw cancelled();
        if (paused || !liveStream()) continue;
        const first = new Promise(r => { onFirstFrame = r; }); // before startLoop(): its first frame can be tracked at once
        startLoop();
        const tracked = await inTime(Promise.race([first, changed()]));
        onFirstFrame = null;
        // the first inference blocks the page, so the time-out can't run while it does: check the clock
        // when it returns, before the fight (and its timer) can start
        if (tracked && clockAt >= 0 && performance.now() - clockAt >= startBudget) throw tooSlow();
        if (tracked) break;
      }
    } catch (e) {
      if (my === session) stop(); // a failed start leaves nothing on (a cancelled one was stopped already)
      throw e;
    } finally {
      clearTimeout(timer);
      if (my === session) starting = false;
    }
  }

  // The app was hidden (another app, screen locked): camera, tracking and screen lock go off right away.
  // The game calls resume() when it comes back and the fight (or break) goes on.
  function pause() {
    paused = true;
    camGen++;
    lockGen++;
    cancelAnimationFrame(rafId);
    rafId = 0;
    stopStream();
    letGoAwake();
    notify();
  }
  async function resume() {
    if (!paused) return;
    paused = false;
    notify();
    if (!running || starting) return; // nothing tracked, or a start still going (it opens its own camera)
    const my = session;
    let s = null;
    try { s = await attachCamera(my); } catch { return; } // no camera now: the fight's timers decide
    if (!s || my !== session || !tracking()) return;
    await keepAwake();
    // still this return's camera? (hidden and back again meanwhile: the newer return starts the loop)
    if (my !== session || !tracking() || stream !== s || !liveStream()) return;
    startLoop();
  }

  // A break (between mine rooms or boss rounds): the camera, its picture and the screen lock stay on, but
  // no body tracking runs (no inference, rep counting or drawing) until hold(false) starts the next set.
  // Hidden and back during a break, resume() brings the camera back but tracking stays off.
  let held = false;
  const processing = () => tracking() && !held;
  function hold(on) {
    held = !!on;
    if (held) { cancelAnimationFrame(rafId); rafId = 0; ctx.clearRect(0, 0, canvas.width, canvas.height); }
    else if (tracking() && liveStream()) { side = null; resetSmooth(); startLoop(); }
  }

  function stop() {
    session++; // a start still waiting for something gives up
    camGen++;  // a camera or screen lock still on its way is switched off when it arrives
    lockGen++;
    running = false;
    paused = false;
    starting = false;
    held = false;
    onFirstFrame = null;
    cancelAnimationFrame(rafId);
    rafId = 0;
    counter.reset(); // a rep in progress (and its frames) isn't kept until the next fight
    stopStream();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    letGoAwake();
    notify();
  }

  function smooth(m) {
    for (const k of ["elbow", "bodyBend", "knee"]) {
      sm[k] = sm[k] == null ? m[k] : sm[k] + 0.5 * (m[k] - sm[k]);
      m[k] = sm[k];
    }
  }
  function resetSmooth() { sm.elbow = sm.bodyBend = sm.knee = null; }

  function loop() {
    if (!processing()) return; // stopped, hidden or in a break: no frame work, and no next frame
    rafId = requestAnimationFrame(loop);
    if (!landmarker || video.readyState < 2 || !newFrame()) return;
    const now = performance.now();
    if (now - lastRun < STEP_MS - 2) return; // too soon for the pace (2 ms for frame-time jitter): this frame waits
    lastRun = now;
    lastVideoTime = video.currentTime;
    doneFrame = frameNo;
    let res;
    try { res = landmarker.detectForVideo(video, now); } catch (e) { console.error(e); return; }
    if (onFirstFrame) { const f = onFirstFrame; onFirstFrame = null; f(true); } // a start waits for this frame
    const lm = res.landmarks && res.landmarks[0];
    let m = null;
    if (lm) {
      m = analyzePose(lm, video.videoWidth, video.videoHeight, side);
      if (m.side !== side) resetSmooth();
      side = m.side;
      smooth(m);
    } else {
      resetSmooth();
    }
    frames++;
    if (now - fpsT > 1000) { fps = Math.round(frames * 1000 / (now - fpsT)); frames = 0; fpsT = now; }
    counter.update(m, now).forEach(onEvent);
    if (!processing()) return; // that rep ended the fight or the set (a break): nothing more to show
    onFrame(m, now);
    draw(lm, m);
  }

  function draw(lm, m) {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!lm) return;
    const cfg = getCfg();
    const lw = Math.max(2, W / 320);
    const p = i => [lm[i].x * W, lm[i].y * H];
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(238, 243, 236, 0.35)";
    ctx.lineWidth = lw;
    ctx.beginPath();
    for (const [a, b] of CONN) { ctx.moveTo(...p(a)); ctx.lineTo(...p(b)); }
    ctx.stroke();
    if (!m) return;
    const s = IDX[m.side];
    const path = (ids, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = lw * 2.4;
      ctx.beginPath();
      ids.forEach((id, n) => n ? ctx.lineTo(...p(id)) : ctx.moveTo(...p(id)));
      ctx.stroke();
      ctx.fillStyle = color;
      for (const id of ids) { ctx.beginPath(); ctx.arc(...p(id), lw * 2.2, 0, Math.PI * 2); ctx.fill(); }
    };
    path([s.sh, s.hip, s.kn, s.an], m.bodyBend > cfg.bend || m.knee < cfg.knee ? C.bad : C.good);
    path([s.sh, s.el, s.wr], m.elbow <= cfg.depth ? C.good : m.elbow >= cfg.top ? C.fg : C.warn);
  }

  return {
    ensureModel,
    startCamera,
    stop,
    pause,
    resume,
    hold,
    counter,
    get running() { return running; },
    get fps() { return fps; },
    get awake() { return awake; },
    get delegate() { return delegate; },
  };
}
