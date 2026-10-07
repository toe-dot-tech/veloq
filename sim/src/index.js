#!/usr/bin/env node
/**
 * Veloq telemetry simulator.
 * Broadcasts packed binary telemetry packets over UDP at a fixed rate with a
 * drift-free scheduler (absolute hrtime deadlines, bounded catch-up bursts).
 *
 *   node sim/src/index.js [--host 127.0.0.1] [--port 9999] [--hz 120] [--seconds N]
 *   npm run sim -- --hz 60
 */
import dgram from 'node:dgram';
import { PACKET_SIZE, createPacket, writeTelemetry } from '../../shared/protocol.js';
import { Scenario } from './scenario.js';

function parseArgs(argv) {
  const opts = { host: '127.0.0.1', port: 9999, hz: 120, seconds: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') opts.host = argv[++i];
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--hz') opts.hz = Number(argv[++i]);
    else if (a === '--seconds') opts.seconds = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(
        'usage: node sim/src/index.js [--host <ip>] [--port <n>] [--hz <60..120>] [--seconds <n>]'
      );
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(1);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    console.error('invalid --port');
    process.exit(1);
  }
  if (!Number.isFinite(opts.hz) || opts.hz < 1 || opts.hz > 1000) {
    console.error('invalid --hz');
    process.exit(1);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

const socket = dgram.createSocket('udp4');
socket.on('error', (err) => {
  console.error(`[sim] socket error: ${err.message}`);
  process.exit(1);
});

const packet = createPacket();
const scenario = new Scenario();
const dt = 1 / opts.hz;

// One reused state object; tire/suspension arrays alias the scenario's arrays
// so encoding never allocates during the run.
const state = {
  timestampUs: 0,
  sequence: 0,
  rpm: 0,
  rpmMax: 0,
  speedKph: 0,
  gear: 1,
  flags: 0,
  throttle: 0,
  brake: 0,
  steer: 0,
  tireTemp: scenario.tireTemp,
  suspension: scenario.suspension,
  fuelL: 100,
  lapTimeMs: 0,
  lapDistancePct: 0,
  lapNumber: 1,
  position: 1,
};

let running = true;
let sentTotal = 0;
let statSent = 0;
let catchUps = 0;

const NS = 1_000_000_000n;
const intervalNs = BigInt(Math.max(1, Math.round(1e9 / opts.hz)));
const STATS_EVERY_NS = 5n * NS;

let nextSend = process.hrtime.bigint() + intervalNs;
let statsStart = process.hrtime.bigint();
let nextStats = statsStart + STATS_EVERY_NS;

function sendPacket() {
  scenario.step(dt);
  scenario.sample(state);
  state.timestampUs = Math.round((performance.timeOrigin + performance.now()) * 1000); // wall-clock µs
  state.sequence = (state.sequence + 1) >>> 0;
  writeTelemetry(packet.view, state);
  socket.send(packet.bytes, opts.port, opts.host);
  sentTotal++;
  statSent++;
}

function tick() {
  if (!running) return;
  const now = process.hrtime.bigint();

  if (now >= nextStats) {
    const windowS = Number(now - statsStart) / 1e9;
    const hz = statSent / windowS;
    const kbps = (statSent * PACKET_SIZE * 8) / 1000 / windowS;
    console.log(
      `[sim] ${hz.toFixed(1)} Hz | sent ${statSent} | ${kbps.toFixed(1)} kbit/s | ` +
        `${catchUps} catch-up bursts | ${opts.host}:${opts.port}`
    );
    statSent = 0;
    catchUps = 0;
    statsStart = now;
    nextStats = now + STATS_EVERY_NS;
  }

  // Send every overdue packet (bounded), then resync if we stalled badly.
  let burst = 0;
  while (now >= nextSend && burst < 16) {
    sendPacket();
    nextSend += intervalNs;
    burst++;
    if (burst > 1) catchUps++;
  }
  if (now >= nextSend) nextSend = now + intervalNs;

  const waitMs = Number(nextSend - process.hrtime.bigint()) / 1e6;
  setTimeout(tick, Math.max(0, Math.min(waitMs, 10)));
}

function stop() {
  if (!running) return;
  running = false;
  const elapsedS = Number(process.hrtime.bigint() - statsStart) / 1e9;
  const rate = elapsedS > 0 ? (statSent + 1) / elapsedS : 0;
  console.log(
    `[sim] done: ${sentTotal} packets total, last window ${rate.toFixed(1)} Hz`
  );
  socket.close();
}

if (Number.isFinite(opts.seconds)) setTimeout(stop, opts.seconds * 1000);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

console.log(
  `[sim] broadcasting ${opts.hz} Hz telemetry -> udp://${opts.host}:${opts.port} ` +
    `(${PACKET_SIZE} B packets, v1)`
);
tick();
