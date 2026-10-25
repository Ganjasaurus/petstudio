/**
 * creative-engine.js: how the pet turns a lesson into its own attempt.
 *
 * AUTHORED ALGORITHM, NOT MACHINE LEARNING. `AuthoredCreativeEngine` applies
 * hand-written, seeded variation rules to the demonstration it is given:
 * it keeps recognisable parts of the lesson (rhythm, motif, contour, shapes,
 * colours) and varies the rest. Two knobs steer it:
 *   - style guidance from the player's nudges (energy: calmer..livelier,
 *     order: neater..wilder), stored in the teaching memory;
 *   - the pet's temperament (playful/calm shift energy, chaotic/neat shift order).
 * Same lesson + seed + style + temperament = same attempt. There are no
 * trainable parameters here: a learned controller replaces this class behind
 * the same compose(kind, source, opts) interface (hybrid-engine.js blends in
 * the trained networks from Iteration 3), and outputs carry `generator` tags
 * so the two can always be told apart.
 */
import { createRng, hashSeed } from './rng.js';
import {
  sanitizePhrase, sanitizeDrawing, PENTATONIC_SCALE, KEY_RANGE, DRUMS, drumById, isPentatonic,
  strokeLength, drawingStats, roundTo, PAPER,
} from './teaching-core.js';

export const MUSIC_GENERATOR = 'imitate-phrase-v1';
export const DRAWING_GENERATOR = 'imitate-draw-v1';
export const ENGINE_INFO = Object.freeze({
  id: 'authored-imitation-v1',
  kind: 'authored',
  learned: false,
  trainableParameters: 0,
  generators: Object.freeze({ music: MUSIC_GENERATOR, drawing: DRAWING_GENERATOR }),
  description: 'Hand-written, seeded variation rules that riff on a lesson from teaching memory. No trainable parameters; a learned controller can replace it behind the same compose() interface.',
});

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

// ---------------------------------------------------------------------------
// Style guidance
// ---------------------------------------------------------------------------
export const NUDGES = Object.freeze({
  calmer: Object.freeze({ id: 'calmer', label: 'Calmer', axis: 'energy', dir: -1 }),
  livelier: Object.freeze({ id: 'livelier', label: 'Livelier', axis: 'energy', dir: 1 }),
  neater: Object.freeze({ id: 'neater', label: 'Neater', axis: 'order', dir: -1 }),
  wilder: Object.freeze({ id: 'wilder', label: 'Wilder', axis: 'order', dir: 1 }),
});
export const NUDGE_IDS = Object.freeze(Object.keys(NUDGES));
export const NUDGE_STEP = 0.34;

export function sanitizeStyle(s) {
  const src = s && typeof s === 'object' ? s : {};
  return { energy: roundTo(clamp(num(src.energy, 0), -1, 1), 3), order: roundTo(clamp(num(src.order, 0), -1, 1), 3) };
}

/** Moves one style axis a step in the nudge's direction (clamped to [-1, 1]). */
export function applyNudge(style, id, step = NUDGE_STEP) {
  const s = sanitizeStyle(style);
  const nudge = NUDGES[id];
  if (!nudge) return s;
  s[nudge.axis] = roundTo(clamp(s[nudge.axis] + nudge.dir * step, -1, 1), 3);
  return s;
}

/** Which model made a creation: the learned network's steps and blend weight (null when authored). */
export function sanitizeModelTag(m) {
  if (!m || typeof m !== 'object' || !Number.isInteger(m.steps) || m.steps < 0) return null;
  return { steps: Math.min(m.steps, 1e7), alpha: Number.isFinite(m.alpha) ? Math.round(clamp(m.alpha, 0, 1) * 1000) / 1000 : 0 };
}

/** Direction tags for a style, e.g. ['calmer', 'neater']. */
export function styleTags(style, threshold = 0.15) {
  const s = sanitizeStyle(style);
  const tags = [];
  if (s.energy <= -threshold) tags.push('calmer');
  if (s.energy >= threshold) tags.push('livelier');
  if (s.order <= -threshold) tags.push('neater');
  if (s.order >= threshold) tags.push('wilder');
  return tags;
}

