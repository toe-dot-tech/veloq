import { FLAGS } from '../../shared/protocol.js';

/**
 * Procedural driving scenario: produces plausible telemetry for a single car
 * lapping a fictional 4.2 km circuit. Deterministic given dt steps — the sim
 * advances the scenario by exactly 1/hz seconds per packet, so the same code
 * produces the same trace at 60 Hz and 120 Hz.
 *
 * All state lives in fixed arrays/fields: sample() only copies scalars into
 * the caller's reused object (the tire/suspension arrays are aliased, not
 * copied), mirroring the zero-allocation discipline of the real pipeline.
 */

const AMBIENT_C = 24;
const TRACK_LENGTH_M = 4200;
const RPM_MAX = 9500;
const IDLE_RPM = 900;
const GEAR_SPAN_KPH = 36; // kph per gear → sawtooth shift pattern

/** Piecewise target speed (km/h) around the lap, keyed by lap progress 0..1. */
const TARGET_SPEED = [
  [0.0, 130],
  [0.08, 265],
  [0.24, 265],
  [0.29, 95],
  [0.36, 95],
  [0.46, 185],
  [0.56, 150],
  [0.66, 215],
  [0.76, 240],
  [0.84, 82],
  [0.9, 140],
  [1.0, 130],
];

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function targetSpeedAt(p) {
  for (let i = 1; i < TARGET_SPEED.length; i++) {
    const [p1, v1] = TARGET_SPEED[i];
    if (p <= p1) {
      const [p0, v0] = TARGET_SPEED[i - 1];
      return v0 + ((v1 - v0) * (p - p0)) / (p1 - p0);
    }
  }
  return TARGET_SPEED[TARGET_SPEED.length - 1][1];
}

export class Scenario {
  constructor() {
    this.time = 0;
    this.progress = 0; // lap progress 0..1
    this.speedKph = 0;
    this.gear = 1;
    this.rpm = IDLE_RPM;
    this.throttle = 0;
    this.brake = 0;
    this.steer = 0;
    this.flags = 0;
    this.tireTemp = [AMBIENT_C, AMBIENT_C, AMBIENT_C, AMBIENT_C]; // FL FR RL RR
    this.suspension = [40, 40, 40, 40]; // mm, mid travel at rest
    this.fuelL = 100;
    this.lapTimeMs = 0;
    this.lapNumber = 1;
  }

  /** Advance the world by dt seconds. */
  step(dt) {
    this.time += dt;
    this.lapTimeMs += dt * 1000;

    // --- Longitudinal dynamics -------------------------------------------------
    // Power falls off with speed, braking is strong; never overshoot the target.
    const target = targetSpeedAt(this.progress);
    const dv = target - this.speedKph;
    if (dv > 0) {
      const accelKphPerS = Math.max(2, 14 * (1 - this.speedKph / 300));
      this.speedKph += Math.min(dv, accelKphPerS * dt);
    } else {
      this.speedKph = Math.max(target, this.speedKph - 45 * dt);
    }

    // --- Gear + engine (sawtooth across each gear band) ------------------------
    if (this.speedKph < 1) {
      this.gear = 1;
      this.rpm = IDLE_RPM;
    } else {
      this.gear = Math.min(8, Math.floor(this.speedKph / GEAR_SPAN_KPH) + 1);
      const frac = clamp(
        (this.speedKph - (this.gear - 1) * GEAR_SPAN_KPH) / GEAR_SPAN_KPH,
        0,
        1
      );
      this.rpm = 3400 + frac * (RPM_MAX - 3400);
    }

    // --- Pedals: proportional to speed error, smoothed --------------------------
    const smooth = Math.min(1, dt * 10);
    this.throttle += (clamp(dv / 30, 0, 1) - this.throttle) * smooth;
    this.brake += (clamp(-dv / 22, 0, 1) - this.brake) * smooth;

    // --- Steering: alternating corners, calmed at high speed -------------------
    const steerTarget =
      Math.sin(this.progress * Math.PI * 6) *
      (1 - clamp(this.speedKph / 300, 0, 1) * 0.6);
    this.steer += (steerTarget - this.steer) * Math.min(1, dt * 6);

    // --- Suspension travel: bumps + lateral roll + dive/squat ------------------
    const lateral = this.steer;
    const longitudinal = this.brake - this.throttle;
    for (let i = 0; i < 4; i++) {
      const side = i % 2 === 0 ? -1 : 1; // left / right
      const axle = i < 2 ? 1 : -1; // front / rear
      const bump = Math.sin(this.time * (7.3 + i * 0.9) + i * 1.7) * 5;
      const roll = -lateral * side * 12; // outer wheel loads up
      const dive = longitudinal * axle * 9; // nose dive / rear squat
      this.suspension[i] = clamp(40 + bump + roll + dive, 0, 80);
    }

    // --- Tire temps: first-order warm-up toward load-dependent targets ---------
    const speedLoad = clamp(this.speedKph / 260, 0, 1);
    const warm = Math.min(1, dt * 0.12);
    for (let i = 0; i < 4; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const axle = i < 2 ? 1 : -1;
      const outer = Math.max(0, lateral * side);
      const targetTemp =
        AMBIENT_C +
        speedLoad * (axle > 0 ? 46 : 40) +
        this.brake * (axle > 0 ? 26 : 6) +
        this.throttle * (axle > 0 ? 4 : 18) +
        outer * 14;
      this.tireTemp[i] += (targetTemp - this.tireTemp[i]) * warm;
    }

    // --- Fuel burn --------------------------------------------------------------
    this.fuelL = Math.max(0, this.fuelL - this.throttle * dt * 0.02);

    // --- Lap progress -----------------------------------------------------------
    this.progress += ((this.speedKph / 3.6) * dt) / TRACK_LENGTH_M;
    if (this.progress >= 1) {
      this.progress -= 1;
      this.lapNumber += 1;
      this.lapTimeMs = 0;
    }

    // --- Flags ------------------------------------------------------------------
    let flags = 0;
    if (this.progress > 0.1 && this.progress < 0.26 && this.speedKph > 200) {
      flags |= FLAGS.DRS;
    }
    if (this.brake > 0.92) flags |= FLAGS.ABS;
    if (this.throttle > 0.95 && this.gear <= 3) flags |= FLAGS.TC;
    if (this.rpm > RPM_MAX * 0.95) flags |= FLAGS.REV_LIGHTS;
    this.flags = flags;
  }

  /**
   * Copy scalar telemetry into the caller's reused `state` object.
   * state.tireTemp / state.suspension must alias this scenario's arrays.
   */
  sample(state) {
    state.rpm = this.rpm;
    state.rpmMax = RPM_MAX;
    state.speedKph = this.speedKph;
    state.gear = this.gear;
    state.flags = this.flags;
    state.throttle = this.throttle;
    state.brake = this.brake;
    state.steer = this.steer;
    state.fuelL = this.fuelL;
    state.lapTimeMs = this.lapTimeMs;
    state.lapDistancePct = this.progress * 100;
    state.lapNumber = this.lapNumber;
    state.position = 1;
  }
}
