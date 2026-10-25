/**
 * teaching-memory.js: the pet's teaching memory (replay buffer).
 *
 * MEMORY, NOT LEARNING. This stores what the player demonstrated and how
 * they reacted; storing or retrieving an example never changes a model
 * parameter. It is the bounded, versioned data source a future on-device
 * trainer will read. Three kinds of record are kept deliberately apart:
 *
 *  - lessons: demonstrations (the player's phrase or drawing in the full
 *    note-event / stroke representation), with their originating session and
 *    the ids of the pet's attempts. These are the supervised examples.
 *  - signals: feedback on creations. `love` is a preference reward (+1.0 on a
 *    creation), NOT a correct next-note or next-stroke label; `nudge` is a
 *    style direction; `variation` and `perform` are requests. Each signal
 *    carries an explicit `label` so a trainer cannot mistake one for another.
 *  - prefs: the style guidance accumulated from nudges (energy, order).
 *
 * Retention: at most 12 lessons per kind (oldest dropped first), 200 signals
 * and ~600 KB serialised. Pure ES module; persistence via persist.js.
 */
import { sanitizePhrase, sanitizeDrawing, phraseIsEmpty, drawingIsEmpty } from './teaching-core.js';
import { sanitizeStyle, applyNudge, NUDGE_IDS } from './creative-engine.js';
import { loadVersioned, saveVersioned, removeKeys } from './persist.js';

export const TEACH_SCHEMA = 'petstudio.teach';
export const TEACH_VERSION = 1;
export const TEACH_KEY = 'petstudio.teach.v1';
export const TEACH_BACKUP_KEY = 'petstudio.teach.v1.bak';
export const TEACH_FUTURE_KEY = 'petstudio.teach.future';
export const TEACH_ORPHAN_KEY = 'petstudio.teach.orphan';
export const MEMORY_LIMITS = Object.freeze({ lessonsPerKind: 12, attemptsPerLesson: 12, signals: 200, maxBytes: 600_000 });
export const LESSON_KINDS = Object.freeze(['music', 'drawing']);
/** Signal kind -> semantic label (what a trainer may and may not infer from it). */
export const SIGNAL_LABELS = Object.freeze({ love: 'preference', nudge: 'direction', variation: 'request', perform: 'request' });
export const PLAN_MODES = Object.freeze(['attempt', 'variation', 'replay']);
const PLAN_ORIGINS = Object.freeze(['attempt', 'starter', 'taught']);

const ID_RE = /^[a-z0-9-]{3,64}$/i;
const REF_RE = /^[a-z0-9:_-]{1,64}$/i;
const TEMPLATE_RE = /^[a-z0-9-]{1,32}$/;
const GENERATOR_RE = /^[a-z0-9-]{1,40}$/;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const isId = (v) => typeof v === 'string' && ID_RE.test(v);

export function sanitizeText(text, max) {
  if (typeof text !== 'string') return '';
  const cleaned = text.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(cleaned).slice(0, max).join('').trim();
}

const sanitizeData = (kind, data) => (kind === 'music' ? sanitizePhrase(data) : sanitizeDrawing(data));
const isEmptyData = (kind, data) => (kind === 'music' ? phraseIsEmpty(data) : drawingIsEmpty(data));

function sanitizeLesson(l) {
  if (!l || typeof l !== 'object' || !LESSON_KINDS.includes(l.kind) || !isId(l.id)) return null;
  const demo = sanitizeData(l.kind, l.demo);
  if (isEmptyData(l.kind, demo)) return null;
  const c = l.context && typeof l.context === 'object' ? l.context : {};
  return {
    id: l.id,
    kind: l.kind,
    createdAt: Number.isFinite(l.createdAt) ? l.createdAt : 0,
    session: isId(l.session) ? l.session : null,
    templateId: typeof l.templateId === 'string' && TEMPLATE_RE.test(l.templateId) ? l.templateId : null,
    title: sanitizeText(l.title, 48) || null,
    demo,
    context: { style: sanitizeStyle(c.style), petName: sanitizeText(c.petName, 16) || null },
    attempts: Array.isArray(l.attempts) ? l.attempts.filter(isId).slice(-MEMORY_LIMITS.attemptsPerLesson) : [],
  };
}

