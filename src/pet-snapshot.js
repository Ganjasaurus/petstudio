/**
 * pet-snapshot.js: portable pet snapshots (format petstudio.snapshot.v1) and
 * the three built-in visitor pets (Iteration 4).
 *
 * A snapshot is a compact, self-contained, sanitised JSON copy of a pet that
 * another studio can invite as a visitor. It holds:
 *   - identity and appearance: name, body / accent / cheek colours, ears,
 *     tail, head and body scale;
 *   - temperament traits and style preferences (energy, order);
 *   - a learned summary plus the compact weights of both networks (lossless
 *     base64 float32, about 30 KB; omitted while the networks are untrained);
 *   - up to two of the pet's own songs and two of its own drawings.
 * Lessons, the gallery history, signals and care state are never included:
 * a snapshot shares the pet, not the player's teaching history.
 *
 * Imports are untrusted data, never code. parseSnapshot() bounds the size,
 * checks format and version, clamps every number, checks every enum and
 * colour, re-validates the weights against the architecture and returns
 * { ok: false, reason, message } instead of throwing. Pure ES module.
 */
import { sanitizeAppearance, sanitizeTraits, sanitizeName, topTraitsOf, TRAIT_LABELS } from './pet-state.js';
import { sanitizePhrase, sanitizeDrawing, phraseIsEmpty, drawingIsEmpty, densify, sanitizeStroke, strokeLength, PAPER } from './teaching-core.js';
import { sanitizeStyle } from './creative-engine.js';
import { generateStarterPhrase, generateStarterDrawing } from './starter-repertoire.js';
import { compactWeights, decodeCompactWeights, engineFromCompactWeights, FEATURE_SCHEMA, BASELINE_ID, NEURAL_GENERATOR, MUSIC_SPEC, DRAW_SPEC, MODEL_SIZES } from './neural-engine.js';
import { hashSeed } from './rng.js';

export const SNAPSHOT_SCHEMA = 'petstudio.snapshot';
export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_FORMAT = 'petstudio.snapshot.v1';
export const SNAPSHOT_LIMITS = Object.freeze({ maxBytes: 262_144, phrases: 2, drawings: 2, titleMax: 40, blurbMax: 90 });
export const SNAPSHOT_ORIGINS = Object.freeze(['export', 'builtin']);

const ID_RE = /^[a-z0-9-]{4,48}$/i;
const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const intIn = (v, max) => (Number.isInteger(v) && v >= 0 ? Math.min(v, max) : 0);

/** Plain text: no control characters or angle brackets, collapsed spaces, bounded length. */
function text(v, max) {
  if (typeof v !== 'string') return '';
  const cleaned = v.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(cleaned).slice(0, max).join('').trim();
}

const REASONS = Object.freeze({
  empty: 'That snapshot is empty. Paste or pick a .json snapshot file.',
  'too-large': 'That file is too large to be a pet snapshot (the limit is 256 KB).',
  'not-json': 'That is not valid snapshot JSON.',
  'not-an-object': 'That JSON is not a pet snapshot.',
  'wrong-format': 'That JSON is not a Pet Studio snapshot (expected petstudio.snapshot.v1).',
  'bad-version': 'That snapshot has an unknown version.',
  'future-version': 'That snapshot comes from a newer Pet Studio. Update this app to import it.',
});

