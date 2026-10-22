// voice.js — two lanes for what a player says.
//
//   grammar   driving words, matched the instant the browser produces an
//             INTERIM transcript ("lef…" → left in ~200 ms). A model round
//             trip is 1.5–3 s: fine for "I get motion sick", useless for
//             "left!". So the grammar is tiny and only about driving.
//   model     everything else — a FINAL transcript the grammar didn't claim
//             goes to the host's `understand(text)` (the server, Gemini).
//
// Recognition is continuous while the mic is on, so a player never has to
// press anything between commands.

// Each rule: words → a command name. Matched against the LAST few words of
// the transcript, whole-word, so "go left" is left and "left" alone is left.
const RULES = [
  [/\b(hard left|sharp left)\b/, 'hard-left'],
  [/\b(hard right|sharp right)\b/, 'hard-right'],
  [/\bleft\b/, 'left'],
  [/\bright\b/, 'right'],
  [/\b(straight|straighten|centre|center|middle)\b/, 'straight'],
  [/\b(faster|speed up|accelerate|full speed|floor it)\b/, 'faster'],
  [/\b(slower|slow down|ease off|easy)\b/, 'slower'],
  [/\b(brake|brakes|stop|halt)\b/, 'brake'],
  [/\b(go|drive|start|resume|continue|play|unpause)\b/, 'go'],
  [/\b(pause|wait|hold on)\b/, 'pause'],
  [/\b(where am i|where are we|position|status)\b/, 'where'],
  [/\b(how fast|speed)\b/, 'speed'],
  [/\b(restart|start over|reset the race|new race)\b/, 'restart'],
  [/\b(help|what can i say)\b/, 'help'],
];

export function parseCommand(text) {
  const t = String(text || '').toLowerCase().replace(/[^a-z' ]+/g, ' ').trim();
  if (!t) return null;
  // Driving commands are short. A sentence that happens to contain "left"
  // ("the screen is on the left") is not a steering command.
  if (t.split(/\s+/).length > 5) return null;
  for (const [re, name] of RULES) if (re.test(t)) return name;
  return null;
}

/**
 * @param {Object} o
 * @param {(cmd:string)=>void} o.onCommand   a grammar hit (may fire on interim text)
 * @param {(text:string)=>void} o.onSentence  a final transcript the grammar didn't claim
 * @param {(on:boolean)=>void}  o.onState
 */
export function createVoice({ onCommand, onSentence, onState }) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return { supported: false, start() {}, stop() {}, toggle() {}, get listening() { return false; } };

  const recog = new Recognition();
  recog.lang = navigator.language || 'en-US';
  recog.continuous = true;
  recog.interimResults = true;
  let listening = false, wanted = false;
  let lastCmd = '', lastCmdAt = 0;

  recog.onresult = (ev) => {
    const res = ev.results[ev.results.length - 1];
    const text = res[0].transcript;
    const cmd = parseCommand(text);
    if (cmd) {
      // Interim results repeat as they grow; fire a command once per phrase.
      const now = performance.now();
      if (cmd !== lastCmd || now - lastCmdAt > 1200) { lastCmd = cmd; lastCmdAt = now; onCommand(cmd); }
      return;
    }
    if (res.isFinal) { lastCmd = ''; onSentence(text.trim()); }
  };
  recog.onend = () => { listening = false; onState(false); if (wanted) { try { recog.start(); listening = true; onState(true); } catch {} } };
  recog.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { wanted = false; } };

  return {
    supported: true,
    get listening() { return listening; },
    start() { wanted = true; try { recog.start(); listening = true; onState(true); } catch {} },
    stop() { wanted = false; try { recog.stop(); } catch {} listening = false; onState(false); },
    toggle() { listening ? this.stop() : this.start(); },
  };
}
