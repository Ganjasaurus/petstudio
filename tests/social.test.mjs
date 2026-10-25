/**
 * Tests for Iteration 4: portable pet snapshots (src/pet-snapshot.js), the
 * built-in visitor pets, Jam Together and Co-Draw Together compositions,
 * bounded social learning (teaching memory + neural datasets) and the visit
 * state machine (src/social-studio.js), all in Node without a DOM.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createSnapshot, parseSnapshot, sanitizeSnapshot, serializeSnapshot, snapshotFileName, snapshotSummary, visitorEngine,
  BUILTIN_VISITORS, builtinVisitor, SNAPSHOT_FORMAT, SNAPSHOT_LIMITS,
} from '../src/pet-snapshot.js';
import {
  SocialStudio, VisitorActor, composeDuet, composeCoDraw, duetTurn, motifOf, FriendsStore, loadFriends, saveFriends,
  VISIT_SPOTS, XYLOPHONE, xylophoneBar, FRIENDS_KEY, FRIENDS_LIMITS,
} from '../src/social-studio.js';
import { PetState } from '../src/pet-state.js';
import { STATIONS, distance } from '../src/studio-layout.js';
import { TeachingMemory, SOCIAL_LESSON_WEIGHT, MEMORY_LIMITS } from '../src/teaching-memory.js';
import { GalleryStore } from '../src/gallery-store.js';
import { CreationFlow } from '../src/creation-flow.js';
import {
  NeuralEngine, buildDatasets, trainingDataFrom, encodeFloat32, decodeCompactWeights, compactWeights, MODEL_SIZES,
} from '../src/neural-engine.js';
import { HybridCreativeEngine } from '../src/hybrid-engine.js';
import { musicTemplate, drawingTemplate, phraseSimilarity, phraseStats, sanitizePhrase } from '../src/teaching-core.js';
import { socialLabel } from '../src/creative-engine.js';

const NOW = 1_760_000_000_000;

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

/** A host pet with memory, gallery, a (trainable) engine and the creation flow. */
function studio({ seed = 2024, traits, needs = {}, name = 'Pico' } = {}) {
  let t = NOW;
  const clock = () => (t += 1000);
  const pet = PetState.create({ seed, now: NOW, clock: () => NOW, traits, needs: { energy: 95, hunger: 92, hygiene: 95, ...needs }, autonomy: false });
  pet.setAppearance({ name });
  const memory = new TeachingMemory({}, { clock, petId: pet.id, sessionId: 'session-social' });
  const gallery = new GalleryStore({}, { clock });
  const neural = new NeuralEngine({ clock: () => NOW });
  neural.setDataSource(() => trainingDataFrom(memory, gallery, pet.traits));
  const creative = new HybridCreativeEngine({ neural });
  const flow = new CreationFlow({ pet, memory, gallery, engine: creative, clock });
  return { pet, memory, gallery, neural, creative, flow, clock };
}

function train(engine, steps) {
  for (let i = 0; i < steps; i++) {
    const r = engine.trainStep();
    assert.equal(r.ok, true, r.reason);
  }
}

/** Steps the host simulation and the visit together (0.1 s ticks) until `until()` holds. */
function run(pet, social, seconds, until = null) {
  for (let i = 0; i <= seconds * 10; i++) {
    if (until?.()) return i / 10;
    pet.update(0.1);
    social.update(0.1);
  }
  return -1;
}

const asVisitor = (snapshot) => {
  const engine = visitorEngine(snapshot);
  return { snapshot, engine, creative: new HybridCreativeEngine({ neural: engine }) };
};
const hostOf = (s) => ({ creative: s.creative, traits: s.pet.traits, prefs: s.memory.prefs, colors: s.pet.appearance, name: s.pet.name });