// ---------------------------------------------------------------------------
// Sanitisation (every field is checked; unknown fields are dropped)
// ---------------------------------------------------------------------------
function sanitizeNeural(n, warnings) {
  const src = isObj(n) ? n : {};
  const steps = { music: intIn(src.steps?.music, 1e7), drawing: intIn(src.steps?.drawing, 1e7) };
  let weights = null;
  if (src.weights != null) {
    if (decodeCompactWeights(src)) weights = { music: src.weights.music, drawing: src.weights.drawing };
    else warnings.push('weights-invalid');
  }
  return {
    featureSchema: FEATURE_SCHEMA,
    baseline: BASELINE_ID,
    generator: NEURAL_GENERATOR,
    dims: { music: [MUSIC_SPEC.inDim, MUSIC_SPEC.hidden, MUSIC_SPEC.outDim], drawing: [DRAW_SPEC.inDim, DRAW_SPEC.hidden, DRAW_SPEC.outDim] },
    parameters: MODEL_SIZES.music + MODEL_SIZES.drawing,
    // Steps without usable weights would claim training the visitor cannot show: they reset to 0.
    steps: weights ? steps : { music: 0, drawing: 0 },
    sessions: weights ? intIn(src.sessions, 1e6) : 0,
    deltaNorm: weights && Number.isFinite(src.deltaNorm) ? Math.round(clamp(src.deltaNorm, 0, 1e4) * 1000) / 1000 : null,
    weights,
  };
}

function pieces(list, kind, max) {
  const out = [];
  for (const p of (Array.isArray(list) ? list : []).slice(0, 8)) {
    if (!isObj(p)) continue;
    const data = kind === 'music' ? sanitizePhrase(p.data) : sanitizeDrawing(p.data);
    if (kind === 'music' ? phraseIsEmpty(data) : drawingIsEmpty(data)) continue;
    out.push({ title: text(p.title, SNAPSHOT_LIMITS.titleMax) || null, data, filled: p.filled === true });
    if (out.length >= max) break;
  }
  return out;
}

/** Authored stand-ins when a snapshot carries no songs or drawings (flagged `filled`). */
function fillPieces(snap) {
  const seed = (k) => hashSeed(`${snap.id}:${k}`);
  if (!snap.phrases.length) {
    snap.phrases.push({ title: `${snap.pet.name}'s little tune`, data: sanitizePhrase(generateStarterPhrase({ seed: seed('music'), traits: snap.traits })), filled: true });
  }
  if (!snap.drawings.length) {
    snap.drawings.push({ title: `${snap.pet.name}'s doodle`, data: sanitizeDrawing(generateStarterDrawing({ seed: seed('drawing'), traits: snap.traits, colors: snap.pet })), filled: true });
  }
}

/** Only the seven look fields; sanitizeAppearance checks colours, enums and scale ranges. */
function pickAppearance(p) {
  const { bodyColor, accentColor, cheekColor, earStyle, tailStyle, headScale, bodyScale } = p;
  return { bodyColor, accentColor, cheekColor, earStyle, tailStyle, headScale, bodyScale };
}

/**
 * Validates a parsed snapshot object. Returns { ok: true, snapshot, warnings }
 * or { ok: false, reason }. `trusted` keeps the 'builtin' origin (bundled data only).
 */
export function sanitizeSnapshot(obj, { trusted = false, now = Date.now() } = {}) {
  if (!isObj(obj)) return { ok: false, reason: 'not-an-object' };
  if (obj.format !== SNAPSHOT_FORMAT && obj.schema !== SNAPSHOT_SCHEMA) return { ok: false, reason: 'wrong-format' };
  const version = obj.version ?? (obj.format === SNAPSHOT_FORMAT ? SNAPSHOT_VERSION : null);
  if (!Number.isInteger(version) || version < 1) return { ok: false, reason: 'bad-version' };
  if (version > SNAPSHOT_VERSION) return { ok: false, reason: 'future-version', version };
  const warnings = [];
  const petSrc = isObj(obj.pet) ? obj.pet : {};
  const name = sanitizeName(petSrc.name);
  if (!name) warnings.push('no-name');
  const appearance = sanitizeAppearance({ ...pickAppearance(petSrc), name: name || 'Visitor' });
  const createdAt = Number.isFinite(obj.createdAt) ? clamp(Math.round(obj.createdAt), 0, now + 86_400_000) : 0;
  const id = typeof obj.id === 'string' && ID_RE.test(obj.id) ? obj.id : `snap-${hashSeed(JSON.stringify([appearance, createdAt])).toString(36)}`;
  const source = isObj(obj.source) ? obj.source : {};
  const snap = {
    format: SNAPSHOT_FORMAT,
    schema: SNAPSHOT_SCHEMA,
    version: SNAPSHOT_VERSION,
    id,
    createdAt,
    origin: trusted && obj.origin === 'builtin' ? 'builtin' : 'export',
    source: {
      petId: typeof source.petId === 'string' && ID_RE.test(source.petId) ? source.petId : null,
      app: text(source.app, 24) || null,
    },
    pet: appearance,
    traits: sanitizeTraits(obj.traits),
    style: sanitizeStyle(obj.style),
    blurb: text(obj.blurb, SNAPSHOT_LIMITS.blurbMax) || null,
    neural: sanitizeNeural(obj.neural, warnings),
    phrases: pieces(obj.phrases, 'music', SNAPSHOT_LIMITS.phrases),
    drawings: pieces(obj.drawings, 'drawing', SNAPSHOT_LIMITS.drawings),
  };
  if (!snap.phrases.length) warnings.push('no-phrases');
  if (!snap.drawings.length) warnings.push('no-drawings');
  fillPieces(snap);
  return { ok: true, snapshot: snap, warnings };
}

