/**
 * Veloq HUD renderer — direct Canvas2D painting.
 *
 * No layout tree, no component re-render: every vsync clears one rect and
 * strokes ~60 vector paths at device pixel ratio. All input comes from the
 * pre-decoded `state` object; this module allocates only during resize.
 */

const COLORS = {
  bg: '#e8eff5', // cool silver-blue, matches bg7 image tone (avoids cream flash)
  track: '#b8bfc7', // cool ash — structural lines that complement the silver bg
  dim: '#5d6673', // cool slate — labels sit with bg7's cool silver
  text: '#3a3730', // warm charcoal — primary ink (green, gold retired)
  accent: '#1763d1', // racing signal blue
  danger: '#d9261f', // racing red — hot alerts, brakes
  violet: '#7c5cd6', // deep violet — motorsport accent (no gold, no green)
  panel: '#d9d9d9', // grey container wrapper
  panelBorder: '#bfbfbf',
  panelPurple: '#e4eaf1', // cool silver-blue backdrop (matches bg7; no lavender flash)
  panelPurpleBorder: '#d3dce6',
};

// Liquid-glass panel treatment.
const GLASS_PAD = 24; // bleed painted around the pane so the edge blur looks natural
const PANEL_RADIUS = 10;

/** Temperature (°C) → colour, cool → warm → hot (harmonised to the cream/olive palette). */
const TEMP_STOPS = [
  [20, [86, 130, 166]],
  [45, [124, 92, 214]],
  [70, [183, 66, 110]],
  [90, [219, 52, 44]],
  [110, [233, 30, 26]],
];

function rampColor(stops, v) {
  if (v <= stops[0][0]) return rgb(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    const [v1, c1] = stops[i];
    if (v <= v1) {
      const [v0, c0] = stops[i - 1];
      const k = (v - v0) / (v1 - v0);
      return rgb([
        c0[0] + (c1[0] - c0[0]) * k,
        c0[1] + (c1[1] - c0[1]) * k,
        c0[2] + (c1[2] - c0[2]) * k,
      ]);
    }
  }
  return rgb(stops[stops.length - 1][1]);
}
function tempColor(t) {
  return rampColor(TEMP_STOPS, t);
}

