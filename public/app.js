// app.js — the host. Wires the game to the toolkit, in the order a host uses it:
//
//   1. The toolkit, over this host's ports.
//   2. The profile: needs, written through the Librarian.
//   3. Render the profile — TWO surfaces from one model: the toolkit's web
//      surface for the page's own text, and this game's surface (surface.js)
//      for everything on the canvas and in the speakers.
//   4. Where needs come from: a sentence, understood by the model.
//   5. Play: keyboard, voice (instant grammar), sound, speech, captions.
//
// Read it top to bottom; README.md walks the same steps.

import { createToolkit } from '/vendor/toolkit/index.js';
import { nodeClock, nodeScheduler } from '/vendor/toolkit/platforms/node/ports.js';
import { noopConsent } from '/vendor/toolkit/ports/index.js';
import { renderWebSettings } from '/vendor/toolkit/surfaces/web.js';
import { VisualAssist } from '/vendor/tools/adapters/visual-assist.js';
import { localStorageKV } from './ports/local-storage-kv.js';
import { renderGameSettings } from './surface.js';
import { createGame } from './game.js';
import { createAudio } from './audio.js';
import { createCommentary } from './commentary.js';
import { createVoice, parseCommand } from './voice.js';

const $ = (id) => document.getElementById(id);

// ── 1. The toolkit, over this host's ports ───────────────────────────────────
const { datastore, librarian } = createToolkit({
  kv: localStorageKV({ prefix: 'ai4a11y-drive' }),
  clock: nodeClock(),
  scheduler: nodeScheduler(),
  consent: noopConsent,
});
await datastore.runMigrations();

// ── 2. The profile: needs, not settings ──────────────────────────────────────
async function currentNeeds() {
  return (await librarian.getAbilityModel()).needs || [];
}
function mergeNeeds(existing, changes, source) {
  const byDim = new Map(existing.map((n) => [n.dimension, n]));
  for (const c of changes) {
    if (c.value === null) byDim.delete(c.dimension);
    else byDim.set(c.dimension, { dimension: c.dimension, value: c.value, strength: 'preference', source });
  }
  return [...byDim.values()];
}
const history = [];
async function setNeeds(needs, { remember = true } = {}) {
  if (remember) history.push(await currentNeeds());
  await librarian.setProfileField('fields.needs', needs);
  await render();
}

// ── 3. Render the profile: two surfaces from one model ───────────────────────
const game = createGame($('game'));
const audio = createAudio();
const commentary = createCommentary({ polite: $('reply'), assertive: $('alert'), caption: $('caption'), cues: $('cues') });
const DEFAULTS = { ...game.settings, visualCues: false, commentary: false, speechRate: 1, sonification: false, singleSwitch: false };
let mode = { singleSwitch: false, visualCues: false, commentary: false };

async function render() {
  const model = await librarian.getAbilityModel();

  // The web surface renders the page's text: textSize → fontScale → the
  // VisualAssist adapter from the catalog scales the HUD and controls.
  const web = renderWebSettings(model);
  VisualAssist.enable({ fontScale: web.fontScale ?? 100 });

  // The game surface renders everything else.
  const { settings, unmet } = renderGameSettings(model);
  const s = { ...DEFAULTS, ...settings };
  for (const k of Object.keys(game.settings)) game.settings[k] = s[k];
  if (s.sonification) audio.enable(); else audio.disable();
  commentary.opts.speak = $('tts').checked;      // replies are always spoken when Speak is on…
  commentary.opts.rate = s.speechRate;
  commentary.opts.captions = s.visualCues;
  mode = { singleSwitch: s.singleSwitch, visualCues: s.visualCues, commentary: s.commentary }; // …game commentary only when asked for
  $('hud-time').hidden = $('hud-best').hidden = s.hudDetail === 'simple';

  const areas = (model.supportAreas || []).join(', ');
  const needs = (model.needs || []).map((n) => `${n.dimension} ${n.value}`).join(' · ');
  $('profile').textContent = needs
    ? `Profile${areas ? ` (${areas})` : ''}: ${needs}${unmet.length ? `  (not rendered here: ${unmet.join(', ')})` : ''}`
    : 'Profile: nothing yet — tell me what you need, or just drive.';
}

// ── 4. Where needs come from: a sentence, understood by the model ────────────
const HOW_TO_PLAY = 'Steer with the left and right arrow keys, accelerate with the up arrow or space, brake with the down arrow. '
  + 'Or say: go, left, right, straight, faster, slower, brake, pause, where am I, how fast. '
  + 'Tell me what you need in your own words: "I can\'t see the screen" turns on sounds that guide you, "I get motion sick" steadies the view, "I only have one hand" lets you play with one key.';