function normTraits(traits) {
  const t = {};
  for (const k of ['playful', 'calm', 'curious', 'dramatic', 'stubborn', 'neat', 'chaotic']) t[k] = clamp(num(traits?.[k], 0.4), 0, 1);
  return t;
}

/** Guidance plus a temperament lean: the style the engine actually uses. */
export function effectiveStyle(style, traits) {
  const s = sanitizeStyle(style);
  if (!traits) return s;
  const t = normTraits(traits);
  return {
    energy: roundTo(clamp(s.energy + 0.3 * (t.playful - t.calm) + 0.1 * (t.dramatic - 0.4), -1, 1), 3),
    order: roundTo(clamp(s.order + 0.3 * (t.chaotic - t.neat), -1, 1), 3),
  };
}

function fingerprint(value) {
  return hashSeed(JSON.stringify(value)).toString(36);
}

// ---------------------------------------------------------------------------
// Music
// ---------------------------------------------------------------------------
const SCALE = PENTATONIC_SCALE;
function degreeOf(midi) {
  let best = 0;
  let bestD = Infinity;
  SCALE.forEach((m, i) => {
    const d = Math.abs(m - midi);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}
const midiAt = (d) => SCALE[clamp(Math.round(d), 0, SCALE.length - 1)];
/** Moves a note by scale steps (the result always lands on the pentatonic scale). */
const shiftNote = (midi, steps) => (steps ? midiAt(degreeOf(midi) + steps) : midi);

function melodyFromHits(hits, beats) {
  // Drums-only lesson: the pet hums a little pentatonic line on the strong hits.
  const strong = hits.filter((h) => Math.abs(h.beat - Math.round(h.beat)) < 1e-6);
  const src = (strong.length >= 2 ? strong : hits).slice(0, 16);
  const contour = [4, 5, 6, 5, 4, 3, 4, 5];
  return src.map((h, i) => ({ beat: h.beat, midi: midiAt(contour[i % contour.length]), dur: 0.5, vel: 0.62 }))
    .filter((x) => x.beat < beats);
}

function transformMelody(notes, mode, rng, beats) {
  const half = beats / 2;
  const first = notes.filter((x) => x.beat < half);
  const second = notes.filter((x) => x.beat >= half);
  const meanDeg = notes.reduce((a, x) => a + degreeOf(x.midi), 0) / Math.max(1, notes.length);
  if (mode === 'echo' && first.length) {
    // Keep the opening as taught, then answer it with the same motif a step away.
    const shift = meanDeg > 6 ? rng.pick([-1, -2]) : meanDeg < 3 ? rng.pick([1, 2]) : rng.pick([-1, 1, 2]);
    return [...first.map((x) => ({ ...x })), ...first.map((x) => ({ ...x, beat: x.beat + half, midi: shiftNote(x.midi, shift) }))];
  }
  if (mode === 'answer' && first.length && second.length) {
    // Call and response: the second half mirrors the taught contour around its first note.
    const pivot = degreeOf(second[0].midi);
    return [...first.map((x) => ({ ...x })), ...second.map((x) => ({ ...x, midi: midiAt(pivot - (degreeOf(x.midi) - pivot)) }))];
  }
  if (mode === 'ornament') {
    const out = [];
    notes.forEach((x, i) => {
      const next = notes[i + 1];
      const gap = (next ? next.beat : beats) - x.beat;
      if (gap >= 1 && rng.chance(0.55)) {
        out.push({ ...x, dur: Math.min(x.dur, 0.5) });
        out.push({ beat: x.beat + 0.5, midi: shiftNote(x.midi, rng.pick([-1, 1])), dur: 0.5, vel: roundTo(x.vel * 0.82, 3) });
      } else {
        out.push({ ...x });
      }
    });
    return out;
  }
  // sequence: the whole tune moved up or down the scale, rhythm and contour intact
  const shift = meanDeg > 6 ? rng.pick([-1, -2]) : meanDeg < 3 ? rng.pick([1, 2]) : rng.pick([-2, -1, 1, 2]);
  return notes.map((x) => ({ ...x, midi: shiftNote(x.midi, shift) }));
}

function applyEnergy(notes, rng, { lively, calm, beats }) {
  let out = notes.map((x) => ({ ...x }));
  if (calm > 0) {
    // Calmer: fewer, longer, softer notes.
    const merged = [];
    let removed = 0;
    for (let i = 0; i < out.length; i++) {
      const x = out[i];
      const next = out[i + 1];
      if (next && next.beat - x.beat <= 0.5 + 1e-6 && out.length - removed > 3 && rng.chance(calm * 0.65)) {
        merged.push({ ...x, dur: next.beat + next.dur - x.beat });
        removed++;
        i++;
      } else {
        merged.push(x);
      }
    }
    out = merged.map((x) => ({ ...x, dur: x.dur * (1 + 0.5 * calm), vel: Math.max(0.22, x.vel * (1 - 0.3 * calm)) }));
  }
  if (lively > 0) {
    // Livelier: split long notes, add pickups, punchier and shorter.
    const busy = [];
    out.forEach((x, i) => {
      const next = out[i + 1];
      const gap = (next ? next.beat : beats) - x.beat;
      if (x.dur >= 1 && gap >= 1 && rng.chance(lively * 0.7)) {
        busy.push({ ...x, dur: 0.5 });
        busy.push({ beat: x.beat + 0.5, midi: shiftNote(x.midi, rng.pick([-1, 1, 2])), dur: 0.5, vel: x.vel * 0.9 });
      } else if (gap >= 1.5 && rng.chance(lively * 0.4)) {
        busy.push({ ...x });
        busy.push({ beat: x.beat + gap - 0.5, midi: next ? shiftNote(next.midi, rng.pick([-1, 1])) : x.midi, dur: 0.5, vel: x.vel * 0.85 });
      } else {
        busy.push({ ...x });
      }
    });
    out = busy.map((x) => ({ ...x, dur: lively > 0.4 ? Math.min(x.dur, 0.75) : x.dur, vel: Math.min(1, x.vel * (1 + 0.18 * lively)) }));
  }
  return out;
}

function applyOrder(notes, rng, { wild, neat, beats }) {
  let out = notes.map((x) => ({ ...x }));
  if (wild > 0) {
    const kept = [];
    for (const x of out) {
      if (kept.length + 3 < out.length && rng.chance(0.08 * wild)) continue; // a playful rest
      const y = { ...x };
      if (rng.chance(0.28 * wild)) y.midi = shiftNote(y.midi, rng.pick([-4, -3, -2, 2, 3, 4]));
      if (rng.chance(0.16 * wild)) y.beat = clamp(y.beat + rng.pick([-0.5, 0.5]), 0, beats - 0.5);
      kept.push(y);
    }
    out = kept;
  }
  if (neat > 0) {
    out = out.map((x) => ({ ...x, midi: neat > 0.2 && !isPentatonic(x.midi) ? midiAt(degreeOf(x.midi)) : x.midi }));
    for (let i = 1; i < out.length; i++) {
      const d = degreeOf(out[i].midi) - degreeOf(out[i - 1].midi);
      if (Math.abs(d) > 2 && rng.chance(0.4 + 0.6 * neat)) out[i].midi = midiAt(degreeOf(out[i - 1].midi) + Math.sign(d) * 2);
    }
  } else if (rng.chance(0.25)) {
    out = out.map((x) => ({ ...x, midi: isPentatonic(x.midi) ? x.midi : midiAt(degreeOf(x.midi)) }));
  }
  return out;
}

function finishNotes(notes, rng, { neat, beats }) {
  const sorted = notes
    .map((x) => ({
      beat: roundTo(clamp(x.beat, 0, beats - 0.25), 3),
      midi: clamp(Math.round(x.midi), KEY_RANGE.lo, KEY_RANGE.hi),
      dur: roundTo(clamp(x.dur, 0.25, 4), 3),
      vel: roundTo(clamp(x.vel, 0.12, 1), 3),
    }))
    .sort((a, b) => a.beat - b.beat || a.midi - b.midi);
  const out = [];
  for (const x of sorted) if (!out.some((y) => y.beat === x.beat && y.midi === x.midi)) out.push(x);
  // Pets like to end at home: resolve the last note to a C on a strong beat.
  const last = out[out.length - 1];
  if (last && rng.chance(0.5 + 0.5 * neat)) {
    last.midi = Math.abs(last.midi - 72) < Math.abs(last.midi - 60) ? 72 : 60;
    last.dur = roundTo(Math.max(last.dur, Math.min(1, beats - last.beat)), 3);
  }
  return out;
}

function transformHits(hits, rng, { lively, calm, wild, neat, beats }) {
  let out = hits.map((x) => ({ ...x }));
  const kick = drumById('kick').midi;
  const hat = drumById('hat').midi;
  const clap = drumById('clap').midi;
  if (calm > 0) out = out.filter((x) => !(x.midi === hat && rng.chance(calm)) && !(x.midi === clap && rng.chance(calm * 0.6)));
  if (lively > 0) {
    for (let b = 0.5; b < beats; b += 1) {
      if (!out.some((x) => x.beat === b) && rng.chance(lively * 0.8)) out.push({ beat: b, midi: hat, dur: 0.25, vel: 0.45 });
    }
    if (lively > 0.5 && !out.some((x) => x.midi === kick && x.beat === 0)) out.push({ beat: 0, midi: kick, dur: 0.25, vel: 0.75 });
  }
  if (neat > 0.4 && out.length) {
    const bar = out.filter((x) => x.beat < 4);
    if (bar.length) out = Array.from({ length: beats / 4 }, (_, k) => bar.map((x) => ({ ...x, beat: x.beat + 4 * k }))).flat();
  }
  if (wild > 0) {
    const extra = Math.round(wild * 3 * rng.next());
    for (let i = 0; i < extra; i++) out.push({ beat: rng.int(0, beats * 2 - 1) / 2, midi: rng.pick([clap, drumById('block').midi]), dur: 0.25, vel: 0.55 });
    out = out.map((x) => (rng.chance(0.12 * wild) ? { ...x, beat: clamp(x.beat + rng.pick([-0.5, 0.5]), 0, beats - 0.5) } : x));
  }
  return out.map((x) => ({ ...x, vel: roundTo(clamp(x.vel * (1 - 0.25 * calm + 0.1 * lively), 0.1, 1), 3) }));
}

/**
 * The pet's own take on a taught phrase (a constrained variation).
 * @param {object} source phrase
 * @param {{seed?: number, style?: object, traits?: object}} opts
 */
export function composePhraseAttempt(source, { seed = 1, style, traits } = {}) {
  const src = sanitizePhrase(source);
  const st = effectiveStyle(style, traits);
  const k = { lively: Math.max(0, st.energy), calm: Math.max(0, -st.energy), wild: Math.max(0, st.order), neat: Math.max(0, -st.order), beats: src.beats };
  const rng = createRng(hashSeed(`attempt:music:${seed >>> 0}:${fingerprint(src)}`));
  const tempo = Math.round(clamp(src.tempo * (1 + 0.14 * st.energy) + rng.range(-3, 3), 60, 160));
  let notes = src.notes.length ? src.notes : melodyFromHits(src.hits, src.beats);
  const mode = notes.length
    ? rng.weighted({ echo: 1 + 1.5 * k.neat, answer: 1 + 0.6 * k.wild, sequence: 0.8, ornament: 0.6 + 1.2 * k.lively })
    : 'none';
  if (notes.length) {
    notes = transformMelody(notes, mode, rng, src.beats);
    notes = applyEnergy(notes, rng, k);
    notes = applyOrder(notes, rng, k);
    notes = finishNotes(notes, rng, k);
  }
  const phrase = sanitizePhrase({ tempo, beats: src.beats, notes, hits: transformHits(src.hits, rng, k) });
  return { ...phrase, source: 'attempt', generator: MUSIC_GENERATOR, seed: seed >>> 0, mode, style: st };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
const STUDIO_PAINTS = ['#ff7fa3', '#ffbf3f', '#55b8ec', '#6ccf7f', '#9a7bff', '#ff8a4c'];

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
const rgbToHex = (c) => `#${c.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`;
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const mixHex = (hex, target, t) => rgbToHex(hexToRgb(hex).map((v, i) => v + (hexToRgb(target)[i] - v) * t));

/** The pet paints with its own colours (made readable on cream paper) plus studio paints. */
function petPalette(colors, calm) {
  const own = [colors?.cheekColor, colors?.bodyColor, colors?.accentColor]
    .filter((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c))
    .map((c) => (luminance(c) > 0.5 ? mixHex(c, '#3d2c3e', 0.32) : c.toLowerCase()));
  const palette = [...own, ...STUDIO_PAINTS];
  return calm > 0.3 ? palette.map((c) => mixHex(c, '#ffffff', 0.18 * calm)) : palette;
}

function smoothPoints(pts, amount) {
  if (pts.length < 5) return pts;
  const k = clamp(amount, 0, 1) * 0.5;
  return pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return p;
    const a = pts[i - 1];
    const b = pts[i + 1];
    return [p[0] + ((a[0] + b[0]) / 2 - p[0]) * k, p[1] + ((a[1] + b[1]) / 2 - p[1]) * k, ...p.slice(2)];
  });
}

function overshoot(pts, amount) {
  if (pts.length < 3) return pts;
  const a = pts[pts.length - 2];
  const b = pts[pts.length - 1];
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const ux = (b[0] - a[0]) / d;
  const uy = (b[1] - a[1]) / d;
  const extra = [];
  for (let s = 0.012; s <= amount; s += 0.012) extra.push([b[0] + ux * s, b[1] + uy * s, ...(b.length > 2 ? [b[2] * 0.8, 0.012] : [])]);
  return [...pts, ...extra];
}

function flourish(rng, bbox, color, width) {
  const corner = [
    [bbox.minX - 0.05, bbox.minY - 0.04], [bbox.maxX + 0.05, bbox.minY - 0.04],
    [bbox.maxX + 0.05, bbox.maxY + 0.03], [bbox.minX - 0.05, bbox.maxY + 0.03],
  ][rng.int(0, 3)];
  const [cx, cy] = [clamp(corner[0], 0.08, 0.92), clamp(corner[1], 0.08, 0.92)];
  const kind = rng.pick(['sparkle', 'dot', 'swoosh']);
  if (kind === 'dot') return [{ color, width: width * 1.4, points: [[cx, cy]], motif: 'flourish' }];
  if (kind === 'swoosh') {
    const pts = [];
    for (let i = 0; i <= 10; i++) {
      const u = i / 10;
      pts.push([cx - 0.05 + 0.1 * u, cy + Math.sin(u * Math.PI) * -0.025]);
    }
    return [{ color, width: width * 0.8, points: pts, motif: 'flourish' }];
  }
  const r = 0.028;
  return [
    { color, width: width * 0.7, points: [[cx - r, cy], [cx, cy], [cx + r, cy]], motif: 'flourish' },
    { color, width: width * 0.7, points: [[cx, cy - r], [cx, cy], [cx, cy + r]], motif: 'flourish' },
  ];
}

function signatureHeart(color) {
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const t = (i / 24) * TAU;
    const x = 16 * Math.sin(t) ** 3;
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    pts.push([0.915 + (x / 17) * 0.028, 0.915 - (y / 17) * 0.028]);
  }
  return { color, width: 0.008, points: pts, motif: 'signature' };
}

