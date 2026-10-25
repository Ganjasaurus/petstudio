/**
 * social-studio.js: visiting friends in the studio (Iteration 4).
 *
 * Pure ES module (no DOM, no Three.js), testable in Node:
 *  - VisitorActor: where the visiting pet stands and what it is doing
 *    (walking between floor spots, playing its toy xylophone, listening,
 *    drawing, waving). Rendered by a second PetModel in the studio.
 *  - composeDuet / composeCoDraw: the joint pieces. A duet is the visitor's
 *    signature motif (the call) followed by the host pet's answer, composed
 *    by the host's own creative engine in its own style: authored rules, plus
 *    its trained networks once it has practised. A co-drawn picture
 *    interleaves the visitor's strokes (its palette and hand) with the host's
 *    take on the same motif (its palette and hand), stroke by stroke.
 *  - SocialStudio: the visit and session state machine (invite, gather,
 *    perform, celebrate, learn, send home). It drives the host pet only
 *    through its public PetState / CreationFlow API.
 *  - "Learn From <Visitor>": keeps the visitor's demonstration in teaching
 *    memory as a social lesson at half weight (SOCIAL_LESSON_WEIGHT).
 *  - FriendsStore: imported friends and the current visit, persisted.
 *
 * AUTHORED, NOT LEARNED: every bit of choreography here is hand-written. The
 * host's answer comes from its hybrid engine (learned once trained); a
 * visitor with trained weights composes with its own copy of them, which is
 * never trained here, so the visitor stays the snapshot it arrived as.
 */
import { planPath, distance, yawTowards, VISIT_SPOTS, XYLOPHONE, xylophoneBar } from './studio-layout.js';
import { sanitizeTraits } from './pet-state.js';
import { sanitizePhrase, sanitizeDrawing, phraseIsEmpty, drawingIsEmpty, strokeLength, roundTo, PAPER } from './teaching-core.js';
import { HybridCreativeEngine } from './hybrid-engine.js';
import { socialLabel } from './creative-engine.js';
import { sanitizeSnapshot, visitorEngine, BUILTIN_VISITORS, builtinVisitor, snapshotSummary } from './pet-snapshot.js';
import { SOCIAL_LESSON_WEIGHT } from './teaching-memory.js';
import { loadVersioned, saveVersioned, removeKeys } from './persist.js';
import { hashSeed } from './rng.js';

const TAU = Math.PI * 2;
const deg = (d) => (d * Math.PI) / 180;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// Where visitors stand lives in the shared floor plan (studio-layout.js).
export { VISIT_SPOTS, XYLOPHONE, xylophoneBar };

export const SOCIAL = Object.freeze({
  gatherTimeout: 16, // s: a session starts anyway when a pet is stuck on its way
  celebrateSeconds: 3.2, // s: both pets enjoy the result before the visitor wanders off
  personalSpace: 0.95, // m: an idle visitor steps aside when the host comes this close
  spaceCheck: 0.6, // s
  hurry: 1.7, // walking-speed factor on the way to a session
  phraseLead: 0.5, // beats of lead-in before a performed phrase (matches the app's stepPhrase)
});

// ---------------------------------------------------------------------------
// VisitorActor: the visiting pet's position, heading and activity
// ---------------------------------------------------------------------------
export class VisitorActor {
  constructor({ traits, position = VISIT_SPOTS.door, heading = deg(-140) } = {}) {
    this.traits = sanitizeTraits(traits);
    this.position = { x: position.x, z: position.z };
    this.heading = heading;
    this.activity = 'idle'; // what the PetModel shows: idle | walking | playing_music | lesson | drawing
    this.path = [];
    this.speedMul = 1;
    this.face = null;
    this.then = null;
    this.elapsed = 0;
    this.expression = 'happy';
    this.bubble = null;
    this.bubbleTimer = 0;
    this.bubbleSeq = 0;
    this.emotes = []; // one-shot emotes for the 3D model (drained by the app)
    this.walked = 0;
  }

  get walking() {
    return this.activity === 'walking';
  }

  get walkSpeed() {
    const t = this.traits;
    return 1.15 * (1 + 0.25 * t.playful - 0.12 * t.calm) * this.speedMul;
  }

  /** Walks to a spot (paths bow around furniture like the host's); `then` runs on arrival. */
  walkTo(spot, { face = null, hurry = false, then = null } = {}) {
    this.path = planPath(this.position, spot, spot.entry ?? []);
    this.face = Number.isFinite(face) ? face : Number.isFinite(spot.facing) ? spot.facing : null;
    this.then = then;
    this.speedMul = hurry ? SOCIAL.hurry : 1;
    this.elapsed = 0;
    if (distance(this.position, spot) < 0.02) {
      this.path = [];
      this._arrive();
      return 0;
    }
    this.activity = 'walking';
    return this.eta();
  }

  /** Seconds until it arrives (0 when standing). */
  eta() {
    if (!this.path.length) return 0;
    let len = 0;
    let from = this.position;
    for (const wp of this.path) {
      len += distance(from, wp);
      from = wp;
    }
    return len / Math.max(0.1, this.walkSpeed);
  }

