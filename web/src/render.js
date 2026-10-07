/**
 * Veloq HUD renderer — direct Canvas2D painting.
 *
 * No layout tree, no component re-render: every vsync clears one rect and
 * strokes ~60 vector paths at device pixel ratio. All input comes from the
 * pre-decoded `state` object; this module allocates only during resize.
 */

const COLORS = {
  bg: '#05070c',
  track: '#141c29',
  dim: '#5f718c',
  text: '#eaf2ff',
  accent: '#31e08a',
  warn: '#ffb02e',
  danger: '#ff3b4e',
  violet: '#7c5cff',
};

/** Temperature (°C) → colour, blue → green → yellow → red. */
const TEMP_STOPS = [
  [20, [47, 129, 247]],
  [45, [49, 208, 122]],
  [70, [242, 201, 76]],
  [90, [242, 153, 74]],
  [110, [235, 87, 87]],
];

function tempColor(t) {
  if (t <= TEMP_STOPS[0][0]) return rgb(TEMP_STOPS[0][1]);
  for (let i = 1; i < TEMP_STOPS.length; i++) {
    const [t1, c1] = TEMP_STOPS[i];
    if (t <= t1) {
      const [t0, c0] = TEMP_STOPS[i - 1];
      const k = (t - t0) / (t1 - t0);
      return rgb([
        c0[0] + (c1[0] - c0[0]) * k,
        c0[1] + (c1[1] - c0[1]) * k,
        c0[2] + (c1[2] - c0[2]) * k,
      ]);
    }
  }
  return rgb(TEMP_STOPS[TEMP_STOPS.length - 1][1]);
}
function rgb([r, g, b]) {
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const CORNERS = ['FL', 'FR', 'RL', 'RR'];

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  let W = 0;
  let H = 0;

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }

  function draw(state, meta) {
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);
    if (!state || meta.gen === 0) {
      drawWaiting();
      return;
    }
    ctx.textBaseline = 'middle';
    drawShiftLights(state);
    drawTach(state);
    drawSpeed(state);
    drawSteer(state);
    drawPedals(state);
    drawTires(state);
    drawSuspension(state);
    drawFlags(state);
    drawFooter(state);
  }

  // --- waiting screen --------------------------------------------------------
  function drawWaiting() {
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 400);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = `rgba(127,231,196,${0.35 + 0.45 * pulse})`;
    ctx.font = `600 ${Math.round(H * 0.045)}px ui-monospace, monospace`;
    ctx.fillText('WAITING FOR TELEMETRY', W / 2, H / 2 - 16);
    ctx.fillStyle = COLORS.dim;
    ctx.font = `${Math.round(H * 0.022)}px ui-monospace, monospace`;
    ctx.fillText('run  npm run sim  and  npm run bridge', W / 2, H / 2 + 24);
    ctx.textAlign = 'start';
  }

  // --- tachometer ------------------------------------------------------------
  function drawTach(state) {
    const cx = W * 0.235;
    const cy = H * 0.54;
    const r = Math.min(W * 0.185, H * 0.42);
    const start = Math.PI * 0.75;
    const sweep = Math.PI * 1.5;
    const frac = clamp01(state.rpm / (state.rpmMax || 9500));

    // track
    ctx.lineWidth = r * 0.13;
    ctx.lineCap = 'round';
    ctx.strokeStyle = COLORS.track;
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, start + sweep);
    ctx.stroke();

    // ticks + labels every 1000 rpm
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#243247';
    ctx.fillStyle = COLORS.dim;
    ctx.font = `${Math.round(r * 0.11)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    for (let k = 0; k <= 10; k++) {
      const f = k / 10;
      const a = start + sweep * f;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(cx + cos * r * 0.86, cy + sin * r * 0.86);
      ctx.lineTo(cx + cos * r * 0.94, cy + sin * r * 0.94);
      ctx.stroke();
      if (k > 0 && k % 2 === 0) {
        ctx.fillText(String(k), cx + cos * r * 0.7, cy + sin * r * 0.7);
      }
    }

    // value arc
    const zone = frac >= 0.9 ? COLORS.danger : frac >= 0.75 ? COLORS.warn : COLORS.accent;
    ctx.strokeStyle = zone;
    ctx.lineWidth = r * 0.13;
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, start + sweep * frac);
    ctx.stroke();

    // digital rpm
    ctx.fillStyle = COLORS.dim;
    ctx.font = `${Math.round(r * 0.16)}px ui-monospace, monospace`;
    ctx.fillText('RPM', cx, cy + r * 0.42);
    ctx.fillStyle = COLORS.text;
    ctx.font = `600 ${Math.round(r * 0.24)}px ui-monospace, monospace`;
    ctx.fillText(String(Math.round(state.rpm)), cx, cy + r * 0.62);
    ctx.textAlign = 'start';
  }

  // --- shift lights ----------------------------------------------------------
  function drawShiftLights(state) {
    const n = 14;
    const segW = Math.max(8, W * 0.014);
    const gap = segW * 0.4;
    const total = n * segW + (n - 1) * gap;
    const x0 = W / 2 - total / 2;
    const y = Math.max(14, H * 0.045);
    const h = Math.max(8, H * 0.018);
    const frac = clamp01(state.rpm / (state.rpmMax || 9500));
    const litColor = (i) => (i < n * 0.45 ? COLORS.accent : i < n * 0.75 ? COLORS.warn : COLORS.danger);
    for (let i = 0; i < n; i++) {
      const lit = frac > (i + 1) / (n + 1);
      ctx.fillStyle = lit ? litColor(i) : COLORS.track;
      roundRect(x0 + i * (segW + gap), y, segW, h, h * 0.3);
      ctx.fill();
    }
  }

  // --- speed + gear ----------------------------------------------------------
  function drawSpeed(state) {
    const cx = W * 0.5;
    const cy = H * 0.5;
    const gearLabel = state.gear === 0 ? 'N' : state.gear < 0 ? 'R' : String(state.gear);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COLORS.text;
    ctx.font = `700 ${Math.round(H * 0.2)}px ui-monospace, monospace`;
    ctx.fillText(String(Math.round(state.speedKph)), cx, cy + H * 0.02);
    const speedW = ctx.measureText(String(Math.round(state.speedKph))).width;

    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.dim;
    ctx.font = `${Math.round(H * 0.03)}px ui-monospace, monospace`;
    ctx.fillText('km/h', cx, cy + H * 0.065);

    // gear chip to the right of the speed number
    const chipW = H * 0.11;
    const chipH = H * 0.09;
    const chipX = cx + speedW / 2 + H * 0.05;
    const chipY = cy - chipH / 2 - H * 0.01;
    ctx.fillStyle = '#0d1420';
    ctx.strokeStyle = COLORS.violet;
    ctx.lineWidth = 2;
    roundRect(chipX, chipY, chipW, chipH, 10);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = COLORS.text;
    ctx.font = `700 ${Math.round(chipH * 0.62)}px ui-monospace, monospace`;
    ctx.fillText(gearLabel, chipX + chipW / 2, chipY + chipH / 2 + 1);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'middle';
  }

  // --- steering --------------------------------------------------------------
  function drawSteer(state) {
    const cx = W * 0.5;
    const y = H * 0.16;
    const w = W * 0.24;
    ctx.fillStyle = COLORS.track;
    roundRect(cx - w / 2, y, w, 6, 3);
    ctx.fill();
    const x = cx + clamp01((state.steer + 1) / 2) * w - w / 2;
    ctx.fillStyle = COLORS.violet;
    roundRect(x - 4, y - 5, 8, 16, 4);
    ctx.fill();
  }

  // --- pedals ----------------------------------------------------------------
  function drawPedals(state) {
    const x = W * 0.5 - W * 0.11;
    const w = W * 0.22;
    const y0 = H * 0.8;
    const barH = Math.max(8, H * 0.016);
    const gap = barH * 1.6;
    const rows = [
      ['THR', state.throttle, COLORS.accent],
      ['BRK', state.brake, COLORS.danger],
    ];
    ctx.font = `${Math.round(H * 0.018)}px ui-monospace, monospace`;
    for (let i = 0; i < 2; i++) {
      const [label, value, color] = rows[i];
      const y = y0 + i * gap;
      ctx.fillStyle = COLORS.dim;
      ctx.textAlign = 'right';
      ctx.fillText(label, x - 8, y + barH / 2);
      ctx.fillStyle = COLORS.track;
      roundRect(x, y, w, barH, barH / 2);
      ctx.fill();
      ctx.fillStyle = color;
      roundRect(x, y, Math.max(0, w * clamp01(value)), barH, barH / 2);
      ctx.fill();
    }
    ctx.textAlign = 'start';
  }

  // --- tire temperatures (2×2 matching car layout) ---------------------------
  function drawTires(state) {
    const gridX = W * 0.7;
    const cellW = W * 0.12;
    const cellH = H * 0.14;
    const gap = W * 0.015;
    // visual order: FL FR / RL RR
    for (let i = 0; i < 4; i++) {
      const col = i % 2;
      const row = (i - col) / 2;
      const x = gridX + col * (cellW + gap);
      const y = H * 0.14 + row * (cellH + gap);
      ctx.fillStyle = '#0c121c';
      roundRect(x, y, cellW, cellH, 10);
      ctx.fill();
      ctx.strokeStyle = COLORS.track;
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = COLORS.dim;
      ctx.font = `${Math.round(H * 0.018)}px ui-monospace, monospace`;
      ctx.fillText(CORNERS[i], x + 10, y + 14);

      ctx.fillStyle = tempColor(state.tireTemp[i]);
      ctx.font = `600 ${Math.round(cellH * 0.36)}px ui-monospace, monospace`;
      ctx.fillText(state.tireTemp[i].toFixed(1), x + cellW / 2, y + cellH * 0.58, cellW - 12);
      ctx.fillStyle = COLORS.dim;
      ctx.font = `${Math.round(cellH * 0.16)}px ui-monospace, monospace`;
      ctx.fillText('°C', x + cellW / 2, y + cellH * 0.84);
    }
    ctx.textAlign = 'start';
  }

  // --- suspension travel (vertical bars, 0..80 mm) ---------------------------
  function drawSuspension(state) {
    const baseX = W * 0.7;
    const totalW = W * 0.12 * 2 + W * 0.015;
    const barW = totalW / 4 - 8;
    const yTop = H * 0.47;
    const h = H * 0.2;
    ctx.font = `${Math.round(H * 0.016)}px ui-monospace, monospace`;
    for (let i = 0; i < 4; i++) {
      const x = baseX + i * (barW + 8) + 4;
      ctx.fillStyle = COLORS.track;
      roundRect(x, yTop, barW, h, barW / 2);
      ctx.fill();
      const frac = clamp01(state.suspension[i] / 80);
      ctx.fillStyle = COLORS.violet;
      roundRect(x, yTop + h * (1 - frac), barW, h * frac, barW / 2);
      ctx.fill();
      ctx.fillStyle = COLORS.dim;
      ctx.textAlign = 'center';
      ctx.fillText(state.suspension[i].toFixed(0), x + barW / 2, yTop + h + 12);
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = COLORS.dim;
    ctx.fillText('SUSPENSION mm', baseX + totalW / 2, yTop - 12);
    ctx.textAlign = 'start';
  }

  // --- flags -----------------------------------------------------------------
  function drawFlags(state) {
    const flags = [
      ['DRS', 0x01, COLORS.accent],
      ['ABS', 0x02, COLORS.warn],
      ['TC', 0x04, '#4aa3ff'],
    ];
    const x0 = W * 0.06;
    const y = H * 0.9;
    const w = W * 0.075;
    const h = H * 0.05;
    ctx.textAlign = 'center';
    ctx.font = `600 ${Math.round(h * 0.42)}px ui-monospace, monospace`;
    for (let i = 0; i < flags.length; i++) {
      const [label, bit, color] = flags[i];
      const on = (state.flags & bit) !== 0;
      const x = x0 + i * (w + 10);
      ctx.fillStyle = on ? color : '#0c121c';
      roundRect(x, y, w, h, 8);
      ctx.fill();
      if (!on) {
        ctx.strokeStyle = COLORS.track;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.fillStyle = on ? '#05070c' : COLORS.dim;
      ctx.fillText(label, x + w / 2, y + h / 2 + 1);
    }
    ctx.textAlign = 'start';
  }

  // --- footer: lap / fuel ----------------------------------------------------
  function drawFooter(state) {
    const y = H * 0.95;
    const mm = Math.floor(state.lapTimeMs / 60000);
    const ss = Math.floor((state.lapTimeMs % 60000) / 1000);
    const ms = Math.floor(state.lapTimeMs % 1000);
    const lapTime = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
    ctx.fillStyle = COLORS.dim;
    ctx.font = `${Math.round(H * 0.02)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(
      `LAP ${state.lapNumber}  ·  ${state.lapDistancePct.toFixed(1)}%  ·  ` +
        `${lapTime}  ·  P${state.position}  ·  FUEL ${state.fuelL.toFixed(1)} L`,
      W / 2,
      y
    );
    ctx.textAlign = 'start';
  }

  return { draw, resize };
}
