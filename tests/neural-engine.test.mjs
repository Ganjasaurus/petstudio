/**
 * Tests for the on-device learning engine (src/neural-engine.js), the hybrid
 * creative engine (src/hybrid-engine.js) and Sleep Practice scheduling
 * (src/practice-runner.js). These check that learning is real: parameter
 * counts, deterministic forward passes, analytic gradients that match finite
 * differences, losses that fall, replay that protects older lessons,
 * rollback of corrupted or divergent sessions, checkpoint persistence and
 * recovery, and attempts that move measurably toward the taught lesson (and
 * the nudged style) because of the trained weights, not the blend schedule.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NeuralEngine, PracticeSession, MLP, MUSIC_SPEC, DRAW_SPEC, MODEL_SIZES, NEURAL_GENERATOR, MODEL_KEY, MODEL_BACKUP_KEY,
  MODEL_FUTURE_KEY, MODEL_ORPHAN_KEY, encodeFloat32, decodeFloat32, loadModel, saveModel, clearModel, sanitizeModelRecord,
  buildDatasets, alphaSchedule, stylePhrase, musicPrior, trainingDataFrom, noiseAllowance, DEFAULT_SETTINGS,
} from '../src/neural-engine.js';
import { HybridCreativeEngine } from '../src/hybrid-engine.js';
import { PracticeRunner } from '../src/practice-runner.js';
import { MUSIC_GENERATOR, DRAWING_GENERATOR } from '../src/creative-engine.js';
import { PetState } from '../src/pet-state.js';
import { TeachingMemory } from '../src/teaching-memory.js';
import { CreationFlow } from '../src/creation-flow.js';
import { GalleryStore } from '../src/gallery-store.js';
import {
  musicTemplate, drawingTemplate, phraseStats, drawingStats, lessonCloseness, resampleStroke, sanitizeDrawing,
  MUSIC_TEMPLATES, DRAWING_TEMPLATES,
} from '../src/teaching-core.js';
import { createRng } from '../src/rng.js';

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const lesson = (id, kind, demo, createdAt = 1, title = null) => ({ id, kind, createdAt, demo, title });
const CHAOTIC = { chaotic: 0.9, neat: 0.1, playful: 0.8, calm: 0.2 };

function engineWith(lessons, { prefs = {}, nudgeCounts = {}, traits = {}, loved = [], settings = null, petId = null } = {}) {
  const e = new NeuralEngine({ petId, settings, clock: () => 1_760_000_000_000 });
  const data = { lessons, loved, prefs, nudgeCounts, traits };
  e.setDataSource(() => data);
  e.data_ = data;
  return e;
}

function practise(engine, opts = {}) {
  const s = new PracticeSession(engine, opts);
  s.begin();
  while (s.running) s.step();
  return { session: s, decision: s.finish() };
}

/** A reproducible "hand-drawn" lesson: wobbly arcs with varying pressure, captured like the workshop canvas. */
function handDrawn(seed) {
  const rng = createRng(seed);
  const strokes = [];
  for (let s = 0; s < 3; s++) {
    const cx = 0.3 + rng.next() * 0.4;
    const cy = 0.3 + rng.next() * 0.4;
    const r = 0.1 + rng.next() * 0.15;
    const a0 = rng.next() * 6.28;
    const raw = [];
    for (let i = 0; i <= 80; i++) {
      const u = i / 80;
      const a = a0 + 3.5 * u;
      raw.push({ x: cx + r * Math.cos(a) + (rng.next() - 0.5) * 0.006, y: cy + r * Math.sin(a) + (rng.next() - 0.5) * 0.006, p: 0.35 + 0.4 * Math.sin(u * 3.14), t: u * 0.8 });
    }
    strokes.push({ color: ['#4a3f6b', '#ff7fa3', '#55b8ec'][s], width: 0.022, points: resampleStroke(raw) });
  }
  return sanitizeDrawing({ strokes });
}

/** Central-difference gradient check on a sample of parameters. */
function gradCheck(net, batch, picks) {
  const rng = createRng(99);
  for (let i = 0; i < net.size; i++) net.params[i] += (rng.next() - 0.5) * 0.2; // make W2 non-zero
  net.grad.fill(0);
  net.lossAndGrad(batch);
  const analytic = Float64Array.from(net.grad);
  const lossAt = () => {
    let W = 0;
    let total = 0;
    for (const e of batch) {
      net.forward(e.x);
      total += e.w * net.head.loss(net.y, e, net.dy);
      W += e.w;
    }
    return total / W;
  };
  let worst = 0;
  for (const i of picks) {
    const orig = net.params[i];
    const h = 1e-2;
    net.params[i] = orig + h;
    const up = lossAt();
    net.params[i] = orig - h;
    const down = lossAt();
    net.params[i] = orig;
    const numeric = (up - down) / (2 * h);
    const err = Math.abs(numeric - analytic[i]) / Math.max(1e-3, Math.abs(numeric) + Math.abs(analytic[i]));
    worst = Math.max(worst, err);
  }
  return worst;
}

