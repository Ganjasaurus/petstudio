/**
 * pet-state.js — identity, appearance, temperament, care needs and the
 * autonomous activity state machine of one pet.
 *
 * AUTHORED GAME LOGIC, NOT MACHINE LEARNING. Everything in this file is
 * deterministic rules driven by a seeded PRNG. Temperament traits weight
 * hand-written utility scores and reactions; they never change by themselves.
 * Genuine on-device learning lives in a separate, replaceable module
 * (neural-engine.js) and must never be inferred from anything in here. Sleep
 * Practice only asks this simulation for a held nap (startPracticeNap).
 *
 * Pure ES module: no DOM and no Three.js. Persistence goes through an injected
 * Storage-like object (window.localStorage in the browser, an in-memory fake
 * in the Node tests).
 */
import {
  STATIONS, STATION_IDS, ACTIVITY_STATION, WANDER_SPOTS,
  planPath, distance, clampToWalkable, nearestStation,
} from './studio-layout.js';
import { mulberry32Step, hashSeed } from './rng.js';

export { mulberry32Step, hashSeed };

// ---------------------------------------------------------------------------
// Schema & storage
// ---------------------------------------------------------------------------
export const SCHEMA = 'petstudio.pet';
export const SCHEMA_VERSION = 1;
export const STORAGE_KEY = 'petstudio.pet.v1';
export const BACKUP_KEY = 'petstudio.pet.v1.bak';
export const FUTURE_BACKUP_KEY = 'petstudio.pet.future';
const EVENT_LIMIT = 20;

/** Time-based care while the app is closed: bounded, gentle, never below a floor. */
export const AWAY = Object.freeze({
  capSeconds: 8 * 3600, // at most 8 h of away-time is ever simulated
  rate: 0.35, // needs drift at 35% of the awake rate while the player is away
  floor: 25, // absence never pushes a need below this
  resumeWindowSeconds: 30 * 60, // unfinished activities resume within 30 min
});

// ---------------------------------------------------------------------------
// Needs
// ---------------------------------------------------------------------------
/** All needs are satisfaction meters: 100 = fully satisfied, 0 = needs attention. */
export const NEEDS = Object.freeze(['hunger', 'energy', 'hygiene', 'mood', 'curiosity', 'bond']);
export const DECAYING_NEEDS = Object.freeze(['hunger', 'energy', 'hygiene', 'curiosity', 'bond']);

export const NEED_INFO = Object.freeze({
  hunger: Object.freeze({ label: 'Hunger', icon: 'food', hint: 'How well fed. Snacks refill it.', words: ['Hungry', 'Peckish', 'Satisfied', 'Full'] }),
  energy: Object.freeze({ label: 'Energy', icon: 'sleep', hint: 'Naps in the Sleep Nook refill it.', words: ['Sleepy', 'Drowsy', 'Awake', 'Bouncy'] }),
  hygiene: Object.freeze({ label: 'Hygiene', icon: 'bath', hint: 'Bubble baths refill it. Painting is messy.', words: ['Messy', 'Smudgy', 'Clean', 'Sparkling'] }),
  mood: Object.freeze({ label: 'Mood', icon: 'mood', hint: 'Follows the other needs, pets and praise.', words: ['Grumpy', 'Meh', 'Content', 'Joyful'] }),
  curiosity: Object.freeze({ label: 'Curiosity', icon: 'idea', hint: 'How inspired. Music, drawing and listening refill it.', words: ['Bored', 'Restless', 'Engaged', 'Inspired'] }),
  bond: Object.freeze({ label: 'Bond', icon: 'heart', hint: 'Grows with your attention and care.', words: ['Shy', 'Friendly', 'Close', 'Besties'] }),
});

export function needWord(key, value) {
  const words = NEED_INFO[key]?.words ?? ['', '', '', ''];
  if (value < 25) return words[0];
  if (value < 50) return words[1];
  if (value < 80) return words[2];
  return words[3];
}

export const DEFAULT_NEEDS = Object.freeze({ hunger: 72, energy: 86, hygiene: 90, mood: 74, curiosity: 64, bond: 35 });

/** Per-second decay while awake, before temperament multipliers. */
export const BASE_DECAY = Object.freeze({ hunger: 0.09, energy: 0.06, hygiene: 0.05, curiosity: 0.12, bond: 0.02 });

/**
 * Self-care the pet chooses on its own is less effective than care the player
 * asks for, so a neglected pet stays okay-ish while the player still matters.
 */
export const AUTO_CARE_EFFICIENCY = 0.55;
const CARE_ACTIVITIES = Object.freeze(['eating', 'bathing', 'sleeping']);

/** Activity-specific multipliers on the base decay (missing key = 1). */
const ACTIVITY_DECAY = Object.freeze({
  sleeping: { hunger: 0.4, energy: 0, hygiene: 0.3, curiosity: 0.2, bond: 0 },
  walking: { energy: 1.35 },
  eating: { hunger: 0 },
  bathing: { hygiene: 0 },
  playing_music: { curiosity: 0 },
  drawing: { curiosity: 0 },
  listening: { curiosity: 0, bond: 0 },
  lesson: { curiosity: 0, bond: 0 },
});

// ---------------------------------------------------------------------------
// Temperament
// ---------------------------------------------------------------------------
export const TRAITS = Object.freeze(['playful', 'calm', 'curious', 'dramatic', 'stubborn', 'neat', 'chaotic']);
export const TRAIT_LABELS = Object.freeze({
  playful: 'Playful', calm: 'Calm', curious: 'Curious', dramatic: 'Dramatic',
  stubborn: 'Stubborn', neat: 'Neat', chaotic: 'Chaotic',
});
export const TRAIT_HINTS = Object.freeze({
  playful: 'Bouncier; gets hungry and tired sooner; loves the music corner.',
  calm: 'Needs drift slower; longer idles; enjoys listening and naps.',
  curious: 'Gets bored quickly and seeks out drawing and music.',
  dramatic: 'Bigger mood swings and reactions; a natural performer.',
  stubborn: 'May refuse requests it does not need (never real needs).',
  neat: 'Stays clean longer, loves baths, paints tidier.',
  chaotic: 'Messier, more random choices, scribbly art.',
});
export const DEFAULT_TRAITS = Object.freeze({
  playful: 0.65, calm: 0.4, curious: 0.7, dramatic: 0.3, stubborn: 0.25, neat: 0.45, chaotic: 0.2,
});
export const TEMPERAMENT_PRESETS = Object.freeze({
  sunny: { label: 'Sunny', traits: { playful: 0.8, calm: 0.35, curious: 0.7, dramatic: 0.3, stubborn: 0.15, neat: 0.45, chaotic: 0.25 } },
  dreamy: { label: 'Dreamy', traits: { playful: 0.3, calm: 0.85, curious: 0.55, dramatic: 0.15, stubborn: 0.25, neat: 0.6, chaotic: 0.1 } },
  rascal: { label: 'Rascal', traits: { playful: 0.75, calm: 0.15, curious: 0.5, dramatic: 0.45, stubborn: 0.7, neat: 0.1, chaotic: 0.85 } },
  diva: { label: 'Diva', traits: { playful: 0.55, calm: 0.25, curious: 0.4, dramatic: 0.9, stubborn: 0.5, neat: 0.7, chaotic: 0.3 } },
  scholar: { label: 'Scholar', traits: { playful: 0.3, calm: 0.6, curious: 0.95, dramatic: 0.2, stubborn: 0.35, neat: 0.75, chaotic: 0.1 } },
});