function sanitizeSignal(s) {
  if (!s || typeof s !== 'object' || !isId(s.id) || !(s.kind in SIGNAL_LABELS)) return null;
  return {
    id: s.id,
    at: Number.isFinite(s.at) ? s.at : 0,
    kind: s.kind,
    label: SIGNAL_LABELS[s.kind],
    itemId: isId(s.itemId) ? s.itemId : null,
    lessonId: isId(s.lessonId) ? s.lessonId : null,
    nudge: NUDGE_IDS.includes(s.nudge) ? s.nudge : null,
    reward: Number.isFinite(s.reward) ? clamp(s.reward, -1, 1) : null,
    session: isId(s.session) ? s.session : null,
  };
}

/** A creation the pet is about to perform (kept so a reload mid-performance can resume it). */
export function sanitizePlan(p) {
  if (!p || typeof p !== 'object' || typeof p.ref !== 'string' || !REF_RE.test(p.ref) || !LESSON_KINDS.includes(p.kind)) return null;
  const data = sanitizeData(p.kind, p.data);
  if (isEmptyData(p.kind, data)) return null;
  return {
    ref: p.ref,
    kind: p.kind,
    mode: PLAN_MODES.includes(p.mode) ? p.mode : 'attempt',
    origin: PLAN_ORIGINS.includes(p.origin) ? p.origin : 'attempt',
    title: sanitizeText(p.title, 48) || null,
    lessonId: isId(p.lessonId) ? p.lessonId : null,
    parentId: isId(p.parentId) ? p.parentId : null,
    itemId: isId(p.itemId) ? p.itemId : null,
    seed: Number.isInteger(p.seed) ? p.seed >>> 0 : null,
    style: p.style ? sanitizeStyle(p.style) : null,
    tags: Array.isArray(p.tags) ? [...new Set(p.tags.filter((t) => NUDGE_IDS.includes(t)))] : [],
    saveOnComplete: p.saveOnComplete !== false,
    generator: typeof p.generator === 'string' && GENERATOR_RE.test(p.generator) ? p.generator : null,
    createdAt: Number.isFinite(p.createdAt) ? p.createdAt : null,
    data,
  };
}

export function sanitizeMemoryRecord(r) {
  const src = r && typeof r === 'object' ? r : {};
  const counts = {};
  for (const id of NUDGE_IDS) counts[id] = Number.isInteger(src.nudgeCounts?.[id]) && src.nudgeCounts[id] >= 0 ? Math.min(src.nudgeCounts[id], 1e6) : 0;
  const seen = new Set();
  const lessons = (Array.isArray(src.lessons) ? src.lessons : [])
    .slice(-MEMORY_LIMITS.lessonsPerKind * 4)
    .map(sanitizeLesson)
    .filter((l) => l && !seen.has(l.id) && seen.add(l.id));
  return {
    petId: typeof src.petId === 'string' && /^[a-z0-9-]{4,48}$/i.test(src.petId) ? src.petId : null,
    createdAt: Number.isFinite(src.createdAt) ? src.createdAt : null,
    seq: Number.isInteger(src.seq) && src.seq >= 0 ? Math.min(src.seq, 1e9) : 0,
    lessons,
    signals: (Array.isArray(src.signals) ? src.signals : []).slice(-MEMORY_LIMITS.signals).map(sanitizeSignal).filter(Boolean),
    prefs: sanitizeStyle(src.prefs),
    nudgeCounts: counts,
    pendingPlan: sanitizePlan(src.pendingPlan),
  };
}

