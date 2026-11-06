// A stand-in for MediaPipe tasks-vision 0.10.14 in the tests. A test saves it in the offline helper's copy of
// the library link (and the blocked internet never sees it), so the game's own model-loading code runs.
// Where timing matters it works like the real one: createFromOptions first starts its WASM, and only after
// that reads the model (from modelAssetPath with fetch, or from modelAssetBuffer: bytes or a reader).
// The test steers it through window.__fakeVision: { log: [], wasmMs, failGpu, firstMs }.
const ctl = () => globalThis.__fakeVision || (globalThis.__fakeVision = { log: [] });
const note = (ev, more = {}) => (ctl().log ||= []).push({ ev, t: performance.now(), ...more });
note("libEvaluated");

export const FilesetResolver = {
  async forVisionTasks(base) {
    note("fileset");
    return { wasmLoaderPath: `${base}/vision_wasm_internal.js`, wasmBinaryPath: `${base}/vision_wasm_internal.wasm` };
  },
};

async function readAll(reader) {
  const parts = [];
  let n = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); n += value.length; }
  const out = new Uint8Array(n);
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

export class PoseLandmarker {
  static async createFromOptions(files, options) {
    const c = ctl(), o = options.baseOptions;
    note("create", { delegate: o.delegate });
    await new Promise(r => setTimeout(r, c.wasmMs || 0)); // the WASM starting up
    note("wasmReady", { delegate: o.delegate });
    let bytes;
    if (o.modelAssetPath) {
      const res = await fetch(o.modelAssetPath.toString());
      if (!res.ok) throw new Error(`Failed to fetch model: ${o.modelAssetPath} (${res.status})`);
      bytes = new Uint8Array(await res.arrayBuffer());
    } else if (o.modelAssetBuffer instanceof Uint8Array) bytes = o.modelAssetBuffer;
    else bytes = await readAll(o.modelAssetBuffer);
    note("modelRead", { bytes: bytes.length, delegate: o.delegate });
    if (c.failGpu && o.delegate === "GPU") throw new Error("Unable to obtain required WebGL resource (test)");
    const lm = new PoseLandmarker();
    Object.assign(lm, { delegate: o.delegate, bytes: bytes.length, frames: 0, closes: 0 });
    (c.made ||= []).push(lm);
    return lm;
  }
  detectForVideo() {
    const c = ctl();
    if (this.frames++ === 0 && c.firstMs) { const end = performance.now() + c.firstMs; while (performance.now() < end) {} }
    return { landmarks: [] };
  }
  close() { this.closes++; }
}