describe('neural engine: architecture and determinism', () => {
  test('two compact Float32 networks of the documented sizes', () => {
    const e = new NeuralEngine();
    assert.deepEqual(e.music.mlp.dims, [75, 32, 26]);
    assert.deepEqual(e.drawing.mlp.dims, [42, 40, 13]);
    assert.equal(e.music.size, 75 * 32 + 32 + 32 * 26 + 26);
    assert.equal(e.drawing.size, 42 * 40 + 40 + 40 * 13 + 13);
    assert.deepEqual(MODEL_SIZES, { music: 3290, drawing: 2253 });
    for (const n of [e.music, e.drawing]) {
      assert.ok(n.size >= 1500 && n.size <= 4000, `${n.spec.name} has ${n.size} parameters`);
      assert.ok(n.params instanceof Float32Array);
    }
    assert.equal(e.parameterCount, 5543);
    assert.equal(e.architecture().music.name, MUSIC_SPEC.name);
    assert.equal(e.architecture().drawing.name, DRAW_SPEC.name);
  });

  test('the untrained baseline is identical for every pet and predicts the starter prior', () => {
    const a = new NeuralEngine({ petId: 'pet-aaaa' });
    const b = new NeuralEngine({ petId: 'pet-bbbb' });
    assert.deepEqual([...a.music.params], [...b.music.params]);
    assert.deepEqual([...a.drawing.params], [...b.drawing.params]);
    // The output layer starts at zero, so outputs equal the prior biases whatever the input.
    const x = new Float32Array(MUSIC_SPEC.inDim).map((_, i) => (i % 7) / 7);
    const y = Float64Array.from(a.music.forward(x));
    const { oB2 } = a.music.mlp;
    for (let k = 0; k < y.length; k++) assert.ok(Math.abs(y[k] - a.music.params[oB2 + k]) < 1e-6);
    const prior = musicPrior();
    assert.ok(prior.onset > 0.2 && prior.onset < 0.9 && prior.phrases >= 16);
  });

  test('forward passes are deterministic', () => {
    const e = engineWith([lesson('lesson-m1', 'music', musicTemplate('sunny-arp'))]);
    for (let i = 0; i < 20; i++) e.trainStep();
    const ex = e.refreshData().music.train[3];
    const y1 = Float64Array.from(e.music.forward(ex.x));
    const y2 = Float64Array.from(e.music.forward(ex.x));
    assert.deepEqual([...y1], [...y2]);
    const twin = engineWith([lesson('lesson-m1', 'music', musicTemplate('sunny-arp'))]);
    for (let i = 0; i < 20; i++) twin.trainStep();
    assert.deepEqual([...twin.music.params], [...e.music.params], 'same data and steps give the same weights');
  });
});

describe('neural engine: gradients and optimisation', () => {
  test('analytic gradients match finite differences (both networks)', () => {
    const e = engineWith([lesson('lesson-m1', 'music', musicTemplate('playful-hop')), lesson('lesson-d1', 'drawing', drawingTemplate('flower'))], { prefs: { energy: 0.4, order: 0.3 } });
    const data = e.refreshData();
    for (const kind of ['music', 'drawing']) {
      const net = e.nets[kind];
      const batch = data[kind].train.slice(0, 12);
      const rng = createRng(kind === 'music' ? 5 : 6);
      const picks = Array.from({ length: 40 }, () => Math.floor(rng.next() * net.size));
      const worst = gradCheck(net, batch, picks);
      assert.ok(worst < 2e-2, `${kind}: worst relative gradient error ${worst}`);
    }
  });

  test('gradients are finite and training loss falls on a music lesson and a drawing lesson', () => {
    const e = engineWith([lesson('lesson-m1', 'music', musicTemplate('bouncy-walk')), lesson('lesson-d1', 'drawing', drawingTemplate('star'))]);
    const before = e.computeTrainingLoss();
    for (let i = 0; i < 150; i++) {
      const r = e.trainStep();
      assert.equal(r.ok, true);
      assert.ok(Number.isFinite(r.loss));
      assert.ok([...e.music.grad].every(Number.isFinite) && [...e.drawing.grad].every(Number.isFinite));
    }
    const after = e.computeTrainingLoss();
    assert.ok(after.music < before.music * 0.2, `music ${before.music.toFixed(3)} -> ${after.music.toFixed(3)}`);
    assert.ok(after.drawing < before.drawing * 0.2, `drawing ${before.drawing.toFixed(3)} -> ${after.drawing.toFixed(3)}`);
    assert.equal(e.music.steps, 150);
    assert.equal(e.drawing.steps, 150);
    assert.ok(e.stats().deltaNorm > 1, 'the weights actually moved away from the baseline');
  });

  test('momentum SGD is available as an alternative optimizer', () => {
    const e = engineWith([lesson('lesson-m1', 'music', musicTemplate('sunny-arp'))], { settings: { optimizer: 'sgd', learningRate: 0.05 } });
    const before = e.computeTrainingLoss().music;
    for (let i = 0; i < 200; i++) e.trainStep();
    assert.ok(e.computeTrainingLoss().music < before * 0.6);
  });

  test('validation uses held-out notes and stroke samples chosen before augmentation', () => {
    const lessons = [lesson('lesson-m1', 'music', musicTemplate('sunny-arp')), lesson('lesson-d1', 'drawing', drawingTemplate('heart'))];
    const plain = buildDatasets({ lessons, prefs: {} });
    const styled = buildDatasets({ lessons, prefs: { energy: -0.68, order: 0.34 }, nudgeCounts: { calmer: 2, wilder: 1 } });
    for (const kind of ['music', 'drawing']) {
      assert.ok(plain[kind].val.length > 0 && plain[kind].train.length > plain[kind].val.length);
      assert.equal(plain[kind].counts.style, 0);
      assert.ok(styled[kind].counts.style > 0, 'style augmentations exist');
      // Every held-out position is held out in its style copy too (no near-duplicates across the split).
      const keyOf = (e) => (kind === 'music' ? [...e.x.slice(31, 43)].join() : [...e.x.slice(0, 13)].map((v) => v.toFixed(5)).join());
      const valKeys = new Set(styled[kind].val.filter((e) => e.role === 'demo').map(keyOf));
      const trainKeys = new Set(styled[kind].train.filter((e) => e.role === 'demo').map(keyOf));
      assert.ok(styled[kind].val.filter((e) => e.role === 'style').every((e) => valKeys.has(keyOf(e)) || !trainKeys.has(keyOf(e))));
    }
    assert.ok(noiseAllowance(4) > noiseAllowance(100), 'small held-out sets get a larger noise allowance');
  });
});

