#!/usr/bin/env node
/**
 * Veloq bridge — UDP → WebSocket relay + static server for the web HUD.
 *
 * Browsers cannot open raw UDP sockets, so the web target receives the exact
 * same binary datagrams through this local relay (byte-for-byte, no JSON).
 * Static responses carry COOP/COEP so the HUD is crossOriginIsolated and may
 * use SharedArrayBuffer + Atomics.
 *
 * Live-telemetry policy: if a client's socket buffers grow beyond a small
 * threshold, frames to THAT client are dropped instead of queued — stale data
 * is worse than no data, and queue bloat is exactly what Veloq exists to fix.
 *
 *   node bridge/src/index.js [--http-port 8080] [--udp-port 9999]
 */
import http from 'node:http';
import dgram from 'node:dgram';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = path.join(ROOT, 'web');
const SHARED_ROOT = path.join(ROOT, 'shared');
const BACKPRESSURE_LIMIT = 128 * 1024; // ≈11 frames of headroom at 96 B/120 Hz

function parseArgs(argv) {
  const opts = { httpPort: 8080, udpPort: 9999 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--http-port') opts.httpPort = Number(argv[++i]);
    else if (a === '--udp-port') opts.udpPort = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log('usage: node bridge/src/index.js [--http-port <n>] [--udp-port <n>]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return opts;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const opts = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// Static server — web/ at /, shared/ at /shared/, with COOP/COEP.
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');

  let pathname;
  try {
    pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    res.writeHead(400);
    res.end('bad request');
    return;
  }

  let filePath;
  if (pathname === '/' || pathname === '/index.html') {
    filePath = path.join(WEB_ROOT, 'index.html');
  } else if (pathname.startsWith('/shared/')) {
    filePath = path.join(SHARED_ROOT, pathname.slice('/shared/'.length));
  } else {
    filePath = path.join(WEB_ROOT, pathname.slice(1));
  }
  const resolved = path.resolve(filePath);
  const allowed =
    resolved.startsWith(WEB_ROOT + path.sep) || resolved.startsWith(SHARED_ROOT + path.sep);
  if (!allowed) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end(`not found: ${pathname}`);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(resolved)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// WebSocket relay — broadcasts each UDP datagram to every connected HUD.
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server });
const clients = new Set();
let relayed = 0;
let dropped = 0;

wss.on('connection', (ws, req) => {
  clients.add(ws);
  console.log(`[bridge] HUD connected: ${req.socket.remoteAddress} (clients=${clients.size})`);
  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[bridge] HUD disconnected (clients=${clients.size})`);
  });
  ws.on('error', () => clients.delete(ws));
});

// ---------------------------------------------------------------------------
// UDP ingestion — the simulator (or a real sim) talks to us here.
// ---------------------------------------------------------------------------
let received = 0;
let receivedBytes = 0;
let statReceived = 0;
let statRelayed = 0;
let statDropped = 0;

const udp = dgram.createSocket('udp4');
udp.on('error', (err) => {
  console.error(`[bridge] UDP error: ${err.message}`);
  process.exit(1);
});
udp.on('message', (msg) => {
  received++;
  receivedBytes += msg.length;
  statReceived++;
  if (clients.size === 0) return;
  for (const ws of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (ws.bufferedAmount > BACKPRESSURE_LIMIT) {
      dropped++;
      statDropped++;
      continue; // live data: drop for this client, never queue
    }
    ws.send(msg, { binary: true });
    relayed++;
    statRelayed++;
  }
});
udp.bind(opts.udpPort);

// ---------------------------------------------------------------------------
// Stats + startup banner
// ---------------------------------------------------------------------------
setInterval(() => {
  if (statReceived === 0) return;
  const hz = statReceived / 5;
  console.log(
    `[bridge] ${hz.toFixed(1)} Hz in | relayed ${statRelayed} | ` +
      `dropped ${statDropped} (backpressure) | clients ${clients.size} | ` +
      `${((statReceived * 96 * 8) / 1000 / 5).toFixed(1)} kbit/s`
  );
  statReceived = 0;
  statRelayed = 0;
  statDropped = 0;
}, 5000);

function lanUrls() {
  const urls = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${opts.httpPort}`);
    }
  }
  return urls;
}

server.listen(opts.httpPort, '0.0.0.0', () => {
  console.log(`[bridge] HUD:   http://localhost:${opts.httpPort}`);
  for (const url of lanUrls()) console.log(`[bridge] LAN:   ${url}  (phone/tablet on same Wi-Fi)`);
  console.log(`[bridge] UDP:   listening on 0.0.0.0:${opts.udpPort}`);
  console.log('[bridge] note: allow Node.js through the firewall if a device cannot reach the LAN URL');
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
function shutdown() {
  console.log(
    `[bridge] done: ${received} packets received (${(receivedBytes / 1024).toFixed(1)} KiB), ` +
      `${relayed} relayed, ${dropped} dropped on backpressure`
  );
  udp.close();
  wss.close();
  server.close();
  process.exit(0);
}