describe('pet snapshots: export and import', () => {
  test('a snapshot round-trips through JSON: appearance, temperament, style, own pieces and bit-exact weights', () => {
    const s = studio({ traits: { playful: 0.8, chaotic: 0.6, calm: 0.2 }, name: 'Doodle' });
    s.memory.applyNudge('livelier');
    s.memory.addLesson('music', musicTemplate('sunny-arp'), { templateId: 'sunny-arp', title: 'Sunny Arp' });
    const attempt = s.gallery.add({ kind: 'music', origin: 'attempt', title: "Doodle's take on Sunny Arp", data: musicTemplate('bouncy-walk'), petId: s.pet.id, favorite: true });
    s.gallery.add({ kind: 'music', origin: 'taught', title: 'Your Sunny Arp', data: musicTemplate('sunny-arp'), petId: s.pet.id });
    train(s.neural, 25);

    const snap = createSnapshot({ pet: s.pet, gallery: s.gallery, memory: s.memory, neural: s.neural, now: NOW, appVersion: '1.3.0' });
    assert.equal(snap.format, SNAPSHOT_FORMAT);
    assert.equal(snap.origin, 'export');
    assert.equal(snap.source.petId, s.pet.id, 'provenance: the snapshot names the pet it was copied from');
    assert.deepEqual(snap.pet, s.pet.appearance);
    assert.deepEqual(snap.traits, s.pet.traits);
    assert.deepEqual(snap.style, s.memory.prefs);
    assert.equal(snap.phrases.length, 2);
    assert.deepEqual(snap.phrases[0].data, attempt.data, 'the favourite creation comes first');
    assert.ok(snap.phrases.every((p) => JSON.stringify(p.data) !== JSON.stringify(sanitizePhrase(musicTemplate('sunny-arp')))), 'lessons are never exported');
    assert.equal(snap.drawings.length, 2);
    assert.ok(snap.drawings.every((d) => d.filled), 'a pet with no drawings is topped up with labelled starter drawings');

    const text = serializeSnapshot(snap);
    assert.ok(text.length < SNAPSHOT_LIMITS.maxBytes, `compact: ${text.length} bytes`);
    assert.equal(snapshotFileName(snap), 'doodle-snapshot.json');
    const parsed = parseSnapshot(text, { now: NOW });
    assert.equal(parsed.ok, true, parsed.message);
    assert.deepEqual(parsed.snapshot, snap, 'sanitising is idempotent');
    assert.deepEqual(parsed.warnings, []);

    const w = decodeCompactWeights(parsed.snapshot.neural);
    assert.ok(w, 'weights survive the trip');
    assert.equal(encodeFloat32(w.music), encodeFloat32(s.neural.nets.music.params));
    assert.equal(encodeFloat32(w.drawing), encodeFloat32(s.neural.nets.drawing.params));
    assert.deepEqual(parsed.snapshot.neural.steps, { music: s.neural.stepsFor('music'), drawing: s.neural.stepsFor('drawing') });
    const sum = snapshotSummary(parsed.snapshot);
    assert.equal(sum.learned.trained, true);
    assert.equal(sum.learned.parameters, MODEL_SIZES.music + MODEL_SIZES.drawing);
  });

  test('the imported copy keeps its learned behaviour exactly and trains independently of the original', () => {
    const s = studio();
    s.memory.addLesson('music', musicTemplate('playful-hop'), { title: 'Playful Hop' });
    s.memory.addLesson('drawing', drawingTemplate('heart'), { title: 'Heart' });
    train(s.neural, 30);
    const parsed = parseSnapshot(serializeSnapshot(createSnapshot({ pet: s.pet, gallery: s.gallery, memory: s.memory, neural: s.neural, now: NOW })));
    const copy = visitorEngine(parsed.snapshot);
    const lessonPhrase = musicTemplate('starlight-lullaby');
    const opts = { seed: 11, prefs: { energy: 0.2, order: -0.1 }, traits: s.pet.traits, alpha: 1 };
    assert.deepEqual(copy.composeMusic(lessonPhrase, opts), s.neural.composeMusic(lessonPhrase, opts), 'same controlled response (bit-exact float32)');
    const a = copy.drawingResiduals(drawingTemplate('star'), opts);
    const b = s.neural.drawingResiduals(drawingTemplate('star'), opts);
    assert.deepEqual([...a.strokes[0].dx], [...b.strokes[0].dx]);
    assert.equal(a.steadiness, b.steadiness);

    // Training the copy never touches the original (and vice versa).
    const original = encodeFloat32(s.neural.nets.music.params);
    copy.setDataSource(() => ({ lessons: [{ id: 'lesson-copy', kind: 'music', createdAt: 1, demo: musicTemplate('bouncy-walk') }], loved: [] }));
    train(copy, 10);
    assert.equal(encodeFloat32(s.neural.nets.music.params), original);
    const copied = encodeFloat32(copy.nets.music.params);
    train(s.neural, 5);
    assert.equal(encodeFloat32(copy.nets.music.params), copied);
  });

  test('an untrained pet travels without weights and is recognised as untrained', () => {
    const s = studio();
    const snap = createSnapshot({ pet: s.pet, gallery: s.gallery, memory: s.memory, neural: s.neural, now: NOW });
    assert.equal(snap.neural.weights, null);
    assert.deepEqual(snap.neural.steps, { music: 0, drawing: 0 });
    assert.ok(snap.phrases.length === 2 && snap.phrases.every((p) => p.filled));
    const e = visitorEngine(snap);
    assert.equal(e.stepsFor('music') + e.stepsFor('drawing'), 0);
  });

  test('hostile and malformed snapshots are rejected or sanitised, never thrown', () => {
    const reject = (input, reason) => {
      let res;
      assert.doesNotThrow(() => { res = parseSnapshot(input); });
      assert.equal(res.ok, false, `${String(input).slice(0, 30)} should be rejected`);
      if (reason) assert.equal(res.reason, reason);
      assert.equal(typeof res.message, 'string');
    };
    reject('', 'empty');
    reject('   ', 'empty');
    reject(null, 'empty');
    reject('not json at all', 'not-json');
    reject('{"format":', 'not-json');
    reject('[]', 'not-an-object');
    reject('42', 'not-an-object');
    reject('null', 'not-an-object');
    reject('"petstudio.snapshot.v1"', 'not-an-object');
    reject('{"format":"something.else"}', 'wrong-format');
    reject('{"schema":"petstudio.snapshot","version":0}', 'bad-version');
    reject('{"schema":"petstudio.snapshot","version":"1"}', 'bad-version');
    reject('{"schema":"petstudio.snapshot","version":9}', 'future-version');
    reject(`{"format":"petstudio.snapshot.v1","pad":"${'x'.repeat(SNAPSHOT_LIMITS.maxBytes)}"}`, 'too-large');
    reject('['.repeat(100_000));
    reject({ format: SNAPSHOT_FORMAT, get pet() { throw new Error('hostile getter'); } });
    const cyclic = { format: SNAPSHOT_FORMAT };
    cyclic.self = cyclic;
    reject(cyclic, 'not-json');

    const hostile = JSON.stringify({
      format: SNAPSHOT_FORMAT, origin: 'builtin', id: '../../etc/passwd',
      source: { petId: '<script>', app: 'x'.repeat(500) },
      pet: { name: '<img src=x onerror=alert(1)>Biscuit the Magnificent', bodyColor: 'red; background:url(javascript:alert(1))', accentColor: '#12345', cheekColor: '#ABCDEF', earStyle: 'wings', tailStyle: 'puff', headScale: 50, bodyScale: -3 },
      traits: { playful: 'very', calm: -5, curious: 99, chaotic: null },
      style: { energy: 7, order: 'wild' },
      neural: { featureSchema: 'pet-features-v1', baseline: 'starter-prior-v1', dims: { music: [75, 32, 26], drawing: [42, 40, 13] }, steps: { music: 1e12, drawing: -4 }, weights: { music: 'not base64!!', drawing: 'AAAA' } },
      phrases: [...Array.from({ length: 5 }, () => 'junk'), { title: 'A'.repeat(300), data: { tempo: 9000, beats: 64, notes: [{ beat: 0, midi: 'C4' }, { beat: 1, midi: 60, dur: 1e9, vel: 5 }, { beat: -1, midi: 61 }], hits: [{ beat: 0, midi: 999 }] } }],
      drawings: [{ data: { strokes: [{ color: 'javascript:alert(1)', width: 9, points: [[0.5, 0.5], [2, -3], ['x', 1]] }] } }],
    }).replace('"headScale":50', '"headScale":1e999');
    const proto = hostile.replace('{"format"', '{"__proto__":{"polluted":true},"format"');
    const res = parseSnapshot(proto);
    assert.equal(res.ok, true, res.message);
    const snap = res.snapshot;
    assert.equal({}.polluted, undefined, 'no prototype pollution');
    assert.equal(snap.origin, 'export', 'an import can never claim to be built in');
    assert.match(snap.id, /^snap-[a-z0-9]+$/);
    assert.equal(snap.source.petId, null);
    assert.ok(snap.source.app.length <= 24);
    assert.ok(!/[<>]/.test(snap.pet.name) && Array.from(snap.pet.name).length <= 16, snap.pet.name);
    assert.equal(snap.pet.bodyColor, '#ffb8c9');
    assert.equal(snap.pet.accentColor, '#fff1dc');
    assert.equal(snap.pet.cheekColor, '#abcdef');
    assert.equal(snap.pet.earStyle, 'bunny');
    assert.ok(snap.pet.headScale >= 0.8 && snap.pet.headScale <= 1.3);
    assert.ok(snap.pet.bodyScale >= 0.8 && snap.pet.bodyScale <= 1.25);
    for (const v of Object.values(snap.traits)) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1);
    assert.deepEqual(snap.style, { energy: 1, order: 0 });
    assert.equal(snap.neural.weights, null, 'damaged weights are dropped');
    assert.deepEqual(snap.neural.steps, { music: 0, drawing: 0 }, 'no claimed training without usable weights');
    assert.ok(res.warnings.includes('weights-invalid'));
    assert.equal(snap.phrases.length, 1);
    assert.ok(snap.phrases[0].title.length <= SNAPSHOT_LIMITS.titleMax);
    const ph = snap.phrases[0].data;
    assert.ok(ph.tempo <= 160 && ph.beats === 16 && ph.notes.length === 1 && ph.notes[0].vel <= 1 && ph.notes[0].dur <= 4 && ph.hits.length === 0);
    const st = snap.drawings[0].data.strokes[0];
    assert.equal(st.color, '#4a3f6b');
    assert.ok(st.width <= 0.08 && st.points.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1));
  });

  test('damaged weights of every kind are refused: wrong length, NaN, huge values, wrong architecture', () => {
    const s = studio();
    s.memory.addLesson('music', musicTemplate('sunny-arp'));
    train(s.neural, 5);
    const good = compactWeights(s.neural);
    const variants = [
      { ...good, weights: { ...good.weights, music: good.weights.music.slice(0, -8) } },
      { ...good, weights: { ...good.weights, music: encodeFloat32(new Float32Array(MODEL_SIZES.music).fill(Number.NaN)) } },
      { ...good, weights: { ...good.weights, drawing: encodeFloat32(new Float32Array(MODEL_SIZES.drawing).fill(5000)) } },
      { ...good, dims: { ...good.dims, music: [75, 64, 26] } },
      { ...good, featureSchema: 'pet-features-v9' },
    ];
    for (const neural of variants) {
      const res = sanitizeSnapshot({ format: SNAPSHOT_FORMAT, pet: { name: 'Bad' }, neural });
      assert.equal(res.ok, true);
      assert.equal(res.snapshot.neural.weights, null);
      assert.ok(res.warnings.includes('weights-invalid'));
    }
    assert.ok(sanitizeSnapshot({ format: SNAPSHOT_FORMAT, pet: { name: 'Good' }, neural: good }).snapshot.neural.weights);
  });
});