export class TeachingMemory {
  /**
   * @param {object} record persisted or partial record (sanitised here)
   * @param {{clock?: () => number, petId?: string, sessionId?: string}} [opts]
   */
  constructor(record = {}, { clock = () => Date.now(), petId = null, sessionId = null } = {}) {
    this._clock = clock;
    const r = sanitizeMemoryRecord(record);
    const now = clock();
    this.petId = r.petId ?? (typeof petId === 'string' ? petId : null);
    this.createdAt = r.createdAt ?? now;
    this.seq = r.seq;
    this.lessons = r.lessons;
    this.signals = r.signals;
    this.prefs = r.prefs;
    this.nudgeCounts = r.nudgeCounts;
    this.pendingPlan = r.pendingPlan;
    this.sessionId = isId(sessionId) ? sessionId : `session-${Math.floor(now).toString(36)}`;
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
        if (typeof console !== 'undefined') console.error('[teaching-memory] listener error', err);
      }
    }
  }

  _id(prefix) {
    this.seq += 1;
    return `${prefix}-${Math.floor(this._clock()).toString(36)}-${this.seq.toString(36)}`;
  }

  /** Stores a demonstration. Returns the lesson, or null when the demo is empty. */
  addLesson(kind, demo, { templateId = null, title = null, petName = null } = {}) {
    if (!LESSON_KINDS.includes(kind)) return null;
    const lesson = sanitizeLesson({
      id: this._id('lesson'),
      kind,
      createdAt: this._clock(),
      session: this.sessionId,
      templateId,
      title,
      demo,
      context: { style: this.prefs, petName },
      attempts: [],
    });
    if (!lesson) return null;
    this.lessons.push(lesson);
    this._retain();
    this._changed('lesson');
    return lesson;
  }

  getLesson(id) {
    return this.lessons.find((l) => l.id === id) ?? null;
  }

  /** Lessons of one kind, newest first. */
  lessonsOf(kind) {
    return this.lessons.filter((l) => l.kind === kind).reverse();
  }

  linkAttempt(lessonId, itemId) {
    const lesson = this.getLesson(lessonId);
    if (!lesson || !isId(itemId) || lesson.attempts.includes(itemId)) return false;
    lesson.attempts.push(itemId);
    if (lesson.attempts.length > MEMORY_LIMITS.attemptsPerLesson) lesson.attempts.shift();
    this._changed('lesson');
    return true;
  }

  /** Records feedback with its explicit semantic label. */
  recordSignal({ kind, itemId = null, lessonId = null, nudge = null, reward = null } = {}) {
    const signal = sanitizeSignal({ id: this._id('signal'), at: this._clock(), kind, itemId, lessonId, nudge, reward, session: this.sessionId });
    if (!signal) return null;
    this.signals.push(signal);
    if (this.signals.length > MEMORY_LIMITS.signals) this.signals.splice(0, this.signals.length - MEMORY_LIMITS.signals);
    this._changed('signal');
    return signal;
  }

  /** Applies a style nudge to the accumulated guidance. Returns the new prefs. */
  applyNudge(id) {
    if (!NUDGE_IDS.includes(id)) return { ...this.prefs };
    this.prefs = applyNudge(this.prefs, id);
    this.nudgeCounts[id] += 1;
    this._changed('prefs');
    return { ...this.prefs };
  }

  setPendingPlan(plan) {
    this.pendingPlan = sanitizePlan({ createdAt: this._clock(), ...plan });
    this._changed('plan');
    return this.pendingPlan;
  }

  clearPendingPlan(ref = null) {
    if (!this.pendingPlan || (ref && this.pendingPlan.ref !== ref)) return false;
    this.pendingPlan = null;
    this._changed('plan');
    return true;
  }

  _retain() {
    for (const kind of LESSON_KINDS) {
      const ofKind = this.lessons.filter((l) => l.kind === kind);
      const extra = ofKind.length - MEMORY_LIMITS.lessonsPerKind;
      if (extra > 0) {
        const drop = new Set(ofKind.slice(0, extra).map((l) => l.id));
        this.lessons = this.lessons.filter((l) => !drop.has(l.id));
      }
    }
    while (this.lessons.length > 1 && JSON.stringify(this.toJSON()).length > MEMORY_LIMITS.maxBytes) this.lessons.shift();
  }

  toJSON(now = this._clock()) {
    return {
      schema: TEACH_SCHEMA,
      version: TEACH_VERSION,
      petId: this.petId,
      createdAt: this.createdAt,
      savedAt: now,
      seq: this.seq,
      prefs: { ...this.prefs },
      nudgeCounts: { ...this.nudgeCounts },
      lessons: this.lessons,
      signals: this.signals,
      pendingPlan: this.pendingPlan,
    };
  }

  /** Diagnostics view (inspection API): what is remembered, never claimed as learned. */
  snapshot() {
    const summary = (l) => ({
      id: l.id, kind: l.kind, createdAt: l.createdAt, session: l.session, templateId: l.templateId, title: l.title,
      events: l.kind === 'music' ? l.demo.notes.length + l.demo.hits.length : l.demo.strokes.length,
      attempts: [...l.attempts],
    });
    return {
      kind: 'teaching-memory (replay buffer); storing examples does not change any model parameter',
      petId: this.petId,
      sessionId: this.sessionId,
      lessons: { music: this.lessons.filter((l) => l.kind === 'music').length, drawing: this.lessons.filter((l) => l.kind === 'drawing').length, list: this.lessons.map(summary) },
      signals: { total: this.signals.length, recent: this.signals.slice(-10).map((s) => ({ ...s })) },
      prefs: { ...this.prefs },
      nudgeCounts: { ...this.nudgeCounts },
      pendingPlan: this.pendingPlan ? { ref: this.pendingPlan.ref, kind: this.pendingPlan.kind, mode: this.pendingPlan.mode } : null,
      limits: MEMORY_LIMITS,
      bytes: JSON.stringify(this.toJSON()).length,
    };
  }
}