const SOUNDS = 'The sounds: a low engine note rises with your speed. A tone sits where the middle of the road is — steer toward it; it is silent when you are centred and turns harsh on the grass. Ticks on one side mean a curve is coming on that side, faster as it gets closer.';

function context() {
  return `${game.trackSummary()} Now: ${game.describe()} Speed ${game.speedMph()} miles an hour. How to play: ${HOW_TO_PLAY} ${SOUNDS}`;
}

async function understand(text) {
  const current = (await currentNeeds()).map((n) => ({ dimension: n.dimension, value: n.value }));
  const r = await fetch('/api/understand', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, current, context: context() }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || 'understand failed');
  return body;
}

async function act(action) {
  switch (action.type) {
    case 'profile':
      if (action.supportAreas?.length) await librarian.setProfileField('supportAreas', action.supportAreas);
      await setNeeds(mergeNeeds(await currentNeeds(), action.needs, 'onboarding'));
      return action.say;
    case 'adjust':
      await setNeeds(mergeNeeds(await currentNeeds(), action.needs, 'user'));
      return action.say;
    case 'undo':
      if (!history.length) return 'Nothing to undo.';
      await setNeeds(history.pop(), { remember: false });
      return action.say;
    case 'reset':
      await librarian.setProfileField('supportAreas', []);
      await setNeeds([]);
      return action.say;
    default:
      return action.say; // 'answer', 'none'
  }
}

let busy = false;
async function handleSentence(text) {
  const t = String(text || '').trim();
  if (!t || busy) return;
  const cmd = parseCommand(t);
  if (cmd) { command(cmd); return; }
  busy = true;
  $('reply').textContent = '…';
  try {
    const reply = await act(await understand(t));
    if (reply) commentary.say(reply, 'event'); else $('reply').textContent = '';
  } catch (e) {
    commentary.say('Sorry, ' + e.message, 'event');
  } finally { busy = false; }
}

// ── 5. Play ──────────────────────────────────────────────────────────────────
// Input is one object the game reads; keyboard, voice and the single switch
// all write it. Voice steers in impulses (a word can't be held down) and
// latches the accelerator ("go" until "brake" or "slower").
const held = { left: false, right: false, accelerate: false, brake: false };
const latch = { accelerate: false, left: 0, right: 0, brake: 0 };

function mergeInput() {
  const now = performance.now();
  game.input.left = held.left || latch.left > now;
  game.input.right = held.right || latch.right > now;
  game.input.accelerate = held.accelerate || latch.accelerate;
  game.input.brake = held.brake || latch.brake > now;
  if (game.input.brake) game.input.accelerate = false;
}

function command(name) {
  audio.unlock();
  const now = performance.now();
  const impulse = 380, hard = 750;
  switch (name) {
    case 'left': latch.left = now + impulse; latch.right = 0; break;
    case 'right': latch.right = now + impulse; latch.left = 0; break;
    case 'hard-left': latch.left = now + hard; latch.right = 0; break;
    case 'hard-right': latch.right = now + hard; latch.left = 0; break;
    case 'straight': latch.left = latch.right = 0; break;
    case 'faster': case 'go': latch.accelerate = true; latch.brake = 0; if (game.state.paused) { game.resume(); audio.cue('start'); } break;
    case 'slower': latch.accelerate = false; break;
    case 'brake': latch.accelerate = false; latch.brake = now + 600; break;
    case 'pause': game.pause(); audio.cue('pause'); commentary.say('Paused.', 'event'); break;
    case 'where': commentary.say(game.describe(), 'warn'); break;
    case 'speed': commentary.say(`${game.speedMph()} miles an hour.`, 'warn'); break;
    case 'restart': game.reset(); commentary.say('Back on the start line.', 'event'); break;
    case 'help': commentary.say(HOW_TO_PLAY, 'event'); break;
  }
  if (!['where', 'speed', 'help', 'pause'].includes(name)) audio.cue('heard');
}