/** Temperament multipliers on need decay. */
export function decayMultipliers(t) {
  return {
    hunger: 1 + 0.25 * t.playful + 0.15 * t.chaotic - 0.15 * t.calm,
    energy: 1 + 0.35 * t.playful + 0.2 * t.chaotic - 0.3 * t.calm,
    hygiene: Math.max(0.3, 1 + 0.55 * t.chaotic + 0.2 * t.playful - 0.45 * t.neat),
    curiosity: 1 + 0.6 * t.curious + 0.25 * t.playful - 0.25 * t.calm,
    bond: Math.max(0.3, 1 + 0.35 * t.stubborn - 0.25 * t.calm),
  };
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------
export const EAR_STYLES = Object.freeze(['round', 'cat', 'bunny', 'horns']);
export const TAIL_STYLES = Object.freeze(['puff', 'long', 'star']);
export const APPEARANCE_LIMITS = Object.freeze({ headScale: [0.8, 1.3], bodyScale: [0.8, 1.25], nameMax: 16 });
export const DEFAULT_APPEARANCE = Object.freeze({
  name: 'Mochi', bodyColor: '#ffb8c9', accentColor: '#fff1dc', cheekColor: '#ff7d9c',
  earStyle: 'bunny', headScale: 1.05, bodyScale: 1, tailStyle: 'puff',
});
export const COLOR_SWATCHES = Object.freeze({
  body: Object.freeze(['#ffb8c9', '#a8d8ff', '#b9e7c4', '#ffd59a', '#cdb8ff', '#ffc4a3', '#f3efe6', '#9fe3dc']),
  accent: Object.freeze(['#fff1dc', '#ffffff', '#ffe08a', '#ffd1e3', '#d6f2ff', '#e4d9ff', '#c7f0d8', '#6a5a9c']),
  cheek: Object.freeze(['#ff7d9c', '#ff9a76', '#f78fd1', '#ff6f6f', '#c58cff', '#ffb36b']),
});
export const NAME_IDEAS = Object.freeze([
  'Mochi', 'Pico', 'Bun', 'Tofu', 'Nori', 'Pip', 'Juniper', 'Biscuit', 'Miso', 'Kiwi', 'Pudding', 'Sprout', 'Doodle', 'Tempo',
]);

// ---------------------------------------------------------------------------
// Activities & expressions
// ---------------------------------------------------------------------------
export const ACTIVITIES = Object.freeze(['idle', 'walking', 'eating', 'bathing', 'sleeping', 'playing_music', 'drawing', 'listening', 'lesson']);
export const STATION_ACTIVITIES = Object.freeze(['eating', 'bathing', 'sleeping', 'playing_music', 'drawing', 'listening']);
export const CREATIVE_ACTIVITIES = Object.freeze(['playing_music', 'drawing']);
export const EXPRESSIONS = Object.freeze(['neutral', 'happy', 'curious', 'sleepy', 'asleep', 'proud', 'excited', 'pouty']);

/**
 * A creation plan attached to an activity: which piece to perform (`ref`, an
 * opaque id owned by the creation flow), its kind, a fixed duration and why
 * (`attempt` = its take on a lesson, `variation` = a retry, `replay` = from
 * the gallery, `social` = made together with a visiting friend). The
 * simulation only schedules it; it never invents content.
 */
export const PLAN_KINDS = Object.freeze(['music', 'drawing']);
export const PLAN_MODES = Object.freeze(['attempt', 'variation', 'replay', 'social']);
const PLAN_STATION = Object.freeze({ music: 'music', drawing: 'easel' });
const REF_RE = /^[a-z0-9:_-]{1,64}$/i;
/** Per-second gains while the pet attends a lesson (time spent teaching it). */
const LESSON_GAIN = Object.freeze({ curiosity: 2.4, mood: 0.5, bond: 0.5 });

export function sanitizePlan(p) {
  if (!p || typeof p !== 'object' || typeof p.ref !== 'string' || !REF_RE.test(p.ref) || !PLAN_KINDS.includes(p.kind)) return null;
  return {
    ref: p.ref,
    kind: p.kind,
    duration: clampNum(p.duration, 2, 120, 12),
    mode: PLAN_MODES.includes(p.mode) ? p.mode : 'attempt',
  };
}

/**
 * Per-activity rules: duration range (s), per-second need gains while active,
 * and an optional early-finish condition once `minDuration` has passed.
 */
export const ACTIVITY_RULES = Object.freeze({
  eating: Object.freeze({ duration: [5.5, 7], minDuration: 3, gain: { hunger: 8.5, mood: 0.5 }, doneWhen: (n) => n.hunger >= 99.5 }),
  bathing: Object.freeze({ duration: [7, 9], minDuration: 3.5, gain: { hygiene: 11.5, mood: 0.4 }, doneWhen: (n) => n.hygiene >= 99.5 }),
  sleeping: Object.freeze({ duration: [24, 75], minDuration: 8, gain: { energy: 3.2, mood: 0.15 }, doneWhen: (n) => n.energy >= 99.5 }),
  playing_music: Object.freeze({ duration: [11, 14], gain: { curiosity: 4.4, mood: 1.1, energy: -0.22 } }),
  drawing: Object.freeze({ duration: [13, 17], gain: { curiosity: 3.8, mood: 0.9, energy: -0.14, hygiene: -0.22 } }),
  // Bond only grows while listening when the player asked the pet to sit and listen.
  listening: Object.freeze({ duration: [7, 10], gain: { curiosity: 1.8, mood: 0.6 }, playerGain: { bond: 0.8 } }),
});

/** Needs that override utility scoring when critically low (lowest first). */
const URGENT = Object.freeze([['hunger', 18, 'food'], ['energy', 15, 'bed'], ['hygiene', 15, 'bath']]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
function clampNum(v, lo, hi, fallback) {
  return Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
}
function round(v, digits = 2) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

// ---------------------------------------------------------------------------
// Pure scoring functions (exported for tests and diagnostics)
// ---------------------------------------------------------------------------

/** Where mood drifts to, given the other needs and temperament. */
export function moodTarget(needs, traits, activityType = 'idle') {
  const w = {
    hunger: 1,
    energy: 0.8,
    hygiene: 0.5 + 0.8 * traits.neat,
    curiosity: 0.6 + 0.5 * traits.curious + 0.3 * traits.playful,
    bond: 0.7 + 0.4 * traits.dramatic,
  };
  let sum = 0;
  let ws = 0;
  for (const k of Object.keys(w)) {
    sum += needs[k] * w[k];
    ws += w[k];
  }
  let target = sum / ws + 6;
  if (CREATIVE_ACTIVITIES.includes(activityType) || activityType === 'listening') target += 8;
  return clamp(target, 0, 100);
}

/**
 * Utility score of every station (plus idle) for the autonomous chooser.
 * Higher = more attractive. Needs supply urgency; temperament adds affinity.
 */
export function scoreStations(needs, traits, { lastStation = null } = {}) {
  // 0 while a need is above 62, rising steeply toward 2 as it empties.
  const urgency = (k) => {
    const x = clamp((62 - needs[k]) / 62, 0, 1);
    return 2 * x ** 1.6;
  };
  const t = traits;
  const s = {
    food: urgency('hunger') * 1.5,
    bath: urgency('hygiene') * (1 + 0.9 * t.neat - 0.35 * t.chaotic) + 0.08 * t.neat,
    bed: urgency('energy') * (1.25 + 0.35 * t.calm) + 0.06 * t.calm,
    music: urgency('curiosity') * (0.55 + 0.3 * t.curious + 0.2 * t.playful) + urgency('mood') * 0.35
      + 0.24 * t.playful + 0.28 * t.dramatic + 0.06 * t.chaotic,
    easel: urgency('curiosity') * (0.6 + 0.45 * t.curious) + urgency('mood') * 0.25
      + 0.2 * t.curious + 0.16 * t.chaotic + 0.08 * t.neat,
    rug: urgency('bond') * (0.25 + 0.15 * t.dramatic) + urgency('curiosity') * 0.3 + 0.18 * t.calm + 0.06 * t.curious + 0.04,
    idle: 0.16 + 0.16 * t.calm - 0.08 * t.playful + 0.04 * t.stubborn,
  };
  // Satiation: a satisfied pet never wanders off to eat, bathe or nap.
  if (needs.hunger > 85) s.food = -Infinity;
  if (needs.hygiene > 85) s.bath = -Infinity;
  if (needs.energy > 75) s.bed = -Infinity;
  // Creative work needs some energy.
  if (needs.energy < 30) {
    s.music *= 0.4;
    s.easel *= 0.5;
  }
  // Novelty: the station just used is less attractive (stubborn pets mind less).
  if (lastStation && lastStation in s && lastStation !== 'idle') s[lastStation] -= 0.32 * (1 - 0.6 * t.stubborn);
  return s;
}

/** Softmax temperature for the autonomous chooser: chaotic pets pick more randomly. */
export function selectionTemperature(traits) {
  return clamp(0.16 + 0.24 * traits.chaotic - 0.05 * traits.calm, 0.08, 0.45);
}

/** Human-readable status: `text` for wide screens, `short` for narrow ones. */
export function describeActivity(activity) {
  const st = activity?.station ? STATIONS[activity.station] : null;
  const mode = activity?.plan?.mode ?? null;
  switch (activity?.type) {
    case 'walking':
      if (!st || activity.pending === 'idle') return { text: 'Wandering around', short: 'Wandering', icon: 'walk' };
      return { text: 'Off to the ' + st.label, short: 'To the ' + st.short, icon: st.icon };
    case 'eating': return { text: 'Having a snack', short: 'Snacking', icon: 'food' };
    case 'bathing': return { text: 'Splashing in the bath', short: 'Bath time', icon: 'bath' };
    case 'sleeping': return { text: 'Napping in its nook', short: 'Napping', icon: 'sleep' };
    case 'playing_music':
      if (mode === 'social') return { text: 'Jamming with a friend', short: 'Jamming', icon: 'music' };
      if (mode === 'replay') return { text: 'Performing a saved song', short: 'Performing', icon: 'music' };
      if (mode) return { text: 'Playing its own take on your tune', short: 'Playing its take', icon: 'music' };
      return { text: 'Playing music', short: 'Playing music', icon: 'music' };
    case 'drawing':
      if (mode === 'social') return { text: 'Drawing together with a friend', short: 'Co-drawing', icon: 'draw' };
      if (mode === 'replay') return { text: 'Redrawing a saved picture', short: 'Redrawing', icon: 'draw' };
      if (mode) return { text: 'Drawing its own take on your drawing', short: 'Drawing its take', icon: 'draw' };
      return { text: 'Drawing at the easel', short: 'Drawing', icon: 'draw' };
    case 'listening': return { text: 'Listening on the rug', short: 'Listening', icon: 'listen' };
    case 'lesson':
      return activity?.plan?.kind === 'drawing'
        ? { text: 'Studying your drawing', short: 'Studying', icon: 'teach' }
        : { text: 'Listening to your tune', short: 'Listening', icon: 'listen' };
    default: return { text: 'Hanging out', short: 'Hanging out', icon: 'idle' };
  }
}

/** Strongest traits for personality badges (at least one is always returned). */
export function topTraitsOf(traits, max = 3, min = 0.55) {
  const sorted = [...TRAITS].sort((a, b) => traits[b] - traits[a]);
  const strong = sorted.filter((k) => traits[k] >= min).slice(0, max);
  return strong.length ? strong : sorted.slice(0, 1);
}

// ---------------------------------------------------------------------------
// Sanitisation (stored and imported data is always treated as untrusted)
// ---------------------------------------------------------------------------
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const ID_RE = /^[a-z0-9-]{4,48}$/i;

export function sanitizeName(name) {
  if (typeof name !== 'string') return '';
  const cleaned = name.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(cleaned).slice(0, APPEARANCE_LIMITS.nameMax).join('').trim();
}

export function sanitizeColor(value, fallback) {
  return typeof value === 'string' && COLOR_RE.test(value) ? value.toLowerCase() : fallback;
}

export function sanitizeAppearance(a) {
  const src = a && typeof a === 'object' ? a : {};
  const d = DEFAULT_APPEARANCE;
  return {
    name: sanitizeName(src.name) || d.name,
    bodyColor: sanitizeColor(src.bodyColor, d.bodyColor),
    accentColor: sanitizeColor(src.accentColor, d.accentColor),
    cheekColor: sanitizeColor(src.cheekColor, d.cheekColor),
    earStyle: EAR_STYLES.includes(src.earStyle) ? src.earStyle : d.earStyle,
    headScale: clampNum(src.headScale, ...APPEARANCE_LIMITS.headScale, d.headScale),
    bodyScale: clampNum(src.bodyScale, ...APPEARANCE_LIMITS.bodyScale, d.bodyScale),
    tailStyle: TAIL_STYLES.includes(src.tailStyle) ? src.tailStyle : d.tailStyle,
  };
}

export function sanitizeTraits(t) {
  const src = t && typeof t === 'object' ? t : {};
  const out = {};
  for (const k of TRAITS) out[k] = clampNum(src[k], 0, 1, DEFAULT_TRAITS[k]);
  return out;
}

export function sanitizeNeeds(n) {
  const src = n && typeof n === 'object' ? n : {};
  const out = {};
  for (const k of NEEDS) out[k] = clampNum(src[k], 0, 100, DEFAULT_NEEDS[k]);
  return out;
}

function sanitizeActivity(a) {
  const src = a && typeof a === 'object' ? a : {};
  let type = ACTIVITIES.includes(src.type) ? src.type : 'idle';
  let station = STATION_IDS.includes(src.station) ? src.station : null;
  const pending = ACTIVITIES.includes(src.pending) ? src.pending : null;
  if (STATION_ACTIVITIES.includes(type) && station !== ACTIVITY_STATION[type]) station = ACTIVITY_STATION[type];
  if (type === 'walking' && pending && STATION_ACTIVITIES.includes(pending)) station = ACTIVITY_STATION[pending];
  if (type === 'walking' && !station && pending !== 'idle') type = 'idle';
  if (type === 'lesson') station = null;
  return {
    type,
    station,
    pending,
    source: src.source === 'player' ? 'player' : 'auto',
    elapsed: clampNum(src.elapsed, 0, 600, 0),
    duration: clampNum(src.duration, 0, 600, 0),
    seed: Number.isInteger(src.seed) ? src.seed >>> 0 : 0,
    plan: sanitizePlan(src.plan),
  };
}

function sanitizePosition(p) {
  const src = p && typeof p === 'object' ? p : {};
  if (!Number.isFinite(src.x) || !Number.isFinite(src.z)) return { ...STATIONS.rug.anchor };
  return clampToWalkable({ x: src.x, z: src.z });
}

const COUNTER_KEYS = Object.freeze(['meals', 'baths', 'naps', 'pets', 'praises', 'songs', 'drawings', 'refusals']);
function sanitizeCounters(c) {
  const src = c && typeof c === 'object' ? c : {};
  const out = {};
  for (const k of COUNTER_KEYS) out[k] = Number.isInteger(src[k]) && src[k] >= 0 ? Math.min(src[k], 1e9) : 0;
  return out;
}

/**
 * Optional record of the style a drawing was made with (temperament + colours
 * at the time), so a saved drawing re-renders identically after customising.
 */
export function sanitizeDrawingStyle(style) {
  if (!style || typeof style !== 'object') return null;
  const c = style.colors && typeof style.colors === 'object' ? style.colors : {};
  return {
    generator: typeof style.generator === 'string' ? style.generator.slice(0, 40) : null,
    traits: sanitizeTraits(style.traits),
    colors: {
      bodyColor: sanitizeColor(c.bodyColor, DEFAULT_APPEARANCE.bodyColor),
      accentColor: sanitizeColor(c.accentColor, DEFAULT_APPEARANCE.accentColor),
      cheekColor: sanitizeColor(c.cheekColor, DEFAULT_APPEARANCE.cheekColor),
    },
  };
}

function sanitizeDrawing(d) {
  if (!d || typeof d !== 'object' || !Number.isInteger(d.seed)) return null;
  return {
    seed: d.seed >>> 0,
    progress: clampNum(d.progress, 0, 1, 0),
    complete: d.complete === true,
    startedAt: Number.isFinite(d.startedAt) ? d.startedAt : null,
    style: sanitizeDrawingStyle(d.style),
    // Planned drawings (lesson attempts, gallery replays) reference their content by id.
    ref: typeof d.ref === 'string' && REF_RE.test(d.ref) ? d.ref : null,
  };
}

function sanitizeEvents(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((e) => e && typeof e === 'object' && typeof e.text === 'string' && Number.isFinite(e.at))
    .slice(-EVENT_LIMIT)
    .map((e) => ({ at: e.at, text: e.text.slice(0, 140) }));
}

export function sanitizeRecord(r) {
  const src = r && typeof r === 'object' ? r : {};
  return {
    id: typeof src.id === 'string' && ID_RE.test(src.id) ? src.id : null,
    createdAt: Number.isFinite(src.createdAt) ? src.createdAt : null,
    savedAt: Number.isFinite(src.savedAt) ? src.savedAt : null,
    appearance: sanitizeAppearance(src.appearance),
    traits: sanitizeTraits(src.traits),
    needs: sanitizeNeeds(src.needs),
    activity: sanitizeActivity(src.activity),
    position: sanitizePosition(src.position),
    heading: Number.isFinite(src.heading) ? wrapAngle(src.heading) : STATIONS.rug.facing,
    rngState: Number.isInteger(src.rngState) ? src.rngState >>> 0 : null,
    counters: sanitizeCounters(src.counters),
    currentDrawing: sanitizeDrawing(src.currentDrawing),
    events: sanitizeEvents(src.events),
    lastStation: STATION_IDS.includes(src.lastStation) ? src.lastStation : null,
  };
}

/** Schema migrations chain here (v1 is the first persisted schema). */
function migrateRecord(obj) {
  return obj;
}

/**
 * Validates a parsed record. Returns { ok:true, record } with sanitised data,
 * or { ok:false, reason }; reason 'future-version' means a newer app wrote it.
 */
export function validateRecord(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'not-an-object' };
  if (obj.schema !== SCHEMA) return { ok: false, reason: 'wrong-schema' };
  if (!Number.isInteger(obj.version) || obj.version < 1) return { ok: false, reason: 'bad-version' };
  if (obj.version > SCHEMA_VERSION) return { ok: false, reason: 'future-version', version: obj.version };
  return { ok: true, record: sanitizeRecord(migrateRecord(obj)) };
}

// ---------------------------------------------------------------------------
// Personality-flavoured reaction text ({n} = pet name)
// ---------------------------------------------------------------------------
const FLAVOR = Object.freeze({
  feed: {
    default: '{n} trots to the Snack Bar.',
    playful: '{n} bounces toward the snacks!',
    calm: '{n} pads over for a snack.',
    curious: "{n} sniffs out today's snack.",
    dramatic: '{n} gasps. Snacks!!',
    stubborn: '{n} agrees to a snack… this time.',
    neat: '{n} heads to the Snack Bar, napkin ready.',
    chaotic: '{n} zooms to the snacks!',
  },
  wash: {
    default: '{n} hops toward the Bubble Bath.',
    playful: 'Splash time! {n} races to the tub.',
    calm: '{n} strolls over for a warm bath.',
    curious: '{n} wants to see how many bubbles fit in the tub.',
    dramatic: '{n} demands extra bubbles!',
    stubborn: '{n} grumbles, then heads for the tub.',
    neat: '{n} loves a sparkly bath!',
    chaotic: '{n} cannonballs toward the bubbles!',
  },
  sleep: {
    default: '{n} heads to the Sleep Nook.',
    playful: '{n} yawns mid-bounce and heads to bed.',
    calm: '{n} yawns and curls up.',
    curious: '{n} wonders what it will dream about.',
    dramatic: '{n} swoons onto the pillow.',
    stubborn: '{n} insists it is just resting its eyes.',
    neat: '{n} fluffs the pillow first.',
    chaotic: '{n} flops into the Sleep Nook.',
  },
  pet: {
    default: '{n} leans into the pets.',
    playful: '{n} giggles and wiggles!',
    calm: '{n} hums softly.',
    curious: '{n} tilts its head into your hand.',
    dramatic: '{n} melts with joy!',
    stubborn: '{n} pretends not to like it… but does.',
    neat: '{n} smooths its fur afterward.',
    chaotic: '{n} flops over for more!',
  },
  praise: {
    default: '{n} wiggles happily.',
    playful: '{n} does a happy hop!',
    calm: '{n} smiles quietly.',
    curious: '{n} looks pleased and curious.',
    dramatic: '{n} takes a bow!',
    stubborn: '{n} acts cool, but its tail gives it away.',
    neat: '{n} stands a little taller.',
    chaotic: '{n} spins with glee!',
  },
  music: {
    default: '{n} heads to the Music Corner.',
    playful: 'Jam time! {n} skips to the keyboard.',
    calm: '{n} settles in for a gentle tune.',
    curious: '{n} wants to try some new notes.',
    dramatic: '{n} takes the stage!',
    stubborn: '{n} will play… its own way.',
    neat: '{n} lines up at the keyboard.',
    chaotic: '{n} rushes to bang some keys!',
  },
  draw: {
    default: '{n} grabs a brush.',
    playful: '{n} hops to the easel!',
    calm: '{n} sets up a calm little sketch.',
    curious: '{n} has an idea to sketch!',
    dramatic: '{n} prepares a masterpiece!',
    stubborn: '{n} will draw what it wants to draw.',
    neat: '{n} lines up the brushes.',
    chaotic: '{n} wants to splatter some paint!',
  },
  listen: {
    default: '{n} sits on the rug to listen.',
    playful: '{n} plops onto the rug, all ears.',
    calm: '{n} settles on the rug to listen.',
    curious: '{n} perks up its ears.',
    dramatic: '{n} listens with great feeling.',
    stubborn: '{n} sits… but on its own terms.',
    neat: '{n} sits neatly on the rug.',
    chaotic: '{n} tumbles onto the rug.',
  },
  refuse: {
    default: '{n} shakes its head. Not now!',
    stubborn: '{n} crosses its arms. Not now!',
    dramatic: '{n} turns away with a huff!',
    chaotic: '{n} pretends not to hear.',
  },
});

// ---------------------------------------------------------------------------
// PetState
// ---------------------------------------------------------------------------
export class PetState {
  /**
   * @param {object} record  persisted or partial record (sanitised here)
   * @param {object} [opts]
   * @param {number} [opts.seed]  PRNG seed for brand-new pets (deterministic tests)
   * @param {number} [opts.now]   wall-clock ms used for timestamps
   * @param {() => number} [opts.clock]  wall-clock source (defaults to Date.now)
   */
  constructor(record = {}, opts = {}) {
    this._clockFn = typeof opts.clock === 'function' ? opts.clock : () => Date.now();
    const now = Number.isFinite(opts.now) ? opts.now : this._clockFn();
    const r = sanitizeRecord(record);
    const seed = opts.seed ?? r.rngState ?? hashSeed(`${now}:${Math.random()}`);

    this.rngState = r.rngState ?? hashSeed(`seed:${seed}`);
    this.id = r.id ?? `pet-${hashSeed(`id:${seed}:${now}`).toString(36)}-${(now >>> 0).toString(36)}`;
    this.createdAt = r.createdAt ?? now;
    this.savedAt = r.savedAt;
    this.appearance = r.appearance;
    this.traits = r.traits;
    this.needs = r.needs;
    this.position = r.position;
    this.heading = r.heading;
    this.counters = r.counters;
    this.currentDrawing = r.currentDrawing;
    this.events = r.events;

    /** Simulated seconds since this instance was created (not persisted). */
    this.clock = 0;
    /**
     * When false the pet finishes what it is doing and then stays idle where it
     * is (used while customising, and by tests that isolate need decay).
     */
    this.autonomy = opts.autonomy !== false;
    /** Sleep Practice holds the nap (not persisted: the practice runner re-applies it). */
    this.sleepHold = false;
    this.reaction = null;
    this.lastCompleted = null;
    this.lastStation = r.lastStation;
    this.path = [];
    this.activity = { type: 'idle', station: null, pending: null, source: 'auto', elapsed: 0, duration: 2, seed: 0, plan: null };
    this._listeners = new Set();
    this._lowFlags = {};
    this._lastPetAt = -1e9;
    this._lastPraiseAt = -1e9;
    this._lastLoveAt = -1e9;
    this._lastNoticeAt = -1e9;
    this._refusedLast = false;
    this._reactionSeq = 0;

    this._restoreActivity(r.activity);
  }

  /** Creates a brand-new pet. */
  static create({ appearance, traits, needs, seed, now, clock, autonomy } = {}) {
    return new PetState({ appearance, traits, needs }, { seed, now, clock, autonomy });
  }

  /** Builds a pet from a parsed JSON record. Throws on invalid or future records. */
  static fromJSON(obj, opts = {}) {
    const v = validateRecord(obj);
    if (!v.ok) {
      const err = new Error(`Invalid pet record: ${v.reason}`);
      err.reason = v.reason;
      throw err;
    }
    return new PetState(v.record, opts);
  }

  /** Restores a persisted activity without consuming randomness (so reloads stay deterministic). */
  _restoreActivity(a) {
    if (a.type === 'walking' && a.station && a.pending && a.pending !== 'idle') {
      this._commandStation(a.station, a.source, a.plan);
      return;
    }
    if (STATION_ACTIVITIES.includes(a.type) && a.station) {
      const st = STATIONS[a.station];
      const rule = ACTIVITY_RULES[a.type];
      this.position = { ...st.anchor };
      this.heading = st.facing;
      const duration = a.duration > 0 ? a.duration : rule.duration[0];
      this.activity = {
        type: a.type, station: a.station, pending: null, source: a.source,
        elapsed: Math.min(a.elapsed, duration), duration, seed: a.seed,
        plan: CREATIVE_ACTIVITIES.includes(a.type) ? a.plan : null,
      };
      return;
    }
    // Idle, and short lessons interrupted by a reload, restart as idle.
    const idleFor = a.type === 'idle' && a.duration > 0 ? a.duration : 1.5;
    this.activity = {
      type: 'idle', station: nearestStation(this.position), pending: null, source: 'auto',
      elapsed: a.type === 'idle' ? Math.min(a.elapsed, idleFor) : 0, duration: idleFor, seed: 0, plan: null,
    };
  }

  // ----- events ----------------------------------------------------------------
  /** Subscribe to simulation events. Returns an unsubscribe function. */
  on(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  emit(type, payload = {}) {
    const evt = { type, ...payload };
    for (const fn of this._listeners) {
      try {
        fn(evt);
      } catch (err) {
        // A faulty listener must never break the simulation.
        if (typeof console !== 'undefined') console.error('[pet-state] listener error', err);
      }
    }
    return evt;
  }

  // ----- randomness --------------------------------------------------------------
  rng() {
    const [value, next] = mulberry32Step(this.rngState);
    this.rngState = next;
    return value;
  }

  // ----- derived state -------------------------------------------------------------
  get isAsleep() {
    return this.activity.type === 'sleeping';
  }

  get name() {
    return this.appearance.name;
  }

  dominantTrait() {
    let best = TRAITS[0];
    for (const k of TRAITS) if (this.traits[k] > this.traits[best]) best = k;
    return best;
  }

  /** Strongest traits for badges (at least one is always returned). */
  topTraits(max = 3, min = 0.55) {
    return topTraitsOf(this.traits, max, min);
  }

  walkSpeed() {
    const t = this.traits;
    return 1.15 * (1 + 0.25 * t.playful - 0.12 * t.calm) * (this.needs.energy < 25 ? 0.72 : 1);
  }

  /** Feet height above the floor (cushion or tub floor while using those stations). */
  get elevation() {
    const a = this.activity;
    if (!STATION_ACTIVITIES.includes(a.type) || !a.station) return 0;
    return STATIONS[a.station].elevation;
  }

  getExpression() {
    if (this.isAsleep) return 'asleep'; // a sleeping pet always shows its sleeping face
    if (this.reaction && this.reaction.timer > 0 && this.reaction.expression) return this.reaction.expression;
    const n = this.needs;
    switch (this.activity.type) {
      case 'sleeping': return 'asleep';
      case 'playing_music': return n.mood > 60 ? 'excited' : 'happy';
      case 'drawing': return 'curious';
      case 'eating':
      case 'bathing': return 'happy';
      case 'listening': return 'curious';
      case 'lesson': return 'curious';
      default: break;
    }
    if (n.energy < 22) return 'sleepy';
    if (n.mood < 28) return 'pouty';
    if (n.mood > 80) return 'happy';
    if (n.curiosity < 30) return 'curious';
    return 'neutral';
  }

  /** Floating mood/activity bubble content, or null. `key` changes whenever the content does. */
  getBubble() {
    const r = this.reaction;
    if (r && r.timer > 0 && r.bubble) return { icon: r.bubble, kind: 'speech', key: `r:${r.id}:${r.bubble}` };
    const a = this.activity;
    if (a.type === 'lesson') {
      const icon = a.plan?.kind === 'drawing' ? 'idea' : 'listen';
      return { icon, kind: 'thought', key: `l:${icon}` };
    }
    if (a.type === 'walking' && a.station && a.pending !== 'idle') {
      return { icon: STATIONS[a.station].icon, kind: 'thought', key: `w:${a.station}` };
    }
    if (STATION_ACTIVITIES.includes(a.type) && a.type !== 'sleeping' && a.elapsed < 2.2) {
      return { icon: STATIONS[a.station].icon, kind: 'speech', key: `a:${a.type}` };
    }
    if (a.type === 'listening' && a.source === 'auto' && this.needs.bond < 45) {
      return { icon: 'heart', kind: 'thought', key: 'n:bond' }; // sits by you, hoping for attention
    }
    if (a.type === 'idle') {
      let lowest = null;
      for (const k of DECAYING_NEEDS) {
        if (this.needs[k] < 30 && (!lowest || this.needs[k] < this.needs[lowest])) lowest = k;
      }
      if (lowest) return { icon: NEED_INFO[lowest].icon, kind: 'thought', key: `n:${lowest}` };
    }
    return null;
  }

  // ----- simulation ------------------------------------------------------------------
  /** Advances the simulation by `dt` seconds (internally sub-stepped). */
  update(dt) {
    if (!(dt > 0)) return;
    let remaining = Math.min(dt, 6 * 3600);
    while (remaining > 1e-9) {
      const step = Math.min(remaining, 0.25);
      this._step(step);
      remaining -= step;
    }
  }

  _step(dt) {
    this.clock += dt;
    this._applyNeeds(dt);
    this.activity.elapsed += dt;
    this._advanceActivity(dt);
    if (this.reaction) {
      this.reaction.timer -= dt;
      if (this.reaction.timer <= 0) this.reaction = null;
    }
    this._checkLowNeeds();
  }

  _applyNeeds(dt) {
    const type = this.activity.type;
    const t = this.traits;
    const mult = decayMultipliers(t);
    const mods = ACTIVITY_DECAY[type] ?? {};
    for (const k of DECAYING_NEEDS) {
      this.needs[k] -= BASE_DECAY[k] * mult[k] * (mods[k] ?? 1) * dt;
    }
    const rule = ACTIVITY_RULES[type];
    if (rule) {
      const byPlayer = this.activity.source === 'player';
      const efficiency = CARE_ACTIVITIES.includes(type) && !byPlayer ? AUTO_CARE_EFFICIENCY : 1;
      for (const [k, v] of Object.entries(rule.gain)) {
        let g = v > 0 ? v * efficiency : v;
        if (k === 'hygiene' && v < 0) g *= (1 - 0.5 * t.neat) * (1 + 0.6 * t.chaotic); // messy painters
        this.needs[k] += g * dt;
      }
      if (byPlayer && rule.playerGain) {
        for (const [k, v] of Object.entries(rule.playerGain)) this.needs[k] += v * dt;
      }
    } else if (type === 'lesson') {
      for (const [k, v] of Object.entries(LESSON_GAIN)) this.needs[k] += v * dt;
    }
    const target = moodTarget(this.needs, t, type);
    const rate = 0.03 * (1 + 1.2 * t.dramatic - 0.5 * t.calm);
    this.needs.mood += (target - this.needs.mood) * (1 - Math.exp(-rate * dt));
    for (const k of NEEDS) this.needs[k] = clamp(this.needs[k], 0, 100);
  }

  _advanceActivity(dt) {
    const a = this.activity;
    if (a.type === 'idle') {
      if (a.elapsed >= a.duration && this.autonomy) this._autonomousChoice();
      return;
    }
    if (a.type === 'walking') {
      this._walk(dt);
      return;
    }
    if (a.type === 'lesson') {
      if (a.elapsed >= a.duration) this._finishLesson();
      return;
    }
    if (a.type === 'sleeping' && this.sleepHold) {
      // Sleep Practice holds the nap: it lasts while the learning engine practises.
      if (a.elapsed >= a.duration - 1) a.duration = Math.min(590, a.elapsed + 30);
      if (a.elapsed < 560) return;
      a.elapsed = Math.max(0, a.elapsed - 300); // a very long practice keeps napping within the saved bounds
      return;
    }
    const rule = ACTIVITY_RULES[a.type];
    if (!rule) {
      this._setIdle();
      return;
    }
    if (a.type === 'drawing' && this.currentDrawing && this.currentDrawing.seed === a.seed) {
      this.currentDrawing.progress = clamp(a.elapsed / a.duration, 0, 1);
    }
    const early = rule.doneWhen && a.elapsed >= (rule.minDuration ?? 0) && rule.doneWhen(this.needs, a.elapsed);
    if (a.elapsed >= a.duration || early) this._endActivity({ completed: true });
  }

  _walk(dt) {
    let budget = this.walkSpeed() * dt;
    while (budget > 1e-6 && this.path.length) {
      const wp = this.path[0];
      const dx = wp.x - this.position.x;
      const dz = wp.z - this.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-4) this.heading = Math.atan2(dx, dz);
      if (d <= budget) {
        this.position = { x: wp.x, z: wp.z };
        budget -= d;
        this.path.shift();
      } else {
        this.position = { x: this.position.x + (dx / d) * budget, z: this.position.z + (dz / d) * budget };
        budget = 0;
      }
    }
    // Arrived, or a stuck guard so that a walk can never last forever.
    if (!this.path.length || this.activity.elapsed > 40) this._arrive();
  }

  _arrive() {
    const a = this.activity;
    if (a.station && a.pending && a.pending !== 'idle') this._startStationActivity(a.station, a.source, a.plan);
    else this._setIdle();
  }

  _setActivity(next, path = []) {
    const prev = this.activity;
    this.activity = {
      type: next.type,
      station: next.station ?? null,
      pending: next.pending ?? null,
      source: next.source === 'player' ? 'player' : 'auto',
      elapsed: 0,
      duration: next.duration ?? 0,
      seed: (next.seed ?? 0) >>> 0,
      plan: next.plan ? sanitizePlan(next.plan) : null,
    };
    this.path = path.map((p) => ({ x: p.x, z: p.z }));
    this.emit('activity', {
      from: prev ? prev.type : null,
      to: this.activity.type,
      station: this.activity.station,
      pending: this.activity.pending,
      source: this.activity.source,
      seed: this.activity.seed,
      duration: this.activity.duration,
      plan: this.activity.plan ? { ...this.activity.plan } : null,
    });
  }

  _setIdle() {
    const t = this.traits;
    const base = 2.4 + 3.2 * t.calm - 1.2 * t.playful;
    const duration = Math.max(1.2, base * (0.7 + 0.6 * this.rng()));
    this._setActivity({ type: 'idle', station: nearestStation(this.position), source: 'auto', duration });
  }

  _startStationActivity(stationId, source, plan = null) {
    const st = STATIONS[stationId];
    const rule = ACTIVITY_RULES[st.activity];
    this.position = { x: st.anchor.x, z: st.anchor.z };
    this.heading = st.facing;
    // Randomness is drawn identically with or without a plan, so plans never shift the seeded sequence.
    let duration = rule.duration[0] + (rule.duration[1] - rule.duration[0]) * this.rng();
    const seed = Math.floor(this.rng() * 4294967296) >>> 0;
    const usable = plan && CREATIVE_ACTIVITIES.includes(st.activity) && PLAN_STATION[plan.kind] === stationId ? plan : null;
    if (usable) duration = usable.duration;
    if (st.activity === 'eating') this.counters.meals++;
    if (st.activity === 'bathing') this.counters.baths++;
    if (st.activity === 'sleeping') this.counters.naps++;
    if (st.activity === 'drawing') {
      this.currentDrawing = { seed, progress: 0, complete: false, startedAt: this._clockFn(), style: null, ref: usable?.ref ?? null };
    }
    this.emit('arrive', { station: stationId });
    this._setActivity({ type: st.activity, station: stationId, source, duration, seed, plan: usable });
  }

  /**
   * Ends the current station activity. `completed` = ran its course;
   * `interrupted` = the player redirected the pet or woke it.
   */
  _endActivity({ completed = false, interrupted = false, silent = false, toIdle = true } = {}) {
    const a = this.activity;
    if (!STATION_ACTIVITIES.includes(a.type)) {
      if (toIdle) this._setIdle();
      return;
    }
    const st = STATIONS[a.station];
    const progress = a.duration > 0 ? clamp(a.elapsed / a.duration, 0, 1) : 1;
    if (a.type === 'drawing' && this.currentDrawing && this.currentDrawing.seed === a.seed) {
      this.currentDrawing.progress = completed ? 1 : progress;
      this.currentDrawing.complete = !!completed;
    }
    if (completed) {
      if (a.type === 'drawing') this.counters.drawings++;
      if (a.type === 'playing_music') this.counters.songs++;
      if (CREATIVE_ACTIVITIES.includes(a.type)) {
        this.lastCompleted = { activity: a.type, at: this.clock, seed: a.seed, praised: false, ref: a.plan?.ref ?? null };
      }
    }
    if (st && distance(st.anchor, st.approach) > 0.05) this.position = { ...st.approach }; // hop back out
    this.lastStation = a.station;
    this.emit('activity:end', {
      activity: a.type, station: a.station, completed: !!completed, interrupted: !!interrupted,
      elapsed: a.elapsed, progress, seed: a.seed, plan: a.plan ? { ...a.plan } : null,
    });
    if (toIdle) this._setIdle();
    if (completed && !silent) {
      const n = this.appearance.name;
      const mode = a.plan?.mode;
      if (a.type === 'drawing') {
        const message = mode === 'social' ? `${n} finished drawing together!` : mode === 'replay' ? `${n} redrew it from the gallery!` : mode ? `${n} finished its own take!` : `${n} finished a drawing!`;
        this._react('complete', { expression: 'proud', emote: 'jump', bubble: 'star', message });
      } else if (a.type === 'playing_music') {
        const message = mode === 'social' ? `${n} finished the duet!` : mode === 'replay' ? `${n} performed it from the gallery!` : mode ? `${n} played its own take!` : `${n} played a little tune!`;
        this._react('complete', { expression: 'proud', emote: 'jump', bubble: 'note', message });
      } else if (a.type === 'sleeping') {
        this._react('complete', { expression: 'happy', emote: 'stretch', message: `${n} woke up refreshed.` });
      } else {
        this._react('complete', { expression: 'happy', emote: null, message: null, duration: 1.6 });
      }
    }
  }

  /** Leaves whatever station the pet is using, or the lesson it attends (interrupting it). */
  _leaveCurrent() {
    const a = this.activity;
    if (STATION_ACTIVITIES.includes(a.type)) {
      this._endActivity({ interrupted: true, toIdle: false, silent: true });
    } else if (a.type === 'lesson') {
      this.emit('activity:end', {
        activity: 'lesson', station: null, completed: false, interrupted: true,
        elapsed: a.elapsed, progress: a.duration > 0 ? clamp(a.elapsed / a.duration, 0, 1) : 0, seed: a.seed,
        plan: a.plan ? { ...a.plan } : null,
      });
    }
  }

  /** The lesson ran its course: off to the station to perform the planned attempt. */
  _finishLesson() {
    const a = this.activity;
    const plan = a.plan;
    this.emit('activity:end', {
      activity: 'lesson', station: null, completed: true, interrupted: false,
      elapsed: a.elapsed, progress: 1, seed: a.seed, plan: plan ? { ...plan } : null,
    });
    if (plan) this._commandStation(PLAN_STATION[plan.kind], 'player', plan, { leave: false });
    else this._setIdle();
  }

  _commandStation(stationId, source, plan = null, { leave = true } = {}) {
    const st = STATIONS[stationId];
    if (leave) this._leaveCurrent();
    if (distance(this.position, st.approach) < 0.12) {
      this._startStationActivity(stationId, source, plan);
      return;
    }
    const path = planPath(this.position, st.approach, st.entry ?? []);
    this._setActivity({ type: 'walking', station: stationId, pending: st.activity, source, plan }, path);
  }

  _autonomousChoice() {
    const choice = this.chooseNextActivity();
    if (choice.station) {
      this._commandStation(choice.station, 'auto');
      return;
    }
    const t = this.traits;
    const wanderChance = clamp(0.35 + 0.35 * t.playful + 0.2 * t.chaotic - 0.25 * t.calm, 0.1, 0.9);
    if (this.rng() < wanderChance) {
      const options = WANDER_SPOTS.filter((p) => distance(p, this.position) > 0.8);
      const spot = options[Math.floor(this.rng() * options.length)] ?? WANDER_SPOTS[0];
      this._setActivity({ type: 'walking', station: null, pending: 'idle', source: 'auto' }, planPath(this.position, spot));
    } else {
      this._setIdle();
    }
  }

  /**
   * Picks what to do next. Critically low hunger/energy/hygiene win outright;
   * otherwise a temperature-scaled softmax over scoreStations (seeded PRNG).
   */
  chooseNextActivity() {
    const n = this.needs;
    const urgent = URGENT.filter(([k, threshold]) => n[k] < threshold).sort((a, b) => n[a[0]] - n[b[0]]);
    if (urgent.length) {
      const station = urgent[0][2];
      return { station, activity: STATIONS[station].activity, reason: 'urgent', scores: null };
    }
    const scores = scoreStations(n, this.traits, { lastStation: this.lastStation });
    const keys = Object.keys(scores);
    const temperature = selectionTemperature(this.traits);
    const max = Math.max(...keys.map((k) => scores[k]));
    const weights = keys.map((k) => Math.exp((scores[k] - max) / temperature));
    const total = weights.reduce((a, b) => a + b, 0);
    let r = this.rng() * total;
    let pick = keys[keys.length - 1];
    for (let i = 0; i < keys.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        pick = keys[i];
        break;
      }
    }
    return {
      station: pick === 'idle' ? null : pick,
      activity: pick === 'idle' ? 'idle' : STATIONS[pick].activity,
      reason: 'scored',
      scores,
    };
  }

  _checkLowNeeds() {
    for (const k of DECAYING_NEEDS) {
      const v = this.needs[k];
      if (v < 25 && !this._lowFlags[k]) {
        this._lowFlags[k] = true;
        this.emit('need:low', { need: k, value: v });
      } else if (v > 32 && this._lowFlags[k]) {
        this._lowFlags[k] = false;
      }
    }
  }

  // ----- reactions -----------------------------------------------------------------
  _bump(key, amount) {
    this.needs[key] = clamp(this.needs[key] + amount, 0, 100);
  }

  _flavor(action) {
    const table = FLAVOR[action] ?? {};
    const template = table[this.dominantTrait()] ?? table.default ?? '{n}';
    return template.replaceAll('{n}', this.appearance.name);
  }

  _react(kind, { ok = true, reason = null, expression = null, emote = null, bubble = null, message = null, duration = 2.6 } = {}) {
    this._reactionSeq += 1;
    this.reaction = { id: this._reactionSeq, kind, expression, bubble, timer: duration };
    if (message) this._log(message);
    return this.emit('reaction', { kind, ok, reason, expression, emote, bubble, message });
  }

  _decline(kind, reason, message, expression = 'neutral', emote = 'shake') {
    return this._react(kind, {
      ok: false, reason, expression, emote, bubble: reason === 'asleep' ? null : 'exclaim', message, duration: 2,
    });
  }

  /** Stubborn pets sometimes refuse requests they do not need; never real needs, never twice in a row. */
  _refuses(needKey) {
    const s = this.traits.stubborn;
    if (s <= 0.35 || this._refusedLast) {
      this._refusedLast = false;
      return false;
    }
    if (needKey && this.needs[needKey] < 40) return false;
    const refused = this.rng() < (s - 0.35) * 0.55;
    this._refusedLast = refused;
    return refused;
  }

  _refusal(kind) {
    this.counters.refusals++;
    return this._react(kind, {
      ok: false, reason: 'refused', expression: 'pouty', emote: 'shake', bubble: 'exclaim', message: this._flavor('refuse'), duration: 2.2,
    });
  }

  _log(text) {
    this.events.push({ at: this._clockFn(), text: String(text).slice(0, 140) });
    if (this.events.length > EVENT_LIMIT) this.events.splice(0, this.events.length - EVENT_LIMIT);
  }

  // ----- care actions (player commands) ------------------------------------------------
  feed() {
    const n = this.appearance.name;
    if (this.isAsleep) return this._decline('feed', 'asleep', `Shh… ${n} is napping. Wake it first.`, 'asleep', null);
    if (this.activity.type === 'eating') return this._decline('feed', 'already', `${n} is already munching.`, 'happy', null);
    if (this.needs.hunger >= 95) return this._decline('feed', 'full', `${n} is full right now. Maybe later!`);
    if (this._refuses('hunger')) return this._refusal('feed');
    this._commandStation('food', 'player');
    this._bump('bond', 1.2);
    return this._react('feed', { expression: 'excited', emote: 'hop', bubble: 'food', message: this._flavor('feed') });
  }

  wash() {
    const n = this.appearance.name;
    if (this.isAsleep) return this._decline('wash', 'asleep', `Shh… ${n} is napping. Wake it first.`, 'asleep', null);
    if (this.activity.type === 'bathing') return this._decline('wash', 'already', `${n} is already splashing.`, 'happy', null);
    if (this.needs.hygiene >= 95) return this._decline('wash', 'clean', `${n} is already squeaky clean!`);
    if (this._refuses('hygiene')) return this._refusal('wash');
    this._commandStation('bath', 'player');
    this._bump('bond', 1.2);
    const expression = this.traits.chaotic > 0.6 && this.traits.neat < 0.4 ? 'pouty' : 'excited';
    return this._react('wash', { expression, emote: 'hop', bubble: 'bath', message: this._flavor('wash') });
  }

  /** Rest: walk to the Sleep Nook and nap until rested (or woken). */
  sleep() {
    const n = this.appearance.name;
    if (this.isAsleep) return this._decline('sleep', 'asleep', `${n} is already asleep.`, 'asleep', null);
    const threshold = 88 + 8 * this.traits.calm; // calm pets nap more readily
    if (this.needs.energy >= threshold) return this._decline('sleep', 'not-sleepy', `${n} is not sleepy yet.`, 'curious');
    if (this._refuses('energy')) return this._refusal('sleep');
    this._commandStation('bed', 'player');
    this._bump('bond', 0.8);
    return this._react('sleep', { expression: 'sleepy', emote: 'stretch', bubble: 'sleep', message: this._flavor('sleep') });
  }

  wake() {
    const n = this.appearance.name;
    this.sleepHold = false;
    if (!this.isAsleep) return this._decline('wake', 'awake', `${n} is already awake.`, null, null);
    this._endActivity({ completed: this.needs.energy >= 95, interrupted: true, silent: true });
    return this._react('wake', { expression: 'sleepy', emote: 'stretch', message: `${n} stretches and wakes up.` });
  }

  /**
   * Sleep Practice: the pet curls up in the Sleep Nook so its learning engine
   * can practise. Unlike Rest it works when the pet is not sleepy and is
   * never refused (a napping pet just settles in). The nap is held, so it
   * does not end when the pet is rested, until releaseSleepHold() or wake().
   */
  startPracticeNap() {
    const n = this.appearance.name;
    this.sleepHold = true;
    if (this.isAsleep) {
      return this._react('practice', { expression: 'asleep', bubble: null, message: `${n} settles in to practise in its dreams.`, duration: 1.6 });
    }
    if (!(this.activity.type === 'walking' && this.activity.station === 'bed')) this._commandStation('bed', 'player');
    return this._react('practice', { expression: 'sleepy', emote: 'stretch', bubble: 'sleep', message: `${n} heads to the Sleep Nook to practise in its dreams.` });
  }

  releaseSleepHold() {
    const held = !!this.sleepHold;
    this.sleepHold = false;
    return held;
  }

  /** True while the pet is asleep or on its way to the Sleep Nook. */
  get headingToBed() {
    return this.activity.type === 'walking' && this.activity.station === 'bed';
  }

  pet() {
    const n = this.appearance.name;
    const since = this.clock - this._lastPetAt;
    this._lastPetAt = this.clock;
    const f = since < 1.2 ? 0.35 : since < 4 ? 0.7 : 1; // diminishing returns when spammed
    const drama = 1 + 0.6 * this.traits.dramatic;
    this.counters.pets++;
    if (this.isAsleep) {
      this._bump('bond', 1.5 * f);
      return this._react('pet', { expression: 'asleep', bubble: 'heart', message: `${n} snuggles in its sleep.`, duration: 1.8 });
    }
    this._bump('bond', 4 * f);
    this._bump('mood', 5 * f * drama);
    const t = this.traits;
    const emote = this.activity.type === 'walking' ? null : t.playful > 0.6 ? 'hop' : t.dramatic > 0.6 ? 'spin' : 'wiggle';
    return this._react('pet', { expression: 'happy', emote, bubble: 'heart', message: this._flavor('pet') });
  }

  /** Praise is strongest right after (or during) a creation: the pet looks proud. */
  praise() {
    const n = this.appearance.name;
    if (this.isAsleep) return this._decline('praise', 'asleep', `${n} is asleep. Praise it when it wakes!`, 'asleep', null);
    const since = this.clock - this._lastPraiseAt;
    this._lastPraiseAt = this.clock;
    const f = since < 1.2 ? 0.35 : since < 4 ? 0.7 : 1;
    const drama = 1 + 0.6 * this.traits.dramatic;
    this.counters.praises++;
    const lc = this.lastCompleted;
    const fresh = !!(lc && !lc.praised && this.clock - lc.at <= 30);
    const creatingNow = CREATIVE_ACTIVITIES.includes(this.activity.type);
    if (fresh || creatingNow) {
      if (fresh) lc.praised = true;
      this._bump('mood', 10 * f * drama);
      this._bump('bond', 3 * f);
      const thing = (fresh ? lc.activity : this.activity.type) === 'drawing' ? 'drawing' : 'song';
      return this._react('praise', {
        expression: 'proud', emote: creatingNow ? 'nod' : 'spin', bubble: 'star',
        message: `${n} beams about its ${thing}!`,
      });
    }
    this._bump('mood', 5 * f * drama);
    this._bump('bond', 2 * f);
    return this._react('praise', { expression: 'happy', emote: 'jump', bubble: 'star', message: this._flavor('praise') });
  }

  /** Player-directed trip to a station (Go Play Music, Go Draw, tapping a station). */
  goTo(stationId) {
    const st = STATIONS[stationId];
    if (!st) return { type: 'reaction', kind: 'goto', ok: false, reason: 'unknown-station', message: 'Unknown station.' };
    if (stationId === 'food') return this.feed();
    if (stationId === 'bath') return this.wash();
    if (stationId === 'bed') return this.sleep();
    const n = this.appearance.name;
    const action = st.activity === 'playing_music' ? 'music' : st.activity === 'drawing' ? 'draw' : 'listen';
    if (this.isAsleep) return this._decline(action, 'asleep', `Shh… ${n} is napping. Wake it first.`, 'asleep', null);
    if (this.activity.type === st.activity) {
      return this._decline(action, 'already', `${n} is already at the ${st.label}.`, 'happy', null);
    }
    if (this.activity.type === 'walking' && this.activity.station === stationId) {
      return this._decline(action, 'already', `${n} is already on its way.`, 'happy', null);
    }
    if (CREATIVE_ACTIVITIES.includes(st.activity) && this.needs.energy < 15) {
      return this._decline(action, 'too-tired', `${n} is too sleepy for that. Try Rest.`, 'sleepy');
    }
    if (this._refuses(null)) return this._refusal(action);
    this._commandStation(stationId, 'player');
    return this._react(action, { expression: 'excited', emote: 'hop', bubble: st.icon, message: this._flavor(action) });
  }

  goPlayMusic() {
    return this.goTo('music');
  }

  goDraw() {
    return this.goTo('easel');
  }

  // ----- teaching (scheduling only: content comes from the creation flow) ----------
  /**
   * The player demonstrates something: the pet stops, faces them and attends
   * for `listenSeconds`, then walks to the matching station and performs the
   * planned piece (`ref`) for `performSeconds`. Lessons are never refused, but
   * a napping or exhausted pet cannot take one.
   */
  teachLesson({ kind, ref, listenSeconds = 5, performSeconds = 12 } = {}) {
    const n = this.appearance.name;
    const plan = sanitizePlan({ ref, kind, duration: performSeconds, mode: 'attempt' });
    if (!plan) return { type: 'reaction', kind: 'lesson', ok: false, reason: 'bad-plan', message: 'That lesson could not be started.' };
    if (this.isAsleep) return this._decline('lesson', 'asleep', `Shh… ${n} is napping. Wake it first, then teach.`, 'asleep', null);
    if (this.needs.energy < 12) return this._decline('lesson', 'too-tired', `${n} is too sleepy to learn right now. Try Rest.`, 'sleepy');
    this._leaveCurrent();
    this._setActivity({ type: 'lesson', station: null, source: 'player', duration: clampNum(listenSeconds, 1.5, 30, 5), plan });
    this._bump('bond', 1.5);
    const music = kind === 'music';
    return this._react('lesson', {
      expression: 'curious', emote: 'nod', bubble: music ? 'listen' : 'idea',
      message: music ? `${n} perks up its ears and listens closely.` : `${n} studies your drawing closely.`,
      duration: 2.4,
    });
  }

  /**
   * After finishing a piece the pet lingers (idle, facing you) a little
   * longer before choosing something new, so there is time to react to it.
   */
  lingerIdle(seconds) {
    const a = this.activity;
    if (a.type !== 'idle' || !(seconds > 0)) return false;
    a.duration = Math.max(a.duration, a.elapsed + Math.min(seconds, 60));
    return true;
  }

  /**
   * Social visits (Iteration 4): walks to a station's approach point and waits
   * there without starting its activity, so a jam or co-draw can begin once
   * the visiting friend has arrived too. Never refused, but a napping or
   * exhausted pet cannot join in. The caller pauses autonomy meanwhile.
   */
  gatherAt(stationId, { message = null } = {}) {
    const st = STATIONS[stationId];
    if (!st) return { type: 'reaction', kind: 'social', ok: false, reason: 'unknown-station', message: 'Unknown station.' };
    const n = this.appearance.name;
    if (this.isAsleep) return this._decline('social', 'asleep', `Shh… ${n} is napping. Wake it first.`, 'asleep', null);
    if (this.needs.energy < 12) return this._decline('social', 'too-tired', `${n} is too sleepy to play right now. Try Rest.`, 'sleepy');
    this._leaveCurrent();
    if (distance(this.position, st.approach) < 0.12) this._setIdle();
    else this._setActivity({ type: 'walking', station: null, pending: 'idle', source: 'player' }, planPath(this.position, st.approach, st.entry ?? []));
    this._bump('mood', 2);
    return this._react('social', { expression: 'excited', emote: 'hop', bubble: st.icon, message: typeof message === 'string' ? message.slice(0, 140) : null });
  }

  /** True when the pet stands (idle) at a station's approach point. */
  isAt(stationId, tolerance = 0.15) {
    const st = STATIONS[stationId];
    return !!st && this.activity.type === 'idle' && distance(this.position, st.approach) <= tolerance;
  }

  /** Walks to the Music Corner or Easel to perform a planned piece (gallery replays, retries). */
  performCreation({ kind, ref, duration = 12, mode = 'replay', message: custom = null } = {}) {
    const n = this.appearance.name;
    const plan = sanitizePlan({ ref, kind, duration, mode });
    const action = kind === 'drawing' ? 'draw' : 'music';
    if (!plan) return { type: 'reaction', kind: action, ok: false, reason: 'bad-plan', message: 'That piece could not be started.' };
    if (this.isAsleep) return this._decline(action, 'asleep', `Shh… ${n} is napping. Wake it first.`, 'asleep', null);
    if (this.needs.energy < 12) return this._decline(action, 'too-tired', `${n} is too sleepy for that. Try Rest.`, 'sleepy');
    const stationId = PLAN_STATION[plan.kind];
    this._commandStation(stationId, 'player', plan);
    let message;
    if (typeof custom === 'string' && custom) message = custom.slice(0, 140);
    else if (plan.mode === 'variation') message = `${n} tries another idea!`;
    else if (plan.mode === 'replay') message = kind === 'drawing' ? `${n} heads to the easel to redraw it.` : `${n} heads to the Music Corner to perform it.`;
    else message = this._flavor(action);
    return this._react(action, { expression: 'excited', emote: 'hop', bubble: STATIONS[stationId].icon, message });
  }

  /** "Love It" on a creation: a warm bond and mood boost (diminishing when spammed). */
  receiveLove() {
    const n = this.appearance.name;
    const since = this.clock - this._lastLoveAt;
    this._lastLoveAt = this.clock;
    const f = since < 1.2 ? 0.35 : since < 4 ? 0.7 : 1;
    if (this.isAsleep) {
      this._bump('bond', 1.5 * f);
      return this._react('love', { expression: 'asleep', bubble: 'heart', message: `${n} smiles in its sleep.`, duration: 1.8 });
    }
    this._bump('bond', 5 * f);
    this._bump('mood', 8 * f * (1 + 0.6 * this.traits.dramatic));
    const creatingNow = CREATIVE_ACTIVITIES.includes(this.activity.type);
    return this._react('love', {
      expression: 'proud', emote: creatingNow ? 'nod' : 'jump', bubble: 'heart', message: `${n} glows with pride!`,
    });
  }

  /** Small attentive reaction while the player plays or draws in the workshop (throttled, silent). */
  notice(kind = 'music') {
    if (this.isAsleep || this.clock - this._lastNoticeAt < 1.4) return null;
    if (this.activity.type !== 'idle' && this.activity.type !== 'lesson') return null;
    this._lastNoticeAt = this.clock;
    return this._react('notice', { expression: 'curious', emote: 'nod', bubble: kind === 'drawing' ? 'draw' : 'note', duration: 1.4 });
  }

  // ----- customisation -----------------------------------------------------------------
  setAppearance(partial) {
    this.appearance = sanitizeAppearance({ ...this.appearance, ...(partial ?? {}) });
    this.emit('appearance', { appearance: { ...this.appearance } });
    return this.appearance;
  }

  setTraits(partial) {
    this.traits = sanitizeTraits({ ...this.traits, ...(partial ?? {}) });
    this.emit('traits', { traits: { ...this.traits } });
    return this.traits;
  }

  /** Developer/testing helper: set needs directly (clamped). */
  setNeeds(partial) {
    this.needs = sanitizeNeeds({ ...this.needs, ...(partial ?? {}) });
    return this.needs;
  }

  // ----- time away (bounded and gentle; never fabricates creative work) ------------------
  applyElapsed(seconds) {
    if (!(seconds > 1)) return null;
    const applied = Math.min(seconds, AWAY.capSeconds);
    const before = { ...this.needs };
    const mult = decayMultipliers(this.traits);
    const asleep = this.isAsleep;
    const gentle = (value, drop) => (value <= AWAY.floor ? value : Math.max(AWAY.floor, value - drop));
    for (const k of ['hunger', 'hygiene', 'curiosity', 'bond']) {
      const mod = asleep ? ACTIVITY_DECAY.sleeping[k] ?? 1 : 1;
      this.needs[k] = gentle(this.needs[k], BASE_DECAY[k] * mult[k] * AWAY.rate * mod * applied);
    }
    if (asleep) {
      const gain = ACTIVITY_RULES.sleeping.gain.energy * (this.activity.source === 'player' ? 1 : AUTO_CARE_EFFICIENCY);
      this.needs.energy = Math.min(100, this.needs.energy + gain * applied);
    } else if (applied > 20 * 60) {
      // Long absences include a nap of their own (time-based care only).
      this.needs.energy = Math.max(this.needs.energy, Math.min(85, this.needs.energy + (applied - 1200) * 0.02));
    } else {
      this.needs.energy = gentle(this.needs.energy, BASE_DECAY.energy * mult.energy * AWAY.rate * applied);
    }
    this.needs.mood = moodTarget(this.needs, this.traits, 'idle');
    for (const k of NEEDS) this.needs[k] = clamp(this.needs[k], 0, 100);

    const a = this.activity;
    if (a.type === 'sleeping') {
      if (this.needs.energy >= 99) this._endActivity({ completed: true, silent: true });
    } else if (STATION_ACTIVITIES.includes(a.type) && applied > AWAY.resumeWindowSeconds) {
      this._endActivity({ interrupted: true, silent: true });
    }
    const deltas = {};
    for (const k of NEEDS) deltas[k] = round(this.needs[k] - before[k], 1);
    return {
      awaySeconds: seconds,
      appliedSeconds: applied,
      capped: seconds > AWAY.capSeconds,
      deltas,
      text: summarizeAway(this.appearance.name, seconds, deltas),
    };
  }

  // ----- serialisation -------------------------------------------------------------------
  toJSON(now = this._clockFn()) {
    const a = this.activity;
    const needs = {};
    for (const k of NEEDS) needs[k] = round(this.needs[k], 2);
    return {
      schema: SCHEMA,
      version: SCHEMA_VERSION,
      id: this.id,
      createdAt: this.createdAt,
      savedAt: now,
      appearance: { ...this.appearance },
      traits: { ...this.traits },
      needs,
      activity: {
        type: a.type, station: a.station, pending: a.pending, source: a.source,
        elapsed: round(a.elapsed, 2), duration: round(a.duration, 2), seed: a.seed >>> 0,
        plan: a.plan ? { ...a.plan } : null,
      },
      position: { x: round(this.position.x, 3), z: round(this.position.z, 3) },
      heading: round(this.heading, 3),
      rngState: this.rngState >>> 0,
      counters: { ...this.counters },
      currentDrawing: this.currentDrawing ? sanitizeDrawing(this.currentDrawing) : null,
      events: this.events.slice(-EVENT_LIMIT).map((e) => ({ ...e })),
      lastStation: this.lastStation,
    };
  }

  /** Plain, render-friendly view of the current state (for UI and inspection). */
  snapshot() {
    const a = this.activity;
    const needs = {};
    for (const k of NEEDS) needs[k] = round(this.needs[k], 1);
    return {
      id: this.id,
      name: this.appearance.name,
      appearance: { ...this.appearance },
      traits: { ...this.traits },
      topTraits: this.topTraits(),
      needs,
      activity: {
        type: a.type, station: a.station, pending: a.pending, source: a.source,
        elapsed: round(a.elapsed, 2), duration: round(a.duration, 2), seed: a.seed,
        progress: a.duration > 0 ? clamp(a.elapsed / a.duration, 0, 1) : 0,
        plan: a.plan ? { ...a.plan } : null,
      },
      status: describeActivity(a),
      asleep: this.isAsleep,
      position: { ...this.position },
      heading: this.heading,
      elevation: this.elevation,
      expression: this.getExpression(),
      bubble: this.getBubble(),
      counters: { ...this.counters },
      currentDrawing: this.currentDrawing ? { ...this.currentDrawing } : null,
      events: this.events.slice(-5).map((e) => ({ ...e })),
    };
  }
}