function fail(reason) {
  return { ok: false, reason, message: REASONS[reason] ?? 'That snapshot could not be read.' };
}

/**
 * Parses an untrusted snapshot (JSON text, or an already parsed object).
 * Never throws: { ok: true, snapshot, warnings } or { ok: false, reason, message }.
 */
export function parseSnapshot(input, { now = Date.now() } = {}) {
  let obj = input;
  try {
    if (typeof input === 'string') {
      const raw = (input.charCodeAt(0) === 0xfeff ? input.slice(1) : input).trim();
      if (!raw) return fail('empty');
      if (raw.length > SNAPSHOT_LIMITS.maxBytes) return fail('too-large');
      try {
        obj = JSON.parse(raw);
      } catch {
        return fail('not-json');
      }
    } else if (input == null) {
      return fail('empty');
    } else {
      // Objects are bounded by their serialised size too (a hostile caller could pass anything).
      let size = 0;
      try {
        size = JSON.stringify(input)?.length ?? 0;
      } catch {
        return fail('not-json');
      }
      if (size > SNAPSHOT_LIMITS.maxBytes) return fail('too-large');
    }
    const res = sanitizeSnapshot(obj, { now });
    return res.ok ? res : fail(res.reason);
  } catch {
    return fail('not-an-object'); // defensive: hostile getters or exotic objects
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
/** The pet's own creations of one kind (favourites and loved first, then the newest); never lessons. */
function ownPieces(gallery, petId, kind) {
  const items = Array.isArray(gallery?.items) ? gallery.items : [];
  const mine = items.filter((it) => it && it.kind === kind && (it.origin === 'attempt' || it.origin === 'starter') && (!it.petId || it.petId === petId));
  const score = (it) => (it.favorite ? 2 : 0) + (it.feedback?.reward > 0 ? 1 : 0);
  return mine
    .sort((a, b) => score(b) - score(a) || (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .slice(0, kind === 'music' ? SNAPSHOT_LIMITS.phrases : SNAPSHOT_LIMITS.drawings)
    .map((it) => ({ title: text(it.title, SNAPSHOT_LIMITS.titleMax) || null, data: it.data }));
}

/**
 * Builds a snapshot of a pet: appearance, temperament, style, learned summary
 * and compact weights, and up to two of its own songs and drawings (topped up
 * with authored starter pieces, flagged `filled`, when it has made fewer).
 */
export function createSnapshot({ pet, gallery = null, memory = null, neural = null, now = Date.now(), appVersion = null } = {}) {
  const petId = typeof pet?.id === 'string' ? pet.id : null;
  const appearance = sanitizeAppearance(pet?.appearance);
  const traits = sanitizeTraits(pet?.traits);
  const compact = neural ? compactWeights(neural) : null;
  const phrases = ownPieces(gallery, petId, 'music');
  const drawings = ownPieces(gallery, petId, 'drawing');
  for (let i = phrases.length; i < SNAPSHOT_LIMITS.phrases; i++) {
    phrases.push({ title: `${appearance.name}'s little tune${i ? ` #${i + 1}` : ''}`, data: generateStarterPhrase({ seed: hashSeed(`${petId}:export:music:${i}`), traits }), filled: true });
  }
  for (let i = drawings.length; i < SNAPSHOT_LIMITS.drawings; i++) {
    drawings.push({ title: `${appearance.name}'s doodle${i ? ` #${i + 1}` : ''}`, data: generateStarterDrawing({ seed: hashSeed(`${petId}:export:drawing:${i}`), traits, colors: appearance }), filled: true });
  }
  const raw = {
    format: SNAPSHOT_FORMAT,
    schema: SNAPSHOT_SCHEMA,
    version: SNAPSHOT_VERSION,
    id: `snap-${hashSeed(`${petId}:${now}`).toString(36)}-${Math.floor(now / 1000).toString(36)}`,
    createdAt: now,
    origin: 'export',
    source: { petId, app: appVersion },
    pet: appearance,
    traits,
    style: sanitizeStyle(memory?.prefs),
    neural: compact ? { ...compact, sessions: neural.sessions ?? 0, deltaNorm: neural.distanceTo?.(null) ?? null } : null,
    phrases,
    drawings,
  };
  return sanitizeSnapshot(raw, { now }).snapshot;
}

/** Compact JSON text of a snapshot (what gets downloaded, copied or pasted). */
export function serializeSnapshot(snap) {
  return JSON.stringify(snap);
}

/** `<pet-name>-snapshot.json`, with the name reduced to safe filename characters. */
export function snapshotFileName(snap) {
  const slug = String(snap?.pet?.name ?? 'pet').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'pet';
  return `${slug}-snapshot.json`;
}

/** What a snapshot contains, for previews and inspection (no payloads). */
export function snapshotSummary(snap) {
  if (!snap) return null;
  const n = snap.neural;
  const trained = !!n?.weights;
  return {
    id: snap.id,
    name: snap.pet.name,
    origin: snap.origin,
    sourcePetId: snap.source?.petId ?? null,
    appearance: { ...snap.pet },
    topTraits: topTraitsOf(snap.traits, 2, 0.55).map((t) => TRAIT_LABELS[t]),
    style: { ...snap.style },
    blurb: snap.blurb,
    learned: { trained, steps: { ...n.steps }, parameters: n.parameters, sessions: n.sessions, deltaNorm: n.deltaNorm },
    phrases: snap.phrases.map((p) => ({ title: p.title, notes: p.data.notes.length, hits: p.data.hits.length, beats: p.data.beats, tempo: p.data.tempo, filled: !!p.filled })),
    drawings: snap.drawings.map((d) => ({ title: d.title, strokes: d.data.strokes.length, filled: !!d.filled })),
    bytes: serializeSnapshot(snap).length,
  };
}

/** A visitor's own engine (its weights, or the untrained baseline): never persisted, never trained. */
export function visitorEngine(snap, { clock } = {}) {
  return engineFromCompactWeights(snap?.neural, { clock });
}

// ---------------------------------------------------------------------------
// Built-in visitors: three authored friends, ready to invite
// ---------------------------------------------------------------------------
const nt = (beat, midi, dur = 0.5, vel = 0.7) => ({ beat, midi, dur, vel });
const DRUM = { kick: 36, clap: 39, hat: 42, block: 76 };
const hit = (beat, id, vel = 0.7) => ({ beat, midi: DRUM[id], dur: 0.25, vel });
const PAINT = { ink: '#4a3f6b', pink: '#ff7fa3', orange: '#ff8a4c', gold: '#ffbf3f', leaf: '#6ccf7f', sky: '#55b8ec', lilac: '#9a7bff' };

function ring(cx, cy, r, count = 48, a0 = -Math.PI / 2, a1 = a0 + TAU, ry = r) {
  const pts = [];
  for (let i = 0; i <= count; i++) {
    const a = a0 + ((a1 - a0) * i) / count;
    pts.push([cx + r * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}

function starPoly(cx, cy, outer, inner, points = 5) {
  const pts = [];
  for (let i = 0; i <= points * 2; i++) {
    const a = -Math.PI / 2 + (i / (points * 2)) * TAU;
    const r = i % 2 ? inner : outer;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return densify(pts);
}

function heartPoly(cx, cy, s, count = 80) {
  const pts = [];
  for (let i = 0; i <= count; i++) {
    const t = (i / count) * TAU;
    const x = 16 * Math.sin(t) ** 3;
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    pts.push([cx + (x / 17) * s, cy - (y / 17) * s]);
  }
  return pts;
}

/** Parts { color, width, pts } -> timed strokes at a steady hand speed (replays look hand drawn). */
function drawingFrom(parts, speed = 0.8) {
  let t = 0;
  const strokes = parts.map((part) => {
    const len = strokeLength({ points: part.pts });
    const dur = Math.max(0.08, len / speed);
    const step = part.pts.length > 1 ? dur / (part.pts.length - 1) : 0;
    const s = sanitizeStroke({ color: part.color, width: part.width, points: part.pts.map(([x, y], i) => [x, y, 0.55, i ? step : 0]), t0: t, dur });
    t += dur + 0.2;
    return s;
  }).filter(Boolean);
  return sanitizeDrawing({ paper: PAPER, strokes });
}

function mochiFlower() {
  const parts = [
    { color: PAINT.leaf, width: 0.018, pts: densify([[0.5, 0.5], [0.5, 0.9]]) },
    { color: PAINT.leaf, width: 0.016, pts: ring(0.585, 0.72, 0.08, 24, Math.PI, Math.PI * 2, 0.034) },
    { color: PAINT.leaf, width: 0.016, pts: ring(0.415, 0.66, 0.08, 24, 0, Math.PI, 0.034) },
  ];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * TAU - Math.PI / 2;
    parts.push({ color: PAINT.lilac, width: 0.02, pts: ring(0.5 + 0.12 * Math.cos(a), 0.34 + 0.12 * Math.sin(a), 0.075, 32, a + Math.PI, a + Math.PI * 3) });
  }
  parts.push({ color: PAINT.gold, width: 0.055, pts: [[0.5, 0.34]] });
  return drawingFrom(parts);
}

function mochiStar() {
  const parts = [
    { color: PAINT.lilac, width: 0.012, pts: ring(0.5, 0.52, 0.33, 72) },
    { color: PAINT.gold, width: 0.024, pts: starPoly(0.5, 0.52, 0.25, 0.105) },
  ];
  for (const [x, y] of [[0.24, 0.26], [0.76, 0.26], [0.24, 0.78], [0.76, 0.78]]) parts.push({ color: PAINT.pink, width: 0.03, pts: [[x, y]] });
  return drawingFrom(parts);
}

function bongoSun() {
  const parts = [{ color: PAINT.orange, width: 0.032, pts: ring(0.5, 0.5, 0.16, 56) }];
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * TAU;
    const r0 = 0.21;
    const r1 = k % 2 ? 0.3 : 0.38;
    const mid = (r0 + r1) / 2;
    const off = 0.025 * (k % 2 ? -1 : 1);
    const nx = -Math.sin(a);
    const ny = Math.cos(a);
    parts.push({
      color: k % 3 ? PAINT.gold : PAINT.orange, width: 0.022,
      pts: densify([[0.5 + r0 * Math.cos(a), 0.5 + r0 * Math.sin(a)], [0.5 + mid * Math.cos(a) + off * nx, 0.5 + mid * Math.sin(a) + off * ny], [0.5 + r1 * Math.cos(a), 0.5 + r1 * Math.sin(a)]]),
    });
  }
  parts.push({ color: PAINT.ink, width: 0.026, pts: [[0.445, 0.46]] }, { color: PAINT.ink, width: 0.026, pts: [[0.555, 0.46]] });
  parts.push({ color: PAINT.ink, width: 0.014, pts: ring(0.5, 0.5, 0.075, 18, Math.PI * 0.15, Math.PI * 0.85, 0.07) });
  return drawingFrom(parts, 1.0);
}

function bongoSpiral() {
  const spiral = [];
  for (let i = 0; i <= 160; i++) {
    const u = i / 160;
    const a = u * 3.5 * TAU;
    const r = 0.015 + 0.25 * u;
    spiral.push([0.46 + r * Math.cos(a), 0.42 + r * Math.sin(a)]);
  }
  const zig = [];
  for (let i = 0; i <= 8; i++) zig.push([0.12 + i * 0.095, i % 2 ? 0.8 : 0.88]);
  return drawingFrom([
    { color: PAINT.orange, width: 0.024, pts: spiral },
    { color: PAINT.gold, width: 0.022, pts: densify(zig) },
    { color: PAINT.pink, width: 0.034, pts: [[0.82, 0.18]] },
    { color: PAINT.pink, width: 0.026, pts: [[0.88, 0.3]] },
    { color: PAINT.sky, width: 0.03, pts: [[0.14, 0.2]] },
  ], 1.05);
}

function lyraHeart() {
  return drawingFrom([
    { color: PAINT.pink, width: 0.042, pts: heartPoly(0.5, 0.5, 0.36, 96) },
    { color: PAINT.lilac, width: 0.018, pts: heartPoly(0.5, 0.49, 0.17, 64) },
    { color: PAINT.gold, width: 0.034, pts: [[0.2, 0.2]] },
    { color: PAINT.gold, width: 0.024, pts: [[0.82, 0.16]] },
    { color: PAINT.sky, width: 0.026, pts: [[0.86, 0.8]] },
  ], 0.75);
}

function lyraConstellation() {
  const stars = [[0.16, 0.62], [0.3, 0.44], [0.46, 0.5], [0.58, 0.34], [0.74, 0.42], [0.84, 0.24], [0.66, 0.66]];
  const parts = [];
  for (let i = 1; i < 6; i++) parts.push({ color: PAINT.sky, width: 0.008, pts: densify([stars[i - 1], stars[i]]) });
  parts.push({ color: PAINT.sky, width: 0.008, pts: densify([stars[4], stars[6]]) });
  stars.forEach(([x, y], i) => parts.push({ color: i % 3 ? PAINT.gold : PAINT.lilac, width: i === 3 ? 0.05 : 0.036, pts: [[x, y]] }));
  parts.push({ color: PAINT.lilac, width: 0.02, pts: ring(0.2, 0.22, 0.09, 30, Math.PI * 0.35, Math.PI * 1.65) });
  return drawingFrom(parts, 0.7);
}

const BUILTIN_SOURCES = [
  {
    id: 'builtin-mochi',
    blurb: 'Gentle lullabies and neat geometric flowers and stars.',
    pet: { name: 'Mochi', bodyColor: '#cdb8ff', accentColor: '#ffffff', cheekColor: '#f78fd1', earStyle: 'bunny', tailStyle: 'puff', headScale: 1.08, bodyScale: 0.95 },
    traits: { playful: 0.25, calm: 0.9, curious: 0.45, dramatic: 0.15, stubborn: 0.2, neat: 0.85, chaotic: 0.08 },
    style: { energy: -0.45, order: -0.5 },
    phrases: () => [
      {
        title: 'Moonlit Lullaby',
        data: { tempo: 72, beats: 8, notes: [nt(0, 67, 1, 0.44), nt(1, 72, 1, 0.46), nt(2, 76, 1.5, 0.5), nt(3.5, 74, 0.5, 0.4), nt(4, 72, 1, 0.45), nt(5, 69, 1, 0.42), nt(6, 67, 2, 0.44)], hits: [hit(0, 'block', 0.25), hit(4, 'block', 0.25)] },
      },
      {
        title: 'Petal Waltz',
        data: { tempo: 84, beats: 8, notes: [nt(0, 72, 1, 0.46), nt(1, 76, 0.5, 0.42), nt(1.5, 79, 0.5, 0.44), nt(2, 76, 1, 0.45), nt(3, 74, 1, 0.42), nt(4, 72, 1, 0.46), nt(5, 69, 0.5, 0.4), nt(5.5, 67, 0.5, 0.4), nt(6, 72, 2, 0.46)], hits: [hit(0, 'block', 0.22), hit(3, 'block', 0.2), hit(6, 'block', 0.22)] },
      },
    ],
    drawings: () => [{ title: 'Lavender Flower', data: mochiFlower() }, { title: 'Twinkle Star', data: mochiStar() }],
  },
  {
    id: 'builtin-bongo',
    blurb: 'Syncopated drum-heavy grooves and energetic sun and spiral doodles.',
    pet: { name: 'Bongo', bodyColor: '#ffad5c', accentColor: '#ffe08a', cheekColor: '#ff6f6f', earStyle: 'horns', tailStyle: 'long', headScale: 1.0, bodyScale: 1.1 },
    traits: { playful: 0.92, calm: 0.1, curious: 0.5, dramatic: 0.45, stubborn: 0.3, neat: 0.1, chaotic: 0.86 },
    style: { energy: 0.6, order: 0.5 },
    phrases: () => [
      {
        title: 'Bongo Bounce',
        data: {
          tempo: 124, beats: 8,
          notes: [nt(0, 60, 0.5, 0.86), nt(1.5, 67, 0.5, 0.76), nt(2, 69, 0.5, 0.82), nt(3, 67, 0.5, 0.7), nt(3.5, 64, 0.5, 0.8), nt(4, 60, 0.5, 0.86), nt(5.5, 67, 0.5, 0.76), nt(6, 69, 0.5, 0.8), nt(6.5, 72, 0.5, 0.88), nt(7.5, 69, 0.5, 0.72)],
          hits: [
            hit(0, 'kick', 0.9), hit(1.5, 'kick', 0.75), hit(2.5, 'kick', 0.8), hit(4, 'kick', 0.9), hit(5.5, 'kick', 0.75), hit(6.5, 'kick', 0.8),
            hit(1, 'clap', 0.7), hit(3, 'clap', 0.72), hit(5, 'clap', 0.7), hit(7, 'clap', 0.75),
            hit(0.5, 'hat', 0.45), hit(2, 'hat', 0.42), hit(3.5, 'hat', 0.45), hit(4.5, 'hat', 0.45), hit(6, 'hat', 0.42), hit(7.5, 'hat', 0.48),
          ],
        },
      },
      {
        title: 'Drum Circle Romp',
        data: {
          tempo: 132, beats: 8,
          notes: [nt(0, 64, 0.5, 0.8), nt(0.5, 67, 0.5, 0.72), nt(1.5, 69, 0.5, 0.78), nt(2, 72, 0.5, 0.84), nt(3, 69, 0.5, 0.74), nt(3.5, 67, 0.5, 0.72), nt(4.5, 64, 0.5, 0.78), nt(5, 62, 0.5, 0.72), nt(6, 60, 0.5, 0.84), nt(6.5, 64, 0.5, 0.74), nt(7, 67, 1, 0.82)],
          hits: [
            hit(0, 'kick', 0.9), hit(1, 'kick', 0.8), hit(2, 'kick', 0.9), hit(3, 'kick', 0.8), hit(4, 'kick', 0.9), hit(5, 'kick', 0.8), hit(6, 'kick', 0.9), hit(7, 'kick', 0.8),
            hit(1.5, 'clap', 0.7), hit(3.5, 'clap', 0.72), hit(5.5, 'clap', 0.7), hit(7.5, 'clap', 0.76),
            hit(0.5, 'block', 0.5), hit(2.5, 'block', 0.5), hit(4.5, 'block', 0.5), hit(6.5, 'block', 0.5),
          ],
        },
      },
    ],
    drawings: () => [{ title: 'Sunny Burst', data: bongoSun() }, { title: 'Zoom Spiral', data: bongoSpiral() }],
  },
  {
    id: 'builtin-lyra',
    blurb: 'Expressive arpeggios and bold heart and constellation art.',
    pet: { name: 'Lyra', bodyColor: '#a8d8ff', accentColor: '#ffffff', cheekColor: '#c58cff', earStyle: 'cat', tailStyle: 'star', headScale: 1.12, bodyScale: 0.95 },
    traits: { playful: 0.5, calm: 0.3, curious: 0.9, dramatic: 0.88, stubborn: 0.3, neat: 0.5, chaotic: 0.3 },
    style: { energy: 0.25, order: 0.15 },
    phrases: () => [
      {
        title: 'Comet Arpeggio',
        data: {
          tempo: 96, beats: 8,
          notes: [nt(0, 60, 0.5, 0.4), nt(0.5, 64, 0.5, 0.48), nt(1, 67, 0.5, 0.56), nt(1.5, 72, 0.5, 0.64), nt(2, 76, 0.5, 0.74), nt(2.5, 79, 0.5, 0.84), nt(3, 81, 1, 0.96), nt(4, 77, 0.5, 0.82), nt(4.5, 74, 0.5, 0.74), nt(5, 69, 0.5, 0.66), nt(5.5, 65, 0.5, 0.6), nt(6, 64, 0.5, 0.62), nt(6.5, 67, 0.5, 0.7), nt(7, 72, 1, 0.86)],
          hits: [hit(0, 'kick', 0.6), hit(3, 'clap', 0.7), hit(4, 'kick', 0.6), hit(7, 'clap', 0.6)],
        },
      },
      {
        title: 'Starfall',
        data: {
          tempo: 88, beats: 8,
          notes: [nt(0, 69, 0.5, 0.5), nt(0.5, 72, 0.5, 0.58), nt(1, 76, 0.5, 0.68), nt(1.5, 81, 1, 0.9), nt(2.5, 79, 0.5, 0.76), nt(3, 76, 0.5, 0.68), nt(3.5, 72, 0.5, 0.6), nt(4, 67, 1, 0.58), nt(5, 65, 0.5, 0.54), nt(5.5, 69, 0.5, 0.62), nt(6, 72, 0.5, 0.7), nt(6.5, 76, 0.5, 0.78), nt(7, 74, 1, 0.84)],
          hits: [hit(0, 'block', 0.35), hit(1.5, 'clap', 0.55), hit(4, 'kick', 0.6), hit(6.5, 'clap', 0.55)],
        },
      },
    ],
    drawings: () => [{ title: 'Bold Heart', data: lyraHeart() }, { title: 'Constellation', data: lyraConstellation() }],
  },
];

const BUILT_AT = Date.UTC(2026, 9, 25, 12, 0, 0);

/** The three built-in visitors (Mochi, Bongo, Lyra): authored snapshots, validated like any import. */
export const BUILTIN_VISITORS = Object.freeze(BUILTIN_SOURCES.map((b) => {
  const res = sanitizeSnapshot({
    format: SNAPSHOT_FORMAT, version: SNAPSHOT_VERSION, id: b.id, createdAt: BUILT_AT, origin: 'builtin',
    source: { petId: null, app: 'built-in' }, pet: b.pet, traits: b.traits, style: b.style, blurb: b.blurb,
    neural: null, phrases: b.phrases(), drawings: b.drawings(),
  }, { trusted: true, now: BUILT_AT });
  return Object.freeze(res.snapshot);
}));
export const BUILTIN_IDS = Object.freeze(BUILTIN_VISITORS.map((s) => s.id));

/** A built-in visitor by id ('builtin-mochi'), short id ('mochi') or name ('Mochi'). */
export function builtinVisitor(id) {
  const key = String(id ?? '').toLowerCase();
  return BUILTIN_VISITORS.find((s) => s.id === key || s.id === `builtin-${key}` || s.pet.name.toLowerCase() === key) ?? null;
}