/**
 * Loads the teaching memory for `petId`. Never throws. status: 'loaded' |
 * 'restored-backup' | 'new' | 'future-version' | 'unavailable' | 'other-pet'
 * (memory of a different pet is moved aside and a fresh one starts).
 */
export function loadTeachingMemory(storage, { petId = null, clock, sessionId } = {}) {
  const res = loadVersioned({
    storage, key: TEACH_KEY, backupKey: TEACH_BACKUP_KEY, futureKey: TEACH_FUTURE_KEY,
    schema: TEACH_SCHEMA, version: TEACH_VERSION, sanitize: sanitizeMemoryRecord,
  });
  let { record, status } = res;
  if (record && petId && record.petId && record.petId !== petId) {
    try {
      storage.setItem(TEACH_ORPHAN_KEY, JSON.stringify({ schema: TEACH_SCHEMA, version: TEACH_VERSION, ...record }));
    } catch {
      /* best effort */
    }
    record = null;
    status = 'other-pet';
  }
  return { memory: new TeachingMemory(record ?? {}, { clock, petId, sessionId }), status };
}

export function saveTeachingMemory(memory, storage = globalThis.localStorage, now = Date.now()) {
  let json;
  try {
    json = JSON.stringify(memory.toJSON(now));
  } catch (err) {
    return { ok: false, reason: `serialize-failed: ${err?.message ?? err}` };
  }
  return saveVersioned({ storage, key: TEACH_KEY, backupKey: TEACH_BACKUP_KEY, json, schema: TEACH_SCHEMA, version: TEACH_VERSION });
}

export function clearTeachingMemory(storage = globalThis.localStorage) {
  return removeKeys(storage, [TEACH_KEY, TEACH_BACKUP_KEY]);
}
