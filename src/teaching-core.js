/**
 * teaching-core.js: shared, pure representations for teaching examples
 * (teaching-example capture). No DOM and no Three.js, so it is fully
 * testable in Node.
 *
 * Phrase (music):
 *   { tempo, beats, notes: [{ beat, midi, dur, vel }], hits: [{ beat, midi, dur, vel }] }
 *   `notes` are pitched events on the studio keyboard (C4..A5, MIDI 60..81).
 *   `hits` are percussion events using General MIDI drum numbers (36 kick,
 *   39 clap, 42 closed hi-hat, 76 wood block), kept in their own list so a
 *   drum number can never be confused with a pitch. Beats are relative to the
 *   phrase start, durations are in beats, velocity is 0..1.
 *
 * Drawing:
 *   { paper, strokes: [{ color, width, points: [[x, y, p, dt], ...], t0, dur }] }
 *   x, y are normalised to [0, 1] (y down) on a square canvas; p is pen
 *   pressure 0..1; dt is seconds since the previous point (0 for the first).
 *   Each stroke is exactly one pen-down..pen-up span, so the raw `pen_state`
 *   of the capture is encoded by the stroke segmentation. `width` is a
 *   fraction of the canvas size; `t0` is when the stroke started, in seconds
 *   from the first stroke (pauses between strokes survive). Starter strokes
 *   with plain [x, y] points are valid drawings too.
 *
 * Capture: PhraseRecorder (free taps or a metronome pass, quantised to an
 * eighth-note grid) and StrokeRecorder (raw x, y, pressure, dt, pen_state
 * samples, normalised and resampled to even arc-length spacing).
 * Templates are authored starter material for one-tap demos. Nothing in this
 * file learns.
 */
import { strokeLength, drawingLength } from './starter-repertoire.js';

export { strokeLength, drawingLength };

const TAU = Math.PI * 2;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
export function roundTo(v, digits = 3) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

// ---------------------------------------------------------------------------
// Music vocabulary
// ---------------------------------------------------------------------------
/** The studio keyboard spans C4..A5 (13 white and 9 black keys). */
export const KEY_RANGE = Object.freeze({ lo: 60, hi: 81 });
export const PENTATONIC_PCS = Object.freeze([0, 2, 4, 7, 9]);
/** Every pentatonic pitch on the studio keyboard, low to high. */
export const PENTATONIC_SCALE = Object.freeze([60, 62, 64, 67, 69, 72, 74, 76, 79, 81]);
export const PHRASE_LIMITS = Object.freeze({
  tempo: Object.freeze([60, 160]),
  defaultTempo: 100,
  beatsOptions: Object.freeze([8, 16]),
  grid: 0.5, // eighth notes
  durStep: 0.25,
  maxDur: 4,
  maxNotes: 64,
  maxHits: 64,
});

/** Percussion pads (General MIDI drum map numbers). */
export const DRUMS = Object.freeze([
  Object.freeze({ id: 'kick', label: 'Boom', midi: 36, color: '#ff9a6b' }),
  Object.freeze({ id: 'clap', label: 'Clap', midi: 39, color: '#f27fae' }),
  Object.freeze({ id: 'hat', label: 'Tick', midi: 42, color: '#5cc3ef' }),
  Object.freeze({ id: 'block', label: 'Tock', midi: 76, color: '#8fcf6a' }),
]);
const DRUM_BY_MIDI = new Map(DRUMS.map((d) => [d.midi, d]));
const DRUM_BY_ID = new Map(DRUMS.map((d) => [d.id, d]));
export const drumByMidi = (midi) => DRUM_BY_MIDI.get(midi) ?? null;
export const drumById = (id) => DRUM_BY_ID.get(id) ?? null;

