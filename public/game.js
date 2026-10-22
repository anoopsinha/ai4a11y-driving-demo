// game.js — the racing game, and nothing else. No accessibility code lives
// here; it exposes a settings object the surface (surface.js) fills in, an
// input object the host drives, and events the host turns into sound, speech
// or captions.
//
// Pseudo-3D road in the Pole Position tradition: the track is a list of
// segments, each with a curve and a height; the camera sits behind the car and
// projects segments to screen quads. (The technique is the classic one Jake
// Gordon documented for "javascript-racer"; this is a small re-telling.)

const SEG = 200;            // segment length, world units
const RUMBLE = 3;           // segments per rumble stripe
const LANES = 3;
const DRAW = 300;           // segments drawn ahead
const CAMERA_HEIGHT = 1000;
const FOV = 100;
const CENTRIFUGAL = 0.3;    // how hard a curve pushes the car outward
const MAX_SPEED = SEG * 60; // one segment per frame at 60fps

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const ease = {
  in: (a, b, p) => a + (b - a) * p * p,
  out: (a, b, p) => a + (b - a) * (1 - (1 - p) * (1 - p)),
  inOut: (a, b, p) => a + (b - a) * (-Math.cos(p * Math.PI) / 2 + 0.5),
};

// ── the track ────────────────────────────────────────────────────────────────
// Built from named sections so the game can say where the player is. Curves
// ease in and out; `curve` is the per-segment horizontal drift (±2 gentle,
// ±4 medium, ±6 sharp), `y` the height.
function buildTrack() {
  const segs = [];
  const lastY = () => (segs.length ? segs[segs.length - 1].p2.y : 0);
  const add = (curve, y, section) => {
    const i = segs.length;
    segs.push({ index: i, section, curve, p1: { y: lastY(), z: i * SEG }, p2: { y, z: (i + 1) * SEG } });
  };
  const road = (enter, hold, leave, curve, y, section) => {
    const startY = lastY();
    const endY = startY + y * SEG;
    const total = enter + hold + leave;
    for (let n = 0; n < enter; n++) add(ease.in(0, curve, n / enter), ease.inOut(startY, endY, n / total), section);
    for (let n = 0; n < hold; n++) add(curve, ease.inOut(startY, endY, (enter + n) / total), section);
    for (let n = 0; n < leave; n++) add(ease.inOut(curve, 0, n / leave), ease.inOut(startY, endY, (enter + hold + n) / total), section);
  };

  // About 1,500 segments: a lap takes about 25 s flat out, a minute or so for a
  // careful driver, which is long enough for the sounds and words to matter.
  road(0, 150, 0, 0, 0, 'the start straight');
  road(40, 100, 40, -3, 0, 'the first left-hander');
  road(30, 90, 30, 0, 24, 'the hill');
  road(40, 80, 40, 4, -24, 'the right-hander over the crest');
  road(0, 200, 0, 0, 0, 'the back straight');
  road(30, 50, 30, -5, 0, 'the chicane, left');
  road(30, 50, 30, 5, 0, 'the chicane, right');
  road(40, 140, 40, -2, 0, 'the long gentle left');
  road(0, 120, 0, 0, 0, 'the home straight');

  // Curve runs, for warnings: contiguous stretches with |curve| >= 1.
  const curves = [];
  let run = null;
  for (const s of segs) {
    const dir = Math.abs(s.curve) >= 1 ? Math.sign(s.curve) : 0;
    if (dir && run && run.dir === dir) { run.end = s.index; run.peak = Math.max(run.peak, Math.abs(s.curve)); }
    else if (dir) { run = { start: s.index, end: s.index, dir, peak: Math.abs(s.curve), section: s.section }; curves.push(run); }
    else run = null;
  }
  for (const c of curves) c.strength = c.peak >= 5 ? 'sharp' : c.peak >= 3.5 ? 'medium' : 'gentle';
  return { segs, curves, length: segs.length * SEG };
}

