/**
 * creation-flow.js: the teaching loop, tying together the pet simulation
 * (pet-state.js), the teaching memory, the creative engine and the gallery.
 *
 *   teach(kind, demo)  -> the lesson is stored in teaching memory and the
 *                         gallery ("Taught by You"); the engine composes the
 *                         pet's attempt; the pet listens, walks to its station
 *                         and performs it; on completion the attempt is saved
 *                         ("Pet Attempt") and linked to its lesson.
 *   perform(itemId)    -> the pet replays a gallery item at its station.
 *   love / variation / nudge(id) -> structured feedback on the current
 *                         creation (the "subject" shown in the feedback bar).
 *
 * The pet's own starter songs and drawings become subjects too, so they can
 * be loved, varied or saved. Pure ES module (no DOM, no Three.js). Nothing
 * here learns: feedback is recorded as labelled signals, and style nudges
 * steer the authored engine.
 */
import { generateStarterDrawing, generateStarterPhrase, STARTER_DRAWING_GENERATOR, STARTER_PHRASE_GENERATOR } from './starter-repertoire.js';
import {
  sanitizePhrase, sanitizeDrawing, phraseIsEmpty, drawingIsEmpty, phraseSeconds, drawingLength,
  MUSIC_TEMPLATES, DRAWING_TEMPLATES,
} from './teaching-core.js';
import { AuthoredCreativeEngine, NUDGES, styleTags, sanitizeStyle } from './creative-engine.js';
import { hashSeed } from './rng.js';

export const FLOW = Object.freeze({
  barHoldSeconds: 30, // the feedback bar lingers this long after a creation finishes
  styleJitter: 0.12, // "Try Variation" nudges the style by up to this much at random
});

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const CREATIVE = Object.freeze({ playing_music: 'music', drawing: 'drawing' });
const ACTIVE_PHASES = Object.freeze(['lesson', 'walking', 'performing']);

/** How long the pet performs a piece (seconds): two loops of a two-bar phrase, or by stroke length. */
export function performSecondsFor(kind, data) {
  if (kind === 'music') {
    const spb = 60 / data.tempo;
    const loops = data.beats <= 8 ? 2 : 1;
    return clamp(0.6 + loops * (data.beats + 1) * spb, 5, 45);
  }
  return clamp(6 + drawingLength(data) * 2.2, 8, 24);
}

/** How long the pet attends the lesson: the phrase once, or a short look at the drawing. */
export function listenSecondsFor(kind, data) {
  if (kind === 'music') return clamp(phraseSeconds(data) + 0.8, 3, 14);
  return clamp(2.5 + drawingLength(data) * 0.8, 3.5, 9);
}

export function templateName(kind, id) {
  const list = kind === 'music' ? MUSIC_TEMPLATES : DRAWING_TEMPLATES;
  return list.find((t) => t.id === id)?.name ?? null;
}

const thing = (kind) => (kind === 'music' ? 'your tune' : 'your drawing');
export const taughtTitle = (kind, tName) => (tName ? `Your ${tName}` : kind === 'music' ? 'Your tune' : 'Your drawing');
export const attemptTitle = (pet, kind, tName) => `${pet}'s take on ${tName ?? thing(kind)}`;

