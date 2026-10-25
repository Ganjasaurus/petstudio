/**
 * starter-repertoire.js — authored, deterministic starter content.
 *
 * Gives a brand-new pet something to make on day one. NOTHING HERE LEARNS:
 * every output is a pure function of (seed, temperament, colours) built from
 * a small hand-written motif vocabulary. Outputs are tagged
 * `source: 'starter'` plus a generator version so behaviour acquired later
 * through genuine on-device training stays distinguishable in storage and
 * diagnostics. Later iterations call these through a replaceable creative
 * engine interface and keep them as fallback candidates.
 *
 * Representations (shared with the future teaching tools):
 *  - Drawing: { strokes: [{ motif, color, width, points: [[x, y], ...] }] }
 *    x, y normalised to [0, 1] with y pointing down; one-point strokes are dots;
 *    `width` is a fraction of the canvas size.
 *  - Phrase: { tempo, beats, notes: [{ beat, midi, dur, vel }] } on a major
 *    pentatonic scale; beats are relative to the phrase start.
 */
import { createRng, hashSeed } from './rng.js';

export const STARTER_DRAWING_GENERATOR = 'starter-draw-v1';
export const STARTER_PHRASE_GENERATOR = 'starter-phrase-v1';

/** Studio paint pots (shared, authored). */
export const STUDIO_PAINTS = Object.freeze(['#ff7fa3', '#ffbf3f', '#55b8ec', '#6ccf7f', '#9a7bff', '#ff8a4c', '#4a3f6b']);
const PASTEL_PAINTS = Object.freeze(['#f59ab5', '#f7c873', '#8ccbee', '#9ad9a4', '#b9a3ff']);

const TRAIT_KEYS = ['playful', 'calm', 'curious', 'dramatic', 'stubborn', 'neat', 'chaotic'];
const TAU = Math.PI * 2;
const MAX_STROKES = 14;

function normTraits(traits) {
  const t = {};
  for (const k of TRAIT_KEYS) {
    const v = traits?.[k];
    t[k] = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.4;
  }
  return t;
}