describe('built-in visitor pets', () => {
  test('Mochi, Bongo and Lyra are valid snapshots, ready to invite without any file', () => {
    assert.deepEqual(BUILTIN_VISITORS.map((b) => b.pet.name), ['Mochi', 'Bongo', 'Lyra']);
    const top = (b) => snapshotSummary(b).topTraits.join(' + ');
    assert.equal(top(BUILTIN_VISITORS[0]), 'Calm + Neat');
    assert.equal(top(BUILTIN_VISITORS[1]), 'Playful + Chaotic');
    assert.equal(top(BUILTIN_VISITORS[2]), 'Curious + Dramatic');
    const [mochi, bongo, lyra] = BUILTIN_VISITORS;
    assert.deepEqual([mochi.pet.earStyle, mochi.pet.bodyColor], ['bunny', '#cdb8ff'], 'pastel lavender bunny');
    assert.deepEqual([bongo.pet.earStyle, bongo.pet.bodyColor], ['horns', '#ffad5c'], 'sunny orange horned pet');
    assert.deepEqual([lyra.pet.earStyle, lyra.pet.bodyColor], ['cat', '#a8d8ff'], 'sky-blue cat-eared pet');
    for (const b of BUILTIN_VISITORS) {
      assert.equal(b.origin, 'builtin');
      assert.ok(Object.isFrozen(b));
      assert.equal(b.neural.weights, null, 'built-ins are authored: no trained weights are claimed');
      assert.equal(b.phrases.length, 2);
      assert.equal(b.drawings.length, 2);
      assert.ok(b.phrases.every((p) => p.title && !p.filled && p.data.notes.length >= 6));
      assert.ok(b.drawings.every((d) => d.title && !d.filled && d.data.strokes.length >= 5));
      const again = parseSnapshot(serializeSnapshot(b));
      assert.equal(again.ok, true);
      assert.deepEqual({ ...again.snapshot, origin: 'builtin' }, { ...b }, 'a re-imported copy only loses the built-in label');
      assert.equal(builtinVisitor(b.pet.name.toLowerCase()), b);
    }
    const stats = (b) => b.phrases.map((p) => phraseStats(p.data));
    assert.ok(stats(mochi).every((x) => x.tempo <= 90 && x.meanVel < 0.55), 'gentle lullabies');
    assert.ok(stats(bongo).every((x) => x.tempo >= 120 && x.hits >= x.notes), 'drum-heavy grooves');
    assert.ok(stats(bongo)[0].onBeatRatio < 0.75, 'syncopated');
    assert.ok(stats(lyra).every((x) => x.range >= 12), 'expressive arpeggios across the keyboard');
  });
});

