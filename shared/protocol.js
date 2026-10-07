/**
 * Veloq telemetry protocol — single source of truth in code.
 * Human-readable spec: docs/PROTOCOL.md (keep both in sync).
 *
 * Implemented on DataView so the exact same module runs in Node (simulator,
 * bridge, tests), browsers, and Web Workers — no Buffer, no bundler magic.
 *
 * Rules:
 *  - Fixed 96-byte packets, little-endian, one packet per UDP datagram.
 *  - No per-packet allocation: callers pre-allocate once (createPacket(),
 *    dataViewOf(), a decode target object) and reuse for every packet.
 *  - Receivers tolerate trailing bytes (read the first 96, ignore the rest)
 *    so new fields can be appended without breaking v1 readers.
 */

export const PACKET_SIZE = 96;
export const MAGIC = 0x564c5131; // "VLQ1" as a little-endian uint32
export const VERSION = 1;
export const TYPE_TELEMETRY = 1;

/** Bitfield values for the `flags` byte. */
export const FLAGS = Object.freeze({
  DRS: 1 << 0,
  ABS: 1 << 1,
  TC: 1 << 2,
  REV_LIGHTS: 1 << 3,
});

/** Byte offsets of every field. Mirrors the table in docs/PROTOCOL.md. */
export const OFFSET = Object.freeze({
  MAGIC: 0,
  VERSION: 4,
  TYPE: 6,
  TIMESTAMP_US: 8,
  SEQUENCE: 16,
  RPM: 20,
  RPM_MAX: 24,
  SPEED_KPH: 28,
  GEAR: 32,
  FLAGS: 33,
  RESERVED: 34,
  THROTTLE: 36,
  BRAKE: 40,
  STEER: 44,
  TIRE_TEMP: 48, // float32[4] FL, FR, RL, RR
  SUSPENSION: 64, // float32[4] FL, FR, RL, RR
  FUEL_L: 80,
  LAP_TIME_MS: 84,
  LAP_DISTANCE_PCT: 88,
  LAP_NUMBER: 92,
  POSITION: 94,
});

