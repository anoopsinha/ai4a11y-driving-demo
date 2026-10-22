// commentary.js — words for the things that happen now and then. Three
// priorities, so the game never babbles over itself:
//
//   warn    interrupts whatever is being said ("off the road, left").
//   event   queued and said in order ("left curve ahead", "lap two").
//   status  said only when nothing else is waiting, and not more often than
//           every few seconds ("eighty miles an hour").
//
// Everything also lands in an ARIA live region (assertive for warnings,
// polite otherwise), so a screen reader user hears it in their own voice with
// speech off. With captions on, every line is also shown on screen. Nothing
// here knows about the game; it is given lines.

export function createCommentary({ polite, assertive, caption, cues } = {}) {
  const opts = { speak: true, rate: 1, captions: false, statusEvery: 6 };
  const queue = [];
  let speaking = false;
  let lastStatus = 0;
  let cueTimer = null;

  function announce(text, priority) {
    const region = priority === 'warn' ? assertive : polite;
    if (region) { region.textContent = ''; region.textContent = text; }
    if (opts.captions && caption) {
      caption.textContent = text;
      clearTimeout(cueTimer);
      cueTimer = setTimeout(() => { if (caption.textContent === text) caption.textContent = ''; }, 2500);
    }
  }

  function utter(text) {
    if (!opts.speak || !('speechSynthesis' in window)) { next(); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.rate = opts.rate;
    u.onend = u.onerror = () => { speaking = false; next(); };
    speaking = true;
    speechSynthesis.speak(u);
  }

  function next() {
    if (speaking) return;
    const item = queue.shift();
    if (item) { announce(item.text, item.priority); utter(item.text); }
  }

  function say(text, priority = 'event') {
    if (!text) return;
    if (priority === 'warn') {
      queue.length = 0;
      if ('speechSynthesis' in window) speechSynthesis.cancel();
      speaking = false;
      queue.push({ text, priority });
      next();
      return;
    }
    if (priority === 'status') {
      const now = performance.now() / 1000;
      if (speaking || queue.length || now - lastStatus < opts.statusEvery) return;
      lastStatus = now;
    }
    queue.push({ text, priority });
    next();
  }

  // A visual cue (arrow + word) for players who can't hear the sounds.
  function cue(text, { warn = false } = {}) {
    if (!cues) return;
    cues.textContent = text;
    cues.classList.toggle('warn', warn);
    clearTimeout(cue.timer);
    cue.timer = setTimeout(() => { cues.textContent = ''; }, 1800);
  }

  return {
    opts, say, cue,
    stop() { queue.length = 0; speaking = false; if ('speechSynthesis' in window) speechSynthesis.cancel(); },
  };
}