describe('Jam Together and Co-Draw Together', () => {
  test('a duet is the visitor\'s call followed by the host\'s answer in its own style', () => {
    const s = studio({ traits: { calm: 0.85, playful: 0.2, neat: 0.8, chaotic: 0.1 } });
    const visitor = asVisitor(builtinVisitor('lyra'));
    const piece = composeDuet({ visitor, host: hostOf(s), index: 0, seed: 5 });
    const call = motifOf(visitor.snapshot.phrases[0].data);
    assert.equal(piece.data.beats, 16);
    assert.equal(piece.split, 8);
    assert.equal(piece.data.tempo, call.tempo, 'one shared tempo: the call\'s');
    assert.deepEqual(piece.data.notes.filter((n) => n.beat < 8), call.notes, 'the visitor plays its motif exactly');
    const answer = piece.data.notes.filter((n) => n.beat >= 8).map((n) => ({ ...n, beat: n.beat - 8 }));
    assert.ok(answer.length >= 3, 'the host answers');
    assert.deepEqual(answer, piece.answer.notes);
    assert.notDeepEqual(answer, call.notes, 'a riff, not a copy');
    assert.ok(phraseSimilarity(call, piece.answer).overall > 0.3, 'recognisably riffs on the motif');
    assert.equal(piece.generator, 'imitate-phrase-v1', 'an untrained host answers with its authored rules');
    assert.deepEqual(composeDuet({ visitor, host: hostOf(s), index: 0, seed: 5 }).data, piece.data, 'deterministic per seed');
    const lively = studio({ traits: { playful: 0.95, calm: 0.05, chaotic: 0.9, neat: 0.05 } });
    assert.notDeepEqual(composeDuet({ visitor, host: hostOf(lively), index: 0, seed: 5 }).answer, piece.answer, 'another pet answers differently');
    assert.equal(piece.demo.kind, 'music');
    assert.deepEqual(piece.demo.data, call);
    assert.equal(piece.title, 'Pico & Lyra: Comet Arpeggio');
  });

  test('a host that has practised answers with its learned networks (neural-v1)', () => {
    const s = studio();
    s.memory.addLesson('music', musicTemplate('bouncy-walk'), { title: 'Bouncy Walk' });
    train(s.neural, 40);
    const piece = composeDuet({ visitor: asVisitor(builtinVisitor('mochi')), host: hostOf(s), seed: 3 });
    assert.equal(piece.generator, 'neural-v1');
    assert.ok(piece.model.steps >= 40);
  });

  test('co-drawn strokes interleave the visitor\'s and the host\'s, each in its own hand and corner', () => {
    const s = studio({ name: 'Pico' });
    s.pet.setAppearance({ cheekColor: '#ff6f6f' });
    const visitor = asVisitor(builtinVisitor('bongo'));
    const piece = composeCoDraw({ visitor, host: hostOf(s), index: 0, seed: 9 });
    const { strokes } = piece.data;
    assert.equal(piece.owners.length, strokes.length);
    assert.match(piece.owners, /^(vh)+(v|h)*$/, 'turns alternate while both have strokes');
    assert.ok(piece.owners.includes('v') && piece.owners.includes('h'));
    const centre = (owner) => {
      const pts = strokes.filter((st, i) => piece.owners[i] === owner && st.motif !== 'signature').flatMap((st) => st.points);
      return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
    };
    const [vx, vy] = centre('v');
    const [hx, hy] = centre('h');
    assert.ok(vx < 0.5 && vy < 0.5, `visitor draws top left (${vx.toFixed(2)}, ${vy.toFixed(2)})`);
    assert.ok(hx > 0.5 && hy > 0.5, `host draws bottom right (${hx.toFixed(2)}, ${hy.toFixed(2)})`);
    const signatures = strokes.map((st, i) => [st, piece.owners[i]]).filter(([st]) => st.motif === 'signature');
    assert.deepEqual(signatures.map(([, o]) => o), ['v', 'h'], 'both sign it');
    assert.equal(signatures[1][0].color, '#ff6f6f', 'the host signs in its own cheek colour');
    assert.ok(strokes.every((st) => st.points.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1)));
    assert.deepEqual(composeCoDraw({ visitor, host: hostOf(s), index: 0, seed: 9 }).data, piece.data, 'deterministic per seed');
    assert.equal(piece.demo.kind, 'drawing');
    assert.equal(piece.title, 'Pico & Bongo: Sunny Burst');
  });

  test('duet turns follow the performance: the visitor\'s call, then the host\'s answer', () => {
    assert.equal(duetTurn(0, { tempo: 120 }).turn, 'visitor');
    assert.equal(duetTurn((8.4 * 60) / 120, { tempo: 120 }).turn, 'visitor');
    assert.equal(duetTurn((8.6 * 60) / 120, { tempo: 120 }).turn, 'host');
    assert.equal(duetTurn((17 * 60) / 120, { tempo: 120 }).turn, 'both');
    assert.equal(xylophoneBar(60), 0);
    assert.equal(xylophoneBar(81), XYLOPHONE.bars.length - 1);
    assert.equal(xylophoneBar(70), XYLOPHONE.bars.indexOf(69));
  });
});