describe('neural engine: replay, rollback and checkpoints', () => {
  test('experience replay keeps lesson A while learning lesson B', () => {
    const A = lesson('lesson-aa', 'music', musicTemplate('sunny-arp'), 1);
    const B = lesson('lesson-bb', 'music', musicTemplate('playful-hop'), 2);
    const run = (settings) => {
      const data = { lessons: [A], prefs: {} };
      const e = new NeuralEngine({ settings });
      e.setDataSource(() => data);
      const untrained = e.lessonLoss('music', A.id);
      for (let i = 0; i < 240; i++) e.trainStep();
      const learned = e.lessonLoss('music', A.id);
      data.lessons = [A, B];
      for (let i = 0; i < 240; i++) e.trainStep();
      const kept = e.lessonLoss('music', A.id);
      // Share of lesson A's improvement still there after learning B.
      return { retained: (untrained - kept) / (untrained - learned), learnedB: e.lessonLoss('music', B.id), untrained, learned, kept };
    };
    const replay = run({});
    const none = run({ replayOlder: 0, replayExtra: 0 });
    assert.ok(replay.retained > 0.6, `with replay A keeps ${(replay.retained * 100).toFixed(0)}% of what it learned`);
    assert.ok(none.retained < 0.3, `without replay A keeps only ${(none.retained * 100).toFixed(0)}%`);
    assert.ok(replay.learnedB < replay.untrained * 0.5, 'and B is learned too');
  });

  test('an injected NaN gradient rolls the session back to the pre-sleep weights', () => {
    const e = engineWith([lesson('lesson-m1', 'music', musicTemplate('sunny-arp'))]);
    for (let i = 0; i < 10; i++) e.trainStep();
    const s = new PracticeSession(e);
    s.begin();
    const pre = e.music.params.slice();
    for (let i = 0; i < 5; i++) s.step();
    e.fault = { kind: 'nan' };
    const r = s.step();
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'diverged');
    assert.equal(s.status, 'rolled-back');
    assert.deepEqual([...e.music.params], [...pre], 'weights restored exactly');
    assert.equal(e.music.steps, 10);
    assert.ok(e.music.isFinite());
    assert.equal(e.lastSession.decision, 'rolled-back');
  });

  test('a corrupted, divergent update is rejected by validation and rolled back', () => {
    const e = engineWith([lesson('lesson-m1', 'music', musicTemplate('bouncy-walk')), lesson('lesson-d1', 'drawing', drawingTemplate('sun'))]);
    const s = new PracticeSession(e);
    s.begin();
    const pre = { music: e.music.params.slice(), drawing: e.drawing.params.slice() };
    for (let i = 0; i < 5; i++) s.step();
    for (const n of [e.music, e.drawing]) for (let i = 0; i < n.size; i++) n.params[i] *= 40; // a wild update
    const d = s.finish();
    assert.equal(d.decision, 'rolled-back');
    assert.equal(d.reason, 'validation-worse');
    assert.deepEqual([...e.music.params], [...pre.music]);
    assert.deepEqual([...e.drawing.params], [...pre.drawing]);
  });

  test('corruption after a good evaluation returns to the best weights seen, never committing it', () => {
    const e = engineWith([lesson('lesson-d1', 'drawing', drawingTemplate('sun'))]);
    const s = new PracticeSession(e, { evalEvery: 10 });
    s.begin();
    for (let i = 0; i < 10; i++) s.step();
    const good = e.drawing.params.slice();
    for (let i = 0; i < e.drawing.size; i++) e.drawing.params[i] *= 40;
    const d = s.finish();
    assert.equal(d.kinds.drawing.decision, 'kept-best');
    assert.deepEqual([...e.drawing.params], [...good]);
    assert.deepEqual([...e.getCheckpoint('latest').params.drawing], [...good]);
  });

  test('a divergent learning rate never commits worse weights', () => {
    const e = engineWith([lesson('lesson-m1', 'music', musicTemplate('sunny-arp'))], { settings: { learningRate: 0.1, clip: 100, anchor: 0, optimizer: 'sgd', momentum: 0.99 } });
    const before = e.computeValidationLoss().total;
    const { decision } = practise(e, { maxSteps: 120 });
    const after = e.computeValidationLoss().total;
    assert.ok(Number.isFinite(after));
    assert.ok(decision.decision === 'rolled-back' || after <= before * (1 + DEFAULT_SETTINGS.rollbackMargin) + noiseAllowance(e.refreshData().music.val.length));
  });

  test('a healthy session commits the latest checkpoint and keeps a pre-sleep one', () => {
    const e = engineWith([lesson('lesson-d1', 'drawing', drawingTemplate('flower'))]);
    const { decision } = practise(e);
    assert.equal(decision.decision, 'committed');
    assert.ok(decision.finalVal < decision.preVal, 'held-out stroke loss fell');
    const ids = e.listCheckpoints().map((c) => c.id);
    assert.deepEqual(ids, ['untrained', 'pre-sleep', 'latest']);
    assert.equal(e.sessions, 1);
    e.createCheckpoint('user', { name: 'Good one' });
    e.createCheckpoint('user', { name: 'Second' });
    e.createCheckpoint('user', { name: 'Third' });
    assert.equal(e.listCheckpoints().length, 5, 'at most five checkpoints');
    assert.deepEqual(e.listCheckpoints().filter((c) => c.kind === 'user').map((c) => c.name), ['Second', 'Third']);
    assert.equal(e.rollbackTo('untrained'), true);
    assert.deepEqual([...e.drawing.params], [...e.drawing.base]);
    assert.equal(e.stepsFor('drawing'), 0);
  });

  test('checkpoints round-trip through storage bit for bit, with optimizer state', () => {
    const storage = new MemoryStorage();
    const e = engineWith([lesson('lesson-m1', 'music', musicTemplate('sunny-arp')), lesson('lesson-d1', 'drawing', drawingTemplate('star'))], { petId: 'pet-test1' });
    practise(e, { maxSteps: 60 });
    assert.equal(saveModel(e, storage).ok, true);
    const { engine, status } = loadModel(storage, { petId: 'pet-test1' });
    assert.equal(status, 'loaded');
    assert.deepEqual([...engine.music.params], [...e.music.params]);
    assert.deepEqual([...engine.drawing.params], [...e.drawing.params]);
    assert.deepEqual([...engine.music.m], [...e.music.m]);
    assert.equal(engine.music.t, e.music.t);
    assert.equal(engine.stepsFor('music'), e.stepsFor('music'));
    assert.deepEqual(engine.lessonSteps, e.lessonSteps);
    engine.setDataSource(() => e.data_);
    const ref = lesson('lesson-m1', 'music', musicTemplate('sunny-arp'));
    assert.deepEqual(engine.composeMusic(ref.demo, { seed: 3 }), e.composeMusic(ref.demo, { seed: 3 }), 'reloaded pets respond identically');
    const json = JSON.parse(storage.getItem(MODEL_KEY));
    assert.equal(json.schema, 'petstudio.model');
    // latest (weights + Adam moments) and pre-sleep: about 120 KB of base64 for 5,543 float32 parameters.
    assert.ok(storage.getItem(MODEL_KEY).length < 140_000, `bounded record size (${storage.getItem(MODEL_KEY).length} bytes)`);
  });

  test('a damaged main record falls back to the backup; hostile values are sanitised', () => {
    const storage = new MemoryStorage();
    const e = engineWith([lesson('lesson-m1', 'music', musicTemplate('sunny-arp'))], { petId: 'pet-test2' });
    practise(e, { maxSteps: 40 });
    saveModel(e, storage);
    const good = e.music.params.slice();
    for (let i = 0; i < 30; i++) e.trainStep();
    e.commit(null);
    saveModel(e, storage); // the previous record becomes the backup
    const torn = storage.getItem(MODEL_KEY).slice(0, 5000);
    storage.setItem(MODEL_KEY, torn);
    const restored = loadModel(storage, { petId: 'pet-test2' });
    assert.equal(restored.status, 'restored-backup');
    assert.deepEqual([...restored.engine.music.params], [...good]);

    const rec = JSON.parse(storage.getItem(MODEL_BACKUP_KEY));
    const bad = structuredClone(rec);
    const nan = new Float32Array(MODEL_SIZES.music).fill(0.1);
    nan[7] = Number.NaN;
    bad.checkpoints.push({ ...bad.checkpoints[0], id: 'user-x1', kind: 'user', params: { music: encodeFloat32(nan), drawing: bad.checkpoints[0].params.drawing } });
    bad.checkpoints.push({ ...bad.checkpoints[0], id: 'user-x2', kind: 'user', params: { music: 'AAAA', drawing: 'not base64!' } });
    bad.checkpoints.push({ ...bad.checkpoints[0], id: 'user-x3', kind: 'user', params: { music: encodeFloat32(new Float32Array(MODEL_SIZES.music).fill(1e6)), drawing: bad.checkpoints[0].params.drawing } });
    bad.history.push({ step: -4, val: 'x' }, { step: 3, val: Infinity, mark: '<script>' });
    bad.settings = { learningRate: 50, batchSize: -3, optimizer: 'evil' };
    const clean = sanitizeModelRecord(bad);
    assert.equal(clean.dropped, 3, 'NaN, malformed and absurd checkpoints are dropped');
    assert.ok(clean.history.every((h) => h.step >= 0 && (h.val === null || Number.isFinite(h.val)) && h.mark !== '<script>'));
    assert.equal(clean.settings.learningRate, 0.1);
    assert.equal(clean.settings.batchSize, 4);
    assert.equal(clean.settings.optimizer, 'adam');
    const broken = structuredClone(rec);
    broken.checkpoints.find((c) => c.kind === 'latest').params.music = 'AAAA';
    assert.throws(() => sanitizeModelRecord(broken), /latest/);
  });

  test('future versions, other pets and other architectures are kept aside, never overwritten', () => {
    const storage = new MemoryStorage();
    const e = engineWith([lesson('lesson-m1', 'music', musicTemplate('sunny-arp'))], { petId: 'pet-owner' });
    practise(e, { maxSteps: 20 });
    saveModel(e, storage);
    const other = loadModel(storage, { petId: 'pet-someone' });
    assert.equal(other.status, 'other-pet');
    assert.equal(other.engine.stepsFor('music'), 0);
    assert.ok(storage.getItem(MODEL_ORPHAN_KEY));
    const rec = JSON.parse(storage.getItem(MODEL_KEY));
    storage.setItem(MODEL_KEY, JSON.stringify({ ...rec, version: 99 }));
    assert.equal(loadModel(storage, { petId: 'pet-owner' }).status, 'future-version');
    assert.ok(storage.getItem(MODEL_FUTURE_KEY));
    storage.setItem(MODEL_KEY, JSON.stringify({ ...rec, arch: { ...rec.arch, music: { ...rec.arch.music, dims: [10, 2, 3] } } }));
    storage.removeItem(MODEL_BACKUP_KEY);
    assert.equal(loadModel(storage, { petId: 'pet-owner' }).status, 'incompatible');
    clearModel(storage);
    assert.equal(storage.getItem(MODEL_KEY), null);
  });

  test('float32 base64 encoding is exact and rejects malformed input', () => {
    const a = new Float32Array([0, -0, 1.5, -2.25, 3.4028234663852886e38, 1e-45, Math.PI, -Math.E]);
    assert.deepEqual([...decodeFloat32(encodeFloat32(a), a.length)], [...a]);
    assert.equal(decodeFloat32(encodeFloat32(a), a.length + 1), null, 'length must match');
    assert.equal(decodeFloat32('ab=c', 1), null);
    assert.equal(decodeFloat32(42, 1), null);
    assert.equal(decodeFloat32('Zm9vé===', 1), null);
  });
});