/** Pastel colour per pitch class (shared by the timeline, keys and floating notes). */
export const NOTE_COLORS = Object.freeze({
  0: '#ff8fa3', 1: '#e7a3cf', 2: '#ffb35c', 3: '#efb98f', 4: '#ffd84d', 5: '#9be08f',
  6: '#a9d9b6', 7: '#7fd8c8', 8: '#9fcbdc', 9: '#8fc8ff', 10: '#b3b4f2', 11: '#c3a6ff',
});
const pc = (midi) => ((midi % 12) + 12) % 12;
export const noteColor = (midi) => NOTE_COLORS[pc(midi)];
export const isPentatonic = (midi) => PENTATONIC_PCS.includes(pc(midi));
export const isBlackKey = (midi) => [1, 3, 6, 8, 10].includes(pc(midi));
const NAMES = Object.freeze(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']);
export function noteName(midi) {
  return `${NAMES[pc(midi)]}${Math.floor(midi / 12) - 1}`;
}

/** Notes shown on the teaching keyboard: pentatonic by default, all 22 keys when chromatic. */
export function keyboardNotes({ chromatic = false } = {}) {
  const out = [];
  for (let m = KEY_RANGE.lo; m <= KEY_RANGE.hi; m++) if (chromatic || isPentatonic(m)) out.push(m);
  return out;
}

/** Rounds `value` to the nearest multiple of `step` (float-safe). */
export function quantize(value, step = PHRASE_LIMITS.grid) {
  if (!(step > 0) || !Number.isFinite(value)) return value;
  return roundTo(Math.round(value / step) * step, 6);
}

// ---------------------------------------------------------------------------
// Phrase sanitisation and metrics
// ---------------------------------------------------------------------------
function sanitizeEvent(e, beats, drum) {
  if (!e || typeof e !== 'object') return null;
  const { beat, midi } = e;
  if (typeof beat !== 'number' || !Number.isFinite(beat) || !Number.isInteger(midi)) return null;
  if (beat < 0 || beat >= beats) return null;
  if (drum ? !DRUM_BY_MIDI.has(midi) : midi < KEY_RANGE.lo || midi > KEY_RANGE.hi) return null;
  const room = Math.max(0.05, beats - beat);
  return {
    beat: roundTo(beat, 3),
    midi,
    dur: roundTo(clamp(num(e.dur, drum ? 0.25 : 0.5), 0.05, Math.min(PHRASE_LIMITS.maxDur, room)), 3),
    vel: roundTo(clamp(num(e.vel, 0.7), 0.05, 1), 3),
  };
}

function cleanEvents(list, beats, drum, max) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const e of list.slice(0, max * 4)) {
    const ev = sanitizeEvent(e, beats, drum);
    if (!ev) continue;
    const key = `${ev.beat}|${ev.midi}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
  }
  out.sort((a, b) => a.beat - b.beat || a.midi - b.midi);
  return out.slice(0, max);
}

/** Validates any phrase-like object into the canonical phrase representation. */
export function sanitizePhrase(p) {
  const src = p && typeof p === 'object' ? p : {};
  const L = PHRASE_LIMITS;
  const tempo = Math.round(clamp(num(src.tempo, L.defaultTempo), L.tempo[0], L.tempo[1]));
  const beats = num(src.beats, 8) > 8 ? 16 : 8;
  return {
    tempo,
    beats,
    notes: cleanEvents(src.notes, beats, false, L.maxNotes),
    hits: cleanEvents(src.hits, beats, true, L.maxHits),
  };
}

export const emptyPhrase = (tempo = PHRASE_LIMITS.defaultTempo, beats = 8) => ({ tempo, beats, notes: [], hits: [] });
export const phraseIsEmpty = (p) => !p || ((!p.notes || !p.notes.length) && (!p.hits || !p.hits.length));
export const phraseSeconds = (p) => (p.beats * 60) / p.tempo;

/** Descriptive statistics (tests, tags and diagnostics). */
export function phraseStats(p) {
  const notes = p?.notes ?? [];
  const hits = p?.hits ?? [];
  const n = notes.length;
  const pitches = notes.map((x) => x.midi);
  let travel = 0;
  let leaps = 0;
  for (let i = 1; i < n; i++) {
    const d = Math.abs(pitches[i] - pitches[i - 1]);
    travel += d;
    if (d > 4) leaps++;
  }
  const mean = (f) => (n ? notes.reduce((a, x) => a + f(x), 0) / n : 0);
  return {
    notes: n,
    hits: hits.length,
    tempo: p?.tempo ?? 0,
    beats: p?.beats ?? 0,
    density: p?.beats ? (n + hits.length) / p.beats : 0,
    meanVel: mean((x) => x.vel),
    meanDur: mean((x) => x.dur),
    range: n ? Math.max(...pitches) - Math.min(...pitches) : 0,
    meanStep: n > 1 ? travel / (n - 1) : 0,
    leapRatio: n > 1 ? leaps / (n - 1) : 0,
    pentatonicRatio: n ? notes.filter((x) => isPentatonic(x.midi)).length / n : 1,
    onBeatRatio: n ? notes.filter((x) => Math.abs(x.beat - Math.round(x.beat)) < 1e-6).length / n : 0,
  };
}

/**
 * Similarity of two phrases in [0, 1]: `rhythm` is the overlap of onset
 * positions (Jaccard on the eighth-note grid); `melody` averages pitch-class
 * content (cosine) and contour agreement (same up/down/repeat motion on the
 * grid). Purely descriptive: used by the Gallery comparison and the tests.
 */
export function phraseSimilarity(a, b) {
  const A = sanitizePhrase(a);
  const B = sanitizePhrase(b);
  const beats = Math.min(A.beats, B.beats);
  const onsets = (p) => new Set([...p.notes, ...p.hits].filter((e) => e.beat < beats).map((e) => quantize(e.beat, 0.5)));
  const oa = onsets(A);
  const ob = onsets(B);
  const union = new Set([...oa, ...ob]).size;
  const rhythm = union ? [...oa].filter((x) => ob.has(x)).length / union : 1;
  const hist = (p) => {
    const h = new Array(12).fill(0);
    for (const n of p.notes) if (n.beat < beats) h[pc(n.midi)] += n.dur;
    return h;
  };
  const ha = hist(A);
  const hb = hist(B);
  const na = Math.hypot(...ha);
  const nb = Math.hypot(...hb);
  const pcSim = na && nb ? ha.reduce((s, v, i) => s + v * hb[i], 0) / (na * nb) : na || nb ? 0 : 1;
  const line = (p) => {
    const slots = [];
    let cur = null;
    let j = 0;
    for (let s = 0; s < beats * 2; s++) {
      while (j < p.notes.length && p.notes[j].beat <= s / 2 + 1e-6) cur = p.notes[j++].midi;
      slots.push(cur);
    }
    return slots;
  };
  const la = line(A);
  const lb = line(B);
  let agree = 0;
  let total = 0;
  for (let s = 1; s < la.length; s++) {
    if (la[s] == null || lb[s] == null || la[s - 1] == null || lb[s - 1] == null) continue;
    total++;
    if (Math.sign(la[s] - la[s - 1]) === Math.sign(lb[s] - lb[s - 1])) agree++;
  }
  const contour = total ? agree / total : A.notes.length || B.notes.length ? 0 : 1;
  const melody = 0.5 * pcSim + 0.5 * contour;
  return { rhythm: roundTo(rhythm, 3), melody: roundTo(melody, 3), overall: roundTo((rhythm + melody) / 2, 3) };
}

// ---------------------------------------------------------------------------
// PhraseRecorder: turns taps into note events
// ---------------------------------------------------------------------------
export const RECORDER = Object.freeze({
  freeResetSeconds: 3, // a pause this long starts a new free-time take
  chordSeconds: 0.06, // taps closer than this land on the same beat
  // Longest gap (beats) kept between free-time taps: slow, one-note-at-a-time
  // tapping becomes steady quarter notes. Longer rests need a Record pass.
  maxFreeStep: 1,
  undoDepth: 40,
});

/**
 * Captures a phrase from key and pad taps. Times are in seconds from any
 * monotonic clock (event timestamps work best).
 *  - Free time (default): the first tap lands at beat 0 (or one beat after
 *    what is already there); later taps keep their spacing at the current
 *    tempo, quantised to the grid, so anyone can just play.
 *  - Metronome pass (startPass): taps land where the playhead is, quantised
 *    to the grid, layered over the existing phrase (overdub).
 * Every capture, clear and load can be undone.
 */
export class PhraseRecorder {
  constructor({ tempo = PHRASE_LIMITS.defaultTempo, beats = 8, grid = PHRASE_LIMITS.grid } = {}) {
    this.grid = grid;
    this.phrase = sanitizePhrase({ tempo, beats });
    this.pass = null;
    this.free = null;
    this.open = new Map();
    this.undoStack = [];
    this.seq = 0;
  }

  get tempo() {
    return this.phrase.tempo;
  }

  get beats() {
    return this.phrase.beats;
  }

  get recording() {
    return !!this.pass;
  }

  get isEmpty() {
    return phraseIsEmpty(this.phrase);
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  /** A clean copy of the current phrase. */
  snapshot() {
    return sanitizePhrase(this.phrase);
  }

  setTempo(bpm) {
    this.phrase.tempo = Math.round(clamp(num(bpm, this.tempo), PHRASE_LIMITS.tempo[0], PHRASE_LIMITS.tempo[1]));
    this.free = null;
    return this.phrase.tempo;
  }

  setBeats(beats) {
    const b = beats > 8 ? 16 : 8;
    if (b === this.phrase.beats) return b;
    this._snapshot();
    this.phrase = sanitizePhrase({ ...this.phrase, beats: b }); // shortening drops events past the end
    this.free = null;
    return b;
  }

  load(phrase) {
    this._snapshot();
    this.phrase = sanitizePhrase(phrase);
    this.free = null;
    this.open.clear();
  }

  clear() {
    if (this.isEmpty) return false;
    this._snapshot();
    this.phrase = sanitizePhrase({ tempo: this.tempo, beats: this.beats });
    this.free = null;
    this.open.clear();
    return true;
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    const p = JSON.parse(prev);
    this.phrase = sanitizePhrase({ ...p, tempo: this.tempo });
    this.free = null;
    this.open.clear();
    return true;
  }

  _snapshot() {
    this.undoStack.push(JSON.stringify({ beats: this.phrase.beats, notes: this.phrase.notes, hits: this.phrase.hits }));
    if (this.undoStack.length > RECORDER.undoDepth) this.undoStack.shift();
  }

  /** Starts a metronome pass whose beat 0 falls at time `t0` (seconds). */
  startPass(t0) {
    this.pass = { t0 };
    this.free = null;
  }

  stopPass() {
    const had = !!this.pass;
    this.pass = null;
    this.free = null;
    return had;
  }

  /** Playhead position (beats) at time t during a pass, else null. */
  beatAt(t) {
    return this.pass ? ((t - this.pass.t0) * this.tempo) / 60 : null;
  }

  _nextFreeBeat() {
    const all = [...this.phrase.notes, ...this.phrase.hits];
    if (!all.length) return 0;
    return quantize(Math.max(...all.map((e) => e.beat)), this.grid) + 1; // a one-beat breath first
  }

  /** Where a tap at time t lands: { beat } or { beat: null, reason: 'early' | 'full' }. */
  place(t) {
    const g = this.grid;
    const beats = this.beats;
    const bps = this.tempo / 60;
    if (this.pass) {
      const raw = (t - this.pass.t0) * bps;
      if (raw < -g / 2) return { beat: null, reason: 'early' };
      return { beat: roundTo(clamp(quantize(Math.max(0, raw), g), 0, beats - g), 3) };
    }
    const f = this.free;
    let beat;
    if (!f || t < f.t || t - f.t > RECORDER.freeResetSeconds) beat = this._nextFreeBeat();
    else if (t - f.t <= RECORDER.chordSeconds) beat = f.beat;
    else beat = f.beat + clamp(quantize((t - f.t) * bps, g), g, RECORDER.maxFreeStep);
    if (beat > beats - g + 1e-9) return { beat: null, reason: 'full' };
    return { beat: roundTo(beat, 3) };
  }

  _insert(list, ev) {
    const i = list.findIndex((e) => Math.abs(e.beat - ev.beat) < 1e-6 && e.midi === ev.midi);
    if (i >= 0) list.splice(i, 1, ev);
    else list.push(ev);
    list.sort((a, b) => a.beat - b.beat || a.midi - b.midi);
  }

  /** Key down. Returns { captured, beat, handle } or { captured: false, reason }. */
  noteOn(midi, t, vel = 0.7) {
    if (!Number.isInteger(midi) || midi < KEY_RANGE.lo || midi > KEY_RANGE.hi) return { captured: false, reason: 'range' };
    const spot = this.place(t);
    if (spot.beat == null) return { captured: false, reason: spot.reason };
    const exists = this.phrase.notes.some((e) => Math.abs(e.beat - spot.beat) < 1e-6 && e.midi === midi);
    if (!exists && this.phrase.notes.length >= PHRASE_LIMITS.maxNotes) return { captured: false, reason: 'limit' };
    this._snapshot();
    const ev = { beat: spot.beat, midi, dur: Math.min(0.5, this.beats - spot.beat), vel: roundTo(clamp(num(vel, 0.7), 0.05, 1), 3) };
    this._insert(this.phrase.notes, ev);
    if (!this.pass) this.free = { t, beat: spot.beat };
    const handle = ++this.seq;
    this.open.set(handle, { ev, t });
    return { captured: true, beat: ev.beat, handle };
  }

  /** Key up: the held time becomes the duration (quantised, at least an eighth). */
  noteOff(handle, t) {
    const o = this.open.get(handle);
    if (!o) return null;
    this.open.delete(handle);
    const held = Math.max(0, ((t - o.t) * this.tempo) / 60);
    const room = Math.max(0.25, this.beats - o.ev.beat);
    o.ev.dur = roundTo(clamp(quantize(held, PHRASE_LIMITS.durStep), Math.min(0.5, room), Math.min(PHRASE_LIMITS.maxDur, room)), 3);
    return { ...o.ev };
  }

  /** Percussion pad tap. */
  hit(midi, t, vel = 0.8) {
    if (!DRUM_BY_MIDI.has(midi)) return { captured: false, reason: 'unknown-drum' };
    const spot = this.place(t);
    if (spot.beat == null) return { captured: false, reason: spot.reason };
    const exists = this.phrase.hits.some((e) => Math.abs(e.beat - spot.beat) < 1e-6 && e.midi === midi);
    if (!exists && this.phrase.hits.length >= PHRASE_LIMITS.maxHits) return { captured: false, reason: 'limit' };
    this._snapshot();
    this._insert(this.phrase.hits, { beat: spot.beat, midi, dur: 0.25, vel: roundTo(clamp(num(vel, 0.8), 0.05, 1), 3) });
    if (!this.pass) this.free = { t, beat: spot.beat };
    return { captured: true, beat: spot.beat };
  }

  /** Removes one event (tap-to-delete on the timeline). */
  remove(beat, midi, drum = false) {
    const list = drum ? this.phrase.hits : this.phrase.notes;
    const i = list.findIndex((e) => Math.abs(e.beat - beat) < 1e-6 && e.midi === midi);
    if (i < 0) return false;
    this._snapshot();
    list.splice(i, 1);
    this.free = null;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Strokes
// ---------------------------------------------------------------------------
export const STROKE_LIMITS = Object.freeze({
  spacing: 0.012, // resampling distance (fraction of the canvas)
  dotLength: 0.006, // shorter strokes become dots
  maxPointsPerStroke: 160,
  sanitizePoints: 400,
  maxStrokes: 60,
  maxTotalPoints: 2400,
  width: Object.freeze([0.004, 0.08]),
  maxDt: 5,
  maxRawSamples: 4000,
});
export const PAPER = '#fffaf1';
export const BRUSH_SIZES = Object.freeze([
  Object.freeze({ id: 'fine', label: 'Fine', width: 0.012 }),
  Object.freeze({ id: 'medium', label: 'Medium', width: 0.022 }),
  Object.freeze({ id: 'bold', label: 'Bold', width: 0.038 }),
]);
export const DRAW_COLORS = Object.freeze(['#4a3f6b', '#ff7fa3', '#ff8a4c', '#ffbf3f', '#6ccf7f', '#55b8ec', '#9a7bff', '#a0785a']);

/** Client-pixel sample to normalised [0, 1] canvas coordinates. */
export function normalizeSample(sample, rect) {
  const w = rect?.width > 0 ? rect.width : 1;
  const h = rect?.height > 0 ? rect.height : 1;
  return [clamp((num(sample?.x, 0) - num(rect?.left, 0)) / w, 0, 1), clamp((num(sample?.y, 0) - num(rect?.top, 0)) / h, 0, 1)];
}

/**
 * Resamples a stroke at even arc-length spacing.
 * @param {{x:number, y:number, p?:number, t?:number}[]} raw normalised samples, t = seconds from the stroke start
 * @returns {number[][]} [[x, y, p, dt], ...]; a dot when the stroke is tiny
 */
export function resampleStroke(raw, spacing = STROKE_LIMITS.spacing, maxPoints = STROKE_LIMITS.maxPointsPerStroke) {
  const pts = [];
  for (const s of raw ?? []) {
    if (!Number.isFinite(s?.x) || !Number.isFinite(s?.y)) continue;
    const q = { x: clamp(s.x, 0, 1), y: clamp(s.y, 0, 1), p: clamp(num(s.p, 0.5), 0, 1), t: Math.max(0, num(s.t, 0)) };
    const prev = pts[pts.length - 1];
    if (prev) {
      q.t = Math.max(prev.t, q.t);
      if (Math.hypot(q.x - prev.x, q.y - prev.y) < 1e-5) {
        prev.p = Math.max(prev.p, q.p);
        continue;
      }
    }
    pts.push(q);
  }
  if (!pts.length) return [];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = cum[cum.length - 1];
  if (total < STROKE_LIMITS.dotLength) {
    const p = pts.reduce((a, q) => a + q.p, 0) / pts.length;
    return [[roundTo(pts[0].x, 4), roundTo(pts[0].y, 4), roundTo(p, 2), 0]];
  }
  const step = Math.max(spacing, total / Math.max(1, maxPoints - 1));
  const n = Math.max(1, Math.round(total / step));
  const even = total / n; // lands exactly on the last sample
  const out = [];
  let j = 1;
  let prevT = 0;
  for (let k = 0; k <= n; k++) {
    const d = k === n ? total : k * even;
    while (j < pts.length - 1 && cum[j] < d) j++;
    const a = pts[j - 1];
    const b = pts[j];
    const seg = cum[j] - cum[j - 1];
    const u = seg > 0 ? clamp((d - cum[j - 1]) / seg, 0, 1) : 0;
    const t = a.t + (b.t - a.t) * u;
    out.push([
      roundTo(a.x + (b.x - a.x) * u, 4),
      roundTo(a.y + (b.y - a.y) * u, 4),
      roundTo(a.p + (b.p - a.p) * u, 2),
      roundTo(k === 0 ? 0 : Math.max(0, t - prevT), 3),
    ]);
    prevT = t;
  }
  return out;
}

/**
 * Builds a canonical stroke from raw capture samples
 * ({ x, y, pressure, dt, pen_state } with normalised x, y).
 */
export function finalizeStroke(samples, { color, width, t0 = 0, spacing = STROKE_LIMITS.spacing } = {}) {
  let t = 0;
  const raw = [];
  (samples ?? []).forEach((s, i) => {
    if (i > 0) t += clamp(num(s?.dt, 0), 0, STROKE_LIMITS.maxDt);
    raw.push({ x: s?.x, y: s?.y, p: s?.pressure, t });
  });
  const points = resampleStroke(raw, spacing);
  if (!points.length) return null;
  return {
    color: typeof color === 'string' && COLOR_RE.test(color) ? color.toLowerCase() : DRAW_COLORS[0],
    width: roundTo(clamp(num(width, 0.022), STROKE_LIMITS.width[0], STROKE_LIMITS.width[1]), 4),
    points,
    t0: roundTo(Math.max(0, num(t0, 0)), 3),
    dur: roundTo(t, 3),
  };
}

/** Validates one stroke (stored and imported data is untrusted). */
export function sanitizeStroke(s) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.points)) return null;
  const L = STROKE_LIMITS;
  const rich = Array.isArray(s.points[0]) && s.points[0].length > 2;
  const points = [];
  for (const pt of s.points.slice(0, L.sanitizePoints)) {
    if (!Array.isArray(pt) || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
    const q = [roundTo(clamp(pt[0], 0, 1), 4), roundTo(clamp(pt[1], 0, 1), 4)];
    if (rich) q.push(roundTo(clamp(num(pt[2], 0.5), 0, 1), 2), roundTo(clamp(num(pt[3], 0), 0, L.maxDt), 3));
    points.push(q);
  }
  if (!points.length) return null;
  const out = {
    color: typeof s.color === 'string' && COLOR_RE.test(s.color) ? s.color.toLowerCase() : DRAW_COLORS[0],
    width: roundTo(clamp(num(s.width, 0.02), L.width[0], L.width[1]), 4),
    points,
  };
  if (Number.isFinite(s.t0) && s.t0 >= 0) out.t0 = roundTo(Math.min(s.t0, 3600), 3);
  if (Number.isFinite(s.dur) && s.dur >= 0) out.dur = roundTo(Math.min(s.dur, 600), 3);
  if (typeof s.motif === 'string' && /^[a-z-]{1,20}$/.test(s.motif)) out.motif = s.motif;
  return out;
}

/** Validates a drawing; bounded stroke and point counts. */
export function sanitizeDrawing(d) {
  const src = d && typeof d === 'object' ? d : {};
  const strokes = [];
  let total = 0;
  if (Array.isArray(src.strokes)) {
    for (const s of src.strokes.slice(0, STROKE_LIMITS.maxStrokes * 2)) {
      const clean = sanitizeStroke(s);
      if (!clean) continue;
      if (total + clean.points.length > STROKE_LIMITS.maxTotalPoints) break;
      total += clean.points.length;
      strokes.push(clean);
      if (strokes.length >= STROKE_LIMITS.maxStrokes) break;
    }
  }
  return { paper: typeof src.paper === 'string' && COLOR_RE.test(src.paper) ? src.paper.toLowerCase() : PAPER, strokes };
}

export const drawingIsEmpty = (d) => !d || !Array.isArray(d.strokes) || d.strokes.length === 0;
export const drawingPointCount = (d) => (d?.strokes ?? []).reduce((a, s) => a + s.points.length, 0);

/** Descriptive statistics; `roughness` is turning per unit length (wobblier = higher). */
export function drawingStats(d) {
  const strokes = d?.strokes ?? [];
  let points = 0;
  let width = 0;
  let turn = 0;
  let turnLen = 0;
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  const colors = new Set();
  for (const s of strokes) {
    points += s.points.length;
    width += s.width;
    colors.add(s.color);
    for (const [x, y] of s.points) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    for (let i = 2; i < s.points.length; i++) {
      const [x0, y0] = s.points[i - 2];
      const [x1, y1] = s.points[i - 1];
      const [x2, y2] = s.points[i];
      let da = Math.abs(Math.atan2(y2 - y1, x2 - x1) - Math.atan2(y1 - y0, x1 - x0));
      if (da > Math.PI) da = TAU - da;
      turn += da;
      turnLen += Math.hypot(x2 - x1, y2 - y1);
    }
  }
  return {
    strokes: strokes.length,
    points,
    length: drawingLength({ strokes }),
    meanWidth: strokes.length ? width / strokes.length : 0,
    colors: colors.size,
    bbox: strokes.length ? { minX, minY, maxX, maxY } : null,
    roughness: turnLen > 0 ? turn / turnLen : 0,
  };
}

/** Up to `max` points spread evenly along all strokes of a drawing (dots included). */
function samplePath(d, max = 360) {
  const strokes = d?.strokes ?? [];
  const total = strokes.reduce((a, s) => a + strokeLength(s), 0);
  if (!total) return [];
  const step = total / max;
  const out = [];
  for (const s of strokes) {
    const p = s.points;
    if (p.length === 1) {
      out.push([p[0][0], p[0][1]]);
      continue;
    }
    let carry = 0;
    for (let i = 1; i < p.length; i++) {
      const seg = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
      let at = carry;
      while (at <= seg) {
        const u = seg > 0 ? at / seg : 0;
        out.push([p[i - 1][0] + (p[i][0] - p[i - 1][0]) * u, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * u]);
        at += step;
      }
      carry = at - seg;
    }
  }
  return out;
}

/**
 * Centres the points' centroid on (0.5, 0.5) and scales their RMS radius to
 * 0.3. Unlike a bounding box this barely moves when a few small extra marks
 * (a signature, a flourish) are added far from the main shape.
 */
function framePoints(pts) {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of pts) {
    cx += x;
    cy += y;
  }
  cx /= pts.length;
  cy /= pts.length;
  let r2 = 0;
  for (const [x, y] of pts) r2 += (x - cx) ** 2 + (y - cy) ** 2;
  const s = 0.3 / Math.max(0.02, Math.sqrt(r2 / pts.length));
  return pts.map(([x, y]) => [0.5 + (x - cx) * s, 0.5 + (y - cy) * s]);
}

/** Mean nearest-point distance from `from` to `to`, ignoring the worst 10% (stray marks). */
function meanNearest(from, to) {
  const ds = from.map(([x, y]) => {
    let best = Infinity;
    for (const [u, v] of to) {
      const d = (x - u) ** 2 + (y - v) ** 2;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }).sort((p, q) => p - q);
  const keep = Math.max(1, Math.ceil(ds.length * 0.9));
  let sum = 0;
  for (let i = 0; i < keep; i++) sum += ds[i];
  return sum / keep;
}

/**
 * Shape similarity of two drawings in [0, 1]. Both are framed (centroid and
 * RMS radius normalised), so a shifted or resized copy still counts as the
 * same shape; then the symmetric trimmed mean nearest-point (chamfer)
 * distance d gives 1 - d / 0.08. Descriptive only (Gallery comparison, tests).
 */
export function drawingSimilarity(a, b) {
  const A = samplePath(a);
  const B = samplePath(b);
  if (!A.length && !B.length) return 1;
  if (!A.length || !B.length) return 0;
  const fa = framePoints(A);
  const fb = framePoints(B);
  const d = (meanNearest(fa, fb) + meanNearest(fb, fa)) / 2;
  return roundTo(clamp(1 - d / 0.08, 0, 1), 3);
}

/**
 * Captures pen strokes. Feed it client-pixel samples plus the canvas rect;
 * it records the raw (x, y, pressure, dt, pen_state) stream and, on pen up,
 * normalises and resamples it into a canonical stroke.
 */
export class StrokeRecorder {
  constructor({ spacing = STROKE_LIMITS.spacing } = {}) {
    this.spacing = spacing;
    this.strokes = [];
    this.active = null;
    this.undoStack = [];
    this.origin = null;
  }

  get isEmpty() {
    return this.strokes.length === 0;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get pointCount() {
    return this.strokes.reduce((a, s) => a + s.points.length, 0);
  }

  /** Canonical drawing (deep copy). */
  get drawing() {
    return sanitizeDrawing({ paper: PAPER, strokes: this.strokes });
  }

  /** Raw samples of the stroke in progress (normalised), for live rendering. */
  get activeSamples() {
    return this.active ? this.active.samples : null;
  }

  _snapshot() {
    this.undoStack.push(JSON.stringify(this.strokes));
    if (this.undoStack.length > RECORDER.undoDepth) this.undoStack.shift();
  }

  /** Pen down. `sample` = { x, y, pressure, t } in client px / seconds. */
  begin(sample, rect, brush = {}) {
    if (this.active) this.end(null, rect);
    if (this.strokes.length >= STROKE_LIMITS.maxStrokes || this.pointCount >= STROKE_LIMITS.maxTotalPoints) return false;
    const [x, y] = normalizeSample(sample, rect);
    const t = num(sample?.t, 0);
    if (this.origin == null) this.origin = t;
    this.active = {
      color: brush.color,
      width: brush.width,
      t0: Math.max(0, t - this.origin),
      lastT: t,
      samples: [{ x, y, pressure: clamp(num(sample?.pressure, 0.5), 0, 1), dt: 0, pen_state: 'down' }],
    };
    return true;
  }

  /** Pen move. Returns the normalised point, or null when no stroke is active. */
  move(sample, rect) {
    const a = this.active;
    if (!a || a.samples.length >= STROKE_LIMITS.maxRawSamples) return null;
    const [x, y] = normalizeSample(sample, rect);
    const t = Math.max(a.lastT, num(sample?.t, a.lastT));
    a.samples.push({ x, y, pressure: clamp(num(sample?.pressure, 0.5), 0, 1), dt: t - a.lastT, pen_state: 'move' });
    a.lastT = t;
    return [x, y];
  }

  /** Pen up: finalises and stores the stroke. Returns it (or null if rejected). */
  end(sample, rect) {
    const a = this.active;
    if (!a) return null;
    this.active = null;
    if (sample) {
      const [x, y] = normalizeSample(sample, rect);
      const t = Math.max(a.lastT, num(sample.t, a.lastT));
      a.samples.push({ x, y, pressure: clamp(num(sample.pressure, 0.5), 0, 1), dt: t - a.lastT, pen_state: 'up' });
    } else if (a.samples.length) {
      a.samples[a.samples.length - 1].pen_state = 'up';
    }
    const stroke = finalizeStroke(a.samples, { color: a.color, width: a.width, t0: a.t0, spacing: this.spacing });
    if (!stroke || this.pointCount + stroke.points.length > STROKE_LIMITS.maxTotalPoints) return null;
    this._snapshot();
    this.strokes.push(stroke);
    return stroke;
  }

  cancel() {
    this.active = null;
  }

  /** Appends ready-made strokes (template stamps). Returns how many were added. */
  addStrokes(strokes) {
    const room = STROKE_LIMITS.maxStrokes - this.strokes.length;
    const clean = (strokes ?? []).map(sanitizeStroke).filter(Boolean);
    const add = [];
    let total = this.pointCount;
    for (const s of clean.slice(0, Math.max(0, room))) {
      if (total + s.points.length > STROKE_LIMITS.maxTotalPoints) break;
      total += s.points.length;
      add.push(s);
    }
    if (!add.length) return 0;
    this._snapshot();
    const last = this.strokes[this.strokes.length - 1];
    const offset = last ? (last.t0 ?? 0) + (last.dur ?? 0) + 0.3 : 0;
    for (const s of add) this.strokes.push({ ...s, t0: roundTo(offset + (s.t0 ?? 0), 3) });
    if (this.origin == null) this.origin = 0;
    return add.length;
  }

  load(drawing) {
    this._snapshot();
    this.strokes = sanitizeDrawing(drawing).strokes;
    this.active = null;
  }

  undo() {
    const prev = this.undoStack.pop();
    if (prev == null) return false;
    this.strokes = sanitizeDrawing({ strokes: JSON.parse(prev) }).strokes;
    this.active = null;
    if (!this.strokes.length) this.origin = null;
    return true;
  }

  clear() {
    if (!this.strokes.length) return false;
    this._snapshot();
    this.strokes = [];
    this.active = null;
    this.origin = null;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Authored templates (starter material for one-tap demos)
// ---------------------------------------------------------------------------
const n = (beat, midi, dur = 0.5, vel = 0.7) => ({ beat, midi, dur, vel });
const h = (beat, id, vel = 0.7) => ({ beat, midi: DRUM_BY_ID.get(id).midi, dur: 0.25, vel });

export const MUSIC_TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'sunny-arp', name: 'Sunny Arp', tempo: 112, beats: 8,
    notes: [
      n(0, 60, 0.5, 0.8), n(0.5, 64, 0.5, 0.62), n(1, 67, 0.5, 0.72), n(1.5, 72, 0.5, 0.62),
      n(2, 76, 0.5, 0.8), n(2.5, 72, 0.5, 0.62), n(3, 67, 0.5, 0.72), n(3.5, 64, 0.5, 0.6),
      n(4, 62, 0.5, 0.8), n(4.5, 67, 0.5, 0.62), n(5, 69, 0.5, 0.72), n(5.5, 74, 0.5, 0.62),
      n(6, 76, 0.5, 0.8), n(6.5, 74, 0.5, 0.62), n(7, 72, 1, 0.75),
    ],
    hits: [h(0, 'kick', 0.7), h(2, 'block', 0.45), h(4, 'kick', 0.7), h(6, 'block', 0.45)],
  }),
  Object.freeze({
    id: 'bouncy-walk', name: 'Bouncy Walk', tempo: 104, beats: 8,
    notes: [
      n(0, 60, 0.5, 0.8), n(1, 64, 0.5, 0.7), n(2, 67, 0.5, 0.78), n(3, 64, 0.5, 0.68),
      n(4, 69, 0.5, 0.8), n(5, 67, 0.5, 0.7), n(6, 64, 0.5, 0.74), n(6.5, 62, 0.5, 0.62), n(7, 60, 1, 0.78),
    ],
    hits: [
      h(0, 'kick', 0.8), h(1, 'clap', 0.6), h(2, 'kick', 0.75), h(3, 'clap', 0.6),
      h(4, 'kick', 0.8), h(5, 'clap', 0.6), h(6, 'kick', 0.75), h(7, 'clap', 0.65),
    ],
  }),
  Object.freeze({
    id: 'starlight-lullaby', name: 'Starlight Lullaby', tempo: 76, beats: 8,
    notes: [
      n(0, 76, 1.5, 0.48), n(1.5, 74, 0.5, 0.4), n(2, 72, 1, 0.45), n(3, 69, 1, 0.4),
      n(4, 67, 1.5, 0.46), n(5.5, 69, 0.5, 0.38), n(6, 74, 1, 0.42), n(7, 72, 1, 0.45),
    ],
    hits: [h(0, 'block', 0.3), h(4, 'block', 0.3)],
  }),
  Object.freeze({
    id: 'playful-hop', name: 'Playful Hop', tempo: 126, beats: 8,
    notes: [
      n(0, 60, 0.5, 0.82), n(0.5, 72, 0.5, 0.7), n(1.5, 67, 0.5, 0.74), n(2, 69, 0.5, 0.78),
      n(2.5, 81, 0.5, 0.7), n(3.5, 79, 0.5, 0.72), n(4, 76, 0.5, 0.8), n(4.5, 72, 0.5, 0.68),
      n(5.5, 74, 0.5, 0.72), n(6, 64, 0.5, 0.78), n(6.5, 67, 0.5, 0.7), n(7, 72, 1, 0.8),
    ],
    hits: [
      h(0, 'kick', 0.8), h(0.5, 'hat', 0.45), h(1.5, 'hat', 0.45), h(2, 'clap', 0.62), h(2.5, 'hat', 0.45),
      h(3.5, 'hat', 0.45), h(4, 'kick', 0.8), h(4.5, 'hat', 0.45), h(5.5, 'hat', 0.45), h(6, 'clap', 0.62),
      h(6.5, 'hat', 0.45), h(7.5, 'hat', 0.45),
    ],
  }),
]);

export function musicTemplate(id) {
  const t = MUSIC_TEMPLATES.find((x) => x.id === id);
  return t ? { ...sanitizePhrase(t), templateId: t.id, name: t.name } : null;
}

const LEAF = '#6ccf7f';
const GOLD = '#ffbf3f';
const INK = '#4a3f6b';

function polyLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return len;
}

/** Inserts points so consecutive points are at most `spacing` apart. */
export function densify(poly, spacing = STROKE_LIMITS.spacing) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    if (i === 0) {
      out.push(poly[0]);
      continue;
    }
    const [x0, y0] = poly[i - 1];
    const [x1, y1] = poly[i];
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / spacing));
    for (let k = 1; k <= steps; k++) out.push([x0 + ((x1 - x0) * k) / steps, y0 + ((y1 - y0) * k) / steps]);
  }
  return out;
}

function arc(cx, cy, rx, ry, a0, a1, count) {
  const pts = [];
  for (let i = 0; i <= count; i++) {
    const a = a0 + ((a1 - a0) * i) / count;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}

const SHAPES = {
  star(c) {
    const pts = [];
    for (let i = 0; i <= 10; i++) {
      const a = -Math.PI / 2 + (i / 10) * TAU;
      const r = i % 2 ? 0.135 : 0.32;
      pts.push([0.5 + r * Math.cos(a), 0.53 + r * Math.sin(a)]);
    }
    return [{ color: c, pts: densify(pts) }];
  },
  heart(c) {
    const pts = [];
    for (let i = 0; i <= 80; i++) {
      const t = (i / 80) * TAU;
      const x = 16 * Math.sin(t) ** 3;
      const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      pts.push([0.5 + (x / 17) * 0.33, 0.47 - (y / 17) * 0.33]);
    }
    return [{ color: c, pts }];
  },
  flower(c) {
    const parts = [{ color: LEAF, pts: densify([[0.5, 0.47], [0.49, 0.62], [0.51, 0.76], [0.5, 0.9]]) }];
    parts.push({ color: LEAF, pts: arc(0.585, 0.71, 0.075, 0.035, Math.PI, Math.PI * 3, 28) });
    for (let p = 0; p < 6; p++) {
      const a = (p / 6) * TAU;
      parts.push({ color: c, pts: arc(0.5 + 0.105 * Math.cos(a), 0.36 + 0.105 * Math.sin(a), 0.07, 0.07, a + Math.PI, a + Math.PI * 3, 30) });
    }
    parts.push({ color: GOLD, pts: [[0.5, 0.36]], wmul: 2.6 });
    return parts;
  },
  sun(c) {
    const parts = [{ color: c, pts: arc(0.5, 0.5, 0.18, 0.18, -Math.PI / 2, Math.PI * 1.5, 64) }];
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU;
      parts.push({ color: c, pts: densify([[0.5 + 0.245 * Math.cos(a), 0.5 + 0.245 * Math.sin(a)], [0.5 + 0.34 * Math.cos(a), 0.5 + 0.34 * Math.sin(a)]]) });
    }
    parts.push({ color: INK, pts: [[0.44, 0.46]], wmul: 1.5 }, { color: INK, pts: [[0.56, 0.46]], wmul: 1.5 });
    parts.push({ color: INK, pts: arc(0.5, 0.5, 0.085, 0.075, Math.PI * 0.18, Math.PI * 0.82, 20), wmul: 0.8 });
    return parts;
  },
  spiral(c) {
    const pts = [];
    for (let i = 0; i <= 150; i++) {
      const u = i / 150;
      const a = u * 3.2 * TAU;
      const r = 0.012 + 0.34 * u;
      pts.push([0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a)]);
    }
    return [{ color: c, pts }];
  },
};

export const DRAWING_TEMPLATES = Object.freeze([
  Object.freeze({ id: 'star', name: 'Star' }),
  Object.freeze({ id: 'heart', name: 'Heart' }),
  Object.freeze({ id: 'flower', name: 'Flower' }),
  Object.freeze({ id: 'sun', name: 'Smiling Sun' }),
  Object.freeze({ id: 'spiral', name: 'Spiral' }),
]);

/**
 * Strokes for a drawing template in the chosen colour and brush width,
 * with steady synthetic pen timing so replays look hand-drawn.
 */
export function templateStrokes(id, { color = DRAW_COLORS[1], width = 0.022 } = {}) {
  const build = SHAPES[id];
  if (!build) return [];
  const speed = 0.85; // canvas widths per second
  let t = 0;
  return build(typeof color === 'string' && COLOR_RE.test(color) ? color.toLowerCase() : DRAW_COLORS[1]).map((part) => {
    const len = polyLength(part.pts);
    const dur = Math.max(0.08, len / speed);
    const step = part.pts.length > 1 ? dur / (part.pts.length - 1) : 0;
    const stroke = sanitizeStroke({
      color: part.color,
      width: width * (part.wmul ?? 1),
      points: part.pts.map(([x, y], i) => [x, y, 0.55, i === 0 ? 0 : step]),
      t0: t,
      dur,
    });
    t += dur + 0.18;
    return stroke;
  });
}

export function drawingTemplate(id, opts) {
  const t = DRAWING_TEMPLATES.find((x) => x.id === id);
  return t ? { paper: PAPER, strokes: templateStrokes(id, opts), templateId: t.id, name: t.name } : null;
}
