/**
 * practice-runner.js: Sleep Practice scheduling (training scheduling).
 *
 * Runs a validation-gated PracticeSession (neural-engine.js) while the pet
 * naps in the Sleep Nook. Pure ES module (no DOM): the app calls tick(dt)
 * once per animation frame and the runner takes optimizer steps at the
 * configured pace (stepsPerSecond), never spending more than `frameBudgetMs`
 * (4 ms) of a frame, so the studio keeps animating smoothly.
 *
 * Truthful statuses: 'idle' (no session), 'no-data' (nothing taught yet),
 * 'waiting' (heading to bed), 'practicing', 'paused', 'complete',
 * 'rolled-back' (validation or NaN guard) and 'cancelled' (the player
 * restored the pre-sleep weights). Training happens only while the app is
 * open and the pet is asleep; nothing is trained while the app is closed.
 * Validated progress is checkpointed every `checkpointEvery` steps, so a
 * reload keeps it.
 */
import { PracticeSession, MODEL_KINDS, stepConfidence } from './neural-engine.js';
import { lessonCloseness } from './teaching-core.js';
import { hashSeed } from './rng.js';

export const PRACTICE = Object.freeze({
  frameBudgetMs: 4, // hard cap on training time per animation frame
  maxBurst: 3, // pending steps never pile up beyond this after a stall
  checkpointEvery: 60, // validated progress is saved this often (steps)
  dreamWindow: 24, // steps over which "what it is dreaming about" is decided
});
/** Before/after closeness is averaged over this many fixed seeds. */
export const COMPARE_SEEDS = 6;

const ACTIVE = Object.freeze(['practicing', 'paused']);

