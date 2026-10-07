/**
 * Veloq web HUD — render loop.
 *
 * Shared-memory pipeline:
 *   worker writes packets → SharedArrayBuffer ring → this thread reads the
 *   newest slot inside requestAnimationFrame (vsync) and paints the canvas.
 *   No messages are pumped; Atomics.load(gen) is the only synchronisation.
 *
 * Everything here is pre-allocated: the decode target, the SAB views, and the
 * latency rings. Per-frame work is bounded and allocation-free.
 */
import { readTelemetry, PACKET_SIZE } from '/shared/protocol.js';
import { createRenderer } from './render.js';

const RING_SLOTS = 64;
const HEADER_SIZE = 64;
const SAB_SIZE = HEADER_SIZE + RING_SLOTS * PACKET_SIZE;
const E2E_RING = 180; // 3 s of samples at 60 fps

const banner = document.getElementById('banner');
const statsEl = document.getElementById('stats');
const canvas = document.getElementById('hud');

if (!crossOriginIsolated) {
  banner.hidden = false;
  banner.textContent =
    'Not crossOriginIsolated — SharedArrayBuffer unavailable. ' +
    'Serve the HUD through the Veloq bridge so COOP/COEP headers are set.';
}

// --- Shared memory layout (must match web/src/worker.js) ---------------------
const sab = new SharedArrayBuffer(SAB_SIZE);
const headerI32 = new Int32Array(sab, 0, 4); // gen, packets, invalid, lastSeq
const headerF64 = new Float64Array(sab, 16, 4); // arrival epoch-ms, reconnects
const sabView = new DataView(sab);

// --- Zero-allocation decode target -------------------------------------------
const state = {
  timestampUs: 0n,
  sequence: 0,
  rpm: 0,
  rpmMax: 9500,
  speedKph: 0,
  gear: 0,
  flags: 0,
  throttle: 0,
  brake: 0,
  steer: 0,
  tireTemp: [0, 0, 0, 0],
  suspension: [0, 0, 0, 0],
  fuelL: 0,
  lapTimeMs: 0,
  lapDistancePct: 0,
  lapNumber: 0,
  position: 0,
};

// --- Worker ------------------------------------------------------------------
let wsStatus = 'connecting';
const worker = new Worker('/src/worker.js', { type: 'module' });
worker.onmessage = (event) => {
  if (event.data && event.data.type === 'status') wsStatus = event.data.state;
};
worker.postMessage({ type: 'init', sab });

// --- Latency rings (pre-allocated) --------------------------------------------
const e2eRing = new Float32Array(E2E_RING);
const ageRing = new Float32Array(E2E_RING);
let e2eIdx = 0;
let e2eCount = 0;

function avgRing(ring, count) {
  const n = Math.min(count, ring.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += ring[i];
  return sum / n;
}

// --- Render loop ---------------------------------------------------------------
const renderer = createRenderer(canvas);
let lastGen = -1;
let frames = 0;
let fps = 60;
let frameMsEma = 16.7;
let lastFpsAt = performance.now();
let hz = 0;
let lastGenCount = 0;
let lastHzAt = performance.now();
let lastStatsAt = 0;
const meta = { fps: 0, frameMs: 0, hz: 0, e2e: 0, age: 0, gen: 0, ws: '', packets: 0, invalid: 0 };

function loop(now) {
  requestAnimationFrame(loop);
  frames++;
  const frameMs = now - lastLoopAt;
  lastLoopAt = now;
  frameMsEma += (frameMs - frameMsEma) * 0.1;

  const gen = Atomics.load(headerI32, 0);
  if (gen !== lastGen && gen > 0) {
    const slot = (gen - 1) % RING_SLOTS;
    readTelemetry(sabView, HEADER_SIZE + slot * PACKET_SIZE, state);
    if (Atomics.load(headerI32, 0) === gen) {
      // stable — commit; otherwise a newer packet landed mid-decode and we
      // simply pick it up on the next vsync
      lastGen = gen;
      const glass = performance.timeOrigin + performance.now();
      const arrival = headerF64[0];
      // timestampUs is BigInt (u64 µs); µs values stay exact in a double
      e2eRing[e2eIdx] = glass - Number(state.timestampUs) / 1000;
      ageRing[e2eIdx] = glass - arrival;
      e2eIdx = (e2eIdx + 1) % E2E_RING;
      e2eCount++;
    }
  }

  renderer.draw(gen > 0 ? state : null, meta);

  if (now - lastFpsAt >= 500) {
    fps = (frames * 1000) / (now - lastFpsAt);
    frames = 0;
    lastFpsAt = now;
  }
  if (now - lastHzAt >= 1000) {
    const total = Atomics.load(headerI32, 1);
    hz = (total - lastGenCount) / ((now - lastHzAt) / 1000);
    lastGenCount = total;
    lastHzAt = now;
  }
  if (now - lastStatsAt >= 250) {
    lastStatsAt = now;
    meta.fps = fps;
    meta.frameMs = frameMsEma;
    meta.hz = hz;
    meta.e2e = avgRing(e2eRing, e2eCount);
    meta.age = avgRing(ageRing, e2eCount);
    meta.gen = gen;
    meta.ws = wsStatus;
    meta.packets = Atomics.load(headerI32, 1);
    meta.invalid = Atomics.load(headerI32, 2);
    statsEl.textContent =
      `fps      ${fps.toFixed(1).padStart(6)}  (${frameMsEma.toFixed(1)} ms)\n` +
      `telemetry ${hz.toFixed(1).padStart(5)} Hz  gen ${gen}\n` +
      `e2e      ${meta.e2e.toFixed(2).padStart(5)} ms  age ${meta.age.toFixed(2)} ms\n` +
      `ws       ${wsStatus.padEnd(6)}  isolated ${crossOriginIsolated}\n` +
      `packets  ${meta.packets}  invalid ${meta.invalid}\n` +
      `sab      ${(SAB_SIZE / 1024).toFixed(1)} KiB  ring ${RING_SLOTS} slots`;
  }

}

let lastLoopAt = performance.now();
requestAnimationFrame(loop);