describe('learning changes what the pet makes', () => {
  test('after practice, music attempts are measurably closer to the taught tune (fair, same seeds)', () => {
    const gains = [];
    for (const [id, traits] of [['bouncy-walk', {}], ['sunny-arp', CHAOTIC], ['starlight-lullaby', CHAOTIC]]) {
      const L = lesson('lesson-m1', 'music', musicTemplate(id));
      const e = engineWith([L], { traits });
      const h = new HybridCreativeEngine({ neural: e });
      const close = (eng) => mean(SEEDS.map((seed) => lessonCloseness('music', L.demo, eng.compose('music', L.demo, { seed, traits, lessonId: L.id }))));
      const before = close(h);
      assert.equal(h.compose('music', L.demo, { seed: 1, traits, lessonId: L.id }).generator, MUSIC_GENERATOR, 'untrained: authored');
      const { decision } = practise(e);
      assert.equal(decision.decision, 'committed');
      const after = close(h);
      // Control: untrained weights at the same blend weight (separates learning from the schedule).
      const alpha = h.alphaFor('music', L.id);
      const control = mean(SEEDS.map((seed) => lessonCloseness('music', L.demo, new HybridCreativeEngine({ neural: engineWith([L], { traits }) }).compose('music', L.demo, { seed, traits, lessonId: L.id, alpha }))));
      assert.ok(after > before + 0.01, `${id}: ${before.toFixed(3)} -> ${after.toFixed(3)}`);
      assert.ok(after > control + 0.01, `${id}: trained ${after.toFixed(3)} vs untrained at the same alpha ${control.toFixed(3)}`);
      assert.equal(h.compose('music', L.demo, { seed: 1, traits, lessonId: L.id }).generator, NEURAL_GENERATOR);
      gains.push(after - before);
    }
    assert.ok(mean(gains) > 0.04, `mean gain ${mean(gains).toFixed(3)}`);
  });

  test('after practice, drawings are measurably closer to the taught drawing (fair, same seeds)', () => {
    const gains = [];
    const cases = [['flower', drawingTemplate('flower'), {}], ['sun', drawingTemplate('sun'), CHAOTIC], ['hand-drawn', handDrawn(3), {}], ['hand-drawn', handDrawn(5), CHAOTIC]];
    for (const [name, demo, traits] of cases) {
      const L = lesson('lesson-d1', 'drawing', demo);
      const e = engineWith([L], { traits });
      const h = new HybridCreativeEngine({ neural: e });
      const close = (eng, alpha) => mean(SEEDS.map((seed) => lessonCloseness('drawing', L.demo, eng.compose('drawing', L.demo, { seed, traits, lessonId: L.id, alpha }))));
      const before = close(h);
      assert.equal(h.compose('drawing', L.demo, { seed: 1, traits, lessonId: L.id }).generator, DRAWING_GENERATOR);
      practise(e);
      const after = close(h);
      const control = close(new HybridCreativeEngine({ neural: engineWith([L], { traits }) }), h.alphaFor('drawing', L.id));
      assert.ok(after > before + 0.005, `${name}: ${before.toFixed(3)} -> ${after.toFixed(3)}`);
      assert.ok(after > control, `${name}: trained ${after.toFixed(3)} vs untrained at the same alpha ${control.toFixed(3)}`);
      gains.push(after - before);
    }
    assert.ok(mean(gains) > 0.02, `mean gain ${mean(gains).toFixed(3)}`);
  });

  test('nudges are learned into the networks: calmer, livelier, wilder', () => {
    const M = lesson('lesson-m1', 'music', musicTemplate('bouncy-walk'), 1);
    const D = lesson('lesson-d1', 'drawing', drawingTemplate('flower'), 2);
    const trained = (prefs, nudgeCounts) => {
      const e = engineWith([M, D], { prefs, nudgeCounts });
      practise(e);
      return e;
    };
    const music = (e, prefs) => {
      const st = SEEDS.slice(0, 6).map((seed) => phraseStats(e.composeMusic(M.demo, { seed, prefs, alpha: 1 })));
      return { tempo: mean(st.map((s) => s.tempo)), notes: mean(st.map((s) => s.notes)), vel: mean(st.map((s) => s.meanVel)), range: mean(st.map((s) => s.range)) };
    };
    const calm = { energy: -0.68, order: 0 };
    const lively = { energy: 0.68, order: 0 };
    const wild = { energy: 0, order: 0.68 };
    const eCalm = trained(calm, { calmer: 2 });
    const eLively = trained(lively, { livelier: 2 });
    const eWild = trained(wild, { wilder: 2 });
    const neutral = trained({}, {});
    const c = music(eCalm, calm);
    const l = music(eLively, lively);
    const n = music(neutral, {});
    assert.ok(c.tempo < n.tempo - 4 && l.tempo > n.tempo + 4, `tempo calm ${c.tempo} neutral ${n.tempo} lively ${l.tempo}`);
    assert.ok(c.vel < n.vel - 0.08 && l.vel > n.vel + 0.03, `velocity calm ${c.vel.toFixed(2)} lively ${l.vel.toFixed(2)}`);
    assert.ok(c.notes < n.notes, 'calmer plays fewer notes');
    assert.ok(music(eWild, wild).range > n.range + 1, `wilder melodies roam further (${music(eWild, wild).range} vs ${n.range} semitones)`);
    const width = (e, prefs) => drawingStats(e.reconstructDrawing(D.demo, { prefs })).meanWidth;
    assert.ok(width(eCalm, calm) < width(neutral, {}) && width(eLively, lively) > width(neutral, {}), 'calmer lines are thinner, livelier bolder');
    assert.ok(eWild.drawingResiduals(D.demo, { prefs: wild }).steadiness < neutral.drawingResiduals(D.demo, {}).steadiness - 0.2, 'wilder keeps more of its own tilt');
    assert.equal(stylePhrase(M.demo, calm).tempo < M.demo.tempo, true, 'the documented augmentation is calmer');
  });

  test('two pets from the same baseline, taught different things, answer a new lesson differently', () => {
    const heldOut = musicTemplate('starlight-lullaby');
    const petA = engineWith([lesson('lesson-a1', 'music', musicTemplate('bouncy-walk'))]);
    const petB = engineWith([lesson('lesson-b1', 'music', musicTemplate('playful-hop'))]);
    assert.deepEqual(petA.composeMusic(heldOut, { seed: 4 }), petB.composeMusic(heldOut, { seed: 4 }), 'identical before teaching');
    practise(petA);
    const aParams = petA.music.params.slice();
    practise(petB);
    assert.deepEqual([...petA.music.params], [...aParams], 'training pet B never touches pet A');
    const outA = SEEDS.map((seed) => petA.composeMusic(heldOut, { seed }));
    const outB = SEEDS.map((seed) => petB.composeMusic(heldOut, { seed }));
    assert.ok(outA.some((p, i) => JSON.stringify(p.notes) !== JSON.stringify(outB[i].notes)), 'different responses to the same new lesson');
    const pitches = (outs) => new Set(outs.flatMap((p) => p.notes.map((x) => x.midi)));
    const fromTaught = (outs, taught) => mean(outs.map((p) => p.notes.filter((x) => taught.notes.some((t) => t.midi === x.midi)).length / Math.max(1, p.notes.length)));
    assert.ok(fromTaught(outA, musicTemplate('bouncy-walk')) > fromTaught(outB, musicTemplate('bouncy-walk')), 'pet A leans on what it was taught');
    assert.ok(pitches(outB).size > 0);
  });

  test('the blend weight grows with steps and lesson practice; unpractised lessons stay mostly authored', () => {
    assert.equal(alphaSchedule(0, 100), 0);
    assert.ok(alphaSchedule(50, 50) < alphaSchedule(200, 200));
    assert.ok(alphaSchedule(300, 0) <= 0.25 + 1e-9, 'a lesson never practised gets at most a quarter');
    assert.ok(alphaSchedule(600, 600) > 0.95);
    const L = lesson('lesson-m1', 'music', musicTemplate('sunny-arp'));
    const e = engineWith([L]);
    const h = new HybridCreativeEngine({ neural: e });
    practise(e, { maxSteps: 40 });
    const tagged = h.compose('music', L.demo, { seed: 2, lessonId: L.id });
    assert.equal(tagged.generator, NEURAL_GENERATOR);
    assert.ok(tagged.alpha > 0 && tagged.alpha < 1 && tagged.model.steps === e.stepsFor('music'));
    assert.equal(h.compose('drawing', drawingTemplate('star'), { seed: 2 }).generator, DRAWING_GENERATOR, 'the untrained drawing net stays authored');
    assert.equal(h.info.learned, true);
  });
});

