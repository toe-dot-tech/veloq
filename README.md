# Veloq

**Real-time racing HUD & telemetry engine.** 60–120 Hz binary UDP telemetry in,
gauges out — through a zero-allocation pipeline with a shared-memory hand-off
between the ingestion thread and the render loop.

## Why it exists

Broadcasting RPM, tire temps, and suspension travel at 120 Hz through a normal
state-driven UI stack causes GC stutter, message-queue bloat, and thermal
throttling. Veloq is built against three hard constraints:

1. **Zero GC stutter** — no JSON, no per-packet allocations; packets are parsed
   in place into pre-allocated buffers.
2. **< 16 ms end-to-end** (target < 8.3 ms at 120 FPS): ingestion → decode →
   state → pixels.
3. **Battery/thermal budget** — gauges repaint directly to the canvas; no
   widget/DOM tree rebuilds during a race.

## Architecture

```
                        ┌────────────────────────── targets ──────────────────────────┐
┌────────────┐  UDP 96B │  WEB                                  │  ANDROID (native)  │
│ simulator  ├─────────►│  UDP→WS bridge ─► Worker ─► Shared-   │  C++ NDK UDP       │
│ (Node,     │  binary   │  (browsers can't   (decode) Array-   │  thread ─► shared  │
│  60–120 Hz)│  packets  │   open raw UDP)     into    Buffer    │  memory            │
└────────────┘           │        │                             │       │            │
                         │        ▼                             ▼       ▼            │
                         │  rAF loop reads SharedArrayBuffer at vsync, draws gauges  │
                         │  straight to Canvas/WebGL — no widget rebuilds            │
                         └───────────────────────────────────────────────────────────┘
```

- **One protocol, two pipelines**: both targets consume the exact same
  96-byte little-endian packet ([docs/PROTOCOL.md](docs/PROTOCOL.md),
  [shared/protocol.js](shared/protocol.js)).
- **Zero-allocation ingest**: the listener parses raw bytes into pre-allocated
  buffers; no objects are created per packet.
- **Shared memory, not message queues**: the render loop reads the latest state
  pointer at vsync instead of draining a queue, so telemetry-to-glass latency
  doesn't grow under load.

## Repository layout

| Path                  | What                                                        |
| --------------------- | ----------------------------------------------------------- |
| `docs/PROTOCOL.md`    | Packet spec — single human-readable source of truth         |
| `shared/protocol.js`  | Encode/decode constants — single in-code source of truth    |
| `sim/`                | UDP telemetry simulator + sanity receiver (self-test)       |
| `bridge/`             | UDP → WebSocket bridge for the web target *(phase 2)*       |
| `web/`                | Web HUD: Worker + SharedArrayBuffer + Canvas *(phase 2)*    |
| `android/`            | Native Android HUD: NDK UDP thread + SurfaceView *(phase 3)*|
| `bench/`              | Latency / FPS / GC / memory harness *(phase 4)*             |

## Quick start

Requires Node.js ≥ 20.

```bash
# terminal 1 — sanity receiver (decodes packets, reports rate/loss, PASS/FAIL)
npm run sim:recv

# terminal 2 — broadcast 120 Hz telemetry to 127.0.0.1:9999
npm run sim

# variants
npm run sim -- --hz 60            # 60 Hz
npm run sim -- --host 0.0.0.0 --port 9999
npm run sim -- --seconds 30       # auto-stop (benchmark runs)
```

### Web HUD

```bash
# terminal 1 — telemetry
npm run sim

# terminal 2 — UDP→WebSocket bridge + static server (COOP/COEP headers)
npm run bridge

# then open http://localhost:8080   (or the printed LAN URL on a phone/tablet)
```

The HUD overlay reports live FPS, telemetry rate, end-to-end latency and
tuning-isolation status. Verified baseline on this machine: 120.0 Hz ingest,
~6 ms telemetry-to-glass, 0 invalid packets.

> Browsers cannot open raw UDP sockets, so the web target receives the same
> 96-byte datagrams through the local bridge. The bridge drops frames under
> backpressure instead of queueing — stale data is worse than no data.

## Phases

| Phase | Deliverable                                      | Status |
| ----- | ------------------------------------------------ | ------ |
| 0     | Repo skeleton + protocol spec                    | ✅     |
| 1     | UDP simulator @ 120 Hz + sanity receiver         | ✅     |
| 2     | Web: bridge, Worker, SharedArrayBuffer, gauges   | ✅     |
| 3     | Android: C++ NDK UDP → shared memory → SurfaceView | ⬜   |
| 4     | Benchmark harness (latency, GC pauses, FPS, memory) | ⬜ |