  setActivity(type, { face = null, expression = null } = {}) {
    if (this.walking && type !== 'walking') this.path = [];
    if (type !== this.activity) this.elapsed = 0;
    this.activity = type;
    if (Number.isFinite(face)) this.heading = face;
    if (expression) this.expression = expression;
  }

  /** A speech or thought bubble for a few seconds. */
  say(icon, { kind = 'speech', seconds = 2.4 } = {}) {
    this.bubbleSeq += 1;
    this.bubble = icon ? { icon, kind, key: `v:${this.bubbleSeq}:${icon}` } : null;
    this.bubbleTimer = icon ? seconds : 0;
  }

  emote(name) {
    if (name) this.emotes.push(name);
  }

  _arrive() {
    this.activity = 'idle';
    this.speedMul = 1;
    if (Number.isFinite(this.face)) this.heading = this.face;
    const fn = this.then;
    this.then = null;
    fn?.();
  }

  update(dt) {
    if (!(dt > 0)) return;
    this.elapsed += dt;
    if (this.bubbleTimer > 0) {
      this.bubbleTimer -= dt;
      if (this.bubbleTimer <= 0) this.bubble = null;
    }
    if (!this.walking) return;
    let budget = this.walkSpeed * dt;
    while (budget > 1e-6 && this.path.length) {
      const wp = this.path[0];
      const dx = wp.x - this.position.x;
      const dz = wp.z - this.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-4) this.heading = Math.atan2(dx, dz);
      if (d <= budget) {
        this.position = { x: wp.x, z: wp.z };
        this.walked += d;
        budget -= d;
        this.path.shift();
      } else {
        this.position = { x: this.position.x + (dx / d) * budget, z: this.position.z + (dz / d) * budget };
        this.walked += budget;
        budget = 0;
      }
    }
    if (!this.path.length || this.elapsed > 30) this._arrive(); // never walks forever
  }

  /** Render view for the PetModel (same shape as the host's view model). */
  view() {
    return {
      position: this.position, heading: this.heading, elevation: 0, activity: this.activity,
      walkSpeed: this.walkSpeed, expression: this.expression, bubble: this.bubble,
    };
  }
}

// ---------------------------------------------------------------------------
// Joint pieces
// ---------------------------------------------------------------------------
/** The first eight beats of a phrase: the visitor's call (its signature motif). */
export function motifOf(phrase) {
  const p = sanitizePhrase(phrase);
  return sanitizePhrase({ tempo: p.tempo, beats: 8, notes: p.notes, hits: p.hits });
}

/**
 * Jam Together: the visitor's call (eight beats of its signature phrase, as
 * it plays it) and the host's answer, composed by the host's own creative
 * engine from that motif in the host's style. One shared tempo (the call's),
 * 16 beats: beats 0-8 belong to the visitor, 8-16 to the host.
 */
export function composeDuet({ visitor, host, index = 0, seed = 1 }) {
  const snap = visitor.snapshot;
  const pick = snap.phrases[((index % snap.phrases.length) + snap.phrases.length) % snap.phrases.length];
  const call = motifOf(pick.data);
  const answer = host.creative.compose('music', call, { seed, style: host.prefs, traits: host.traits, colors: host.colors });
  const ans = sanitizePhrase({ ...answer, beats: 8 });
  const split = 8;
  const duet = sanitizePhrase({
    tempo: call.tempo,
    beats: 16,
    notes: [...call.notes, ...ans.notes.map((n) => ({ ...n, beat: n.beat + split }))],
    hits: [...call.hits, ...ans.hits.map((h) => ({ ...h, beat: h.beat + split }))],
  });
  const name = snap.pet.name;
  return {
    kind: 'music',
    data: duet,
    split,
    call,
    answer: ans,
    title: host.name ? `${host.name} & ${name}: ${pick.title ?? 'a duet'}` : `Duet with ${name}: ${pick.title ?? 'a tune'}`,
    generator: answer.generator ?? null,
    model: answer.model ?? null,
    demo: { kind: 'music', data: call, title: `${name}'s ${pick.title ?? 'tune'}` },
  };
}

function bounds(strokes) {
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
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: 0.3, minY: 0.3, maxX: 0.7, maxY: 0.7 };
}

/** Moves strokes so their bounding box is centred on (cx, cy) and fits in a box of `size`. */
function placeStrokes(strokes, { cx, cy, size }) {
  const b = bounds(strokes);
  const s = Math.min(1, size / Math.max(0.05, b.maxX - b.minX, b.maxY - b.minY));
  const bx = (b.minX + b.maxX) / 2;
  const by = (b.minY + b.maxY) / 2;
  return strokes.map((st) => ({
    ...st,
    width: clamp(st.width * (0.55 + 0.45 * s), 0.004, 0.08),
    points: st.points.map((p) => [clamp(cx + (p[0] - bx) * s, 0.01, 0.99), clamp(cy + (p[1] - by) * s, 0.01, 0.99), ...p.slice(2)]),
  }));
}