const clamp01 = (v) => Math.min(0.96, Math.max(0.04, v));
const r4 = (v) => Math.round(v * 10000) / 10000;

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function darken(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * (1 - amount)));
  return `#${ch.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** The pet paints with its own colours (made readable on cream paper) plus studio paints. */
function buildPalette(t, colors, rng) {
  const own = [colors?.bodyColor, colors?.cheekColor, colors?.accentColor]
    .filter((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c))
    .map((c) => (luminance(c) > 0.55 ? darken(c, 0.28) : c));
  const studio = (t.calm > 0.6 && t.dramatic < 0.5 ? PASTEL_PAINTS : STUDIO_PAINTS)
    .filter((c) => c !== '#4a3f6b' || t.dramatic >= 0.6); // deep plum is for dramatic pets
  const pool = [...own, ...studio];
  const size = Math.min(pool.length, 3 + Math.round(2 * t.chaotic + t.playful));
  const palette = [];
  while (palette.length < size && pool.length) palette.push(pool.splice(Math.floor(rng.next() * pool.length), 1)[0]);
  return palette;
}

function motifWeights(t) {
  return {
    wave: 0.4 + 1.1 * t.calm,
    spiral: 0.3 + 0.9 * t.curious + 0.3 * t.playful,
    loops: 0.3 + 1.0 * t.playful,
    zigzag: 0.2 + 0.9 * t.chaotic + 0.4 * t.dramatic,
    circle: 0.3 + 1.0 * t.neat,
    sun: 0.15 + 1.1 * t.dramatic,
    dots: 0.3 + 0.6 * t.playful + 0.4 * t.chaotic,
    scribble: 0.05 + 1.2 * t.chaotic,
    stripes: 0.05 + 0.9 * t.neat,
    flower: 0.2 + 0.6 * t.curious + 0.4 * t.playful,
    hills: 0.3 + 0.8 * t.calm,
    star: 0.15 + 0.6 * t.dramatic + 0.3 * t.neat,
  };
}

// ----- motif builders: each returns an array of { color, width, points } -----
const MOTIFS = {
  wave(rng, o) {
    const y0 = rng.range(0.2, 0.85);
    const amp = rng.range(0.025, 0.07);
    const freq = rng.range(1.5, 3.5);
    const phase = rng.range(0, TAU);
    const x0 = rng.range(0.06, 0.2);
    const x1 = rng.range(0.8, 0.94);
    const pts = [];
    for (let i = 0; i < 36; i++) {
      const u = i / 35;
      pts.push([x0 + (x1 - x0) * u, y0 + amp * Math.sin(phase + u * freq * TAU)]);
    }
    return [{ color: o.color, width: o.width, points: pts }];
  },
  spiral(rng, o) {
    const cx = rng.range(0.28, 0.72);
    const cy = rng.range(0.28, 0.72);
    const turns = rng.range(1.8, 3.2);
    const r1 = rng.range(0.08, 0.17);
    const dir = rng.chance(0.5) ? 1 : -1;
    const pts = [];
    for (let i = 0; i < 64; i++) {
      const u = i / 63;
      const a = dir * u * turns * TAU;
      pts.push([cx + r1 * u * Math.cos(a), cy + r1 * u * Math.sin(a) * 0.95]);
    }
    return [{ color: o.color, width: o.width * 0.85, points: pts }];
  },
  loops(rng, o) {
    const y0 = rng.range(0.25, 0.78);
    const k = rng.int(4, 7);
    const r = rng.range(0.035, 0.06);
    const x0 = rng.range(0.08, 0.16);
    const x1 = rng.range(0.84, 0.92);
    const pts = [];
    for (let i = 0; i < 90; i++) {
      const u = i / 89;
      const a = TAU * k * u;
      pts.push([x0 + (x1 - x0) * u - r * 1.2 * Math.sin(a), y0 - r * Math.cos(a) + r]);
    }
    return [{ color: o.color, width: o.width * 0.8, points: pts }];
  },
  zigzag(rng, o) {
    const y0 = rng.range(0.2, 0.8);
    const amp = rng.range(0.03, 0.08);
    const teeth = rng.int(5, 9);
    const pts = [];
    for (let i = 0; i <= teeth * 2; i++) {
      const u = i / (teeth * 2);
      pts.push([0.1 + 0.8 * u, y0 + (i % 2 ? amp : -amp)]);
    }
    return [{ color: o.color, width: o.width, points: pts }];
  },
  circle(rng, o) {
    const cx = rng.range(0.25, 0.75);
    const cy = rng.range(0.25, 0.75);
    const r = rng.range(0.06, 0.16);
    const start = rng.range(0, TAU);
    const pts = [];
    for (let i = 0; i <= 40; i++) {
      const a = start + (i / 40) * TAU;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return [{ color: o.color, width: o.width, points: pts }];
  },
  sun(rng, o) {
    const cx = rng.range(0.25, 0.75);
    const cy = rng.range(0.2, 0.5);
    const r = rng.range(0.06, 0.1);
    const circ = [];
    for (let i = 0; i <= 32; i++) {
      const a = (i / 32) * TAU;
      circ.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    const out = [{ color: o.color, width: o.width * 1.1, points: circ }];
    const rays = rng.int(8, 12);
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * TAU + rng.range(-0.08, 0.08);
      out.push({ color: o.color, width: o.width * 0.7, points: [
        [cx + r * 1.45 * Math.cos(a), cy + r * 1.45 * Math.sin(a)],
        [cx + r * 2.1 * Math.cos(a), cy + r * 2.1 * Math.sin(a)],
      ] });
    }
    return out;
  },
  dots(rng, o) {
    const cx = rng.range(0.25, 0.75);
    const cy = rng.range(0.25, 0.75);
    const n = rng.int(5, 11);
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, TAU);
      const d = rng.range(0, 0.14);
      out.push({ color: o.color, width: o.width * rng.range(0.9, 1.7), points: [[cx + d * Math.cos(a), cy + d * Math.sin(a)]] });
    }
    return out;
  },
  scribble(rng, o) {
    let x = rng.range(0.3, 0.7);
    let y = rng.range(0.3, 0.7);
    let heading = rng.range(0, TAU);
    const pts = [[x, y]];
    for (let i = 0; i < 48; i++) {
      heading += rng.range(-0.95, 0.95);
      const step = rng.range(0.018, 0.034);
      x = clamp01(x + Math.cos(heading) * step);
      y = clamp01(y + Math.sin(heading) * step);
      pts.push([x, y]);
    }
    return [{ color: o.color, width: o.width * 0.75, points: pts }];
  },
  stripes(rng, o) {
    const n = rng.int(3, 5);
    const tilt = rng.chance(0.5) ? 0 : rng.range(-0.25, 0.25);
    const y0 = rng.range(0.18, 0.45);
    const gap = rng.range(0.05, 0.08);
    const x0 = rng.range(0.12, 0.3);
    const x1 = rng.range(0.7, 0.88);
    const out = [];
    for (let i = 0; i < n; i++) {
      const y = y0 + i * gap;
      out.push({ color: o.color, width: o.width * 0.9, points: [[x0, y - tilt * 0.1], [(x0 + x1) / 2, y], [x1, y + tilt * 0.1]] });
    }
    return out;
  },
  flower(rng, o) {
    const cx = rng.range(0.3, 0.7);
    const cy = rng.range(0.3, 0.6);
    const petals = rng.int(5, 7);
    const pr = rng.range(0.045, 0.07);
    const out = [];
    out.push({ color: '#6ccf7f', width: o.width * 0.8, points: [[cx, cy + pr * 1.2], [cx + rng.range(-0.03, 0.03), Math.min(0.94, cy + pr * 1.2 + rng.range(0.18, 0.3))]] });
    for (let p = 0; p < petals; p++) {
      const a0 = (p / petals) * TAU;
      const pts = [];
      for (let i = 0; i <= 18; i++) {
        const u = (i / 18) * TAU;
        const lx = pr + pr * Math.cos(u);
        const ly = pr * 0.55 * Math.sin(u);
        pts.push([cx + lx * Math.cos(a0) - ly * Math.sin(a0), cy + lx * Math.sin(a0) + ly * Math.cos(a0)]);
      }
      out.push({ color: o.color, width: o.width * 0.7, points: pts });
    }
    out.push({ color: '#ffbf3f', width: o.width * 2.1, points: [[cx, cy]] });
    return out;
  },
  hills(rng, o) {
    const base = rng.range(0.72, 0.86);
    const bumps = rng.int(2, 4);
    const amp = rng.range(0.05, 0.12);
    const phase = rng.range(0, Math.PI);
    const pts = [];
    for (let i = 0; i < 40; i++) {
      const u = i / 39;
      pts.push([0.05 + 0.9 * u, base - amp * Math.abs(Math.sin(phase + u * bumps * Math.PI))]);
    }
    return [{ color: o.color, width: o.width * 1.1, points: pts }];
  },
  star(rng, o) {
    const cx = rng.range(0.25, 0.75);
    const cy = rng.range(0.22, 0.6);
    const r = rng.range(0.06, 0.12);
    const rot = rng.range(0, TAU);
    const pts = [];
    for (let i = 0; i <= 10; i++) {
      const a = rot + (i / 10) * TAU;
      const rr = i % 2 ? r * 0.45 : r;
      pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
    }
    return [{ color: o.color, width: o.width * 0.85, points: pts }];
  },
};

export const DRAWING_MOTIFS = Object.freeze(Object.keys(MOTIFS));

/**
 * Generates an authored starter drawing.
 * @param {{seed?: number, traits?: object, colors?: object}} opts
 */
export function generateStarterDrawing({ seed = 1, traits, colors } = {}) {
  const t = normTraits(traits);
  const rng = createRng(hashSeed(`draw:${seed >>> 0}`));
  const palette = buildPalette(t, colors, rng);
  const count = Math.min(7, Math.max(3, Math.round(3 + 2.2 * t.chaotic + 1.6 * t.playful - 1.2 * t.calm + rng.range(0, 1.5))));
  const jitter = Math.max(0, 0.003 + 0.014 * t.chaotic - 0.005 * t.neat);
  const widthBase = 0.013 + 0.012 * t.dramatic + 0.004 * t.playful;
  const weights = motifWeights(t);
  const strokes = [];
  const motifs = [];
  for (let i = 0; i < count && strokes.length < MAX_STROKES; i++) {
    const motif = rng.weighted(weights);
    weights[motif] *= 0.45; // prefer variety within one drawing
    motifs.push(motif);
    const color = palette[i % palette.length];
    for (const s of MOTIFS[motif](rng, { color, width: widthBase * rng.range(0.85, 1.2), t })) {
      if (strokes.length >= MAX_STROKES) break;
      strokes.push({
        motif,
        color: s.color,
        width: r4(Math.min(0.06, Math.max(0.006, s.width))),
        points: s.points.map(([x, y]) => [r4(clamp01(x + rng.noise() * jitter)), r4(clamp01(y + rng.noise() * jitter))]),
      });
    }
  }
  return {
    generator: STARTER_DRAWING_GENERATOR,
    source: 'starter',
    seed: seed >>> 0,
    paper: '#fffaf1',
    palette,
    motifs,
    strokes,
  };
}

/** Total polyline length of a drawing (normalised units); dots count as a small fixed length. */
export function drawingLength(drawing) {
  let total = 0;
  for (const s of drawing.strokes) total += strokeLength(s);
  return total;
}

export function strokeLength(stroke) {
  const p = stroke.points;
  if (p.length < 2) return 0.03;
  let len = 0;
  for (let i = 1; i < p.length; i++) len += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return len;
}

// ---------------------------------------------------------------------------
// Music
// ---------------------------------------------------------------------------
const PENTATONIC = [0, 2, 4, 7, 9];
const ROOT = 60; // C4

/** Scale-degree index (0..12) to MIDI note on the C major pentatonic scale. */
export function degreeToMidi(index) {
  const i = Math.max(0, Math.min(12, Math.round(index)));
  return ROOT + 12 * Math.floor(i / 5) + PENTATONIC[i % 5];
}

const RHYTHM_CELLS = Object.freeze({ q: [1], h: [2], ee: [0.5, 0.5], dq: [1.5, 0.5], sw: [0.5, 1, 0.5] });

/**
 * Generates an authored two-bar (8 beat) starter phrase.
 * mode 'perform' = the pet playing the keyboard; 'lullaby' = soft music from
 * the studio speakers while it listens on the rug.
 */
export function generateStarterPhrase({ seed = 1, traits, mode = 'perform' } = {}) {
  const t = normTraits(traits);
  const soft = mode === 'lullaby';
  const rng = createRng(hashSeed(`phrase:${soft ? 'lullaby' : 'perform'}:${seed >>> 0}`));
  const rawTempo = soft
    ? 74 + rng.range(-4, 6)
    : 92 + 34 * t.playful - 22 * t.calm + 10 * t.dramatic + rng.range(-6, 6);
  const tempo = Math.round(Math.min(144, Math.max(66, rawTempo)));
  const beats = 8;

  const cellWeights = soft
    ? { q: 3, h: 2, ee: 0.5 }
    : {
      q: 1.2 + 1.2 * t.calm + 0.6 * t.neat,
      h: 0.4 + 1.0 * t.calm,
      ee: 0.6 + 1.4 * t.playful + 0.4 * t.chaotic,
      dq: 0.2 + 0.8 * t.dramatic,
      sw: 0.1 + 1.2 * t.chaotic,
    };
  const durations = [];
  let total = 0;
  while (total < beats - 1e-9) {
    let cell = RHYTHM_CELLS[rng.weighted(cellWeights)];
    const len = cell.reduce((a, b) => a + b, 0);
    if (total + len > beats + 1e-9) cell = [beats - total];
    durations.push(...cell);
    total += cell.reduce((a, b) => a + b, 0);
  }
  // Neat pets repeat their first-bar rhythm in the second bar.
  if (!soft && t.neat > 0.6) {
    const firstBar = [];
    let acc = 0;
    for (const d of durations) {
      if (acc + d > 4 + 1e-9) break;
      firstBar.push(d);
      acc += d;
    }
    if (Math.abs(acc - 4) < 1e-9) durations.splice(0, durations.length, ...firstBar, ...firstBar);
  }

  const maxStep = soft ? 1 : 1 + Math.round(2 * t.dramatic + t.chaotic);
  const upBias = 0.25 * t.curious - 0.15 * t.calm;
  // Range C4..A5 = the 13 white keys of the studio keyboard, so every note has a key to press.
  const lo = soft ? 2 : 0;
  const hi = soft ? 7 : 9;
  let idx = soft ? 4 : rng.int(3, 6);
  let beat = 0;
  const notes = [];
  durations.forEach((dur, i) => {
    if (i > 0) {
      let step = rng.int(-maxStep, maxStep);
      if (rng.next() < Math.abs(upBias)) step = Math.sign(upBias) * Math.max(1, Math.abs(step));
      if (step === 0 && rng.chance(0.6 - 0.4 * t.neat)) step = rng.chance(0.5) ? 1 : -1;
      idx = Math.max(lo, Math.min(hi, idx + step));
    }
    if (i === durations.length - 1) idx = idx >= 3 ? 5 : 0; // resolve home to C
    const onStrongBeat = Math.abs(beat % 2) < 1e-9;
    const vel = soft
      ? 0.3 + rng.range(0, 0.08)
      : Math.min(1, 0.55 + (onStrongBeat ? 0.1 + 0.18 * t.dramatic : 0) + rng.range(-0.06, 0.06));
    notes.push({ beat: r4(beat), midi: degreeToMidi(idx), dur: r4(dur * (soft ? 0.95 : 0.85)), vel: r4(vel) });
    beat += dur;
  });

  return {
    generator: STARTER_PHRASE_GENERATOR,
    source: 'starter',
    seed: seed >>> 0,
    mode: soft ? 'lullaby' : 'perform',
    tempo,
    beats,
    notes,
  };
}

/** Phrase length in seconds. */
export function phraseDurationSeconds(phrase) {
  return (phrase.beats * 60) / phrase.tempo;
}
