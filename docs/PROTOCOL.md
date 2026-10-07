# Veloq Telemetry Protocol — v1

Status: **active** · Canonical code: [`shared/protocol.js`](../shared/protocol.js)

## Transport

- **UDP/IPv4**, one telemetry packet per datagram — no framing, no batching.
- Default endpoint: `127.0.0.1:9999` (simulator). On-device builds listen on
  `0.0.0.0:9999` and receive from the simulator host's LAN IP.
- Recommended rate: **120 Hz** (supported range 60–120 Hz). Receivers must
  tolerate bursts, jitter and dropped datagrams (UDP gives no delivery
  guarantee) — never reset HUD state on a gap, just keep the last known values.

## Packet layout

- Fixed size: **96 bytes**
- Byte order: **little-endian**
- Offset 0 = first byte of the datagram.

| Offset | Size | Type       | Field            | Unit   | Notes                                  |
| -----: | ---: | ---------- | ---------------- | ------ | -------------------------------------- |
|      0 |    4 | uint32     | magic            | —      | `0x564C5131` ("VLQ1")                  |
|      4 |    2 | uint16     | version          | —      | `1`                                    |
|      6 |    2 | uint16     | packetType       | —      | `1` = telemetry                        |
|      8 |    8 | uint64     | timestampUs      | µs     | sender wall clock at packet build time |
|     16 |    4 | uint32     | sequence         | —      | +1 per packet, wraps at 2³²            |
|     20 |    4 | float32    | rpm              | rpm    |                                        |
|     24 |    4 | float32    | rpmMax           | rpm    | redline                                |
|     28 |    4 | float32    | speedKph         | km/h   |                                        |
|     32 |    1 | int8       | gear             | —      | -1 = R, 0 = N, 1..8                    |
|     33 |    1 | uint8      | flags            | —      | bitfield, see below                    |
|     34 |    2 | uint16     | reserved         | —      | must be 0                              |
|     36 |    4 | float32    | throttle         | 0..1   |                                        |
|     40 |    4 | float32    | brake            | 0..1   |                                        |
|     44 |    4 | float32    | steer            | -1..1  | positive = right                       |
|     48 |   16 | float32[4] | tireTemp         | °C     | order **FL, FR, RL, RR**               |
|     64 |   16 | float32[4] | suspension       | mm     | travel 0..80, order **FL, FR, RL, RR** |
|     80 |    4 | float32    | fuelL            | litres |                                        |
|     84 |    4 | float32    | lapTimeMs        | ms     | current lap                            |
|     88 |    4 | float32    | lapDistancePct   | 0..100 |                                        |
|     92 |    2 | uint16     | lapNumber        | —      |                                        |
|     94 |    2 | uint16     | position         | —      | race position                          |

## Flags (byte at offset 33)

| Bit | Mask   | Name       | Meaning                        |
| --- | ------ | ---------- | ------------------------------ |
| 0   | `0x01` | DRS        | drag reduction system available |
| 1   | `0x02` | ABS        | anti-lock braking active        |
| 2   | `0x04` | TC         | traction control active         |
| 3   | `0x08` | REV_LIGHTS | shift lights (≥ 95% redline)    |

## Versioning & compatibility

1. Receivers **drop** any datagram whose magic or type is wrong.
2. Receivers **drop** any datagram whose `version` they don't support.
3. Receivers **must ignore trailing bytes** — read the first 96 bytes only.
   New fields get appended (and `version` stays until the first 96 bytes
   change meaning); the first 96 bytes are frozen for v1.
4. On a gap or invalid packet: keep last-known state, never blank the HUD.

## Timing semantics

- `timestampUs` is the sender's **wall clock** in microseconds.
- Same-host benchmarks may use it directly for end-to-end latency.
- Cross-device latency must baseline on **local arrival time** (or synced
  clocks) — otherwise clock skew pollutes the measurement.

## Reference implementations

| Role                     | File                        | Status  |
| ------------------------ | --------------------------- | ------- |
| encode + decode (JS)     | `shared/protocol.js`        | ✅      |
| simulator (encode)       | `sim/src/index.js`          | ✅      |
| sanity receiver (decode) | `sim/test/receive.js`       | ✅      |
| UDP → WebSocket bridge   | `bridge/`                   | phase 2 |
| web worker (decode)      | `web/`                      | phase 2 |
| android C++ (decode)     | `android/.../cpp/protocol.h`| phase 3 |