function fitToPaper(strokes, margin) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of strokes) {
    for (const p of s.points) {
      minX = Math.min(minX, p[0]);
      minY = Math.min(minY, p[1]);
      maxX = Math.max(maxX, p[0]);
      maxY = Math.max(maxY, p[1]);
    }
  }
  if (!Number.isFinite(minX)) return strokes;
  const lo = margin;
  const hi = 1 - margin;
  const scale = Math.min(1, (hi - lo) / Math.max(1e-6, maxX - minX), (hi - lo) / Math.max(1e-6, maxY - minY));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const half = { x: ((maxX - minX) * scale) / 2, y: ((maxY - minY) * scale) / 2 };
  const tx = clamp(cx, lo + half.x, hi - half.x) - cx;
  const ty = clamp(cy, lo + half.y, hi - half.y) - cy;
  return strokes.map((s) => ({
    ...s,
    points: s.points.map((p) => [cx + (p[0] - cx) * scale + tx, cy + (p[1] - cy) * scale + ty, ...p.slice(2)]),
  }));
}

/**
 * The pet's own take on a taught drawing: same subject and colours, its own
 * hand (wobble), a composition shift, guidance-driven character (calmer =
 * softer colours and thinner, smoother lines; livelier = bolder lines and
 * flourishes; neater = smoothed; wilder = wobblier, overshooting, sometimes
 * mirrored) and a tiny heart signature so attempts are recognisable at a glance.
 *
 * `neural` (optional, Iteration 3) blends in a learned stroke hand:
 * { alpha, steadiness, strokes: [{ dx, dy, pressure, width, color, colorConf }] }
 * from StrokePolicyNet. Each point moves (1 - alpha) by the authored wobble
 * and alpha toward the network's reconstruction; pressure, width and colour
 * blend the same way, and the learned steadiness damps the authored
 * placement jitter (tilt, scale, shift). Random draws are identical with or
 * without it, so alpha = 0 reproduces the authored attempt exactly.
 */