export class CreationFlow {
  /**
   * @param {{pet: import('./pet-state.js').PetState, memory: import('./teaching-memory.js').TeachingMemory,
   *          gallery: import('./gallery-store.js').GalleryStore, engine?: AuthoredCreativeEngine, clock?: () => number}} deps
   */
  constructor({ pet, memory, gallery, engine = new AuthoredCreativeEngine(), clock = () => Date.now() }) {
    this.pet = pet;
    this.memory = memory;
    this.gallery = gallery;
    this.engine = engine;
    this.clock = clock;
    this.subject = null;
    this.listeners = new Set();
    this.refSeq = 0;
    this.unsubscribe = pet.on((e) => this._onPet(e));
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(type, payload = {}) {
    const evt = { type, ...payload };
    for (const fn of this.listeners) {
      try {
        fn(evt);
      } catch (err) {
        if (typeof console !== 'undefined') console.error('[creation-flow] listener error', err);
      }
    }
    return evt;
  }

  _ref(prefix) {
    this.refSeq += 1;
    return `${prefix}-${Math.floor(this.clock()).toString(36)}-${this.refSeq.toString(36)}`;
  }

  /** Attempt seeds come from the pet's seeded PRNG, so a given pet stays reproducible. */
  _seed() {
    return Math.floor(this.pet.rng() * 4294967296) >>> 0;
  }

  _setSubject(subject) {
    this.subject = subject;
    this._emit('subject', { subject });
  }

  _sanitize(kind, data) {
    return kind === 'music' ? sanitizePhrase(data) : sanitizeDrawing(data);
  }

  _isEmpty(kind, data) {
    return kind === 'music' ? phraseIsEmpty(data) : drawingIsEmpty(data);
  }

  // ----- teaching --------------------------------------------------------------
  /**
   * Teaches a demonstration. Nothing is stored unless the pet can take the
   * lesson (awake, not exhausted).
   */
  teach(kind, demo, { templateId = null, title = null } = {}) {
    if (kind !== 'music' && kind !== 'drawing') return { ok: false, reason: 'bad-kind', message: 'Unknown lesson type.' };
    const data = this._sanitize(kind, demo);
    if (this._isEmpty(kind, data)) {
      return { ok: false, reason: 'empty', message: kind === 'music' ? 'Play a few notes first.' : 'Draw something first.' };
    }
    const pet = this.pet;
    const tName = templateName(kind, templateId);
    const seed = this._seed();
    const style = sanitizeStyle(this.memory.prefs);
    const attempt = this.engine.compose(kind, data, { seed, style, traits: pet.traits, colors: pet.appearance });
    const plan = {
      ref: this._ref('a'), kind, mode: 'attempt', origin: 'attempt', title: attemptTitle(pet.name, kind, tName),
      lessonId: null, parentId: null, itemId: null, seed, style: attempt.style ?? style, tags: styleTags(style),
      saveOnComplete: true, generator: attempt.generator ?? null, data: this._sanitize(kind, attempt),
    };
    const prev = this.subject;
    this._setSubject({ ...plan, phase: 'lesson', lessonData: data, sourceTitle: tName ?? thing(kind), loved: false, dismissed: false });
    const res = pet.teachLesson({ kind, ref: plan.ref, listenSeconds: listenSecondsFor(kind, data), performSeconds: performSecondsFor(kind, plan.data) });
    if (!res.ok) {
      this._setSubject(prev);
      return { ok: false, reason: res.reason, message: res.message };
    }
    const lesson = this.memory.addLesson(kind, data, { templateId, title: tName, petName: pet.name });
    const taught = this.gallery.add({
      kind, origin: 'taught', title: title ?? taughtTitle(kind, tName), data, lessonId: lesson?.id ?? null,
      petId: pet.id, petName: pet.name, generator: 'player-demo', templateId,
    });
    plan.lessonId = lesson?.id ?? null;
    plan.parentId = taught?.id ?? null;
    Object.assign(this.subject, { lessonId: plan.lessonId, parentId: plan.parentId });
    this.memory.setPendingPlan(plan);
    this._emit('lesson', { lesson, taught, plan });
    return { ok: true, lesson, taught, plan };
  }

  /** Sends the pet to perform a saved creation (no new gallery item is made). */
  perform(itemId) {
    const item = this.gallery.get(itemId);
    if (!item) return { ok: false, reason: 'missing', message: 'That creation is no longer in the gallery.' };
    const res = this._start({
      ref: this._ref('p'), kind: item.kind, mode: 'replay', origin: item.origin, title: item.title,
      lessonId: item.lessonId, parentId: item.parentId, itemId: item.id, seed: item.seed, style: item.style,
      tags: [...item.tags], saveOnComplete: false, generator: item.generator, data: item.data,
    }, { loved: item.favorite });
    if (res.ok) this.memory.recordSignal({ kind: 'perform', itemId: item.id, lessonId: item.lessonId });
    return res;
  }

  _start(plan, extra = {}, message = null) {
    const prev = this.subject;
    this._setSubject({ ...plan, phase: 'walking', loved: false, dismissed: false, ...extra });
    const res = this.pet.performCreation({ kind: plan.kind, ref: plan.ref, duration: performSecondsFor(plan.kind, plan.data), mode: plan.mode, message });
    if (!res.ok) {
      this._setSubject(prev);
      return { ok: false, reason: res.reason, message: res.message };
    }
    this.memory.setPendingPlan(plan);
    return { ok: true, plan };
  }

  // ----- feedback on the current creation -----------------------------------
  _ensureSaved(s, { favorite = false } = {}) {
    let item = s.itemId ? this.gallery.get(s.itemId) : null;
    if (!item) {
      item = this.gallery.add({
        kind: s.kind, origin: s.origin, title: s.title, data: s.data, lessonId: s.lessonId, parentId: s.parentId,
        petId: this.pet.id, petName: this.pet.name, seed: s.seed, generator: s.generator, style: s.style,
        tags: s.tags, favorite: favorite || !!s.loved,
      });
      s.itemId = item?.id ?? null;
      if (item && s.lessonId && item.origin === 'attempt') this.memory.linkAttempt(s.lessonId, item.id);
    }
    return item;
  }

  /** "Love It": favourite + save, +1.0 preference reward, and a bond/mood boost. */
  love() {
    const s = this.subject;
    if (!s || !['performing', 'done'].includes(s.phase)) return { ok: false, reason: 'nothing', message: 'Wait for your pet to start creating.' };
    const item = this._ensureSaved(s, { favorite: true });
    if (!item) return { ok: false, reason: 'save-failed', message: 'That creation could not be saved.' };
    this.gallery.setFavorite(item.id, true);
    this.gallery.recordFeedback(item.id, { reward: 1, love: true });
    const signal = this.memory.recordSignal({ kind: 'love', itemId: item.id, lessonId: s.lessonId ?? item.lessonId, reward: 1 });
    s.loved = true;
    const reaction = this.pet.receiveLove();
    this._emit('love', { subject: s, item, signal });
    this._emit('subject', { subject: s });
    return { ok: true, item, signal, reaction };
  }

  /** "Try Variation": another attempt with a new seed and a slightly tweaked style. */
  variation() {
    return this._retry({ signalKind: 'variation' });
  }

  /** Directional nudge: stores the preference signal and asks for a guided retry. */
  nudge(id) {
    if (!NUDGES[id]) return { ok: false, reason: 'unknown-nudge', message: 'Unknown style.' };
    const s = this.subject;
    if (!s || !['performing', 'done'].includes(s.phase)) return { ok: false, reason: 'nothing', message: 'Wait for your pet to start creating.' };
    const prefs = this.memory.applyNudge(id);
    if (s.itemId) this.gallery.recordFeedback(s.itemId, { nudge: id });
    const signal = this.memory.recordSignal({ kind: 'nudge', nudge: id, itemId: s.itemId ?? null, lessonId: s.lessonId ?? null });
    const retry = this._retry({ tag: id });
    return { ...retry, prefs, signal };
  }

  _retry({ tag = null, signalKind = null } = {}) {
    const s = this.subject;
    if (!s || !['performing', 'done'].includes(s.phase)) return { ok: false, reason: 'nothing', message: 'Wait for your pet to start creating.' };
    const lesson = s.lessonId ? this.memory.getLesson(s.lessonId) : null;
    const source = lesson?.demo ?? s.lessonData ?? s.data; // riff on the original lesson, not on a riff
    const seed = this._seed();
    const prefs = sanitizeStyle(this.memory.prefs);
    const j = (k) => (((hashSeed(`${seed}:${k}`) % 1000) / 1000) * 2 - 1) * FLOW.styleJitter;
    const style = tag ? prefs : sanitizeStyle({ energy: prefs.energy + j('e'), order: prefs.order + j('o') });
    const attempt = this.engine.compose(s.kind, source, { seed, style, traits: this.pet.traits, colors: this.pet.appearance });
    if (signalKind) this.memory.recordSignal({ kind: signalKind, itemId: s.itemId ?? null, lessonId: s.lessonId ?? null });
    const own = `${this.pet.name}'s `;
    const starterBase = s.title?.startsWith(own) ? `its ${s.title.slice(own.length)}` : s.title;
    const base = s.sourceTitle ?? (lesson?.title ?? (s.origin === 'starter' ? starterBase : thing(s.kind)));
    const title = tag
      ? `${this.pet.name}'s ${NUDGES[tag].label.toLowerCase()} take on ${base}`
      : `${this.pet.name}'s new take on ${base}`;
    const message = tag ? `${this.pet.name} tries a ${NUDGES[tag].label.toLowerCase()} take!` : `${this.pet.name} tries another idea!`;
    return this._start({
      ref: this._ref('v'), kind: s.kind, mode: 'variation', origin: 'attempt', title,
      lessonId: s.lessonId ?? null, parentId: s.parentId ?? s.itemId ?? null, itemId: null, seed,
      style: attempt.style ?? style, tags: tag ? [tag, ...styleTags(prefs).filter((t) => t !== tag)] : styleTags(style),
      saveOnComplete: true, generator: attempt.generator ?? null, data: this._sanitize(s.kind, attempt),
    }, { lessonData: lesson?.demo ?? s.lessonData ?? null, sourceTitle: base }, message);
  }

  dismiss() {
    if (!this.subject) return false;
    this.subject.dismissed = true;
    this._emit('subject', { subject: this.subject });
    return true;
  }

  // ----- what to render -----------------------------------------------------------
  starterPhrase(seed) {
    return generateStarterPhrase({ seed, traits: this.pet.traits });
  }

  /** Starter drawing for the pet's current drawing record (style frozen at start). */
  starterDrawing(rec) {
    if (!rec) return null;
    if (!rec.style) {
      const { bodyColor, accentColor, cheekColor } = this.pet.appearance;
      rec.style = { generator: STARTER_DRAWING_GENERATOR, traits: { ...this.pet.traits }, colors: { bodyColor, accentColor, cheekColor } };
    }
    return generateStarterDrawing({ seed: rec.seed, traits: rec.style.traits, colors: rec.style.colors });
  }

  _dataForRef(ref, kind) {
    if (this.subject?.ref === ref && this.subject.kind === kind) return this.subject.data;
    const plan = this.memory.pendingPlan;
    if (plan && plan.ref === ref && plan.kind === kind) {
      // Resuming after a reload: adopt the saved plan as the subject.
      const a = this.pet.activity;
      const phase = a.plan?.ref === ref ? (a.type === 'walking' ? 'walking' : 'performing') : 'performing';
      this._setSubject({ ...plan, phase, loved: false, dismissed: false });
      return plan.data;
    }
    return null;
  }

  /** The phrase for a playing_music activity (planned piece or starter tune). */
  phraseFor(activity) {
    const ref = activity?.plan?.ref;
    return (ref && this._dataForRef(ref, 'music')) || this.starterPhrase(activity?.seed ?? 1);
  }

  /** The drawing for the pet's drawing record (planned piece or starter drawing). */
  drawingFor(rec) {
    return (rec?.ref && this._dataForRef(rec.ref, 'drawing')) || this.starterDrawing(rec);
  }

  /** The demonstration the pet is attending to during a lesson. */
  lessonData() {
    const s = this.subject;
    return s && s.phase === 'lesson' ? { kind: s.kind, data: s.lessonData } : null;
  }

  // ----- simulation events ----------------------------------------------------------
  _onPet(e) {
    const s = this.subject;
    if (e.type === 'activity') {
      const ref = e.plan?.ref ?? null;
      if (s && ref && ref === s.ref) {
        if (e.to === 'lesson' || e.to === 'walking') s.phase = e.to;
        else if (CREATIVE[e.to]) s.phase = 'performing';
        this._emit('subject', { subject: s });
        return;
      }
      if (CREATIVE[e.to] && !ref) {
        this._startStarter(e);
        return;
      }
      if (CREATIVE[e.to] && ref) {
        this._dataForRef(ref, CREATIVE[e.to]);
        return;
      }
      if (e.to === 'idle' && s && s.phase === 'done' && !s.lingered) {
        // Give the player a moment to react before the pet wanders off.
        s.lingered = true;
        this.pet.lingerIdle(s.mode === 'starter' ? 5 : 12);
        return;
      }
      // Any other change while a lesson or performance is under way means the
      // pet was redirected (fed, put to bed, sent elsewhere) before finishing.
      if (s && ACTIVE_PHASES.includes(s.phase)) this._interrupt(s);
      return;
    }
    if (e.type === 'activity:end' && s) {
      const ref = e.plan?.ref ?? null;
      const matches = ref ? ref === s.ref : s.origin === 'starter' && s.mode === 'starter' && s.seed === e.seed && CREATIVE[e.activity] === s.kind;
      if (!matches) return;
      if (e.activity === 'lesson') {
        if (!e.completed) this._interrupt(s);
        return;
      }
      if (e.completed) this._complete(s);
      else this._interrupt(s);
    }
  }

  _startStarter(e) {
    const kind = CREATIVE[e.to];
    const data = kind === 'music' ? this.starterPhrase(e.seed) : this.starterDrawing(this.pet.currentDrawing);
    if (!data) return;
    const count = (kind === 'music' ? this.pet.counters.songs : this.pet.counters.drawings) + 1;
    this._setSubject({
      ref: `starter-${kind}-${e.seed}`, kind, mode: 'starter', origin: 'starter',
      title: `${this.pet.name}'s ${kind === 'music' ? 'little tune' : 'doodle'} #${count}`,
      lessonId: null, parentId: null, itemId: null, seed: e.seed, style: null, tags: [],
      saveOnComplete: true, generator: kind === 'music' ? STARTER_PHRASE_GENERATOR : STARTER_DRAWING_GENERATOR,
      data: this._sanitize(kind, data), phase: 'performing', loved: false, dismissed: false,
    });
  }

  _complete(s) {
    s.phase = 'done';
    s.completedAt = this.pet.clock;
    const item = s.saveOnComplete || s.loved ? this._ensureSaved(s) : s.itemId ? this.gallery.get(s.itemId) : null;
    this.memory.clearPendingPlan(s.ref);
    this._emit('creation', { subject: s, item });
    this._emit('subject', { subject: s });
  }

  _interrupt(s) {
    s.phase = 'interrupted';
    this.memory.clearPendingPlan(s.ref);
    this._emit('subject', { subject: s });
  }

  /** State for the Creation Feedback Bar. */
  barState() {
    const s = this.subject;
    if (!s || s.dismissed || s.phase === 'interrupted') return { visible: false };
    if (s.phase === 'done' && this.pet.clock - (s.completedAt ?? 0) > FLOW.barHoldSeconds) return { visible: false };
    const a = this.pet.activity;
    const ofSubject = a.plan?.ref === s.ref || (s.mode === 'starter' && CREATIVE[a.type] === s.kind && a.seed === s.seed);
    let progress = s.phase === 'done' ? 1 : 0;
    if ((s.phase === 'lesson' || s.phase === 'performing') && ofSubject && a.duration > 0) progress = clamp(a.elapsed / a.duration, 0, 1);
    return {
      visible: true,
      phase: s.phase,
      kind: s.kind,
      origin: s.origin,
      mode: s.mode,
      title: s.title,
      itemId: s.itemId ?? null,
      ref: s.ref,
      loved: !!s.loved,
      tags: [...(s.tags ?? [])],
      canFeedback: s.phase === 'performing' || s.phase === 'done',
      progress,
      elapsed: ofSubject ? a.elapsed : 0,
      duration: ofSubject ? a.duration : 0,
      data: s.phase === 'lesson' ? s.lessonData ?? s.data : s.data,
      petName: this.pet.name,
    };
  }
}