function formatDuration(seconds) {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${Math.max(1, m)} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

function summarizeAway(name, seconds, deltas) {
  const notes = [];
  if (deltas.energy > 10) notes.push('had a nap');
  if (deltas.hunger < -10) notes.push('got peckish');
  if (deltas.hygiene < -10) notes.push('could use a bath');
  if (deltas.curiosity < -10) notes.push('is itching to make something');
  if (deltas.bond < -10) notes.push('is ready for some attention');
  const what = notes.length ? `${name} ${notes.slice(0, 2).join(' and ')}.` : `${name} kept the studio cozy.`;
  return `Welcome back! You were away ${formatDuration(seconds)}. ${what}`;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function readRecord(storage, key) {
  let raw = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { status: 'unavailable' };
  }
  if (raw == null) return { status: 'missing' };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'corrupt', raw };
  }
  const v = validateRecord(parsed);
  if (!v.ok) return { status: v.reason === 'future-version' ? 'future-version' : 'corrupt', raw, reason: v.reason };
  return { status: 'ok', raw, record: v.record };
}

/**
 * Saves the pet. The previous valid record is kept as a last-known-good backup;
 * localStorage.setItem replaces a key atomically, so a failed write (quota,
 * private mode) leaves the previous save intact.
 */
export function savePet(pet, storage = globalThis.localStorage, now = Date.now()) {
  if (!storage) return { ok: false, reason: 'no-storage' };
  let json;
  try {
    json = JSON.stringify(pet.toJSON(now));
  } catch (err) {
    return { ok: false, reason: `serialize-failed: ${err?.message ?? err}` };
  }
  try {
    const prev = readRecord(storage, STORAGE_KEY);
    if (prev.status === 'ok' && prev.raw !== json) storage.setItem(BACKUP_KEY, prev.raw);
    storage.setItem(STORAGE_KEY, json);
    pet.savedAt = now;
    return { ok: true, bytes: json.length };
  } catch (err) {
    return { ok: false, reason: String(err?.name ?? err) };
  }
}