describe('Sleep Practice scheduling', () => {
  function setup() {
    const pet = PetState.create({ seed: 11, now: 1, clock: () => 1, needs: { energy: 96, hunger: 90, hygiene: 95 }, autonomy: false });
    const memory = new TeachingMemory({}, { petId: pet.id, clock: () => 1000 });
    const engine = new NeuralEngine({ petId: pet.id });
    engine.setDataSource(() => trainingDataFrom(memory, { items: [] }, pet.traits));
    const creative = new HybridCreativeEngine({ neural: engine });
    let now = 0;
    const runner = new PracticeRunner({ engine, creative, pet, memory, now: () => now });
    return { pet, memory, engine, creative, runner, advance: (ms) => { now += ms; } };
  }

  test('with nothing taught there is nothing to practise', () => {
    const { runner, pet } = setup();
    assert.equal(runner.begin().reason, 'no-data');
    assert.equal(runner.status, 'no-data');
    assert.equal(pet.isAsleep, false);
  });

  test('the pet naps (even when not sleepy), practises at the set pace and finishes with a before/after comparison', () => {
    const { runner, pet, memory, engine } = setup();
    memory.addLesson('music', musicTemplate('bouncy-walk'), { title: 'Bouncy Walk' });
    assert.equal(runner.begin().ok, true);
    assert.equal(runner.status, 'waiting');
    for (let i = 0; i < 300 && !pet.isAsleep; i++) {
      pet.update(0.1);
      runner.tick(0.1);
    }
    assert.equal(pet.isAsleep, true);
    runner.tick(0);
    assert.equal(runner.status, 'practicing');
    const steps = runner.tick(0.5);
    assert.equal(steps, Math.min(3, Math.floor(0.5 * engine.settings.stepsPerSecond)), 'paced, with a burst cap');
    // The nap is held while practising, even once the pet is fully rested.
    pet.setNeeds({ energy: 100 });
    for (let i = 0; i < 200; i++) pet.update(0.5);
    assert.equal(pet.isAsleep, true);
    runner.pause();
    assert.equal(runner.status, 'paused');
    const before = runner.state().sessionSteps;
    runner.stepOnce();
    assert.equal(runner.state().sessionSteps, before + 1, 'Step +1');
    runner.start();
    let frames = 0;
    while (runner.status === 'practicing' && frames++ < 10000) runner.tick(1 / 60);
    assert.equal(runner.status, 'complete');
    const st = runner.state();
    assert.equal(st.result.decision, 'committed');
    assert.ok(st.confidence > 0.5);
    const c = runner.result.comparison;
    assert.equal(c.before.generator, MUSIC_GENERATOR);
    assert.equal(c.after.generator, NEURAL_GENERATOR);
    assert.ok(c.after.closeness > c.before.closeness, `closeness ${c.before.closeness} -> ${c.after.closeness}`);
    runner.finish();
    assert.equal(pet.isAsleep, false, 'Wake & Finish wakes the pet');
  });

  test('the frame budget caps training time per frame', () => {
    const { runner, pet, memory, engine } = setup();
    memory.addLesson('drawing', drawingTemplate('flower'));
    engine.settings.stepsPerSecond = 5000;
    runner.begin();
    for (let i = 0; i < 300 && !pet.isAsleep; i++) {
      pet.update(0.1);
      runner.tick(0.1);
    }
    // A clock where every step costs 3 ms: only the steps started within 4 ms run.
    let t = 0;
    runner.now = () => (t += 1.5);
    assert.ok(runner.tick(1) <= 2);
  });

  test('waking the pet pauses practice; Cancel & Rollback restores the pre-sleep weights', () => {
    const { runner, pet, memory, engine } = setup();
    memory.addLesson('music', musicTemplate('sunny-arp'));
    pet.setNeeds({ energy: 30 });
    runner.begin();
    for (let i = 0; i < 300 && !pet.isAsleep; i++) {
      pet.update(0.1);
      runner.tick(0.1);
    }
    runner.tick(0);
    const pre = engine.music.params.slice();
    for (let i = 0; i < 40; i++) runner.tick(0.2);
    assert.ok(runner.state().sessionSteps > 10);
    pet.wake();
    runner.tick(0.1);
    assert.equal(runner.status, 'paused');
    assert.equal(runner.reason, 'woke');
    assert.equal(runner.cancel().ok, true);
    assert.equal(runner.status, 'cancelled');
    assert.deepEqual([...engine.music.params], [...pre]);
    assert.deepEqual([...engine.getCheckpoint('latest').params.music], [...pre], 'the latest checkpoint is the pre-sleep weights again');
  });

  test('the creation flow uses the learned engine after practice and tags its attempts', () => {
    const pet = PetState.create({ seed: 3, now: 1, clock: () => 1, needs: { energy: 95, hunger: 90, hygiene: 95 }, autonomy: false });
    let t = 1_760_000_000_000;
    const clock = () => (t += 1000);
    const memory = new TeachingMemory({}, { petId: pet.id, clock });
    const gallery = new GalleryStore({}, { clock });
    const engine = new NeuralEngine({ petId: pet.id, clock });
    engine.setDataSource(() => trainingDataFrom(memory, gallery, pet.traits));
    const flow = new CreationFlow({ pet, memory, gallery, engine: new HybridCreativeEngine({ neural: engine }), clock });
    const first = flow.teach('music', musicTemplate('bouncy-walk'), { templateId: 'bouncy-walk' });
    assert.equal(first.plan.generator, MUSIC_GENERATOR, 'before practice the attempt is authored');
    practise(engine);
    for (let i = 0; i < 600 && pet.activity.type !== 'playing_music'; i++) pet.update(0.1);
    for (let i = 0; i < 600 && flow.subject?.phase !== 'done'; i++) pet.update(0.1);
    const v = flow.variation();
    assert.equal(v.ok, true);
    assert.equal(v.plan.generator, NEURAL_GENERATOR, 'after practice the retry is learned');
    const data = trainingDataFrom(memory, gallery, pet.traits);
    assert.equal(data.lessons.length, 1);
  });
});

