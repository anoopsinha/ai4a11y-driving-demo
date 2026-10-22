// audio.js — the game by ear. Sounds, not words, for the things that change
// many times a second; words (commentary.js) for the things that happen now
// and then. Blind racing games have used this split for twenty years.
//
//   engine     a low tone whose pitch is your speed.
//   centre     a tone that sits where the middle of the road is, relative to
//              you: steer TOWARD the tone. Silent when you are centred, louder
//              the further off you drift, harsh once you are on the grass.
//   curve      ticks on the side the road is about to bend to, faster as the
//              bend gets closer, higher for a sharper bend.
//   earcons    start, lap, pause, and a short "heard you" for voice commands.
//
// Web Audio only. Nothing here reads the DOM.

export function createAudio() {
  let ctx = null;
  let engine = null, centre = null, tick = null;
  let enabled = false;
  let tickTimer = null;

  function ensure() {
    if (ctx) return ctx;
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    const eOsc = ctx.createOscillator(); eOsc.type = 'sawtooth'; eOsc.frequency.value = 60;
    const eFilter = ctx.createBiquadFilter(); eFilter.type = 'lowpass'; eFilter.frequency.value = 400;
    const eGain = ctx.createGain(); eGain.gain.value = 0;
    eOsc.connect(eFilter).connect(eGain).connect(ctx.destination); eOsc.start();
    engine = { osc: eOsc, gain: eGain };

    const cOsc = ctx.createOscillator(); cOsc.type = 'sine'; cOsc.frequency.value = 440;
    const cGain = ctx.createGain(); cGain.gain.value = 0;
    const cPan = ctx.createStereoPanner();
    cOsc.connect(cGain).connect(cPan).connect(ctx.destination); cOsc.start();
    centre = { osc: cOsc, gain: cGain, pan: cPan };

    const tPan = ctx.createStereoPanner();
    const tGain = ctx.createGain(); tGain.gain.value = 0.5;
    tGain.connect(tPan).connect(ctx.destination);
    tick = { gain: tGain, pan: tPan };
    return ctx;
  }

  function beep(freq, ms, { pan = 0, type = 'sine', gain = 0.25, at = 0 } = {}) {
    const c = ensure();
    const t0 = c.currentTime + at;
    const o = c.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = c.createGain(); g.gain.setValueAtTime(gain, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + ms / 1000);
    const p = c.createStereoPanner(); p.pan.value = pan;
    o.connect(g).connect(p).connect(c.destination); o.start(t0); o.stop(t0 + ms / 1000 + 0.02);
  }

  const earcons = {
    start:  () => { beep(440, 120); beep(660, 160, { at: 0.15 }); },
    lap:    () => { beep(660, 100); beep(880, 100, { at: 0.12 }); beep(1100, 180, { at: 0.24 }); },
    pause:  () => beep(330, 200, { type: 'triangle' }),
    heard:  () => beep(900, 60, { gain: 0.15 }),
    offroad:() => beep(140, 250, { type: 'square', gain: 0.2 }),
  };

  // Called every frame with the game state.
  function update(state, maxSpeed) {
    if (!enabled || !ctx) return;
    const now = ctx.currentTime;
    const speedPct = state.speed / maxSpeed;
    engine.osc.frequency.setTargetAtTime(55 + speedPct * 150, now, 0.05);
    engine.gain.gain.setTargetAtTime(state.paused ? 0 : 0.06 + speedPct * 0.08, now, 0.05);

    const x = Math.max(-1.6, Math.min(1.6, state.playerX));
    const off = Math.abs(x);
    centre.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, -x)), now, 0.03);
    centre.gain.gain.setTargetAtTime(state.paused ? 0 : Math.min(0.35, Math.max(0, off - 0.12) * 0.5), now, 0.05);
    centre.osc.type = state.offRoad ? 'square' : 'sine';
    centre.osc.frequency.setTargetAtTime(state.offRoad ? 220 : 440, now, 0.03);

    // Curve ticks: schedule the next one from how far the bend is.
    if (state.nextCurve && !state.inCurve && !state.paused) {
      if (!tickTimer) {
        const segs = Math.max(1, state.distanceToCurve);
        const period = 120 + Math.min(900, segs * 10);
        const freq = { gentle: 600, medium: 800, sharp: 1050 }[state.nextCurve.strength] || 700;
        tick.pan.pan.value = state.nextCurve.dir < 0 ? -0.8 : 0.8;
        beep(freq, 50, { pan: tick.pan.pan.value, gain: 0.2, type: 'triangle' });
        tickTimer = setTimeout(() => { tickTimer = null; }, period);
      }
    }
  }

  return {
    get enabled() { return enabled; },
    enable() { enabled = true; ensure().resume(); },
    disable() { enabled = false; if (ctx) { engine.gain.gain.value = 0; centre.gain.gain.value = 0; } },
    update,
    cue(name) { if (earcons[name]) { ensure(); earcons[name](); } },
    unlock() { ensure().resume(); }, // call from a user gesture so the context may start
  };
}