function tinySignature(kind, color, x, y) {
  const pts = [];
  if (kind === 'star') {
    for (let i = 0; i <= 10; i++) {
      const a = -Math.PI / 2 + (i / 10) * TAU;
      const r = i % 2 ? 0.012 : 0.028;
      pts.push([x + r * Math.cos(a), y + r * Math.sin(a)]);
    }
  } else {
    for (let i = 0; i <= 24; i++) {
      const t = (i / 24) * TAU;
      const hx = 16 * Math.sin(t) ** 3;
      const hy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      pts.push([x + (hx / 17) * 0.028, y - (hy / 17) * 0.028]);
    }
  }
  return { color, width: 0.008, points: pts, motif: 'signature' };
}

const readable = (hex) => {
  const v = parseInt(String(hex).slice(1), 16);
  const lum = (0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)) / 255;
  return lum > 0.72 ? '#4a3f6b' : hex;
};

/**
 * Co-Draw Together: the visitor's take on its signature drawing (its palette
 * and hand; its own trained weights when it brought any) and the host's take
 * on the same motif (its palette and hand), placed side by side on one
 * canvas and interleaved stroke by stroke. `owners` says who draws each
 * stroke ('v' visitor, 'h' host), so the two pets take turns at the easel.
 */
export function composeCoDraw({ visitor, host, index = 0, seed = 1 }) {
  const snap = visitor.snapshot;
  const pick = snap.drawings[((index % snap.drawings.length) + snap.drawings.length) % snap.drawings.length];
  const source = sanitizeDrawing(pick.data);
  const vTake = visitor.creative.compose('drawing', source, { seed: hashSeed(`codraw:v:${seed}`), style: snap.style, traits: snap.traits, colors: snap.pet });
  const hTake = host.creative.compose('drawing', source, { seed: hashSeed(`codraw:h:${seed}`), style: host.prefs, traits: host.traits, colors: host.colors });
  const own = (d) => sanitizeDrawing(d).strokes.filter((s) => s.motif !== 'signature');
  const vStrokes = placeStrokes(own(vTake), { cx: 0.33, cy: 0.37, size: 0.46 });
  const hStrokes = placeStrokes(own(hTake), { cx: 0.67, cy: 0.63, size: 0.46 });
  const strokes = [];
  let owners = '';
  for (let i = 0; i < Math.max(vStrokes.length, hStrokes.length); i++) {
    if (vStrokes[i]) {
      strokes.push(vStrokes[i]);
      owners += 'v';
    }
    if (hStrokes[i]) {
      strokes.push(hStrokes[i]);
      owners += 'h';
    }
  }
  strokes.push(tinySignature('star', readable(snap.pet.cheekColor), 0.085, 0.915));
  owners += 'v';
  strokes.push(tinySignature('heart', readable(host.colors?.cheekColor ?? '#ff7d9c'), 0.915, 0.915));
  owners += 'h';
  // Each pet paints at its own steady pace (the easel paints by length; timings serve replays).
  let t = 0;
  const timed = strokes.map((s) => {
    const dur = Math.max(0.1, strokeLength(s) / 0.7);
    const step = s.points.length > 1 ? dur / (s.points.length - 1) : 0;
    const out = { ...s, points: s.points.map((p, i) => [p[0], p[1], p[2] ?? 0.55, i ? step : 0]), t0: roundTo(t, 3), dur: roundTo(dur, 3) };
    t += dur + 0.3;
    return out;
  });
  const drawing = sanitizeDrawing({ paper: PAPER, strokes: timed });
  owners = owners.slice(0, drawing.strokes.length);
  const name = snap.pet.name;
  const demo = sanitizeDrawing({ paper: PAPER, strokes: own(vTake) });
  return {
    kind: 'drawing',
    data: drawing,
    owners,
    title: host.name ? `${host.name} & ${name}: ${pick.title ?? 'a picture'}` : `Co-Drawn with ${name}: ${pick.title ?? 'a picture'}`,
    generator: hTake.generator ?? null,
    model: hTake.model ?? null,
    demo: { kind: 'drawing', data: drawingIsEmpty(demo) ? source : demo, title: `${name}'s ${pick.title ?? 'drawing'}` },
  };
}

/** Whose turn it is in a duet at a given point of the host's performance (seconds into it). */
export function duetTurn(elapsed, { tempo, split = 8, beats = 16 }) {
  const beat = (elapsed * tempo) / 60 - SOCIAL.phraseLead;
  if (beat < split) return { beat, turn: 'visitor' };
  if (beat < beats) return { beat, turn: 'host' };
  return { beat, turn: 'both' };
}

// ---------------------------------------------------------------------------
// SocialStudio: visits and sessions
// ---------------------------------------------------------------------------
const STATION_FOR = Object.freeze({ jam: 'music', codraw: 'easel' });
const KIND_FOR = Object.freeze({ jam: 'music', codraw: 'drawing' });