export function composeDrawingAttempt(source, { seed = 1, style, traits, colors, neural = null } = {}) {
  const src = sanitizeDrawing(source);
  const st = effectiveStyle(style, traits);
  const lively = Math.max(0, st.energy);
  const calm = Math.max(0, -st.energy);
  const wild = Math.max(0, st.order);
  const neat = Math.max(0, -st.order);
  const a = neural && neural.alpha > 0 ? clamp(neural.alpha, 0, 1) : 0;
  const learned = a > 0 && Array.isArray(neural.strokes) ? neural.strokes : [];
  const steady = a > 0 ? clamp(num(neural.steadiness, 0), 0, 1) * a : 0;
  const rng = createRng(hashSeed(`attempt:draw:${seed >>> 0}:${fingerprint(src)}`));
  const palette = petPalette(colors, calm);
  const stats = drawingStats(src);
  const bb = stats.bbox ?? { minX: 0.35, minY: 0.35, maxX: 0.65, maxY: 0.65 };
  const cx = (bb.minX + bb.maxX) / 2;
  const cy = (bb.minY + bb.maxY) / 2;
  const jitterScale = 1 - steady;
  const angle = rng.noise() * (0.05 + 0.2 * wild) * jitterScale;
  const scale = 1 + (rng.noise() * (0.05 + 0.1 * wild) - 0.04 * calm) * jitterScale;
  const tx = rng.noise() * (0.025 + 0.045 * wild) * jitterScale;
  const ty = rng.noise() * (0.025 + 0.045 * wild) * jitterScale;
  const mirror = rng.chance(0.3 * wild) && steady < 0.5;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const place = (x, y) => {
    let dx = (x - cx) * scale;
    const dy = (y - cy) * scale;
    if (mirror) dx = -dx;
    return [cx + dx * cos - dy * sin + tx, cy + dx * sin + dy * cos + ty];
  };
  const wobble = Math.max(0, 0.0045 + 0.013 * wild - 0.004 * neat - 0.0015 * calm);
  const jitter = 0.0035 * wild;
  const keepColor = 0.82 - 0.3 * wild - 0.1 * calm;
  const maxDrops = src.strokes.length > 3 ? Math.floor(src.strokes.length * 0.2) : 0;
  let drops = 0;
  const out = [];
  src.strokes.forEach((s, si) => {
    if (drops < maxDrops && rng.chance(0.07 * wild)) {
      drops++;
      return;
    }
    const r = learned[si] && learned[si].dx?.length === s.points.length ? learned[si] : null;
    const len = strokeLength(s);
    const ph1 = rng.range(0, TAU);
    const ph2 = rng.range(0, TAU);
    const f1 = rng.range(1.5, 3.5);
    const f2 = rng.range(5, 9);
    let acc = 0;
    let pts = s.points.map((p, i, arr) => {
      if (i > 0) acc += Math.hypot(p[0] - arr[i - 1][0], p[1] - arr[i - 1][1]);
      const u = len > 0 ? acc / len : 0;
      const pa = arr[Math.max(0, i - 1)];
      const pb = arr[Math.min(arr.length - 1, i + 1)];
      let nx = -(pb[1] - pa[1]);
      let ny = pb[0] - pa[0];
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl;
      ny /= nl;
      const w = wobble * (0.7 * Math.sin(ph1 + u * f1 * TAU) + 0.3 * Math.sin(ph2 + u * f2 * TAU)) * Math.min(1, len * 6);
      let ox = nx * w + rng.noise() * jitter;
      let oy = ny * w + rng.noise() * jitter;
      let pressure = p.length > 2 ? clamp(p[2] * (1 + 0.2 * st.energy), 0.05, 1) : 0.55;
      if (r) {
        ox = (1 - a) * ox + a * r.dx[i];
        oy = (1 - a) * oy + a * r.dy[i];
        pressure = clamp((1 - a) * pressure + a * r.pressure[i], 0.05, 1);
      }
      const [x, y] = place(p[0] + ox, p[1] + oy);
      return [x, y, pressure, 0];
    });
    if (neat > 0.2 || calm > 0.4) pts = smoothPoints(pts, Math.max(neat, calm * 0.6) * (1 - a));
    if (wild > 0.3 && rng.chance(0.5 * wild)) pts = overshoot(pts, 0.03 * wild * (1 - a));
    let base = rng.chance(keepColor) ? s.color : rng.pick(palette);
    let width = clamp(s.width * (1 + 0.3 * st.energy) * rng.range(0.9, 1.1), 0.005, 0.07);
    if (r) {
      if (r.color && ((hashSeed(`${seed >>> 0}:color:${si}`) % 1000) / 1000) < a * clamp(num(r.colorConf, 0), 0, 1)) base = r.color;
      width = clamp((1 - a) * width + a * num(r.width, width), 0.005, 0.07);
    }
    out.push({
      color: calm > 0.3 ? mixHex(base, '#ffffff', 0.14 * calm) : base,
      width,
      points: pts,
    });
  });
  const accent = palette[0] ?? '#ff7fa3';
  if (lively > 0.15) {
    const count = 1 + Math.round(lively * 3 * rng.next());
    for (let i = 0; i < count; i++) out.push(...flourish(rng, bb, rng.pick(palette), 0.016));
  }
  const fitted = fitToPaper(out, 0.045);
  fitted.push(signatureHeart(accent));
  // Steady pet pace for replays (the easel paints by length, not by time).
  let t = 0;
  const timed = fitted.map((s) => {
    const dur = Math.max(0.1, strokeLength(s) / 0.7);
    const step = s.points.length > 1 ? dur / (s.points.length - 1) : 0;
    const stroke = { ...s, points: s.points.map((p, i) => [p[0], p[1], p[2] ?? 0.55, i === 0 ? 0 : step]), t0: t, dur };
    t += dur + 0.25;
    return stroke;
  });
  const drawing = sanitizeDrawing({ paper: PAPER, strokes: timed });
  return { ...drawing, source: 'attempt', generator: DRAWING_GENERATOR, seed: seed >>> 0, style: st };
}

/** The replaceable creative-engine interface (authored implementation). */
export class AuthoredCreativeEngine {
  constructor() {
    this.info = ENGINE_INFO;
  }

  /**
   * @param {'music'|'drawing'} kind
   * @param {object} source the lesson (phrase or drawing)
   * @param {{seed?: number, style?: object, traits?: object, colors?: object}} opts
   */
  compose(kind, source, opts = {}) {
    return kind === 'music' ? composePhraseAttempt(source, opts) : composeDrawingAttempt(source, opts);
  }
}

export { DRUMS };
