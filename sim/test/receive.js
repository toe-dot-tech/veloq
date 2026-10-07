#!/usr/bin/env node
/**
 * Sanity receiver for the Veloq simulator: binds a UDP port, decodes packets
 * with the shared zero-allocation reader, and reports rate / loss / integrity.
 * Exits 0 on PASS (no invalid packets, no sequence gaps), 1 otherwise.
 *
 *   node sim/test/receive.js [--port 9999] [--seconds 8]
 */
import dgram from 'node:dgram';
import {
  PACKET_SIZE,
  dataViewOf,
  isValidPacket,
  readTelemetry,
} from '../../shared/protocol.js';

function parseArgs(argv) {
  const opts = { port: 9999, seconds: 8 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--seconds') opts.seconds = Number(argv[++i]);
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

// One reused decode object — the receiver never allocates per packet either.
const decoded = {
  timestampUs: 0n,
  sequence: 0,
  rpm: 0,
  rpmMax: 0,
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

let received = 0;
let invalid = 0;
let lost = 0;
let sizeMismatches = 0;
let lastSeq = null;
let bytes = 0;
let firstPrinted = 0;
let statReceived = 0;
let statsStart = null;
let lastRate = 0;

const socket = dgram.createSocket('udp4');

socket.on('error', (err) => {
  console.error(`[recv] socket error: ${err.message}`);
  process.exit(1);
});

socket.on('message', (msg) => {
  const view = dataViewOf(msg);
  if (!isValidPacket(view)) {
    invalid++;
    return;
  }
  if (msg.length !== PACKET_SIZE) sizeMismatches++;

  const now = process.hrtime.bigint();
  if (statsStart === null) statsStart = now;
  readTelemetry(view, 0, decoded);

  if (lastSeq !== null) {
    const expected = (lastSeq + 1) >>> 0;
    if (decoded.sequence !== expected) {
      lost += (decoded.sequence - expected) >>> 0;
    }
  }
  lastSeq = decoded.sequence;
  received++;
  statReceived++;
  bytes += msg.length;

  if (firstPrinted < 3) {
    firstPrinted++;
    console.log(
      `[recv] #${decoded.sequence} rpm=${decoded.rpm.toFixed(0)} ` +
        `speed=${decoded.speedKph.toFixed(1)} kph gear=${decoded.gear} ` +
        `thr=${decoded.throttle.toFixed(2)} brk=${decoded.brake.toFixed(2)} ` +
        `steer=${decoded.steer.toFixed(2)} flags=0x${decoded.flags.toString(16)}`
    );
    console.log(
      `       tire=[${decoded.tireTemp.map((t) => t.toFixed(1)).join(' ')}] °C  ` +
        `susp=[${decoded.suspension.map((s) => s.toFixed(1)).join(' ')}] mm  ` +
        `lap=${decoded.lapNumber} @${decoded.lapDistancePct.toFixed(1)}%  ` +
        `fuel=${decoded.fuelL.toFixed(1)} L`
    );
  }
});

const rateTimer = setInterval(() => {
  if (statsStart === null) return;
  const windowS = Number(process.hrtime.bigint() - statsStart) / 1e9;
  lastRate = statReceived / windowS;
  console.log(
    `[recv] ${lastRate.toFixed(1)} Hz | received ${received} | lost ${lost} | invalid ${invalid}`
  );
  statReceived = 0;
  statsStart = process.hrtime.bigint();
}, 2000);

socket.bind(opts.port, () => {
  console.log(`[recv] listening on udp://0.0.0.0:${opts.port} for ${opts.seconds}s...`);
  setTimeout(finish, opts.seconds * 1000);
});

function finish() {
  clearInterval(rateTimer);
  socket.close();
  const total = received + invalid + lost;
  const lossPct = total > 0 ? (lost / total) * 100 : 0;
  const avgHz = lastRate;
  const pass = invalid === 0 && lost === 0 && received > 0;
  console.log('---------- summary ----------');
  console.log(`packets : ${received} received, ${invalid} invalid, ${lost} lost (${lossPct.toFixed(2)}%)`);
  console.log(`rate    : ${avgHz.toFixed(1)} Hz (last window)`);
  console.log(`payload : ${PACKET_SIZE} B/packet, ${((received * PACKET_SIZE) / 1024).toFixed(1)} KiB total`);
  if (sizeMismatches > 0) console.log(`note    : ${sizeMismatches} packets != ${PACKET_SIZE} B (trailing bytes tolerated)`);
  console.log(pass ? 'PASS' : 'FAIL');
  process.exit(pass ? 0 : 1);
}