// Keyboard. In single-switch mode any key is the accelerator and the car
// steers itself (the surface set steeringAssist to 1).
const KEYS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'accelerate', ' ': 'accelerate', ArrowDown: 'brake' };
function keyHandled(e) {
  if (e.target === $('text') && $('text').value) return false; // typing
  return true;
}
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.code === 'Space') { e.preventDefault(); voice.toggle(); return; }
  if (!keyHandled(e)) return;
  audio.unlock();
  if (mode.singleSwitch && !e.repeat && !['p', 'r', 'w', 'Escape'].includes(e.key)) { e.preventDefault(); held.accelerate = true; if (game.state.paused) { game.resume(); audio.cue('start'); } return; }
  if (KEYS[e.key]) { e.preventDefault(); held[KEYS[e.key]] = true; if (game.state.paused && KEYS[e.key] === 'accelerate') { game.resume(); audio.cue('start'); } }
  else if (e.key === 'p' || e.key === 'P') { game.state.paused ? command('go') : command('pause'); }
  else if (e.key === 'r' || e.key === 'R') command('restart');
  else if (e.key === 'w' || e.key === 'W') command('where');
});
document.addEventListener('keyup', (e) => {
  if (mode.singleSwitch) { held.accelerate = false; return; }
  if (KEYS[e.key]) held[KEYS[e.key]] = false;
});
$('pause').addEventListener('click', () => (game.state.paused ? command('go') : command('pause')));

// Voice: the grammar fires on interim results; sentences go to the model.
const voice = createVoice({
  onCommand: command,
  onSentence: handleSentence,
  onState: (on) => { $('mic').setAttribute('aria-pressed', String(on)); $('mic').textContent = on ? '🎤 Listening' : '🎤 Voice'; },
});
if (!voice.supported) { $('mic').disabled = true; $('mic').title = 'Speech recognition is not available in this browser'; }
$('mic').addEventListener('click', () => { audio.unlock(); voice.toggle(); });
$('ask').addEventListener('submit', (e) => { e.preventDefault(); const t = $('text').value; $('text').value = ''; handleSentence(t); });
$('tts').addEventListener('change', render);

// Game events → sound, words, captions.
const DIR = { left: '◀', right: '▶' };
const tell = (text, priority) => { if (mode.commentary) commentary.say(text, priority); };
const show = (text, opts) => { if (mode.visualCues) commentary.cue(text, opts); };
function onEvent(ev) {
  switch (ev.kind) {
    case 'curve-ahead':
      tell(`${ev.strength} ${ev.dir} ahead.`, 'event');
      show(`${DIR[ev.dir]} ${ev.strength.toUpperCase()} ${ev.dir.toUpperCase()} AHEAD`);
      break;
    case 'offroad':
      if (audio.enabled) audio.cue('offroad');
      tell(`Off the road on the ${ev.side}. Steer ${ev.side === 'left' ? 'right' : 'left'}.`, 'warn');
      show(`OFF ROAD — STEER ${ev.side === 'left' ? 'RIGHT ▶' : '◀ LEFT'}`, { warn: true });
      break;
    case 'onroad':
      tell('Back on the road.', 'event');
      show('ON ROAD');
      break;
    case 'lap':
      audio.cue('lap');
      tell(`Lap ${ev.lap} done, ${fmtSpoken(ev.time)}${ev.best ? ', your best' : ''}.`, 'event');
      show(`LAP ${ev.lap}: ${fmt(ev.time)}`);
      break;
    case 'section':
      tell(`Entering ${ev.section}.`, 'status');
      break;
  }
}

const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}.${Math.floor((t % 1) * 10)}`;
const fmtSpoken = (t) => `${Math.floor(t / 60) ? `${Math.floor(t / 60)} minute${Math.floor(t / 60) > 1 ? 's' : ''} ` : ''}${(t % 60).toFixed(1)} seconds`;

// The loop.
let last = performance.now(), statusAt = 0;
function frame(now) {
  const dt = (now - last) / 1000; last = now;
  mergeInput();
  for (const ev of game.update(dt)) onEvent(ev);
  audio.update(game.state, game.settings.topSpeedFactor * 12000);
  game.render();
  $('hud-speed').textContent = `${game.speedMph()} mph`;
  $('hud-lap').textContent = `Lap ${game.state.lap}`;
  $('hud-time').textContent = fmt(game.state.lapTime);
  $('hud-best').textContent = game.state.bestLap === null ? '' : `best ${fmt(game.state.bestLap)}`;
  if (!game.state.paused && now - statusAt > 9000) { statusAt = now; tell(`${game.speedMph()} miles an hour.`, 'status'); }
  requestAnimationFrame(frame);
}

// Boot: apply whatever the profile holds, say what this is, and go.
await render();
commentary.say('Drive. ' + HOW_TO_PLAY, 'event');
$('reply').textContent = 'Drive. ' + HOW_TO_PLAY;
requestAnimationFrame(frame);
window.drive = { librarian, game, audio, commentary, command, handleSentence, currentNeeds, render }; // for the console