export class SocialStudio {
  /**
   * @param {object} deps
   * @param {import('./pet-state.js').PetState} deps.pet the host pet
   * @param {import('./creation-flow.js').CreationFlow} deps.flow
   * @param {import('./teaching-memory.js').TeachingMemory} deps.memory
   * @param {{compose: Function}} deps.creative the host's creative engine (hybrid)
   * @param {() => number} [deps.clock] wall-clock ms
   * @param {(on: boolean) => void} [deps.setAutonomy] how the host's autonomy is paused and restored
   */
  constructor({ pet, flow, memory, creative, clock = () => Date.now(), setAutonomy = null, now = () => Date.now() }) {
    this.pet = pet;
    this.flow = flow;
    this.memory = memory;
    this.creative = creative;
    this.clock = clock;
    this.perfNow = now;
    this.setAutonomy = setAutonomy ?? ((on) => { this.pet.autonomy = on; });
    this.visitor = null;
    this.session = null;
    this.lastSession = null;
    this.listeners = new Set();
    this.spaceTimer = 0;
    this.sinceMove = 0;
    this.seq = 0;
    /** Camera position on the floor plan ({ x, z }), set by the app: keeps an idle visitor out of the shot. */
    this.viewHint = null;
    this.unsubscribe = pet.on((e) => this._onPet(e));
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(type, payload = {}) {
    for (const fn of this.listeners) {
      try {
        fn({ type, ...payload });
      } catch (err) {
        if (typeof console !== 'undefined') console.error('[social-studio] listener error', err);
      }
    }
  }

  get host() {
    const p = this.pet;
    return { creative: this.creative, traits: p.traits, prefs: this.memory.prefs, colors: p.appearance, name: p.name };
  }

  /** The visitor's name as shown here: a snapshot of the host itself is "<name> (copy)". */
  displayName(snap = this.visitor?.snapshot) {
    if (!snap) return '';
    return snap.source?.petId && snap.source.petId === this.pet.id ? `${snap.pet.name} (copy)` : snap.pet.name;
  }

  /**
   * Invites a friend (a sanitised snapshot). It pops in at the door and walks
   * to a hangout spot, or appears there at once with `instant` (a reload).
   * A friend who is already visiting goes home first.
   */
  invite(snapshot, { friendId = null, origin = 'builtin', instant = false } = {}) {
    const res = sanitizeSnapshot(snapshot, { trusted: snapshot?.origin === 'builtin' && BUILTIN_VISITORS.some((b) => b.id === snapshot.id) });
    if (!res.ok) return { ok: false, reason: res.reason };
    if (this.visitor) this.sendHome({ instant: true });
    const snap = res.snapshot;
    const engine = visitorEngine(snap, { clock: this.clock });
    const spot = this._hangoutSpot();
    const actor = new VisitorActor({ traits: snap.traits, position: instant ? spot : VISIT_SPOTS.door, heading: deg(-140) });
    this.seq += 1;
    this.visitor = {
      id: friendId ?? snap.id,
      origin,
      snapshot: snap,
      name: snap.pet.name,
      engine,
      creative: new HybridCreativeEngine({ neural: engine }),
      actor,
      since: this.clock(),
      arrived: instant,
      leaving: false,
      jams: 0,
      draws: 0,
      seq: this.seq,
    };
    if (instant) {
      actor.heading = yawTowards(spot, this.pet.position);
    } else {
      actor.say('heart', { seconds: 2.6 });
      actor.walkTo(spot, { then: () => this._arrived() });
    }
    this._emit('arrive', { visitor: this.describeVisitor(), instant });
    return { ok: true, visitor: this.describeVisitor() };
  }

  _arrived() {
    const v = this.visitor;
    if (!v || v.leaving) return;
    v.arrived = true;
    v.actor.heading = yawTowards(v.actor.position, this.pet.position);
    v.actor.emote('jump');
    v.actor.say('heart', { seconds: 2.2 });
    this._emit('arrived', { visitor: this.describeVisitor() });
  }

  /** "Send <Visitor> Home": ends any session; the friend walks to the door and leaves. */
  sendHome({ instant = false } = {}) {
    const v = this.visitor;
    if (!v) return { ok: false, reason: 'no-visitor' };
    if (this.session) this._endSession('cancelled', 'home');
    if (instant) {
      this.visitor = null;
      this._emit('left', { visitorId: v.id, name: v.name, instant: true });
      return { ok: true };
    }
    if (v.leaving) return { ok: true, leaving: true };
    v.leaving = true;
    v.actor.emote('hop');
    v.actor.say('heart', { seconds: 2 });
    v.actor.walkTo(VISIT_SPOTS.door, { then: () => this._left(v) });
    this._emit('leaving', { visitorId: v.id, name: v.name });
    return { ok: true, leaving: true };
  }

  _left(v) {
    if (this.visitor !== v) return;
    this.visitor = null;
    this._emit('left', { visitorId: v.id, name: v.name, instant: false });
  }

  /**
   * True when a visitor standing at `spot` would get in the shot: too close to
   * the camera (`viewHint`, set by the app each frame), or between the camera
   * and its host (or where the host is heading), close enough to hide it.
   */
  blocksView(spot) {
    const cam = this.viewHint;
    if (!cam) return false;
    if (distance(spot, cam) < 1.4) return true;
    const host = this.pet.position;
    const goal = this.pet.path?.length ? this.pet.path[this.pet.path.length - 1] : host;
    for (const target of [host, goal]) {
      const dx = target.x - cam.x;
      const dz = target.z - cam.z;
      const len2 = dx * dx + dz * dz;
      if (len2 < 1e-6) continue;
      const t = ((spot.x - cam.x) * dx + (spot.z - cam.z) * dz) / len2;
      if (t <= 0 || t >= 1) continue;
      const lateral = Math.hypot(spot.x - (cam.x + t * dx), spot.z - (cam.z + t * dz));
      if (lateral < 0.85 && Math.sqrt(len2) * (1 - t) < 2.6) return true;
    }
    return false;
  }

  /** A hangout spot away from the host (and from where it is heading) that keeps the host in view. */
  _hangoutSpot(exclude = null) {
    const host = this.pet.position;
    const goal = this.pet.path?.length ? this.pet.path[this.pet.path.length - 1] : host;
    let best = VISIT_SPOTS.hangout[0];
    let bestScore = -Infinity;
    for (const s of VISIT_SPOTS.hangout) {
      if (exclude && distance(s, exclude) < 0.1) continue;
      const score = Math.min(distance(s, host), distance(s, goal) + 0.3) - (this.blocksView(s) ? 10 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best;
  }

  get busy() {
    return !!this.session;
  }

  canSession() {
    const v = this.visitor;
    if (!v) return { ok: false, reason: 'no-visitor', message: 'Invite a friend first.' };
    if (v.leaving) return { ok: false, reason: 'leaving', message: `${v.name} is on the way home.` };
    if (this.session) return { ok: false, reason: 'busy', message: `${this.pet.name} and ${v.name} are busy right now.` };
    return { ok: true };
  }

  startJam() {
    return this._startSession('jam');
  }

  startCoDraw() {
    return this._startSession('codraw');
  }

  _startSession(mode) {
    const ok = this.canSession();
    if (!ok.ok) return ok;
    const v = this.visitor;
    const name = this.displayName();
    const t0 = this.perfNow();
    const seed = hashSeed(`${mode}:${v.id}:${this.pet.id}:${mode === 'jam' ? v.jams : v.draws}:${this.clock()}`);
    const piece = mode === 'jam'
      ? composeDuet({ visitor: v, host: this.host, index: v.jams, seed })
      : composeCoDraw({ visitor: v, host: this.host, index: v.draws, seed });
    const composeMs = Math.round((this.perfNow() - t0) * 100) / 100;
    const station = STATION_FOR[mode];
    const message = mode === 'jam' ? `${this.pet.name} heads to the Music Corner to jam with ${name}!` : `${this.pet.name} and ${name} head to the easel to draw together!`;
    const res = this.pet.gatherAt(station, { message });
    if (!res.ok) return { ok: false, reason: res.reason, message: res.message };
    this.setAutonomy(false);
    const spot = mode === 'jam' ? VISIT_SPOTS.jam : VISIT_SPOTS.codraw;
    v.actor.say(mode === 'jam' ? 'music' : 'draw', { seconds: 2.4 });
    v.actor.walkTo(spot, { hurry: true });
    this.session = {
      id: `${mode}-${this.seq}-${Math.floor(this.clock()).toString(36)}`,
      mode,
      kind: KIND_FOR[mode],
      station,
      phase: 'gathering',
      piece,
      ref: null,
      timer: 0,
      turn: null,
      beat: 0,
      composeMs,
      visitorId: v.id,
      snapshotId: v.snapshot.id,
      visitorName: name,
      itemId: null,
    };
    this._emit('session', { phase: 'gathering', session: this.describeSession() });
    return { ok: true, session: this.describeSession() };
  }

  _perform() {
    const s = this.session;
    const v = this.visitor;
    // The host's performance starts synchronously inside performSocial(): its own activity
    // events must not read as the player redirecting the pet.
    s.phase = 'starting';
    const tag = {
      mode: s.mode, visitor: s.visitorName.replace(/ \(copy\)$/, ''), visitorId: s.visitorId, snapshotId: s.snapshotId,
      ...(s.mode === 'jam' ? { split: s.piece.split } : { owners: s.piece.owners }),
    };
    const res = this.flow.performSocial({
      kind: s.kind, data: s.piece.data, title: s.piece.title, social: tag, generator: s.piece.generator, model: s.piece.model,
      style: this.memory.prefs, message: s.mode === 'jam' ? `${v.name} plays first, then ${this.pet.name} answers!` : `${this.pet.name} and ${v.name} take turns at the easel!`,
    });
    if (!res.ok) {
      this._endSession('cancelled', res.reason ?? 'refused', res.message);
      return;
    }
    s.ref = res.plan.ref;
    s.phase = 'performing';
    s.timer = 0;
    if (s.mode === 'codraw') v.actor.setActivity('drawing', { face: VISIT_SPOTS.codraw.facing, expression: 'curious' });
    else v.actor.setActivity('idle', { face: VISIT_SPOTS.jam.facing, expression: 'excited' });
    this._emit('session', { phase: 'performing', session: this.describeSession() });
  }

  _onPet(e) {
    const s = this.session;
    if (!s) return;
    // Gathering walks have no station; any station-bound walk or other activity means the player redirected the host.
    if (s.phase === 'gathering' && e.type === 'activity' && ((e.to !== 'walking' && e.to !== 'idle') || (e.to === 'walking' && e.station))) {
      this._endSession('cancelled', 'redirected', `The ${s.mode === 'jam' ? 'jam' : 'drawing session'} stopped: ${this.pet.name} went off to do something else.`);
      return;
    }
    if (s.phase === 'performing' && e.type === 'activity:end' && e.plan?.ref === s.ref) {
      if (e.completed) {
        s.phase = 'done';
        s.timer = 0;
        const item = this.flow.subject?.ref === s.ref ? this.flow.subject.itemId : null;
        s.itemId = item ?? null;
        const v = this.visitor;
        if (s.mode === 'jam' && v) v.jams += 1;
        if (s.mode === 'codraw' && v) v.draws += 1;
        if (v) {
          v.actor.setActivity('idle', { expression: 'proud' });
          v.actor.emote('hop'); // a small hop: it celebrates beside its instrument or the easel
          v.actor.say('star', { seconds: 2.6 });
        }
        this.lastSession = this._summary(s);
        this._emit('session', { phase: 'done', session: this.describeSession() });
      } else {
        this._endSession('cancelled', 'interrupted', `The ${s.mode === 'jam' ? 'duet' : 'drawing'} was interrupted.`);
      }
    }
  }

  _summary(s) {
    return {
      mode: s.mode, kind: s.kind, title: s.piece.title, itemId: s.itemId, ref: s.ref,
      visitorId: s.visitorId, snapshotId: s.snapshotId, visitorName: s.visitorName,
      demo: { ...s.piece.demo, from: { name: s.visitorName.replace(/ \(copy\)$/, ''), snapshotId: s.snapshotId, visitorId: s.visitorId } },
      learned: false, at: this.clock(),
    };
  }

  _endSession(outcome, reason = null, message = null) {
    const s = this.session;
    if (!s) return;
    this.session = null;
    this.setAutonomy(true);
    const v = this.visitor;
    if (v && !v.leaving) {
      v.actor.setActivity('idle', { expression: 'happy' });
      v.actor.walkTo(this._hangoutSpot(), { then: () => { if (this.visitor === v) v.actor.heading = yawTowards(v.actor.position, this.pet.position); } });
    }
    this._emit('session', { phase: outcome, reason, message, session: { ...this.describeSession(s), phase: outcome } });
  }

  /**
   * "Learn From <Visitor>": keeps the visitor's demonstration from the current
   * or last session in teaching memory as a social lesson at half weight. The
   * host can then practise it in Sleep Practice; nothing trains right now.
   */
  learn() {
    const s = this.session && this.session.phase !== 'gathering' ? this._summary(this.session) : this.lastSession;
    if (!s?.demo) return { ok: false, reason: 'nothing', message: 'Jam or draw together first, then keep what your friend showed you.' };
    const res = this.memory.addSocialLesson(s.demo.kind, s.demo.data, { from: s.demo.from, title: s.demo.title, petName: this.pet.name });
    if (!res) return { ok: false, reason: 'empty', message: 'There was nothing to keep from that session.' };
    if (this.lastSession && this.lastSession.ref === s.ref) this.lastSession.learned = true;
    if (this.session && this.session.ref === s.ref) this.session.learned = true;
    this._emit('learned', { lesson: res.lesson, existing: res.existing, from: s.demo.from });
    return {
      ok: true, existing: res.existing, lesson: res.lesson, weight: SOCIAL_LESSON_WEIGHT, kind: s.demo.kind, from: s.demo.from.name,
      message: res.existing
        ? `${this.pet.name} already keeps ${s.demo.title} as inspiration.`
        : `${this.pet.name} keeps ${s.demo.title} as inspiration (half weight). It can practise it in Sleep Practice.`,
    };
  }

  /** True when the subject in the feedback bar can be learned from. */
  canLearn(ref = null) {
    const s = this.session && this.session.phase !== 'gathering' ? this.session : this.lastSession;
    if (!s) return { ok: false };
    if (ref && s.ref !== ref) return { ok: false };
    return { ok: true, learned: !!s.learned, name: s.visitorName };
  }

  /** Advances the visit (call once per frame with real seconds). */
  update(dt) {
    const v = this.visitor;
    if (v) v.actor.update(dt);
    const s = this.session;
    if (s) this._updateSession(s, dt);
    else if (v && v.arrived && !v.leaving) this._hangout(v, dt);
  }

  _updateSession(s, dt) {
    const v = this.visitor;
    s.timer += dt;
    if (!v) {
      this._endSession('cancelled', 'no-visitor');
      return;
    }
    if (s.phase === 'gathering') {
      this.pet.autonomy = false; // a sheet closing elsewhere must not let the host wander off mid-gathering
      const hostThere = this.pet.isAt(s.station);
      const visitorThere = !v.actor.walking;
      if ((hostThere && visitorThere) || s.timer > SOCIAL.gatherTimeout) this._perform();
      return;
    }
    if (s.phase === 'performing') {
      this.pet.autonomy = false;
      const a = this.pet.activity;
      if (a.plan?.ref !== s.ref) return; // still walking the last step to its spot
      if (s.mode === 'jam') {
        const t = duetTurn(a.elapsed, { tempo: s.piece.data.tempo, split: s.piece.split });
        s.beat = t.beat;
        if (t.turn !== s.turn) {
          s.turn = t.turn;
          if (t.turn === 'visitor') {
            v.actor.setActivity('playing_music', { face: VISIT_SPOTS.jam.facing, expression: 'excited' });
            v.actor.say('note', { seconds: 1.8 });
          } else if (t.turn === 'host') {
            v.actor.setActivity('lesson', { face: wrap(VISIT_SPOTS.jam.facing - deg(12)), expression: 'curious' });
          } else {
            v.actor.setActivity('idle', { face: VISIT_SPOTS.jam.facing, expression: 'happy' });
          }
          this._emit('turn', { turn: t.turn });
        }
      } else {
        s.turn = 'shared';
      }
      return;
    }
    if (s.phase === 'done' && s.timer > SOCIAL.celebrateSeconds) {
      this._endSession('complete', null);
    }
  }

  _hangout(v, dt) {
    const a = v.actor;
    if (a.walking) return;
    const host = this.pet.activity.type;
    // Hanging out together: bob along when the host makes music, watch otherwise.
    const want = host === 'playing_music' ? 'lesson' : 'idle';
    if (a.activity !== want) a.setActivity(want);
    this.sinceMove = (this.sinceMove ?? 0) + dt;
    this.spaceTimer -= dt;
    if (this.spaceTimer > 0) return;
    this.spaceTimer = SOCIAL.spaceCheck;
    const crowded = distance(a.position, this.pet.position) < SOCIAL.personalSpace;
    // Stepping out of the shot waits a little after the last move, so the visitor never fidgets.
    const inTheWay = this.sinceMove > 4 && this.blocksView(a.position);
    if (!crowded && !inTheWay) return;
    const spot = this._hangoutSpot(a.position);
    if (inTheWay && !crowded && this.blocksView(spot)) return; // nowhere better to stand right now
    this.sinceMove = 0;
    a.walkTo(spot, { then: () => { if (this.visitor === v) a.heading = yawTowards(a.position, this.pet.position); } });
  }

  describeVisitor(v = this.visitor) {
    if (!v) return null;
    return {
      id: v.id, origin: v.origin, name: v.name, displayName: this.displayName(v.snapshot), snapshotId: v.snapshot.id,
      arrived: v.arrived, leaving: v.leaving, jams: v.jams, draws: v.draws, since: v.since,
      position: { x: roundTo(v.actor.position.x, 3), z: roundTo(v.actor.position.z, 3) }, heading: roundTo(v.actor.heading, 3),
      activity: v.actor.activity, expression: v.actor.expression, walked: roundTo(v.actor.walked, 2),
      engine: { trained: v.engine.stepsFor('music') + v.engine.stepsFor('drawing') > 0, steps: { music: v.engine.stepsFor('music'), drawing: v.engine.stepsFor('drawing') } },
      summary: snapshotSummary(v.snapshot),
    };
  }

  describeSession(s = this.session) {
    if (!s) return null;
    return {
      id: s.id, mode: s.mode, kind: s.kind, phase: s.phase, ref: s.ref, turn: s.turn, beat: roundTo(s.beat ?? 0, 3),
      title: s.piece.title, split: s.piece.split ?? null, owners: s.piece.owners ?? null, composeMs: s.composeMs,
      generator: s.piece.generator, visitorName: s.visitorName, itemId: s.itemId, learned: !!s.learned,
    };
  }

  state() {
    return {
      visitor: this.describeVisitor(),
      session: this.describeSession(),
      lastSession: this.lastSession ? { ...this.lastSession, demo: { kind: this.lastSession.demo.kind, title: this.lastSession.demo.title, from: { ...this.lastSession.demo.from } } } : null,
    };
  }

  /**
   * The joint piece the host is performing (the app routes notes and strokes
   * with it), or null. While the performance is starting (inside
   * performSocial) the plan ref is the flow's new subject.
   */
  pieceFor(ref) {
    const s = this.session;
    if (!s || !ref) return null;
    return s.ref === ref || (s.phase === 'starting' && this.flow.subject?.ref === ref) ? s : null;
  }
}

// ---------------------------------------------------------------------------
// FriendsStore: imported friends and the current visit (persisted)
// ---------------------------------------------------------------------------
export const FRIENDS_SCHEMA = 'petstudio.friends';
export const FRIENDS_VERSION = 1;
export const FRIENDS_KEY = 'petstudio.friends.v1';
export const FRIENDS_BACKUP_KEY = 'petstudio.friends.v1.bak';
export const FRIENDS_FUTURE_KEY = 'petstudio.friends.future';
export const FRIENDS_LIMITS = Object.freeze({ imported: 4 });
const LOCAL_ID_RE = /^friend-[a-z0-9-]{3,40}$/;

export function sanitizeFriendsRecord(r) {
  const src = r && typeof r === 'object' ? r : {};
  const friends = [];
  for (const f of (Array.isArray(src.friends) ? src.friends : []).slice(-FRIENDS_LIMITS.imported * 2)) {
    if (!f || typeof f !== 'object' || typeof f.localId !== 'string' || !LOCAL_ID_RE.test(f.localId)) continue;
    const res = sanitizeSnapshot(f.snapshot); // untrusted: never 'builtin'
    if (!res.ok || friends.some((x) => x.localId === f.localId || x.snapshot.id === res.snapshot.id)) continue;
    friends.push({ localId: f.localId, importedAt: Number.isFinite(f.importedAt) ? f.importedAt : 0, snapshot: res.snapshot });
  }
  const kept = friends.slice(-FRIENDS_LIMITS.imported);
  const visitId = typeof src.visit?.friendId === 'string' ? src.visit.friendId : null;
  const known = visitId && (BUILTIN_VISITORS.some((b) => b.id === visitId) || kept.some((f) => f.localId === visitId));
  const n = (v) => (Number.isInteger(v) && v >= 0 ? Math.min(v, 1e6) : 0);
  return {
    friends: kept,
    visit: known ? { friendId: visitId, since: Number.isFinite(src.visit.since) ? src.visit.since : 0 } : null,
    stats: { jams: n(src.stats?.jams), codraws: n(src.stats?.codraws), learned: n(src.stats?.learned), exports: n(src.stats?.exports), imports: n(src.stats?.imports) },
  };
}

export class FriendsStore {
  constructor(record = {}, { clock = () => Date.now() } = {}) {
    this.clock = clock;
    const r = sanitizeFriendsRecord(record);
    this.friends = r.friends;
    this.visit = r.visit;
    this.stats = r.stats;
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _changed(what) {
    for (const fn of this.listeners) {
      try {
        fn(what);
      } catch (err) {
        if (typeof console !== 'undefined') console.error('[friends-store] listener error', err);
      }
    }
  }

  /**
   * Keeps an imported (already parsed) snapshot as a friend with its own local
   * identity; the same snapshot id is kept once. At most FRIENDS_LIMITS.imported
   * friends (the oldest import goes first, never the one visiting).
   */
  add(snapshot) {
    const res = sanitizeSnapshot(snapshot);
    if (!res.ok) return { ok: false, reason: res.reason };
    const snap = res.snapshot;
    const existing = this.friends.find((f) => f.snapshot.id === snap.id);
    if (existing) {
      existing.snapshot = snap;
      this._changed('friends');
      return { ok: true, friend: existing, existing: true };
    }
    const importedAt = this.clock();
    const friend = { localId: `friend-${hashSeed(`${snap.id}:${importedAt}`).toString(36)}-${(this.friends.length + this.stats.imports).toString(36)}`, importedAt, snapshot: snap };
    this.friends.push(friend);
    this.stats.imports += 1;
    while (this.friends.length > FRIENDS_LIMITS.imported) {
      const victim = this.friends.find((f) => f.localId !== this.visit?.friendId) ?? this.friends[0];
      this.friends = this.friends.filter((f) => f !== victim);
    }
    this._changed('friends');
    return { ok: true, friend, existing: false };
  }

  remove(localId) {
    const before = this.friends.length;
    this.friends = this.friends.filter((f) => f.localId !== localId);
    if (this.visit?.friendId === localId) this.visit = null;
    if (this.friends.length !== before) this._changed('friends');
    return this.friends.length !== before;
  }

  /** { id, origin: 'builtin' | 'import', snapshot, importedAt } for a built-in id or a local id. */
  get(id) {
    const b = BUILTIN_VISITORS.find((s) => s.id === id) ?? (typeof id === 'string' && !id.startsWith('friend-') ? builtinVisitor(id) : null);
    if (b) return { id: b.id, origin: 'builtin', snapshot: b, importedAt: null };
    const f = this.friends.find((x) => x.localId === id);
    return f ? { id: f.localId, origin: 'import', snapshot: f.snapshot, importedAt: f.importedAt } : null;
  }

  /** The three built-in friends, then imported ones (newest first). */
  all() {
    return [
      ...BUILTIN_VISITORS.map((s) => ({ id: s.id, origin: 'builtin', snapshot: s, importedAt: null })),
      ...[...this.friends].reverse().map((f) => ({ id: f.localId, origin: 'import', snapshot: f.snapshot, importedAt: f.importedAt })),
    ];
  }

  setVisit(friendId) {
    this.visit = friendId ? { friendId, since: this.clock() } : null;
    this._changed('visit');
  }

  count(stat) {
    if (stat in this.stats) {
      this.stats[stat] += 1;
      this._changed('stats');
    }
  }

  toJSON(now = this.clock()) {
    return { schema: FRIENDS_SCHEMA, version: FRIENDS_VERSION, savedAt: now, friends: this.friends, visit: this.visit, stats: { ...this.stats } };
  }
}

export function loadFriends(storage, { clock } = {}) {
  const res = loadVersioned({
    storage, key: FRIENDS_KEY, backupKey: FRIENDS_BACKUP_KEY, futureKey: FRIENDS_FUTURE_KEY,
    schema: FRIENDS_SCHEMA, version: FRIENDS_VERSION, sanitize: sanitizeFriendsRecord,
  });
  return { friends: new FriendsStore(res.record ?? {}, { clock }), status: res.status };
}

export function saveFriends(store, storage = globalThis.localStorage, now = Date.now()) {
  let json;
  try {
    json = JSON.stringify(store.toJSON(now));
  } catch (err) {
    return { ok: false, reason: `serialize-failed: ${err?.message ?? err}` };
  }
  return saveVersioned({ storage, key: FRIENDS_KEY, backupKey: FRIENDS_BACKUP_KEY, json, schema: FRIENDS_SCHEMA, version: FRIENDS_VERSION });
}

export function clearFriends(storage = globalThis.localStorage) {
  return removeKeys(storage, [FRIENDS_KEY, FRIENDS_BACKUP_KEY]);
}

export { socialLabel };
