// surface.js — the game as a SURFACE of the toolkit.
//
// The toolkit ships renderers for the web, mobile and XR: pure functions from
// the AbilityModel to one platform's settings. A game is another platform, so
// it writes its own. This is the whole of it: a table from need dimensions to
// game settings, and a function that folds the model through the table.
//
// Standard dimensions (textSize, reduceMotion, contrast, captions, readAloud,
// readAloudRate, simplify) mean here what they mean everywhere. Three are the
// game's own — audioNavigation, steeringAssist, pace, singleSwitch — which
// the web surface would simply report as "unmet"; a surface may define what
// only it can render.

import { rankOf } from '/vendor/toolkit/core/strength.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v)));

export const GAME_DERIVATION = {
  reduceMotion:   (v) => ({ cameraShake: !v, horizonBob: !v, curveSway: v ? 0.35 : 1 }),
  contrast:       (v) => ({ highContrast: v === true || v === 'high' }),
  simplify:       (v) => (v ? { topSpeedFactor: 0.6, roadWidthFactor: 1.4, warningLeadFactor: 1.6, hudDetail: 'simple' }
                            : { topSpeedFactor: 1, roadWidthFactor: 1, warningLeadFactor: 1, hudDetail: 'full' }),
  captions:       (v) => ({ visualCues: !!v }),
  readAloud:      (v) => ({ commentary: !!v }),
  readAloudRate:  (v) => ({ speechRate: clamp(v, 0.5, 2) }),
  audioNavigation:(v) => ({ sonification: !!v }),
  steeringAssist: (v) => ({ steeringAssist: clamp(v, 0, 1) }),
  pace:           (v) => ({ timeScale: clamp(v, 0.4, 1) }),
  singleSwitch:   (v) => ({ singleSwitch: !!v, ...(v ? { steeringAssist: 1 } : {}) }),
  // textSize is rendered by the WEB surface for the DOM (HUD, controls) — see app.js.
};

/**
 * Fold the AbilityModel's needs through the table. On a collision the
 * stronger need wins (floor > preference > hint; ties: later wins) — the same
 * rule the toolkit's web surface uses. Returns the settings to merge over the
 * game's defaults, plus the needs this surface has no rendering for.
 */
export function renderGameSettings(model) {
  const settings = {};
  const strengthByKey = {};
  const unmet = [];
  for (const need of (model && model.needs) || []) {
    const fn = GAME_DERIVATION[need.dimension];
    if (!fn) { if (need.dimension !== 'textSize') unmet.push(need.dimension); continue; }
    const s = need.strength || 'preference';
    for (const [k, v] of Object.entries(fn(need.value))) {
      if (k in settings && rankOf(s) < rankOf(strengthByKey[k])) continue;
      settings[k] = v;
      strengthByKey[k] = s;
    }
  }
  return { settings, unmet };
}
