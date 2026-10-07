/**
 * Veloq ingestion worker.
 *
 * Owns the WebSocket to the bridge and writes every validated packet into a
 * ring buffer inside a SharedArrayBuffer — the render thread never receives a
 * message, it just reads the newest slot at vsync. This is the web analogue of
 * the shared-memory hand-off: no message queue, no queue bloat, latest-wins.
 *
 * Allocation policy: one small Uint8Array/DataView *wrapper* per message (the
 * data itself is never copied twice); everything else is pre-allocated.
 */
import { PACKET_SIZE, isValidPacketBytes } from '/shared/protocol.js';

export const RING_SLOTS = 64; // 64 × 96 B = 533 ms of history at 120 Hz
export const HEADER_SIZE = 64;

// Int32 header: [0] generation (publish), [1] packets, [2] invalid, [3] lastSeq
// Float64 header at byte 16: [0] arrival epoch-ms, [1] WS reconnects
let i32 = null;
let f64 = null;
const slots = [];
let gen = 0;
let reconnectTimer = null;

self.onmessage = (event) => {
  const msg = event.data;
  if (msg && msg.type === 'init' && msg.sab) {
    const sab = msg.sab;
    i32 = new Int32Array(sab, 0, 4);
    f64 = new Float64Array(sab, 16, 4);
    for (let s = 0; s < RING_SLOTS; s++) {
      slots.push(new Uint8Array(sab, HEADER_SIZE + s * PACKET_SIZE, PACKET_SIZE));
    }
    connect();
    self.postMessage({ type: 'status', state: 'connecting' });
  }
};

function connect() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => self.postMessage({ type: 'status', state: 'open' });

  ws.onmessage = (event) => {
    const u8 = new Uint8Array(event.data); // view over the received buffer — no data copy
    if (!isValidPacketBytes(u8)) {
      Atomics.add(i32, 2, 1);
      return;
    }
    // Latest-wins ring: drop the slot in after the newest generation, then
    // publish with a seq-cst store so the render thread sees all bytes first.
    const slot = slots[gen % RING_SLOTS];
    if (u8.length === PACKET_SIZE) {
      slot.set(u8);
    } else if (u8.length > PACKET_SIZE) {
      slot.set(u8.subarray(0, PACKET_SIZE)); // tolerate trailing (future) bytes
    } else {
      Atomics.add(i32, 2, 1);
      return;
    }
    f64[0] = performance.timeOrigin + performance.now(); // arrival, epoch ms
    const seq = u8[16] | (u8[17] << 8) | (u8[18] << 16) | (u8[19] << 24);
    Atomics.store(i32, 3, seq);
    Atomics.add(i32, 1, 1);
    gen++;
    Atomics.store(i32, 0, gen); // publish
  };

  ws.onclose = () => {
    self.postMessage({ type: 'status', state: 'reconnecting' });
    f64[1] = f64[1] + 1; // reconnect counter
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1000);
  };
  ws.onerror = () => ws.close();
}