describe('bounded social learning', () => {
  test('Learn From <Visitor> keeps the demonstration once, at half weight, bounded, and dropped before yours', () => {
    const memory = new TeachingMemory({}, { clock: () => NOW, petId: 'pet-test-1' });
    memory.addLesson('music', musicTemplate('sunny-arp'), { title: 'Sunny Arp' });
    const from = { name: 'Mochi', snapshotId: 'builtin-mochi', visitorId: 'builtin-mochi' };
    const first = memory.addSocialLesson('music', builtinVisitor('mochi').phrases[0].data, { from, title: "Mochi's Moonlit Lullaby" });
    assert.equal(first.existing, false);
    assert.equal(first.lesson.source, 'social');
    assert.equal(first.lesson.weight, SOCIAL_LESSON_WEIGHT);
    assert.equal(SOCIAL_LESSON_WEIGHT, 0.5);
    assert.deepEqual(first.lesson.from, from);
    const again = memory.addSocialLesson('music', builtinVisitor('mochi').phrases[0].data, { from, title: 'again' });
    assert.equal(again.existing, true, 'the same demonstration is kept once');
    assert.equal(memory.lessons.length, 2);
    assert.equal(memory.addSocialLesson('music', builtinVisitor('mochi').phrases[0].data, { from: { name: '' } }), null, 'a social lesson always names its visitor');
    // A forged weight on load is clamped: a social lesson never weighs more than 0.5.
    const reloaded = new TeachingMemory(JSON.parse(JSON.stringify({ ...memory.toJSON(), lessons: memory.lessons.map((l) => ({ ...l, weight: 9 })) })), { petId: 'pet-test-1' });
    assert.deepEqual(reloaded.lessons.map((l) => l.weight), [1, 0.5]);
    // Bounded: at most socialPerKind social lessons per kind.
    BUILTIN_VISITORS.flatMap((b) => b.phrases.map((p) => [b, p])).forEach(([b, p]) => {
      memory.addSocialLesson('music', p.data, { from: { name: b.pet.name, snapshotId: b.id }, title: p.title });
    });
    assert.equal(memory.lessons.filter((l) => l.source === 'social').length, MEMORY_LIMITS.socialPerKind);
    assert.equal(memory.lessons.filter((l) => l.source === 'player').length, 1, 'your lesson stays');
    // Over the per-kind cap, social lessons go first.
    for (let i = 0; i < MEMORY_LIMITS.lessonsPerKind; i++) memory.addLesson('music', { tempo: 90 + i, beats: 8, notes: [{ beat: 0, midi: 60 + i, dur: 1, vel: 0.7 }], hits: [] });
    const music = memory.lessons.filter((l) => l.kind === 'music');
    assert.equal(music.length, MEMORY_LIMITS.lessonsPerKind);
    assert.ok(music.every((l) => l.source === 'player'));
    assert.equal(memory.snapshot().lessons.social, 0);
  });

  test('social lessons train at 0.5x and never take the newest-lesson share of a batch from yours', () => {
    const memory = new TeachingMemory({}, { clock: (() => { let t = NOW; return () => (t += 1000); })(), petId: 'pet-test-2' });
    const own = memory.addLesson('music', musicTemplate('bouncy-walk'), { title: 'Bouncy Walk' });
    const social = memory.addSocialLesson('music', builtinVisitor('lyra').phrases[0].data, { from: { name: 'Lyra' }, title: "Lyra's Comet Arpeggio" }).lesson;
    const raw = trainingDataFrom(memory, null, {});
    assert.deepEqual(raw.lessons.map((l) => [l.source, l.weight]), [['player', 1], ['social', 0.5]]);
    const set = buildDatasets(raw).music;
    assert.equal(set.newest, own.id, 'your newest lesson keeps the newest share although the visitor\'s is newer');
    const ex = [...set.train, ...set.val];
    assert.ok(ex.filter((e) => e.lesson === social.id).every((e) => e.w === 0.5));
    assert.ok(ex.filter((e) => e.lesson === own.id).every((e) => e.w === 1));
    assert.ok(set.counts.social > 0);
    assert.ok(set.groups.older.some((e) => e.lesson === social.id), 'replayed with the older lessons');
    assert.ok(set.groups.recent.every((e) => e.lesson === own.id));
    // With only a visitor's lesson, it leads (there is nothing else to practise).
    const solo = new TeachingMemory({}, { clock: () => NOW, petId: 'pet-test-3' });
    const only = solo.addSocialLesson('drawing', builtinVisitor('mochi').drawings[0].data, { from: { name: 'Mochi' } }).lesson;
    assert.equal(buildDatasets(trainingDataFrom(solo, null, {})).drawing.newest, only.id);
  });

  test('the pet practises a visitor\'s lesson without losing what you taught it', () => {
    const s = studio();
    const own = s.memory.addLesson('music', musicTemplate('sunny-arp'), { title: 'Sunny Arp' });
    const untrainedOwn = s.neural.lessonLoss('music', own.id);
    train(s.neural, 60);
    const taught = s.neural.lessonLoss('music', own.id);
    assert.ok(taught < untrainedOwn * 0.7, `your lesson was learned (${untrainedOwn.toFixed(3)} -> ${taught.toFixed(3)})`);
    const social = s.memory.addSocialLesson('music', builtinVisitor('mochi').phrases[0].data, { from: { name: 'Mochi' }, title: "Mochi's Moonlit Lullaby" }).lesson;
    const before = s.neural.lessonLoss('music', social.id);
    train(s.neural, 60);
    assert.ok(s.neural.lessonSteps.music[social.id] > 0, 'Sleep Practice batches include the visitor\'s lesson');
    assert.ok(s.neural.lessonLoss('music', social.id) < before, 'and the pet gets closer to it');
    assert.ok(s.neural.lessonLoss('music', own.id) < untrainedOwn * 0.75, 'while keeping most of what you taught');
    assert.ok(s.neural.lessonSteps.music[own.id] > s.neural.lessonSteps.music[social.id], 'your lesson still gets more practice');
  });
});