export class PracticeRunner {
  /**
   * @param {object} deps
   * @param {import('./neural-engine.js').NeuralEngine} deps.engine
   * @param {{compose: Function}} deps.creative the hybrid creative engine (for before/after attempts)
   * @param {import('./pet-state.js').PetState} deps.pet
   * @param {{lessons: object[], prefs: object}} deps.memory teaching memory
   * @param {() => number} [deps.now] monotonic milliseconds (frame budget)
   */
  constructor({ engine, creative, pet, memory, now = () => Date.now() }) {
    this.engine = engine;
    this.creative = creative;
    this.pet = pet;
    this.memory = memory;
    this.now = now;
    this.status = 'idle';
    this.reason = null;
    this.session = null;
    this.result = null;
    this.carry = 0;
    this.dreamScores = new Map();
    this.dream = null;
    this.sinceDream = 0;
    this.sinceCheckpoint = 0;
    this.sessionSamples = 0;
    /** While the Sleep Practice drawer shows the results, the pet keeps dozing (the app sets this). */
    this.holdAfterSession = false;
    this.listeners = new Set();
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
        if (typeof console !== 'undefined') console.error('[practice-runner] listener error', err);
      }
    }
  }

  _set(status, reason = null) {
    const changed = status !== this.status || reason !== this.reason;
    this.status = status;
    this.reason = reason;
    if (changed) this._emit('status', { status, reason });
  }

  get active() {
    return ACTIVE.includes(this.status) || this.status === 'waiting';
  }

  get running() {
    return this.status === 'practicing';
  }

  /** The player opened Sleep Practice: the pet heads to bed and practice starts once it sleeps. */
  begin({ autoStart = true } = {}) {
    if (this.status === 'practicing' || this.status === 'waiting') return { ok: true, status: this.status };
    if (!this.engine.hasData()) {
      this._set('no-data');
      return { ok: false, reason: 'no-data' };
    }
    const reaction = this.pet.startPracticeNap();
    this.autoStart = autoStart;
    if (this.pet.isAsleep) {
      if (this.status === 'paused' && this.session?.running) this._set('practicing');
      else if (autoStart) this._startSession();
      else this._set('paused', 'ready');
    } else {
      this._set('waiting');
    }
    return { ok: true, status: this.status, reaction };
  }

  _startSession() {
    this.session = new PracticeSession(this.engine);
    const r = this.session.begin();
    if (!r.ok) {
      this.session = null;
      this._set('no-data');
      return false;
    }
    this.result = null;
    this.carry = 0;
    this.sinceCheckpoint = 0;
    this.sessionSamples = 0;
    this.dreamScores.clear();
    this.sinceDream = PRACTICE.dreamWindow;
    this._set('practicing');
    this._emit('session-start', { preVal: r.val });
    return true;
  }

  /** Start / Resume: resumes a paused session or begins a new one (sending the pet to bed if needed). */
  start() {
    if (this.status === 'practicing') return { ok: true, status: this.status };
    if (!this.pet.isAsleep) return this.begin({ autoStart: true });
    this.pet.startPracticeNap();
    if (this.session?.running) this._set('practicing');
    else if (!this._startSession()) return { ok: false, reason: 'no-data' };
    return { ok: true, status: this.status };
  }

  pause(reason = 'player') {
    if (this.status === 'practicing' || this.status === 'waiting') this._set('paused', reason);
    return this.status === 'paused';
  }

  /** One optimizer step (Step +1). Starts a paused session first when needed. */
  stepOnce() {
    if (!this.session?.running) {
      if (!this.pet.isAsleep) return { ok: false, reason: 'awake' };
      this.pet.startPracticeNap();
      if (!this._startSession()) return { ok: false, reason: 'no-data' };
      this._set('paused', 'step');
    }
    return this._step();
  }

  _step() {
    const r = this.session.step();
    if (r.ok) {
      this.sinceCheckpoint += 1;
      this.sessionSamples += r.result.samples;
      this._trackDream(r.result.lessons);
      if (r.evaluated && this.sinceCheckpoint >= PRACTICE.checkpointEvery) this._checkpoint();
      this._emit('step', { step: this.session.steps, loss: r.result.loss });
    }
    if (r.done) this._finishSession();
    return r;
  }

  /** Saves validated progress mid-session (a reload resumes from here). */
  _checkpoint() {
    const s = this.session;
    const v = s.val?.total;
    if (v == null || s.preVal == null || v <= s.preVal * (1 + s.margin)) {
      this.engine.commit(v ?? null);
      this.engine.mark('partial', v ?? null);
      this.sinceCheckpoint = 0;
      this._emit('checkpoint', { val: v });
    }
  }

  _trackDream(counts) {
    for (const [id, score] of this.dreamScores) this.dreamScores.set(id, score * 0.9);
    for (const [id, c] of Object.entries(counts ?? {})) this.dreamScores.set(id, (this.dreamScores.get(id) ?? 0) + c);
    this.sinceDream += 1;
    if (this.sinceDream < PRACTICE.dreamWindow && this.dream) return;
    this.sinceDream = 0;
    let best = null;
    for (const [id, score] of this.dreamScores) if (!best || score > best.score) best = { id, score };
    const lesson = best ? this.memory.lessons.find((l) => l.id === best.id) : null;
    if (lesson && lesson.id !== this.dream?.lessonId) {
      this.dream = { lessonId: lesson.id, kind: lesson.kind, title: lesson.title ?? null };
      this._emit('dream', { dream: this.dream });
    }
  }

  /** Advances practice by dt seconds of wall time (call once per animation frame). */
  tick(dt) {
    if (this.status === 'waiting') {
      if (this.pet.isAsleep) {
        if (this.session?.running) this._set('practicing'); // resume the paused session
        else if (this.autoStart) this._startSession();
        else this._set('paused', 'ready');
      } else if (!this.pet.headingToBed) {
        this.pet.releaseSleepHold();
        this._set('idle', 'got-up');
      }
      return 0;
    }
    if (this.status === 'paused' && this.session?.running && !this.pet.isAsleep && this.reason !== 'woke') {
      this._set('paused', 'woke');
    }
    if (this.status !== 'practicing') return 0;
    if (!this.pet.isAsleep) {
      this._set('paused', 'woke');
      return 0;
    }
    const rate = this.engine.settings.stepsPerSecond;
    this.carry = Math.min(PRACTICE.maxBurst, this.carry + Math.max(0, dt) * rate);
    const t0 = this.now();
    let steps = 0;
    while (this.carry >= 1 && this.status === 'practicing' && this.now() - t0 < PRACTICE.frameBudgetMs) {
      this._step();
      this.carry -= 1;
      steps += 1;
    }
    return steps;
  }

  _finishSession() {
    const s = this.session;
    if (!s) return null;
    const d = s.finish();
    if (d.decision === 'rolled-back') this.engine.commit(d.preVal ?? null); // the latest checkpoint returns to the pre-sleep weights
    if (!this.holdAfterSession) this.pet.releaseSleepHold();
    this.result = { ...d, at: this.engine.clock(), comparison: d.decision === 'committed' ? this.compareBeforeAfter() : null };
    this._set(d.decision === 'committed' ? 'complete' : d.decision === 'rolled-back' ? 'rolled-back' : 'complete', d.reason);
    this._emit('session-end', { result: this.result });
    return this.result;
  }

  /** Cancel & Rollback: restores the pre-sleep weights and discards the session. */
  cancel() {
    if (!this.session || this.session.decision) {
      if (this.status === 'waiting') {
        this.pet.releaseSleepHold();
        this._set('idle', 'cancelled');
      }
      return { ok: false, reason: 'no-session' };
    }
    const d = this.session.cancel();
    this.engine.commit(d.preVal ?? null);
    if (!this.holdAfterSession) this.pet.releaseSleepHold();
    this.result = { ...d, at: this.engine.clock(), comparison: null };
    this._set('cancelled', 'player');
    this._emit('session-end', { result: this.result });
    return { ok: true, decision: d };
  }

  /** Wake & Finish: judges and commits the session, then wakes the pet. */
  finish({ wake = true } = {}) {
    let result = this.result;
    if (this.session && !this.session.decision) result = this._finishSession();
    else if (this.status === 'waiting') this._set('idle');
    this.pet.releaseSleepHold();
    let woke = null;
    if (wake && this.pet.isAsleep) woke = this.pet.wake();
    if (this.status === 'paused' || this.status === 'practicing') this._set('idle');
    return { ok: true, result, woke };
  }

  /** The lesson this practice is (or was) about: the dream lesson, else the newest lesson. */
  focusLesson() {
    const lessons = this.memory.lessons;
    const id = this.dream?.lessonId;
    return (id && lessons.find((l) => l.id === id)) || lessons[lessons.length - 1] || null;
  }

  /**
   * The pet's attempts at a lesson with the pre-sleep weights and with the
   * current weights: same seeds, style and temperament, so the only
   * difference is what practice changed. Closeness is averaged over
   * COMPARE_SEEDS seeds (separating learning from sampling luck); the first
   * seed's attempts are the ones shown and performed.
   */
  compareBeforeAfter(lesson = this.focusLesson()) {
    if (!lesson) return null;
    const e = this.engine;
    const pre = e.getCheckpoint('pre-sleep');
    if (!pre) return null;
    const seeds = Array.from({ length: COMPARE_SEEDS }, (_, k) => hashSeed(`compare:${lesson.id}:${k}`));
    const opts = (seed) => ({ seed, style: this.memory.prefs, traits: this.pet.traits, colors: this.pet.appearance, lessonId: lesson.id });
    const attempts = () => seeds.map((seed) => this.creative.compose(lesson.kind, lesson.demo, opts(seed)));
    const mean = (list) => list.reduce((a, x) => a + lessonCloseness(lesson.kind, lesson.demo, x), 0) / list.length;
    const live = e.snapshot();
    e.applyCheckpoint(pre);
    const before = attempts();
    e.restoreSnapshot(live);
    const after = attempts();
    const side = (list) => ({ data: list[0], generator: list[0].generator, alpha: list[0].alpha ?? 0, closeness: Math.round(mean(list) * 1000) / 1000, shown: lessonCloseness(lesson.kind, lesson.demo, list[0]) });
    return { lessonId: lesson.id, kind: lesson.kind, title: lesson.title ?? null, seed: seeds[0], seeds: seeds.length, before: side(before), after: side(after) };
  }

  /** Live numbers for the Sleep Practice view (and the inspection API). */
  state() {
    const e = this.engine;
    const s = this.session;
    const data = e.refreshData();
    const trainTotal = MODEL_KINDS.reduce((a, k) => a + data[k].train.length, 0);
    const perStep = MODEL_KINDS.reduce((a, k) => a + (data[k].train.length ? e.settings.batchSize : 0), 0);
    const epochs = trainTotal ? this.sessionSamples / trainTotal : 0;
    const batchesPerEpoch = perStep ? Math.max(1, Math.ceil(trainTotal / perStep)) : 0;
    const lesson = this.focusLesson();
    const kind = lesson?.kind ?? null;
    const pre = s?.preSnapshot ?? null;
    return {
      status: this.status,
      reason: this.reason,
      asleep: this.pet.isAsleep,
      sessionSteps: s?.steps ?? 0,
      maxSteps: s?.maxSteps ?? e.settings.sessionSteps,
      totalSteps: e.totalSteps,
      epoch: Math.floor(epochs) + 1,
      batch: batchesPerEpoch ? Math.min(batchesPerEpoch, Math.floor((epochs % 1) * batchesPerEpoch) + 1) : 0,
      batchesPerEpoch,
      trainLoss: s?.trainEma ?? null,
      valLoss: s?.val?.total ?? null,
      preVal: s?.preVal ?? null,
      valKinds: s?.val ? { music: s.val.music, drawing: s.val.drawing } : null,
      deltaNorm: pre ? e.distanceTo(pre) : 0,
      confidence: kind ? e.alphaFor(kind, lesson.id) : 0,
      stepConfidence: kind ? stepConfidence(e.stepsFor(kind)) : 0,
      dream: lesson ? { lessonId: lesson.id, kind: lesson.kind, title: lesson.title ?? null } : null,
      replaying: Object.keys(s?.lastBatch ?? {}).filter((id) => id !== lesson?.id),
      frozen: s?.frozen ? [...s.frozen] : [],
      result: this.result ? { decision: this.result.decision, reason: this.result.reason, preVal: this.result.preVal, finalVal: this.result.finalVal, steps: this.result.steps, kinds: this.result.kinds ?? null } : null,
      hasComparison: !!this.result?.comparison,
      history: e.history.slice(-120),
    };
  }
}