// ── the game ─────────────────────────────────────────────────────────────────
export function createGame(canvas) {
  const ctx = canvas.getContext('2d');
  const track = buildTrack();
  const cameraDepth = 1 / Math.tan((FOV / 2) * Math.PI / 180);
  const playerZ = CAMERA_HEIGHT * cameraDepth;

  // What the surface renders from the profile. Defaults = the game as designed.
  const settings = {
    topSpeedFactor: 1,     // 0.5–1
    roadWidthFactor: 1,    // 1–1.5
    warningLeadFactor: 1,  // 1–2: how early a curve counts as "ahead"
    steeringAssist: 0,     // 0–1: pull toward the road centre, cancel curve drift
    timeScale: 1,          // 0.4–1
    cameraShake: true,
    horizonBob: true,
    curveSway: 1,          // 0–1: how much the view leans into curves
    highContrast: false,
    hudDetail: 'full',     // 'full' | 'simple'
  };

  // What the host sets each frame (keyboard, voice, switch — the game doesn't care).
  const input = { left: false, right: false, accelerate: false, brake: false };

  const state = {
    position: 0, playerX: 0, speed: 0,
    lap: 1, lapTime: 0, lastLap: null, bestLap: null,
    offRoad: false, paused: true, started: false,
    section: track.segs[0].section,
    inCurve: null,          // the curve run the player is in
    nextCurve: null,        // the curve run ahead (within lead distance)
    distanceToCurve: 0,     // segments to nextCurve.start
  };

  let announcedCurve = null;
  let shake = 0;

  const segmentAt = (z) => track.segs[Math.floor(z / SEG) % track.segs.length];
  const maxSpeed = () => MAX_SPEED * settings.topSpeedFactor;

  function reset() {
    Object.assign(state, { position: 0, playerX: 0, speed: 0, lap: 1, lapTime: 0, lastLap: null, offRoad: false, inCurve: null, nextCurve: null });
    announcedCurve = null;
  }

  // Advance the world by dt seconds. Returns the events that happened.
  function update(dt) {
    const events = [];
    if (state.paused) return events;
    dt = Math.min(dt, 0.1) * settings.timeScale;
    const max = maxSpeed();
    const seg = segmentAt(state.position + playerZ);
    const speedPct = state.speed / max;
    const dx = dt * 2 * speedPct;

    state.lapTime += dt;
    const before = state.position;
    state.position = (state.position + dt * state.speed) % track.length;
    if (state.position < before) {
      state.lastLap = state.lapTime;
      if (state.bestLap === null || state.lapTime < state.bestLap) state.bestLap = state.lapTime;
      events.push({ kind: 'lap', lap: state.lap, time: state.lapTime, best: state.bestLap === state.lapTime });
      state.lap++;
      state.lapTime = 0;
    }

    // Steering, then the curve's outward push — reduced by the assist, which
    // also eases the car back toward the centre.
    if (input.left) state.playerX -= dx;
    else if (input.right) state.playerX += dx;
    state.playerX -= dx * speedPct * seg.curve * CENTRIFUGAL * (1 - settings.steeringAssist);
    state.playerX -= state.playerX * settings.steeringAssist * 1.5 * dt;

    if (input.accelerate) state.speed += (max / 5) * dt;
    else if (input.brake) state.speed -= max * dt;
    else state.speed -= (max / 5) * dt;

    const limit = 1 * settings.roadWidthFactor;
    const off = Math.abs(state.playerX) > limit;
    if (off && state.speed > max / 4) state.speed -= (max / 2) * dt;
    if (off !== state.offRoad) { state.offRoad = off; events.push({ kind: off ? 'offroad' : 'onroad', side: state.playerX < 0 ? 'left' : 'right' }); }

    state.playerX = clamp(state.playerX, -3, 3);
    state.speed = clamp(state.speed, 0, max);
    shake = settings.cameraShake ? speedPct * 2 : 0;

    // Where we are, and what is coming.
    if (seg.section !== state.section) { state.section = seg.section; events.push({ kind: 'section', section: seg.section }); }
    const here = seg.index;
    const inCurve = track.curves.find((c) => here >= c.start && here <= c.end) || null;
    if (inCurve !== state.inCurve) {
      state.inCurve = inCurve;
      events.push(inCurve ? { kind: 'in-curve', dir: inCurve.dir < 0 ? 'left' : 'right', strength: inCurve.strength }
                          : { kind: 'straight' });
    }
    const lead = clamp(speedPct * 70, 25, 90) * settings.warningLeadFactor;
    const n = track.segs.length;
    let next = null, dist = 0;
    for (const c of track.curves) {
      const d = ((c.start - here) % n + n) % n;
      if (d > 0 && d <= lead && (!next || d < dist)) { next = c; dist = d; }
    }
    state.nextCurve = next; state.distanceToCurve = dist;
    if (next && next !== announcedCurve && next !== inCurve) {
      announcedCurve = next;
      events.push({ kind: 'curve-ahead', dir: next.dir < 0 ? 'left' : 'right', strength: next.strength, segments: dist });
    }
    if (!next) announcedCurve = null;
    return events;
  }

  // ── rendering ──────────────────────────────────────────────────────────────
  const PALETTE = {
    normal: { sky: '#72c5ff', skyLow: '#dff1ff', grass: ['#10a63b', '#0d8f33'], rumble: ['#ffffff', '#c8102e'], road: ['#6b6b6b', '#676767'], lane: '#ffffff', car: '#d7263d', fog: '#9fd6ff' },
    high:   { sky: '#000000', skyLow: '#000000', grass: ['#003300', '#002200'], rumble: ['#ffff00', '#ffffff'], road: ['#303030', '#202020'], lane: '#ffff00', car: '#ffffff', fog: '#000000' },
  };

  function project(p, camX, camY, camZ, w, h, roadW) {
    const cx = (p.x || 0) - camX, cy = p.y - camY, cz = p.z - camZ;
    const scale = cameraDepth / cz;
    return { x: Math.round(w / 2 + scale * cx * w / 2), y: Math.round(h / 2 - scale * cy * h / 2), w: Math.round(scale * roadW * w / 2), z: cz };
  }

  function poly(x1, y1, x2, y2, x3, y3, x4, y4, color) {
    ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.lineTo(x4, y4); ctx.closePath(); ctx.fill();
  }

  function render() {
    const w = canvas.width, h = canvas.height;
    const pal = settings.highContrast ? PALETTE.high : PALETTE.normal;
    const roadW = 2000 * settings.roadWidthFactor;
    const base = segmentAt(state.position);
    const basePct = (state.position % SEG) / SEG;
    const playerSeg = segmentAt(state.position + playerZ);
    const playerPct = ((state.position + playerZ) % SEG) / SEG;
    const playerY = playerSeg.p1.y + (playerSeg.p2.y - playerSeg.p1.y) * playerPct;
    const bob = settings.horizonBob ? Math.sin(state.position / 400) * 3 * (state.speed / maxSpeed()) : 0;
    const jitter = shake ? (Math.random() - 0.5) * shake : 0;

    // sky
    const sky = ctx.createLinearGradient(0, 0, 0, h / 2);
    sky.addColorStop(0, pal.sky); sky.addColorStop(1, pal.skyLow);
    ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);

    let maxy = h, x = 0, dx = -(base.curve * basePct) * settings.curveSway;
    const camX = state.playerX * roadW;
    const camY = playerY + CAMERA_HEIGHT + bob;
    for (let n = 0; n < DRAW; n++) {
      const seg = track.segs[(base.index + n) % track.segs.length];
      const looped = seg.index < base.index;
      const camZ = state.position - (looped ? track.length : 0);
      const p1 = project({ ...seg.p1, x: -x }, camX, camY, camZ, w, h, roadW);
      const p2 = project({ ...seg.p2, x: -x - dx }, camX, camY, camZ, w, h, roadW);
      x += dx; dx += seg.curve * settings.curveSway;
      if (p1.z <= cameraDepth || p2.y >= p1.y || p2.y >= maxy) continue;

      const stripe = Math.floor(seg.index / RUMBLE) % 2;
      const r1 = p1.w / 6, r2 = p2.w / 6;
      const fog = 1 - Math.min(1, Math.exp(-((n / DRAW) ** 2) * 5)) ** 1; // 0 near → 1 far
      poly(0, p2.y, w, p2.y, w, p1.y, 0, p1.y, pal.grass[stripe]);
      poly(p1.x - p1.w - r1, p1.y, p1.x - p1.w, p1.y, p2.x - p2.w, p2.y, p2.x - p2.w - r2, p2.y, pal.rumble[stripe]);
      poly(p1.x + p1.w + r1, p1.y, p1.x + p1.w, p1.y, p2.x + p2.w, p2.y, p2.x + p2.w + r2, p2.y, pal.rumble[stripe]);
      poly(p1.x - p1.w, p1.y, p1.x + p1.w, p1.y, p2.x + p2.w, p2.y, p2.x - p2.w, p2.y, pal.road[stripe]);
      if (stripe === 0) {
        const l1 = p1.w / 32, l2 = p2.w / 32, lw1 = p1.w * 2 / LANES, lw2 = p2.w * 2 / LANES;
        for (let i = 1; i < LANES; i++) {
          const lx1 = p1.x - p1.w + lw1 * i, lx2 = p2.x - p2.w + lw2 * i;
          poly(lx1 - l1, p1.y, lx1 + l1, p1.y, lx2 + l2, p2.y, lx2 - l2, p2.y, pal.lane);
        }
      }
      if (fog > 0.02 && !settings.highContrast) { ctx.fillStyle = `rgba(159,214,255,${fog * 0.8})`; ctx.fillRect(0, p2.y, w, p1.y - p2.y); }
      maxy = p1.y;
    }

    // the car — a drawn shape, no sprite; leans with steering
    const cw = w * 0.17, ch = cw * 0.5;
    const cx = w / 2 + jitter, cy = h - ch * 0.75 + jitter;
    const lean = (input.left ? -1 : input.right ? 1 : 0) * cw * 0.06;
    ctx.fillStyle = '#111';
    ctx.fillRect(cx - cw / 2 - cw * 0.08, cy - ch * 0.1, cw * 0.14, ch * 0.5);
    ctx.fillRect(cx + cw / 2 - cw * 0.06, cy - ch * 0.1, cw * 0.14, ch * 0.5);
    ctx.fillStyle = pal.car;
    ctx.beginPath();
    ctx.moveTo(cx - cw / 2, cy + ch * 0.3); ctx.lineTo(cx - cw * 0.3 + lean, cy - ch * 0.3); ctx.lineTo(cx + cw * 0.3 + lean, cy - ch * 0.3); ctx.lineTo(cx + cw / 2, cy + ch * 0.3);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#222';
    ctx.fillRect(cx - cw * 0.2 + lean, cy - ch * 0.3, cw * 0.4, ch * 0.18);

    if (state.paused) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(h / 12)}px system-ui, sans-serif`; ctx.textAlign = 'center';
      ctx.fillText(state.started ? 'Paused' : 'Press Space, or say "go"', w / 2, h / 2);
    }
  }

  // A plain-words description of where the player is, for "where am I".
  function describe() {
    const pct = Math.round((state.position / track.length) * 100);
    const curve = state.inCurve ? `, in a ${state.inCurve.strength} ${state.inCurve.dir < 0 ? 'left' : 'right'} curve` : '';
    const next = state.nextCurve ? `. A ${state.nextCurve.strength} ${state.nextCurve.dir < 0 ? 'left' : 'right'} curve is ahead` : '';
    const where = state.offRoad ? `off the road on the ${state.playerX < 0 ? 'left' : 'right'}` : Math.abs(state.playerX) < 0.3 ? 'in the middle of the road' : `on the ${state.playerX < 0 ? 'left' : 'right'} side of the road`;
    return `Lap ${state.lap}, ${pct} percent round, on ${state.section}${curve}, ${where}${next}.`;
  }

  const speedMph = () => Math.round((state.speed / MAX_SPEED) * 200);
  const trackSummary = () => 'A loop of nine sections: ' + [...new Set(track.segs.map((s) => s.section))].join(', ') + '.';

  return { settings, input, state, track, update, render, reset, describe, speedMph, trackSummary,
    start() { state.started = true; state.paused = false; },
    pause() { state.paused = true; },
    resume() { if (state.started) state.paused = false; else this.start(); },
  };
}