describe('visits in the studio (SocialStudio)', () => {
  test('invite, jam, learn, co-draw and send home: a whole visit', () => {
    const s = studio({ name: 'Pico' });
    const social = new SocialStudio({ pet: s.pet, flow: s.flow, memory: s.memory, creative: s.creative, clock: s.clock });
    const events = [];
    social.on((e) => events.push(e.type === 'session' ? `session:${e.phase}` : e.type));
    assert.equal(social.invite(builtinVisitor('mochi'), { friendId: 'builtin-mochi' }).ok, true);
    assert.equal(social.visitor.actor.activity, 'walking', 'the friend walks in from the door');
    assert.ok(run(s.pet, social, 20, () => social.visitor.arrived) > 0);
    assert.ok(VISIT_SPOTS.hangout.some((h) => distance(h, social.visitor.actor.position) < 0.05));

    const jam = social.startJam();
    assert.equal(jam.ok, true, jam.message);
    assert.equal(s.pet.autonomy, false, 'the host stays on task');
    assert.ok(run(s.pet, social, 30, () => social.session?.phase === 'performing') >= 0);
    assert.ok(distance(s.pet.position, STATIONS.music.anchor) < 0.05, 'the host plays the studio keyboard');
    assert.ok(distance(social.visitor.actor.position, VISIT_SPOTS.jam) < 0.05, 'the visitor stands at its xylophone');
    assert.equal(s.pet.activity.type, 'playing_music');
    assert.equal(s.pet.activity.plan.mode, 'social');
    const turns = [];
    const actorActs = new Set();
    assert.ok(run(s.pet, social, 40, () => {
      const t = social.session?.turn;
      if (t && turns.at(-1) !== t) turns.push(t);
      actorActs.add(social.visitor.actor.activity);
      return social.session?.phase === 'done';
    }) > 0);
    assert.deepEqual(turns.slice(0, 2), ['visitor', 'host'], 'call, then answer');
    assert.ok(actorActs.has('playing_music') && actorActs.has('lesson'), 'the visitor plays, then listens');
    const duet = s.gallery.list().find((it) => it.origin === 'social' && it.kind === 'music');
    assert.ok(duet, 'the duet is saved to the gallery');
    assert.equal(duet.social.mode, 'jam');
    assert.equal(duet.social.split, 8);
    assert.equal(socialLabel(duet.social), 'Duet with Mochi');
    assert.equal(s.flow.barState().social.label, 'Duet with Mochi');

    assert.equal(social.canLearn(s.flow.barState().ref).ok, true);
    const learned = social.learn();
    assert.equal(learned.ok, true, learned.message);
    assert.equal(learned.weight, 0.5);
    assert.equal(s.memory.lessons.filter((l) => l.source === 'social').length, 1);
    assert.equal(social.canLearn().learned, true);

    assert.ok(run(s.pet, social, 10, () => !social.session) >= 0);
    assert.equal(s.pet.autonomy, true, 'autonomy returns after the jam');
    assert.equal(social.startCoDraw().ok, true);
    assert.ok(run(s.pet, social, 30, () => social.session?.phase === 'performing') >= 0);
    assert.ok(distance(social.visitor.actor.position, VISIT_SPOTS.codraw) < 0.05);
    assert.equal(social.visitor.actor.activity, 'drawing');
    assert.ok(run(s.pet, social, 60, () => social.session?.phase === 'done') > 0);
    const pic = s.gallery.list().find((it) => it.origin === 'social' && it.kind === 'drawing');
    assert.equal(socialLabel(pic.social), 'Co-Drawn with Mochi');
    assert.equal(pic.social.owners.length, pic.data.strokes.length);
    assert.equal(social.visitor.draws, 1);

    assert.equal(social.sendHome().ok, true);
    assert.ok(run(s.pet, social, 20, () => !social.visitor) > 0, 'the friend walks out and leaves');
    assert.ok(events.includes('arrived') && events.includes('session:done') && events.includes('learned') && events.includes('left'));
  });

  test('a napping host cannot jam, and redirecting the host cancels the session cleanly', () => {
    const s = studio();
    const social = new SocialStudio({ pet: s.pet, flow: s.flow, memory: s.memory, creative: s.creative, clock: s.clock });
    social.invite(builtinVisitor('bongo'), { instant: true });
    assert.equal(social.visitor.arrived, true);
    s.pet.setNeeds({ energy: 40 });
    s.pet.sleep();
    run(s.pet, social, 30, () => s.pet.isAsleep);
    const res = social.startJam();
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'asleep');
    assert.equal(social.session, null);
    s.pet.wake();
    s.pet.setNeeds({ energy: 95, hunger: 30 });
    assert.equal(social.startCoDraw().ok, true);
    s.pet.feed(); // the player sends the host to the Snack Bar mid-gathering
    assert.equal(social.session, null, 'the session ends');
    assert.equal(s.pet.autonomy, true);
    assert.equal(s.pet.activity.station, 'food', 'the host goes where the player asked');
    assert.equal(social.startJam().ok, true, 'a new jam request is a player command too, so the host heads over');
    assert.equal(s.pet.activity.station, null);
  });

  test('a snapshot of the host itself visits as a distinct copy', () => {
    const s = studio({ name: 'Doodle' });
    const social = new SocialStudio({ pet: s.pet, flow: s.flow, memory: s.memory, creative: s.creative, clock: s.clock });
    const snap = createSnapshot({ pet: s.pet, gallery: s.gallery, memory: s.memory, neural: s.neural, now: NOW });
    const res = social.invite(parseSnapshot(serializeSnapshot(snap)).snapshot, { friendId: 'friend-abc', origin: 'import', instant: true });
    assert.equal(res.ok, true);
    assert.equal(res.visitor.displayName, 'Doodle (copy)');
    assert.notEqual(res.visitor.id, s.pet.id, 'the copy has its own identity');
  });

  test('friends persist with distinct local identities, bounded and sanitised', () => {
    const storage = new MemoryStorage();
    let t = NOW;
    const store = new FriendsStore({}, { clock: () => (t += 1000) });
    const make = (name, i) => sanitizeSnapshot({ format: SNAPSHOT_FORMAT, id: `snap-test-${i}`, pet: { name } }).snapshot;
    const a = store.add(make('Pip', 1));
    assert.equal(a.ok, true);
    assert.match(a.friend.localId, /^friend-/);
    assert.notEqual(a.friend.localId, a.friend.snapshot.id, 'a distinct local identity');
    assert.equal(store.add(make('Pip', 1)).existing, true);
    for (let i = 2; i <= 6; i++) store.add(make(`Pal${i}`, i));
    assert.equal(store.friends.length, FRIENDS_LIMITS.imported);
    assert.equal(store.all().length, 3 + FRIENDS_LIMITS.imported);
    assert.equal(store.get('mochi').origin, 'builtin');
    const kept = store.friends.at(-1);
    store.setVisit(kept.localId);
    assert.equal(saveFriends(store, storage, NOW).ok, true);
    const back = loadFriends(storage).friends;
    assert.deepEqual(back.friends.map((f) => f.localId), store.friends.map((f) => f.localId));
    assert.equal(back.visit.friendId, kept.localId);
    assert.deepEqual(back.get(kept.localId).snapshot, kept.snapshot);
    // Hostile records: bad ids, unknown visits and foreign snapshots are dropped.
    storage.setItem(FRIENDS_KEY, JSON.stringify({
      schema: 'petstudio.friends', version: 1,
      friends: [{ localId: '../evil', snapshot: make('X', 7) }, { localId: 'friend-ok1', snapshot: { format: 'nope' } }, { localId: 'friend-ok2', snapshot: { ...make('Ok', 8), origin: 'builtin' } }],
      visit: { friendId: 'friend-missing' },
    }));
    const hostile = loadFriends(storage).friends;
    assert.deepEqual(hostile.friends.map((f) => f.localId), ['friend-ok2']);
    assert.equal(hostile.friends[0].snapshot.origin, 'export');
    assert.equal(hostile.visit, null);
  });

  test('the visitor actor walks paths at its own pace and reports its view', () => {
    const actor = new VisitorActor({ traits: builtinVisitor('bongo').traits, position: VISIT_SPOTS.door });
    const eta = actor.walkTo(VISIT_SPOTS.jam, { hurry: true });
    assert.ok(eta > 0.5 && eta < 6);
    for (let i = 0; i < 100 && actor.walking; i++) actor.update(0.1);
    assert.equal(actor.walking, false);
    assert.ok(distance(actor.position, VISIT_SPOTS.jam) < 1e-6);
    assert.ok(Math.abs(actor.heading - VISIT_SPOTS.jam.facing) < 1e-9);
    const v = actor.view();
    assert.deepEqual(Object.keys(v).sort(), ['activity', 'bubble', 'elevation', 'expression', 'heading', 'position', 'walkSpeed']);
  });
});