describe('recognising practised content', () => {
  test('a re-taught identical tune gets the practised blend weight, a new tune does not', () => {
    const L = lesson('lesson-m1', 'music', musicTemplate('bouncy-walk'));
    const e = engineWith([L]);
    const h = new HybridCreativeEngine({ neural: e });
    practise(e);
    const practised = h.compose('music', musicTemplate('bouncy-walk'), { seed: 3 }); // no lesson id: as when it is taught again
    const fresh = h.compose('music', musicTemplate('starlight-lullaby'), { seed: 3 });
    assert.ok(practised.alpha > 0.8, `re-taught: alpha ${practised.alpha}`);
    assert.ok(fresh.alpha <= 0.25, `new tune: alpha ${fresh.alpha}`);
    assert.equal(fresh.generator, NEURAL_GENERATOR, 'still tagged: the network had a (small) say');
  });
});

describe('session bookkeeping', () => {
  test('a session closed before any step leaves no dangling start mark', () => {
    const e = engineWith([lesson('lesson-m1', 'music', musicTemplate('sunny-arp'))]);
    const s = new PracticeSession(e);
    s.begin();
    assert.equal(s.finish().decision, 'nothing');
    const last = [...e.history].reverse().find((h) => h.mark)?.mark;
    assert.equal(last, 'end', 'the next launch will not report an interrupted practice');
    const storage = new MemoryStorage();
    saveModel(e, storage);
    assert.equal([...loadModel(storage).engine.history].reverse().find((h) => h.mark)?.mark, 'end');
  });
});