/**
 * Loads the saved pet (falling back to the backup if the main record is
 * damaged) and applies bounded time-away care. Never throws.
 * status: 'loaded' | 'restored-backup' | 'new' | 'future-version' | 'unavailable'.
 * `pet` is null when no usable record exists (the caller then creates one).
 */
export function loadPet(storage = globalThis.localStorage, { now = Date.now(), clock } = {}) {
  if (!storage) return { pet: null, status: 'unavailable', away: null };
  const main = readRecord(storage, STORAGE_KEY);
  let source = main;
  let status = 'loaded';
  if (main.status === 'unavailable') return { pet: null, status: 'unavailable', away: null };
  if (main.status === 'future-version') {
    // Written by a newer app: keep a copy so starting fresh never destroys it.
    try {
      storage.setItem(FUTURE_BACKUP_KEY, main.raw);
    } catch {
      /* ignore */
    }
    return { pet: null, status: 'future-version', away: null };
  }
  if (main.status !== 'ok') {
    const bak = readRecord(storage, BACKUP_KEY);
    if (bak.status !== 'ok') return { pet: null, status: 'new', away: null };
    source = bak;
    status = 'restored-backup';
  }
  const pet = new PetState(source.record, { now, clock });
  const savedAt = source.record.savedAt;
  const elapsed = Number.isFinite(savedAt) ? Math.max(0, (now - savedAt) / 1000) : 0;
  const away = elapsed > 60 ? pet.applyElapsed(elapsed) : null;
  return { pet, status, away };
}

/** Removes the saved pet and its backup (used by "start over"). */
export function clearSavedPet(storage = globalThis.localStorage) {
  try {
    storage?.removeItem(STORAGE_KEY);
    storage?.removeItem(BACKUP_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Random, pleasant starting appearance for the pet creator. */
export function randomAppearance(rand = Math.random) {
  const pick = (list) => list[Math.floor(rand() * list.length) % list.length];
  return sanitizeAppearance({
    name: pick(NAME_IDEAS),
    bodyColor: pick(COLOR_SWATCHES.body),
    accentColor: pick(COLOR_SWATCHES.accent.slice(0, 7)),
    cheekColor: pick(COLOR_SWATCHES.cheek),
    earStyle: pick(EAR_STYLES),
    tailStyle: pick(TAIL_STYLES),
    headScale: round(0.95 + rand() * 0.25, 2),
    bodyScale: round(0.9 + rand() * 0.2, 2),
  });
}

/** Random temperament (each trait 0.1 to 0.9). */
export function randomTraits(rand = Math.random) {
  const out = {};
  for (const k of TRAITS) out[k] = round(0.1 + rand() * 0.8, 2);
  return out;
}