function rgb([r, g, b]) {
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const CORNERS = ['FL', 'FR', 'RL', 'RR'];

/** Pick cream or olive text so labels stay legible on any chip colour. */
function onChipText(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#3a3730' : '#f2f6fa';
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  let W = 0;
  let H = 0;
  // Eased display values — the sim is authoritative, but we glide the drawn
  // values so the needle and digits "breathe" instead of snapping frame to frame.
  let shownRpm = 0;
  let shownKph = 0;
  let shownSteer = 0;

  // Whole-page backdrop photo, painted into the purple wrapper (loaded lazily;
  // until it arrives the wrapper simply stays lavender).
  const bg = new Image();
  bg.src = 'veloq_bg7.jpg';

  // Steering wheel SVG — the driver's wheel mirrors the left steer slider.
  const steerImg = new Image();
  steerImg.src = 'steering.svg';

  // Project logo — the alien mark (logo.svg), same baked navy as the wheel.
  const logoImg = new Image();
  logoImg.src = 'logo.svg';

  // Panel geometry (set every frame in draw()), shared by the glass layers.
  let mx = 0;
  let my = 0;
  let cw = 0;
  let ch = 0;
  // Cached frosted backdrop for the glass pane.
  let blurBuf = null;
  let glassKey = '';

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

  // Sim/non-sim switch — state, hit-area for clicks, and last frame so the
  // switch can redraw itself without waiting for the render loop.
  let simEnabled = true;
  let toggleRect = null;
  let lastState = null;
  let lastMeta = null;
  canvas.addEventListener('click', (e) => {
    if (!toggleRect) return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (
      x >= toggleRect.x &&
      x <= toggleRect.x + toggleRect.w &&
      y >= toggleRect.y &&
      y <= toggleRect.y + toggleRect.h
    ) {
      simEnabled = !simEnabled;
      if (lastState) draw(lastState, lastMeta);
    }
  });

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }

  // Frosted backdrop for the glass pane — a blurred copy of the photo behind
  // the panel, re-rendered only when the pane size or the image changes.
  function ensureGlass() {
    const key = `${cw}|${ch}|${bg.complete && bg.naturalWidth ? 'img' : ''}`;
    if (blurBuf && key === glassKey) return;
    glassKey = key;
    const bw = cw + GLASS_PAD * 2;
    const bh = ch + GLASS_PAD * 2;
    blurBuf = document.createElement('canvas');
    const bdpr = Math.min(2, window.devicePixelRatio || 1);
    blurBuf.width = Math.max(1, Math.round(bw * bdpr));
    blurBuf.height = Math.max(1, Math.round(bh * bdpr));
    const bc = blurBuf.getContext('2d');
    bc.setTransform(bdpr, 0, 0, bdpr, 0, 0);
    bc.filter = 'blur(2px)';
    if (bg.complete && bg.naturalWidth) {
      const ir = bg.naturalWidth / bg.naturalHeight;
      const ar = bw / bh;
      let dw;
      let dh;
      if (ir > ar) {
        dh = bh;
        dw = bh * ir;
      } else {
        dw = bw;
        dh = bw / ir;
      }
      bc.drawImage(bg, Math.round((bw - dw) / 2), Math.round((bh - dh) / 2), Math.round(dw), Math.round(dh));
    } else {
      bc.fillStyle = COLORS.panel;
      bc.fillRect(0, 0, bw, bh);
    }
  }

  // Apple-style liquid glass — airy, nearly transparent material that lets the
  // backdrop refract through; delicate highlights do the talking, no dark.
  function drawLiquidGlass() {
    // 1) airy coat — barely tinted, mostly transparent
    const g = ctx.createLinearGradient(0, my, 0, my + ch);
    g.addColorStop(0, 'rgba(248,250,253,0.32)');
    g.addColorStop(0.45, 'rgba(244,248,252,0.22)');
    g.addColorStop(1, 'rgba(240,245,250,0.15)');
    ctx.fillStyle = g;
    ctx.fillRect(mx, my, cw, ch);

    // 2) broad diffuse sheen — the top quarter catches soft light
    const tg = ctx.createLinearGradient(0, my, 0, my + ch * 0.22);
    tg.addColorStop(0, 'rgba(255,255,255,0.22)');
    tg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = tg;
    ctx.fillRect(mx, my, cw, ch * 0.22);

    // 3) faint diagonal wash — barely-there, no hard edge
    ctx.save();
    ctx.translate(mx + cw * 0.36, my + ch * 0.3);
    ctx.rotate(-0.35);
    const sw = cw * 0.8;
    const sh = ch * 0.16;
    const sg = ctx.createLinearGradient(-sw / 2, 0, sw / 2, 0);
    sg.addColorStop(0, 'rgba(255,255,255,0)');
    sg.addColorStop(0.5, 'rgba(255,255,255,0.09)');
    sg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(-sw / 2, -sh / 2, sw, sh);
    ctx.restore();

    // 4) soft meniscus — a slim light rim hugging the edge (all white)
    for (const [inset, lw, a] of [
      [0.5, 5, 0.03],
      [1.4, 2, 0.06],
      [2.5, 1, 0.12],
    ]) {
      ctx.strokeStyle = `rgba(255,255,255,${a})`;
      ctx.lineWidth = lw;
      roundRect(mx + inset, my + inset, cw - inset * 2, ch - inset * 2, Math.max(0, PANEL_RADIUS - inset));
      ctx.stroke();
    }

    // 5) lens sparkle — one crisp little highlight up near the top-left
    const sx = mx + cw * 0.18;
    const sy = my + ch * 0.14;
    const sr = Math.min(cw, ch) * 0.06;
    const sgd = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr);
    sgd.addColorStop(0, 'rgba(255,255,255,0.5)');
    sgd.addColorStop(0.3, 'rgba(255,255,255,0.12)');
    sgd.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sgd;
    ctx.fillRect(sx - sr, sy - sr, sr * 2, sr * 2);

    // 6) crisp micro-bevel along the very top edge
    ctx.strokeStyle = 'rgba(255,255,255,0.65)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(mx + PANEL_RADIUS, my + 1);
    ctx.lineTo(mx + cw - PANEL_RADIUS, my + 1);
    ctx.stroke();
  }

  function draw(state, meta) {
    lastState = state;
    lastMeta = meta;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);

    // full-screen backdrop photo — the image fills the whole screen, uncropped
    // (lavender only shows as letterbox strips if the window aspect differs).
    ctx.fillStyle = COLORS.panelPurple;
    ctx.fillRect(0, 0, W, H);
    if (bg.complete && bg.naturalWidth) {
      const ir = bg.naturalWidth / bg.naturalHeight;
      const ar = W / H;
      let dw;
      let dh;
      if (ir > ar) {
        dh = H;
        dw = H * ir; // wider than the screen → crop the sides, fill full height
      } else {
        dw = W;
        dh = W / ir; // taller than the screen → crop top/bottom, fill full width
      }
      ctx.drawImage(bg, Math.round((W - dw) / 2), Math.round((H - dh) / 2), Math.round(dw), Math.round(dh));
    }

    // liquid-glass panel — everything lives inside a 4% inset frosted pane
    mx = W * 0.04;
    my = H * 0.04;
    cw = W - mx * 2;
    ch = H - my * 2;
    ensureGlass();
    ctx.save();
    roundRect(mx, my, cw, ch, PANEL_RADIUS);
    ctx.clip();
    if (blurBuf) {
      ctx.drawImage(blurBuf, mx - GLASS_PAD, my - GLASS_PAD, cw + GLASS_PAD * 2, ch + GLASS_PAD * 2);
    }
    drawLiquidGlass();
    ctx.restore();
    // whisper of a rim — barely visible border
    const rim = ctx.createLinearGradient(mx, my, mx + cw, my + ch);
    rim.addColorStop(0, 'rgba(255,255,255,0.35)');
    rim.addColorStop(0.5, 'rgba(255,255,255,0.1)');
    rim.addColorStop(1, 'rgba(255,255,255,0.03)');
    ctx.strokeStyle = rim;
    ctx.lineWidth = 1;
    roundRect(mx, my, cw, ch, PANEL_RADIUS);
    ctx.stroke();

    ctx.save();
    ctx.translate(mx, my);
    const fullW = W;
    const fullH = H;
    W = cw; // widgets size themselves to the panel interior
    H = ch;

    if (!state || meta.gen === 0) {
      drawWaiting();
    } else {
      ctx.textBaseline = 'middle';
      drawShiftLights(state);
      // DRS / ABS / TC chips hidden per request (no signal value right now).
      // Restore by re-adding:  drawFlags(state);
      drawFooter(state);
      drawTach(state);
      drawSpeed(state);
      drawPedals(state);
      drawWheel(state);
      drawTires(state);
      drawSuspension(state);
      drawLogo();
      drawRailPanels(state);
    }

    W = fullW;
    H = fullH;
    ctx.restore();
  }

  // --- waiting screen --------------------------------------------------------
  function drawWaiting() {
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 400);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = `rgba(23,99,209,${0.35 + 0.45 * pulse})`;
    ctx.font = `600 ${Math.round(H * 0.034)}px ui-monospace, monospace`;
    ctx.fillText('WAITING FOR TELEMETRY', W * 0.94, H * 0.4);
    ctx.fillStyle = COLORS.dim;
    ctx.font = `${Math.round(H * 0.017)}px ui-monospace, monospace`;
    ctx.fillText('run  npm run sim  and  npm run bridge', W * 0.94, H * 0.46);
    ctx.textAlign = 'start';
  }

  // --- tachometer ------------------------------------------------------------
  function drawTach(state) {
    // A true, perfect half circle — diameter = 70% of the screen width,
    // pinned low so the whole cluster sits right at the bottom of the screen.
    const cx = W * 0.5;
    const cy = H * 0.87;
    const r = W * 0.35; // perfect circle radius → dial takes ~70% of the screen
    const start = Math.PI; // left end…
    const sweep = Math.PI; // …over the top to the right end (perfect half circle)
    const t = performance.now() / 1000;

    // glide the value so the knob never snaps
    const target = state.rpm;
    shownRpm += (target - shownRpm) * 0.3;
    if (Math.abs(target - shownRpm) > (state.rpmMax || 9500) * 0.5) {
      shownRpm = target; // teleport on reconnect/reset so it never "spins"
    }
    const frac = clamp01(shownRpm / (state.rpmMax || 9500));
    const zone = frac >= 0.88 ? COLORS.danger : COLORS.accent;
    const lw = Math.max(1.5, r * 0.007); // hairline arc — very thin

    // hairline track
    ctx.lineCap = 'round';
    ctx.lineWidth = lw;
    ctx.strokeStyle = COLORS.track;
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, start + sweep);
    ctx.stroke();

    // fine scale INSIDE the rim — majors every 2k rpm, minors half-way
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(58,55,48,0.35)';
    ctx.fillStyle = COLORS.dim;
    ctx.font = `600 ${Math.round(r * 0.075)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let k = 0; k <= 20; k++) {
      const f = k / 20;
      const a = start + sweep * f;
      const maj = k % 4 === 0;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      if (maj) {
        ctx.beginPath();
        ctx.moveTo(cx + cos * r * 0.82, cy + sin * r * 0.82);
        ctx.lineTo(cx + cos * r * 0.9, cy + sin * r * 0.9);
        ctx.stroke();
        if (k > 0) {
          ctx.fillText(String(k / 2), cx + cos * r * 0.64, cy + sin * r * 0.64);
        }
      } else {
        ctx.beginPath();
        ctx.moveTo(cx + cos * r * 0.82, cy + sin * r * 0.82);
        ctx.lineTo(cx + cos * r * 0.86, cy + sin * r * 0.86);
        ctx.stroke();
      }
    }

    // progress arc — clean, no glow
    ctx.strokeStyle = zone;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, start + sweep * frac);
    ctx.stroke();

    // round knob riding the head of the arc — pulses in the red zone
    const a = start + sweep * frac;
    const kx = cx + Math.cos(a) * r;
    const ky = cy + Math.sin(a) * r;
    const knobR = Math.max(5, lw * 2.8);
    const pulse = frac >= 0.9 ? 1 + 0.1 * Math.sin(t * 9) : 1;
    ctx.fillStyle = zone;
    ctx.beginPath();
    ctx.arc(kx, ky, knobR * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = COLORS.bg;
    ctx.lineWidth = Math.max(1.5, lw * 0.5);
    ctx.stroke();

    // digital rpm inside the dial
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.text;
    ctx.font = `600 ${Math.round(r * 0.24)}px ui-monospace, monospace`;
    ctx.fillText(String(Math.round(shownRpm)), cx, cy - r * 0.3);
    ctx.fillStyle = COLORS.dim;
    ctx.font = `${Math.round(r * 0.1)}px ui-monospace, monospace`;
    ctx.fillText('RPM', cx, cy - r * 0.08);
    ctx.textAlign = 'start';
  }

  // --- shift lights ----------------------------------------------------------
  function drawShiftLights(state) {
    // three full rows stacked on the right — a "cascade tree". Rows light from
    // the bottom tier up as revs climb: low = blue, mid = violet, top = red.
    const rows = 3;
    const per = 12; // segments per row
    const segW = Math.max(8, W * 0.014);
    const gap = segW * 0.4;
    const total = per * segW + (per - 1) * gap;
    // right side — flush to the panel's right edge, top-aligned with the
    // flag chips (DRS/ABS/TC row) so the cluster shares its roofline
    const x0 = W - W * 0.015 - total; // right edge at W - 1.5%, like the lap card
    const h = Math.max(8, H * 0.014);
    const rowGap = gap;
    const y0 = H * 0.045; // same top line as the flags row
    const frac = clamp01(state.rpm / (state.rpmMax || 9500));
    const litCount = Math.round(frac * rows * per);
    const rowColor = [COLORS.accent, COLORS.violet, COLORS.danger];
    for (let i = 0; i < rows * per; i++) {
      const r = Math.floor(i / per); // 0 bottom … 2 top tier
      const c = i % per;
      const lit = i < litCount;
      ctx.fillStyle = lit ? rowColor[r] : COLORS.track;
      roundRect(x0 + c * (segW + gap), y0 + (rows - 1 - r) * (h + rowGap), segW, h, h * 0.3);
      ctx.fill();
    }
  }

  // --- speed + gear (single row inside the dial's mouth, never covering it) --
  function drawSpeed(state) {
    const cx = W * 0.5;
    const cy = H * 0.87;
    const r = W * 0.35;
    const gearLabel = state.gear === 0 ? 'N' : state.gear < 0 ? 'R' : String(state.gear);

    // glide the displayed speed the same way the knob glides
    const target = state.speedKph;
    shownKph += (target - shownKph) * 0.3;
    if (Math.abs(target - shownKph) > 200) shownKph = target;

    const yNum = cy + r * 0.06; // just below the dial's flat edge
    const speed = String(Math.round(shownKph));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.text;
    ctx.font = `700 ${Math.round(H * 0.105)}px ui-monospace, monospace`;
    ctx.fillText(speed, cx, yNum);
    const speedW = ctx.measureText(speed).width;

    ctx.fillStyle = COLORS.dim;
    ctx.font = `${Math.round(H * 0.028)}px ui-monospace, monospace`;
    const labelGap = H * 0.045; // clear space between the readout and its unit
    ctx.fillText('km/h', cx + speedW / 2 + labelGap, yNum);

    // gear chip to the right of the readout — liquid glass, not a cream box
    const chipW = H * 0.075;
    const chipH = H * 0.075;
    const chipGap = H * 0.025;
    const chipX = cx + speedW / 2 + labelGap + ctx.measureText('km/h').width + chipGap;
    const chipY = yNum - chipH / 2;
    const cg = ctx.createLinearGradient(chipX, 0, chipX, chipY + chipH);
    cg.addColorStop(0, 'rgba(255,255,255,0.6)');
    cg.addColorStop(1, 'rgba(255,255,255,0.22)');
    ctx.fillStyle = cg;
    ctx.strokeStyle = COLORS.violet;
    ctx.lineWidth = 1.5;
    roundRect(chipX, chipY, chipW, chipH, 10);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = COLORS.text;
    ctx.font = `700 ${Math.round(chipH * 0.6)}px ui-monospace, monospace`;
    ctx.fillText(gearLabel, chipX + chipW / 2, chipY + chipH / 2 + 1);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'middle';
  }

  // --- steering wheel (top-right, now owns the FL/FR slot) -------------------
  // The driver's wheel mirrors the left steer slider: it glides to the live
  // steer value and adds a tiny road-wobble while moving, so it reads as a
  // real wheel held in the driver's hands.
  function drawWheel(state) {
    const gridX = W * 0.8;
    const cellW = W * 0.09;
    const gap = W * 0.012;
    const cx = gridX + cellW + gap / 2; // centre of the tire-grid column
    const cy = H * 0.31; // sits where the FL/FR grid used to be
    const r = H * 0.09;

    // glass disc behind the wheel — same ivory treatment as the tire cells
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.strokeStyle = 'rgba(93,102,115,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // eased steer → rotation. Full lock is ~±140°; steer -1 = marker far left
    // on the slider, which visually turns the wheel left (counter-clockwise).
    const target = state.steer ?? 0;
    shownSteer += (target - shownSteer) * 0.3;
    if (Math.abs(target - shownSteer) > 1) shownSteer = target;
    let ang = shownSteer * 2.4;
    if ((state.speedKph ?? 0) > 0) {
      ang += Math.sin(performance.now() / 90) * 0.035; // driver micro-corrections
    }

    if (steerImg.complete && steerImg.naturalWidth > 0) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ang);
      ctx.drawImage(steerImg, -r, -r, r * 2, r * 2);
      ctx.restore();
    } else {
      // placeholder ring until the svg is ready
      ctx.strokeStyle = COLORS.dim;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.7, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // --- pedals: compact THR/BRK stack beside the km/h row, clear gap ----------
  function drawPedals(state) {
    const cy = H * 0.87;
    const r = W * 0.35;
    const yNum = cy + r * 0.06; // same baseline as the km/h readout
    const x = W * 0.3;
    const w = W * 0.09;
    const barH = Math.max(8, H * 0.016);
    const gap = barH * 1.6;
    // the two bars form one block whose geometric centre sits exactly on the
    // km/h baseline — the old yNum + (i-0.5)*… formula left it half a bar low.
    const blockH = barH * 2 + gap;
    const yTop = yNum - blockH / 2;
    const rows = [
      ['THR', state.throttle, COLORS.accent],
      ['BRK', state.brake, COLORS.danger],
    ];
    ctx.font = `${Math.round(H * 0.018)}px ui-monospace, monospace`;
    ctx.textBaseline = 'middle';
    for (let i = 0; i < 2; i++) {
      const [label, value, color] = rows[i];
      const y = yTop + i * (barH + gap);
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
    ctx.textBaseline = 'middle';
  }

  // --- tire temperatures — compact 2×2 panel at the bottom of the speedo ---
  // Redesigned (restructured, no icons): a single glass panel tucked below the
  // dial's right edge where the fuel cell used to be. Each corner is a slim
  // glass cell: tag + value in the cool ramp colour + a thin heat bar.
  function drawTires(state) {
    const panelX = W * 0.86; // shifted right — clear of the dial's right arc end
    const panelY = H * 0.82;
    const panelW = W * 0.125;
    const panelH = H * 0.16;

    // glass panel
    const g = ctx.createLinearGradient(panelX, 0, panelX, panelY + panelH);
    g.addColorStop(0, 'rgba(255,255,255,0.32)');
    g.addColorStop(1, 'rgba(255,255,255,0.12)');
    ctx.fillStyle = g;
    roundRect(panelX, panelY, panelW, panelH, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(93,102,115,0.30)';
    roundRect(panelX + 0.5, panelY + 0.5, panelW - 1, panelH - 1, 9.5);
    ctx.stroke();

    // heading
    ctx.fillStyle = COLORS.dim;
    ctx.font = `600 ${Math.round(H * 0.013)}px ui-monospace, monospace`;
    ctx.textAlign = 'start';
    ctx.textBaseline = 'middle';
    ctx.fillText('TIRE · °C', panelX + 10, panelY + H * 0.024);

    const gap = 7;
    const cellW = (panelW - 10 * 2 - gap) / 2;
    const cellH = (panelH - H * 0.05 - gap) / 2;
    const x0 = panelX + 10;
    const y0 = panelY + H * 0.05;
    for (let i = 0; i < 4; i++) {
      const col = i % 2;
      const row = (i - col) / 2;
      const x = x0 + col * (cellW + gap);
      const y = y0 + row * (cellH + gap);
      const t = state.tireTemp[i];
      const tc = tempColor(t);

      // slim glass cell
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      roundRect(x, y, cellW, cellH, 8);
      ctx.fill();

      // corner tag
      ctx.fillStyle = COLORS.dim;
      ctx.font = `700 ${Math.round(H * 0.012)}px ui-monospace, monospace`;
      ctx.textAlign = 'left';
      ctx.fillText(CORNERS[i], x + 6, y + 8);

      // value in the ramp colour
      ctx.fillStyle = tc;
      ctx.font = `700 ${Math.round(cellH * 0.42)}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(t.toFixed(1), x + cellW / 2, y + cellH * 0.5);

      // thin heat bar
      const barW = cellW * 0.7;
      const barX = x + (cellW - barW) / 2;
      const barY = y + cellH - 8;
      ctx.fillStyle = 'rgba(93,102,115,0.25)';
      roundRect(barX, barY, barW, 3, 1.5);
      ctx.fill();
      ctx.fillStyle = tc;
      roundRect(barX, barY, Math.max(3, barW * clamp01(t / 110)), 3, 1.5);
      ctx.fill();
    }
    ctx.textAlign = 'start';
    ctx.textBaseline = 'middle';
  }

  // --- suspension travel (vertical bars, 0..80 mm), above the tire cells --------
  // Same liquid-glass panel language as the tire cells — compact 4-corner bar
  // readout. The whole right column is shifted clear of the tach arc.
  function drawSuspension(state) {
    const panelX = W * 0.86; // right edge flush with the tire panel + shift lights
    const panelY = H * 0.70;
    const panelW = W * 0.125;
    const panelH = H * 0.115;

    // glass panel
    const g = ctx.createLinearGradient(panelX, 0, panelX, panelY + panelH);
    g.addColorStop(0, 'rgba(255,255,255,0.32)');
    g.addColorStop(1, 'rgba(255,255,255,0.12)');
    ctx.fillStyle = g;
    roundRect(panelX, panelY, panelW, panelH, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(93,102,115,0.30)';
    roundRect(panelX + 0.5, panelY + 0.5, panelW - 1, panelH - 1, 9.5);
    ctx.stroke();

    // heading
    ctx.fillStyle = COLORS.dim;
    ctx.font = `600 ${Math.round(H * 0.013)}px ui-monospace, monospace`;
    ctx.textAlign = 'start';
    ctx.textBaseline = 'middle';
    ctx.fillText('SUSPENSION · mm', panelX + 10, panelY + H * 0.02);

    const pad = 10;
    const innerX = panelX + pad;
    const innerW = panelW - pad * 2;
    const barW = Math.max(10, innerW * 0.16);
    const barGap = (innerW - barW * 4) / 3;
    const barH = panelH * 0.34;
    const barTop = panelY + panelH * 0.42;
    const tagY = panelY + panelH * 0.3;
    const valY = panelY + panelH * 0.88;

    for (let i = 0; i < 4; i++) {
      const x = innerX + i * (barW + barGap);
      const v = state.suspension[i];
      const frac = clamp01(Math.abs(v) / 80);
      // corner tag
      ctx.fillStyle = COLORS.dim;
      ctx.font = `700 ${Math.round(H * 0.0115)}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(CORNERS[i], x + barW / 2, tagY);
      // track
      ctx.fillStyle = 'rgba(93,102,115,0.2)';
      roundRect(x, barTop, barW, barH, barW / 2);
      ctx.fill();
      // centre-zero hairline
      ctx.strokeStyle = 'rgba(93,102,115,0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - 2, barTop + barH / 2);
      ctx.lineTo(x + barW + 2, barTop + barH / 2);
      ctx.stroke();
      // deviation bar (v<0 = bump/compression → accent; v>0 = extension → violet)
      ctx.fillStyle = v < 0 ? 'rgba(23,99,209,0.6)' : COLORS.violet;
      const hh = barH * 0.5 * frac;
      roundRect(x, barTop + barH / 2 - (v < 0 ? hh : 0), barW, hh, barW / 2);
      ctx.fill();
      // value
      ctx.fillStyle = COLORS.dim;
      ctx.font = `600 ${Math.round(H * 0.012)}px ui-monospace, monospace`;
      ctx.fillText(Math.abs(v).toFixed(0), x + barW / 2, valY);
    }
    ctx.textAlign = 'start';
    ctx.textBaseline = 'middle';
  }

  // --- flags → upper-left corner -------------------------------------------------
  function drawFlags(state) {
    const flags = [
      ['DRS', 0x01, COLORS.accent, 'zap'],
      ['ABS', 0x02, COLORS.danger, 'alert'],
      ['TC', 0x04, COLORS.violet, 'gauge'],
    ];
    const x0 = W * 0.04;
    const y = H * 0.045;
    const w = W * 0.075;
    const h = H * 0.046;
    const gap = 14;
    // Fixed internal grid so every chip lines up identically regardless of
    // glyph geometry: the icon lives in a square of side h at the pill's
    // left edge, label starts at a fixed gutter after that square.
    const ico = Math.round(h * 0.5);
    const iInset = Math.round((h - ico) / 2);
    for (let i = 0; i < flags.length; i++) {
      const [label, bit, color, icon] = flags[i];
      const on = (state.flags & bit) !== 0;
      const x = x0 + i * (w + gap);
      const labelX = x + Math.round(h * 0.75) + 10;
      // status pill with a lucide icon
      if (on) {
        ctx.fillStyle = color;
      } else {
        const og = ctx.createLinearGradient(x, 0, x, y + h);
        og.addColorStop(0, 'rgba(255,255,255,0.55)');
        og.addColorStop(1, 'rgba(255,255,255,0.2)');
        ctx.fillStyle = og;
      }
      roundRect(x, y, w, h, h / 2);
      ctx.fill();
      ctx.strokeStyle = on ? 'rgba(255,255,255,0.55)' : 'rgba(93,102,115,0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();
      // icon — centered in its fixed square, never touching the pill edge
      drawIcon(icon, x + iInset, y + iInset, ico, on ? onChipText(color) : COLORS.dim);
      ctx.fillStyle = on ? onChipText(color) : COLORS.dim;
      ctx.font = `700 ${Math.round(h * 0.34)}px ui-monospace, monospace`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, labelX, y + h / 2 + 1);
    }
    ctx.textAlign = 'start';
    ctx.textBaseline = 'middle';
  }

  // --- top-left readout: LAP (racing flag beside) on the shift-lights roofline,
  // left-aligned with the comms card; time / P / fuel on the line below --------
  function drawFooter(state) {
    const x0 = W * 0.02; // flush-left with the driver-comms container (lx)
    const lapY = H * 0.07;
    const mm = Math.floor(state.lapTimeMs / 60000);
    const ss = Math.floor((state.lapTimeMs % 60000) / 1000);
    const ms = Math.floor(state.lapTimeMs % 1000);
    const lapTime = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;

    // row 1 — racing flag + lap text
    const flagS = Math.round(H * 0.03);
    drawSvg('flag', x0, lapY - flagS * 0.5, flagS, COLORS.violet);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.text;
    ctx.font = `800 ${Math.round(H * 0.032)}px ui-monospace, monospace`;
    ctx.fillText(`LAP ${state.lapNumber}`, x0 + flagS + W * 0.011, lapY);

    // row 2 — time / position / fuel directly under the lap text
    ctx.fillStyle = COLORS.dim;
    ctx.font = `${Math.round(H * 0.016)}px ui-monospace, monospace`;
    ctx.fillText(
      `${lapTime}  ·  P${state.position}  ·  FUEL ${state.fuelL.toFixed(1)} L`,
      x0,
      H * 0.105
    );
  }

  // --- project logo — the alien mark (logo.svg). Baked navy line-art, drawn
  // top-centre on the same band as the shift lights (right) and the LAP
  // readout (left); a faint frosted disc keeps the lines readable on the
  // photo, matching the wheel's glass-disc treatment.
  function drawLogo() {
    if (!(logoImg.complete && logoImg.naturalWidth > 0)) return;

    const cx = W * 0.5;
    const s = H * 0.07;
    const top = H * 0.016;
    const discCy = top + s * 0.5;
    const discR = s * 0.36;

    // faint frosted disc behind the head (antennas stay clear above it)
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, discCy, discR, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.drawImage(logoImg, cx - s / 2, top, s, s);
  }

  // --- real Lucide icons (path data from lucide-static, viewBox 24) ----------
  // Circles are expanded to full-circle arc pairs; everything strokes at 2u.
  const ICONS = {
    flag: 'M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528',
    msg: 'M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z',
    timer: 'M10 2 L14 2 M12 14 L15 11 M4 14 A8 8 0 1 1 20 14 A8 8 0 1 1 4 14 Z',
    clock: 'M2 12 A10 10 0 1 1 22 12 A10 10 0 1 1 2 12 Z M12 6v6l4 2',
    user: 'M8 7 A4 4 0 1 1 16 7 A4 4 0 1 1 8 7 Z M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2',
    car: 'M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2 M5 17 A2 2 0 1 1 9 17 A2 2 0 1 1 5 17 Z M9 17h6 M15 17 A2 2 0 1 1 19 17 A2 2 0 1 1 15 17 Z',
    thermo: 'M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z',
    alert: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3 M12 9v4 M12 17h.01',
    gauge: 'm12 14 4-4 M3.34 19a10 10 0 1 1 17.32 0',
    zap: 'M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z',
    tire: 'M5 12 A7 7 0 1 1 19 12 A7 7 0 1 1 5 12 Z M9.5 12 A2.5 2.5 0 1 1 14.5 12 A2.5 2.5 0 1 1 9.5 12 Z',
  };

  function drawIcon(kind, x, y, s, color) {
    const d = ICONS[kind];
    if (!d) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s / 24, s / 24);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(new Path2D(d));
    ctx.restore();
  }

  // --- user-drawn SVG icons (exact path data from Downloads/*.svg) -----------
  // Each entry stores its viewBox so we scale 1:1 like drawIcon; paths stroke
  // with the supplied HUD color instead of the baked-in navy.
  const SVG_ICONS = {
    support: { vb: 107, paths: [
      'M75.792 48.1701C75.792 46.6288 75.792 45.8584 76.0238 45.1718C76.6979 43.1765 78.475 42.4021 80.2552 41.5913C82.2566 40.6797 83.257 40.2239 84.2486 40.1437C85.3743 40.0527 86.5018 40.2952 87.4639 40.8352C88.7394 41.551 89.6289 42.9112 90.5397 44.0172C94.7457 49.1255 96.8483 51.6801 97.6178 54.4969C98.2388 56.7697 98.2388 59.1469 97.6178 61.4198C96.4956 65.5281 92.9499 68.9722 90.3253 72.1599C88.9829 73.7903 88.3114 74.6058 87.4639 75.0815C86.5018 75.6214 85.3743 75.8639 84.2486 75.7729C83.257 75.6927 82.2566 75.2371 80.2552 74.3253C78.475 73.5144 76.6979 72.7404 76.0238 70.7448C75.792 70.0583 75.792 69.2879 75.792 67.7466V48.1701Z',
      'M31.2087 48.1705C31.2087 46.2303 31.1542 44.4862 29.5854 43.1219C29.0148 42.6257 28.2584 42.2811 26.7455 41.592C24.7441 40.6804 23.7434 40.2247 22.7519 40.1445C19.7771 39.9039 18.1766 41.9343 16.4611 44.0179C12.2552 49.1264 10.1522 51.6806 9.38271 54.4973C8.76175 56.7706 8.76175 59.1478 9.38271 61.4207C10.5051 65.529 14.0509 68.9727 16.6754 72.1608C18.3298 74.1702 19.9102 76.0035 22.7519 75.7738C23.7434 75.6936 24.7441 75.2375 26.7455 74.3262C28.2584 73.637 29.0148 73.2923 29.5854 72.7961C31.1542 71.4319 31.2087 69.6882 31.2087 67.7475V48.1705Z',
      'M22.292 40.125C22.292 25.3514 36.2645 13.375 53.5003 13.375C70.7362 13.375 84.7087 25.3514 84.7087 40.125',
      'M84.708 75.792V79.3587C84.708 87.2379 76.7236 93.6253 66.8747 93.6253H57.958',
    ] },
    userCircle: { vb: 79, paths: [
      'M60.8909 63.0394C57.0703 57.2813 50.3454 53.3283 42.5659 52.8543L39.4951 52.667C38.3983 52.6943 37.3762 52.7308 36.4118 52.774C28.6945 53.1199 21.9425 57.2082 18.1045 63.0394',
      'M49.3623 32.917C49.3623 38.371 44.941 42.792 39.4873 42.792C34.0334 42.792 29.6123 38.371 29.6123 32.917C29.6123 27.4632 34.0334 23.042 39.4873 23.042C44.941 23.042 49.3623 27.4632 49.3623 32.917Z',
      'M72.4163 39.4997C72.4163 57.6789 57.6789 72.4163 39.4997 72.4163C21.3203 72.4163 6.58301 57.6789 6.58301 39.4997C6.58301 21.3203 21.3203 6.58301 39.4997 6.58301C57.6789 6.58301 72.4163 21.3203 72.4163 39.4997Z',
    ] },
    flag: { vb: 84, paths: [
      'M19.8513 48.6833C35 55.7627 49 27.4459 73.5 41.6041L63 9.74757C46.9837 -1.04971 29.97 23.9974 10.5 16.1883L28.0002 77',
      'M66.5 24.5025C47.25 10.5026 31.5 42.0024 15.75 31.5022',
      'M28 17.1667L37.8822 45.5M46.1178 10.5L56 37.1665',
    ] },
  };

  function drawSvg(kind, x, y, s, color) {
    const ic = SVG_ICONS[kind];
    if (!ic) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s / ic.vb, s / ic.vb);
    ctx.strokeStyle = color;
    // lineWidth lives in the scaled space, so compensate to keep a constant
    // 2px visual stroke regardless of viewBox size (Lucide is 24u; these
    // user icons are 79–107u and would otherwise stroke at <1px).
    ctx.lineWidth = (2 * ic.vb) / s;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const d of ic.paths) ctx.stroke(new Path2D(d));
    ctx.restore();
  }

  // --- translucent glass card used by the data rails --------------------------
  function card(x, y, w, h, heading, iconKind) {
    const g = ctx.createLinearGradient(x, 0, x, y + h);
    g.addColorStop(0, 'rgba(255,255,255,0.32)');
    g.addColorStop(1, 'rgba(255,255,255,0.12)');
    ctx.fillStyle = g;
    roundRect(x, y, w, h, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(93,102,115,0.30)';
    roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 9.5);
    ctx.stroke();
    ctx.fillStyle = COLORS.dim;
    ctx.font = `600 ${Math.round(H * 0.015)}px ui-monospace, monospace`;
    ctx.textAlign = 'start';
    ctx.textBaseline = 'middle';
    const s = Math.round(H * 0.024);
    const ix = x + w * 0.07;
    const iy = y + h * 0.18;
    if (iconKind) {
      drawIcon(iconKind, ix - s * 0.5, iy - s * 0.5, s, COLORS.dim);
    }
    ctx.fillText(heading, ix + (iconKind ? s + 5 : 0), iy);
  }

  // --- driver comms: live voice-transcription message box ------------------
  // Mirrors an external feed (state.comms: objects {who,text} or strings).
  // With no feed it plays a scripted transcript at a spoken cadence, so the
  // box always reads like a real-time transcription of team voice.
  const COMMS_SCRIPT = [
    { who: 'PIT', text: 'box box — confirm in 3' },
    { who: 'DRV', text: 'copy, boxing this lap' },
    { who: 'PIT', text: 'car ahead is on hards' },
    { who: 'DRV', text: 'keeping station behind' },
    { who: 'PIT', text: 'P3 in reach — push now' },
    { who: 'DRV', text: 'holding it, all clear' },
  ];
  let commsKey = null;
  let commsLog = [];
  let commsCursor = 0;
  let commsNextAt = 0;

  function updateComms(state, now) {
    const feed = Array.isArray(state.comms) && state.comms.length ? state.comms : null;
    const key = feed ? `${feed.length}:${String(feed[feed.length - 1].text)}` : null;
    if (key !== commsKey) {
      commsKey = key;
      if (feed) {
        commsLog = feed
          .map((m) => (typeof m === 'string' ? { who: 'PIT', text: m } : m))
          .slice(-6);
      } else {
        commsCursor = 0;
        commsNextAt = 0;
        commsLog = [];
      }
    }
    if (!feed && now >= commsNextAt && commsCursor < COMMS_SCRIPT.length) {
      commsLog.push({ ...COMMS_SCRIPT[commsCursor] });
      commsLog = commsLog.slice(-6);
      commsCursor += 1;
      commsNextAt = now + 1100;
    }
  }

  function drawCommsCard(state, x, y, w, h) {
    const now = performance.now();
    updateComms(state, now);

    // no glass box — the transcript floats straight on the pane, with a soft
    // fade at the top and bottom of the list (clean mobile-messenger look).
    const blink = (now % 900) < 450;
    const micS = Math.round(H * 0.024);
    const hy = y + h * 0.09;
    drawSvg('support', x + w * 0.07 - micS * 0.5, hy - micS * 0.5, micS, COLORS.dim);
    ctx.fillStyle = COLORS.dim;
    ctx.font = `600 ${Math.round(H * 0.015)}px ui-monospace, monospace`;
    ctx.textAlign = 'start';
    ctx.textBaseline = 'middle';
    ctx.fillText('DRIVER COMMS', x + w * 0.07 + micS + 5, hy);
    const badgeX = x + w - w * 0.07 - 30;
    ctx.fillStyle = blink ? COLORS.danger : 'rgba(93,102,115,0.5)';
    ctx.beginPath();
    ctx.arc(badgeX - 6, hy, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.dim;
    ctx.font = `800 ${Math.round(H * 0.012)}px ui-monospace, monospace`;
    ctx.fillText('LIVE', badgeX, hy);

    // transcript — mobile-messenger bubbles: PIT on the left, DRV on the right,
    // sender name above the bubble, a little tail on the speaker's side. Up to
    // six messages; the list fades out at the top and bottom edges.
    const msgFont = Math.round(H * 0.015);
    const charW = H * 0.0095;
    const padX = 10;
    const bMax = w * 0.68;
    const bh = Math.round(H * 0.022);
    const step = bh + Math.round(H * 0.012);
    const chatTop = y + h * 0.2;
    let by = chatTop;
    let lastBottom = by + bh;
    commsLog.slice(-6).forEach((m) => {
      const isPit = m.who === 'PIT';
      const text = m.text.slice(0, 38);
      const bw = Math.min(bMax, padX * 2 + text.length * charW);
      const bx = isPit ? x + w * 0.06 : x + w * 0.94 - bw;
      // sender name above the bubble
      ctx.textAlign = isPit ? 'start' : 'end';
      ctx.fillStyle = isPit ? COLORS.accent : COLORS.violet;
      ctx.font = `800 ${Math.round(H * 0.011)}px ui-monospace, monospace`;
      ctx.fillText(isPit ? 'PIT' : 'DRV', isPit ? bx + 2 : bx + bw - 2, by - H * 0.005);
      // bubble body — tinted glass with a thin matching rim
      ctx.fillStyle = isPit ? 'rgba(23,99,209,0.20)' : 'rgba(124,92,214,0.28)';
      ctx.strokeStyle = isPit ? 'rgba(23,99,209,0.55)' : 'rgba(124,92,214,0.55)';
      ctx.lineWidth = 1;
      roundRect(bx, by, bw, bh, 8);
      ctx.fill();
      ctx.stroke();
      // chat tail on the speaker's side
      ctx.beginPath();
      if (isPit) {
        ctx.moveTo(bx + 6, by + bh);
        ctx.lineTo(bx + 1, by + bh - 4);
        ctx.lineTo(bx + 9, by + bh);
      } else {
        ctx.moveTo(bx + bw - 6, by + bh);
        ctx.lineTo(bx + bw - 1, by + bh - 4);
        ctx.lineTo(bx + bw - 9, by + bh);
      }
      ctx.closePath();
      ctx.fill();
      // transcribed message
      ctx.textAlign = 'start';
      ctx.fillStyle = COLORS.text;
      ctx.font = `${msgFont}px ui-monospace, monospace`;
      ctx.fillText(text, bx + padX, by + bh / 2);
      lastBottom = by + bh;
      by += step;
    });

    // fixed-height list window — the fades hug the section edges, not the
    // content, so the pane always reads the same height even past 6 messages
    // (the list simply clips and fades at the same top/bottom boundaries).
    const listTop = chatTop;
    const listBottom = y + h * 0.97;
    const fadeH = H * 0.045;
    const tint = 'rgba(235,241,248,';
    const tf = ctx.createLinearGradient(0, listTop - 4, 0, listTop + fadeH);
    tf.addColorStop(0, tint + '0.95)');
    tf.addColorStop(1, tint + '0)');
    ctx.fillStyle = tf;
    ctx.fillRect(x - 8, listTop - 4, w + 16, fadeH + 4);
    const bf = ctx.createLinearGradient(0, listBottom - fadeH, 0, listBottom + 4);
    bf.addColorStop(0, tint + '0)');
    bf.addColorStop(1, tint + '0.95)');
    ctx.fillStyle = bf;
    ctx.fillRect(x - 8, listBottom - fadeH, w + 16, fadeH + 4);
  }

  // --- data rails: comms / pit / laps (left), progress (right) ---------------
  function drawRailPanels(state) {
    const lx = W * 0.02; // left rail — clears the dial's left arc at every card height
    const lw = W * 0.15;
    const lwComms = W * 0.19; // comms is the primary panel — wider, still clear of the arc

    // driver comms — live voice-transcription chat list (up to 6 messages,
    // clean messenger look: no box, soft fades at the top and bottom).
    // Kept high and slim so it never touches the LAPS card below it.
    const y1 = H * 0.17;
    const h1 = H * 0.27;
    drawCommsCard(state, lx, y1, lwComms, h1);

    // last / fastest lap — clean timing list, no glass box (matches the
    // floating messenger rows of the comms list above): a small timer mark,
    // then LAST / FASTEST / GAP rows all flush-left at the rail edge (lx).
    const y3 = H * 0.505;
    const ts = Math.round(H * 0.024);
    drawIcon('timer', lx, y3 + H * 0.012, ts, COLORS.dim);
    const fmt = (ms) => {
      const t = ms || 0;
      const m = Math.floor(t / 60000);
      const s = Math.floor((t % 60000) / 1000);
      const f = Math.floor(t % 1000);
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(f).padStart(3, '0')}`;
    };
    const gapMs = Math.max(0, (state.lastLapMs ?? state.lapTimeMs) - (state.fastestLapMs ?? state.lapTimeMs));
    const rows = [
      ['LAST', fmt(state.lastLapMs ?? state.lapTimeMs), COLORS.text],
      ['FASTEST', fmt(state.fastestLapMs ?? state.lapTimeMs), COLORS.violet],
    ];
    if (gapMs > 0) rows.push(['GAP', `+${(gapMs / 1000).toFixed(3)}s`, COLORS.dim]);
    const rowY0 = y3 + H * 0.055;
    const rowDy = H * 0.032;
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${Math.round(H * 0.012)}px ui-monospace, monospace`;
    rows.forEach(([k, v, c], i) => {
      // label flush-left with the rail
      ctx.fillStyle = COLORS.dim;
      ctx.textAlign = 'start';
      ctx.fillText(k, lx, rowY0 + i * rowDy);
      // value right-aligned to the same column edge, mono bold
      ctx.fillStyle = c;
      ctx.font = `800 ${Math.round(H * 0.018)}px ui-monospace, monospace`;
      ctx.textAlign = 'end';
      ctx.fillText(v, lx + lw * 0.95, rowY0 + i * rowDy);
      ctx.font = `600 ${Math.round(H * 0.012)}px ui-monospace, monospace`;
    });
    ctx.textAlign = 'start';

    drawSimToggle(state);
  }

  // --- driver pill (bottom-left) — inherits the old sim-switch structure:
  // same pill, same blue knob, now carrying a white profile icon and the
  // driver's identity instead of the sim/non-sim label pair.
  function drawSimToggle(state) {
    const tx = W * 0.02; // flush-left with the rest of the left rail (footer / comms / laps)
    const ty = H * 0.89; // bottom aligned with the tire panel (both sit at 0.98H)
    const tw = W * 0.24;
    const th = H * 0.09;

    // pill
    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    roundRect(tx, ty, tw, th, th / 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // knob — the blue circle stays; a white round profile icon sits on top
    const kr = th * 0.28;
    const pad = th * 0.14;
    const kx = tx + tw - kr - pad;
    const ky = ty + th / 2;
    ctx.fillStyle = COLORS.accent;
    ctx.beginPath();
    ctx.arc(kx, ky, kr, 0, Math.PI * 2);
    ctx.fill();
    const ico = Math.round(kr * 1.5);
    drawSvg('userCircle', kx - ico / 2, ky - ico / 2, ico, '#ffffff');

    // notation — driver identity inside the pill
    const textX = tx + pad + kr + 12;
    ctx.textAlign = 'start';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.text;
    ctx.font = `700 ${Math.round(H * 0.02)}px ui-monospace, monospace`;
    ctx.fillText(state.driver ?? 'T. KOWALSKI', textX, ty + th * 0.36);
    ctx.fillStyle = COLORS.dim;
    ctx.font = `${Math.round(H * 0.014)}px ui-monospace, monospace`;
    ctx.fillText(`${state.carClass ?? 'GT3'} · ${state.carStatus ?? 'NOMINAL'}`, textX, ty + th * 0.7);

    toggleRect = { x: mx + tx, y: my + ty, w: tw, h: th };
  }

  return { draw, resize, setSim: (v) => { simEnabled = !!v; } };
}