/** Pre-allocated send packet: bytes + DataView, header already written. */
export function createPacket() {
  const bytes = new Uint8Array(PACKET_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint32(OFFSET.MAGIC, MAGIC, true);
  view.setUint16(OFFSET.VERSION, VERSION, true);
  view.setUint16(OFFSET.TYPE, TYPE_TELEMETRY, true);
  view.setUint16(OFFSET.RESERVED, 0, true);
  return { bytes, view };
}

/**
 * DataView over a Uint8Array/Buffer honoring byteOffset — network Buffers are
 * pooled, so always wrap rather than assuming offset 0.
 */
export function dataViewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Encode telemetry state at `byteOffset` (default 0). Zero allocation. */
export function writeTelemetry(view, state, byteOffset = 0) {
  const ts = state.timestampUs;
  view.setBigUint64(
    byteOffset + OFFSET.TIMESTAMP_US,
    typeof ts === 'bigint' ? ts : BigInt(Math.round(ts)),
    true
  );
  view.setUint32(byteOffset + OFFSET.SEQUENCE, state.sequence >>> 0, true);
  view.setFloat32(byteOffset + OFFSET.RPM, state.rpm, true);
  view.setFloat32(byteOffset + OFFSET.RPM_MAX, state.rpmMax, true);
  view.setFloat32(byteOffset + OFFSET.SPEED_KPH, state.speedKph, true);
  view.setInt8(byteOffset + OFFSET.GEAR, state.gear);
  view.setUint8(byteOffset + OFFSET.FLAGS, state.flags & 0xff);
  view.setFloat32(byteOffset + OFFSET.THROTTLE, state.throttle, true);
  view.setFloat32(byteOffset + OFFSET.BRAKE, state.brake, true);
  view.setFloat32(byteOffset + OFFSET.STEER, state.steer, true);
  for (let i = 0; i < 4; i++) {
    view.setFloat32(byteOffset + OFFSET.TIRE_TEMP + i * 4, state.tireTemp[i], true);
    view.setFloat32(byteOffset + OFFSET.SUSPENSION + i * 4, state.suspension[i], true);
  }
  view.setFloat32(byteOffset + OFFSET.FUEL_L, state.fuelL, true);
  view.setFloat32(byteOffset + OFFSET.LAP_TIME_MS, state.lapTimeMs, true);
  view.setFloat32(byteOffset + OFFSET.LAP_DISTANCE_PCT, state.lapDistancePct, true);
  view.setUint16(byteOffset + OFFSET.LAP_NUMBER, state.lapNumber, true);
  view.setUint16(byteOffset + OFFSET.POSITION, state.position, true);
  return view;
}

/**
 * Decode the packet at `byteOffset` into a caller-owned object (zero
 * allocation). `out.tireTemp` / `out.suspension` must be 4-element arrays.
 * Trailing bytes beyond the 96-byte body are ignored.
 */
export function readTelemetry(view, byteOffset, out) {
  out.timestampUs = view.getBigUint64(byteOffset + OFFSET.TIMESTAMP_US, true);
  out.sequence = view.getUint32(byteOffset + OFFSET.SEQUENCE, true);
  out.rpm = view.getFloat32(byteOffset + OFFSET.RPM, true);
  out.rpmMax = view.getFloat32(byteOffset + OFFSET.RPM_MAX, true);
  out.speedKph = view.getFloat32(byteOffset + OFFSET.SPEED_KPH, true);
  out.gear = view.getInt8(byteOffset + OFFSET.GEAR);
  out.flags = view.getUint8(byteOffset + OFFSET.FLAGS);
  out.throttle = view.getFloat32(byteOffset + OFFSET.THROTTLE, true);
  out.brake = view.getFloat32(byteOffset + OFFSET.BRAKE, true);
  out.steer = view.getFloat32(byteOffset + OFFSET.STEER, true);
  for (let i = 0; i < 4; i++) {
    out.tireTemp[i] = view.getFloat32(byteOffset + OFFSET.TIRE_TEMP + i * 4, true);
    out.suspension[i] = view.getFloat32(byteOffset + OFFSET.SUSPENSION + i * 4, true);
  }
  out.fuelL = view.getFloat32(byteOffset + OFFSET.FUEL_L, true);
  out.lapTimeMs = view.getFloat32(byteOffset + OFFSET.LAP_TIME_MS, true);
  out.lapDistancePct = view.getFloat32(byteOffset + OFFSET.LAP_DISTANCE_PCT, true);
  out.lapNumber = view.getUint16(byteOffset + OFFSET.LAP_NUMBER, true);
  out.position = view.getUint16(byteOffset + OFFSET.POSITION, true);
  return out;
}

/** Header validation via DataView (magic, version, type, minimum size). */
export function isValidPacket(view, byteOffset = 0) {
  return (
    view.byteLength - byteOffset >= PACKET_SIZE &&
    view.getUint32(byteOffset + OFFSET.MAGIC, true) === MAGIC &&
    view.getUint16(byteOffset + OFFSET.VERSION, true) === VERSION &&
    view.getUint16(byteOffset + OFFSET.TYPE, true) === TYPE_TELEMETRY
  );
}

/**
 * Zero-allocation header check for hot worker loops: reads raw bytes only,
 * creates no DataView. Assumes version/type are single-byte values (they are:
 * 1).
 */
export function isValidPacketBytes(u8, byteOffset = 0) {
  return (
    u8.length - byteOffset >= PACKET_SIZE &&
    u8[byteOffset] === 0x31 && // magic 0x564C5131, little-endian
    u8[byteOffset + 1] === 0x51 &&
    u8[byteOffset + 2] === 0x4c &&
    u8[byteOffset + 3] === 0x56 &&
    u8[byteOffset + 4] === VERSION &&
    u8[byteOffset + 5] === 0 &&
    u8[byteOffset + 6] === TYPE_TELEMETRY &&
    u8[byteOffset + 7] === 0
  );
}
