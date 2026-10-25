/**
 * End-to-end tests of the teaching loop in Node (no DOM): the real pet
 * simulation (PetState) driven through CreationFlow, the teaching memory and
 * the gallery. Teach -> listen -> walk -> perform the attempt -> save it ->
 * feedback (Love It, Try Variation, style nudges), plus declines,
 * interruptions, gallery replays, starter creations and reload resumption.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { PetState, savePet, loadPet } from '../src/pet-state.js';
import { STATIONS, distance } from '../src/studio-layout.js';
import { CreationFlow, FLOW, performSecondsFor, listenSecondsFor } from '../src/creation-flow.js';
import { TeachingMemory, saveTeachingMemory, loadTeachingMemory } from '../src/teaching-memory.js';
import { GalleryStore, saveGallery, loadGallery } from '../src/gallery-store.js';
import { MUSIC_GENERATOR, DRAWING_GENERATOR } from '../src/creative-engine.js';
import { STARTER_PHRASE_GENERATOR } from '../src/starter-repertoire.js';
import { musicTemplate, drawingTemplate, sanitizePhrase, sanitizeDrawing, phraseSimilarity, drawingSimilarity } from '../src/teaching-core.js';

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

function setup({ seed = 2024, needs = {}, traits, autonomy = false } = {}) {
  let t = NOW;
  const clock = () => (t += 1000);
  const pet = PetState.create({ seed, now: NOW, clock: () => NOW, needs: { energy: 95, hunger: 90, hygiene: 95, ...needs }, traits, autonomy });
  const memory = new TeachingMemory({}, { clock, petId: pet.id, sessionId: 'session-flow' });
  const gallery = new GalleryStore({}, { clock });
  const flow = new CreationFlow({ pet, memory, gallery, clock });
  const events = [];
  flow.on((e) => events.push(e));
  return { pet, memory, gallery, flow, events, clock };
}

/** Steps the simulation until predicate(pet) holds; returns the simulated seconds or -1. */
function runUntil(pet, predicate, maxSeconds = 120, step = 0.1) {
  for (let t = 0; t <= maxSeconds; t += step) {
    if (predicate(pet)) return t;
    pet.update(step);
  }
  return -1;
}

describe('teaching -> pet attempt flow', () => {
  test('music: the pet listens, walks to the Music Corner, performs its attempt and saves it linked to the lesson', () => {
    const { pet, memory, gallery, flow, events } = setup();
    const lessonPhrase = musicTemplate('sunny-arp');
    const res = flow.teach('music', lessonPhrase, { templateId: 'sunny-arp' });
    assert.equal(res.ok, true, res.message);

    // 1. It listens attentively first.
    assert.equal(pet.activity.type, 'lesson');
    assert.equal(pet.activity.plan.ref, res.plan.ref);
    assert.equal(pet.getExpression(), 'curious');
    assert.equal(pet.getBubble().icon, 'listen');
    assert.ok(Math.abs(pet.activity.duration - listenSecondsFor('music', sanitizePhrase(lessonPhrase))) < 1e-6);
    assert.equal(flow.barState().phase, 'lesson');
    assert.equal(flow.barState().canFeedback, false, 'no feedback until the pet performs');

    // 2. The demonstration is in teaching memory with full note events, and in the gallery.
    const lesson = memory.getLesson(res.lesson.id);
    assert.deepEqual(lesson.demo.notes, sanitizePhrase(lessonPhrase).notes);
    assert.ok(lesson.demo.notes.every((n) => ['beat', 'midi', 'dur', 'vel'].every((k) => Number.isFinite(n[k]))));
    assert.equal(lesson.templateId, 'sunny-arp');
    assert.equal(gallery.get(res.taught.id).origin, 'taught');
    assert.equal(gallery.get(res.taught.id).title, 'Your Sunny Arp');
    assert.equal(memory.pendingPlan.ref, res.plan.ref);
    assert.ok(events.some((e) => e.type === 'lesson'));

    // 3. Then it walks to the Music Corner...
    assert.ok(runUntil(pet, (p) => p.activity.type === 'walking') >= 0);
    assert.equal(pet.activity.station, 'music');
    assert.equal(pet.activity.plan.ref, res.plan.ref);
    assert.equal(flow.barState().phase, 'walking');

    // 4. ...and performs its own attempt, inspired by (not copied from) the lesson.
    assert.ok(runUntil(pet, (p) => p.activity.type === 'playing_music') >= 0);
    assert.ok(distance(pet.position, STATIONS.music.anchor) < 1e-9);
    assert.ok(Math.abs(pet.activity.duration - performSecondsFor('music', res.plan.data)) < 1e-6);
    const performed = flow.phraseFor(pet.activity);
    assert.deepEqual(performed, res.plan.data);
    assert.notDeepEqual(performed.notes, sanitizePhrase(lessonPhrase).notes, 'an attempt, not a copy');
    assert.ok(phraseSimilarity(lessonPhrase, performed).overall > 0.5, 'recognisably inspired by the lesson');
    assert.equal(flow.barState().phase, 'performing');
    assert.equal(flow.barState().canFeedback, true);
    assert.match(pet.snapshot().status.text, /own take/);

    // 5. When it finishes, the attempt is saved and linked to its lesson.
    assert.ok(runUntil(pet, (p) => p.activity.type !== 'playing_music', 60) >= 0);
    const attempt = gallery.list().find((it) => it.origin === 'attempt');
    assert.ok(attempt, 'the attempt is in the gallery');
    assert.equal(attempt.kind, 'music');
    assert.equal(attempt.parentId, res.taught.id);
    assert.equal(attempt.lessonId, lesson.id);
    assert.equal(attempt.generator, MUSIC_GENERATOR);
    assert.deepEqual(attempt.data, res.plan.data);
    assert.deepEqual(memory.getLesson(lesson.id).attempts, [attempt.id]);
    assert.equal(memory.pendingPlan, null);
    assert.equal(pet.counters.songs, 1);
    assert.deepEqual(flow.barState().visible && flow.barState().phase, 'done');
    assert.ok(events.some((e) => e.type === 'creation' && e.item?.id === attempt.id));
  });

  test('drawing: the pet studies the drawing, then draws its attempt progressively on the easel', () => {
    const { pet, gallery, flow } = setup();
    const demo = drawingTemplate('heart', { color: '#ff7fa3', width: 0.03 });
    const res = flow.teach('drawing', demo, { templateId: 'heart' });
    assert.equal(res.ok, true);
    assert.equal(pet.getBubble().icon, 'idea');
    assert.match(pet.snapshot().status.text, /Studying your drawing/);
    assert.ok(runUntil(pet, (p) => p.activity.type === 'drawing') >= 0);
    assert.equal(pet.currentDrawing.ref, res.plan.ref, 'the easel knows which drawing to paint');
    const drawing = flow.drawingFor(pet.currentDrawing);
    assert.deepEqual(drawing, res.plan.data);
    assert.ok(drawingSimilarity(demo, drawing) > 0.3);
    pet.update(3);
    const mid = pet.currentDrawing.progress;
    assert.ok(mid > 0 && mid < 1, `progressive (${mid})`);
    pet.update(3);
    assert.ok(pet.currentDrawing.progress > mid);
    assert.ok(runUntil(pet, (p) => p.activity.type !== 'drawing', 60) >= 0);
    assert.equal(pet.currentDrawing.complete, true);
    const attempt = gallery.list({ kind: 'drawing' }).find((it) => it.origin === 'attempt');
    assert.equal(attempt.generator, DRAWING_GENERATOR);
    assert.equal(attempt.parentId, res.taught.id);
  });

  test('Love It favourites the creation, records a +1.0 preference signal and boosts bond and mood', () => {
    const { pet, memory, gallery, flow } = setup({ needs: { bond: 40, mood: 50 } });
    const res = flow.teach('music', musicTemplate('bouncy-walk'));
    assert.equal(flow.love().ok, false, 'nothing to love while it is still listening');
    runUntil(pet, (p) => p.activity.type === 'playing_music');
    pet.update(2);
    const before = { ...pet.needs };
    const love = flow.love();
    assert.equal(love.ok, true);
    assert.equal(love.item.favorite, true);
    assert.equal(love.item.origin, 'attempt');
    assert.equal(love.item.feedback.reward, 1);
    assert.equal(love.signal.kind, 'love');
    assert.equal(love.signal.label, 'preference');
    assert.equal(love.signal.reward, 1);
    assert.equal(love.signal.lessonId, res.lesson.id);
    assert.equal(love.reaction.kind, 'love');
    assert.ok(pet.needs.bond > before.bond + 3, 'bond grows');
    assert.ok(pet.needs.mood > before.mood + 4, 'mood grows');
    assert.equal(flow.barState().loved, true);
    const count = gallery.items.length;
    runUntil(pet, (p) => p.activity.type !== 'playing_music', 60);
    assert.equal(gallery.items.length, count, 'finishing a loved creation does not save it twice');
    assert.equal(memory.signals.filter((s) => s.kind === 'love').length, 1);
  });

  test('Try Variation performs another attempt with a new seed', () => {
    const { pet, memory, gallery, flow } = setup();
    const res = flow.teach('music', musicTemplate('playful-hop'));
    runUntil(pet, (p) => p.activity.type === 'playing_music');
    runUntil(pet, (p) => p.activity.type !== 'playing_music', 60);
    const first = gallery.list().find((it) => it.origin === 'attempt');
    const v = flow.variation();
    assert.equal(v.ok, true, v.message);
    assert.notEqual(v.plan.seed, res.plan.seed);
    assert.equal(v.plan.mode, 'variation');
    assert.equal(v.plan.lessonId, res.lesson.id, 'a variation riffs on the original lesson');
    assert.equal(memory.signals.at(-1).kind, 'variation');
    assert.equal(memory.signals.at(-1).label, 'request');
    assert.ok(runUntil(pet, (p) => p.activity.type === 'playing_music' && p.activity.plan?.ref === v.plan.ref, 30) >= 0);
    runUntil(pet, (p) => p.activity.type !== 'playing_music', 60);
    const attempts = gallery.list().filter((it) => it.origin === 'attempt');
    assert.equal(attempts.length, 2);
    assert.notDeepEqual(attempts[0].data, first.data);
    assert.equal(attempts[0].parentId, res.taught.id);
    assert.equal(memory.getLesson(res.lesson.id).attempts.length, 2);
  });

  test('style nudges store a direction signal, update the preferences and trigger a guided retry', () => {
    const { pet, memory, gallery, flow } = setup();
    flow.teach('drawing', drawingTemplate('star'));
    runUntil(pet, (p) => p.activity.type === 'drawing');
    runUntil(pet, (p) => p.activity.type !== 'drawing', 60);
    const first = gallery.list().find((it) => it.origin === 'attempt');
    const firstStyle = flow.subject.style;
    const r = flow.nudge('calmer');
    assert.equal(r.ok, true, r.message);
    assert.ok(r.prefs.energy < 0, 'guidance moved toward calmer');
    assert.equal(memory.prefs.energy, r.prefs.energy);
    assert.equal(r.signal.kind, 'nudge');
    assert.equal(r.signal.label, 'direction');
    assert.equal(r.signal.nudge, 'calmer');
    assert.deepEqual(gallery.get(first.id).feedback.nudges, ['calmer'], 'the nudge is recorded on the creation it was about');
    assert.equal(r.plan.tags[0], 'calmer');
    assert.ok(r.plan.style.energy < firstStyle.energy, 'the retry uses the calmer guidance');
    runUntil(pet, (p) => p.activity.type === 'drawing' && p.activity.plan?.ref === r.plan.ref, 30);
    runUntil(pet, (p) => p.activity.type !== 'drawing', 60);
    const retry = gallery.list().find((it) => it.origin === 'attempt');
    assert.notEqual(retry.id, first.id);
    assert.ok(retry.tags.includes('calmer'));
    assert.match(retry.title, /calmer take/);
    assert.equal(flow.nudge('sideways').ok, false);
  });

  test('a napping pet cannot take a lesson, and nothing is stored', () => {
    const { pet, memory, gallery, flow } = setup({ needs: { energy: 20 } });
    pet.sleep();
    runUntil(pet, (p) => p.isAsleep, 60);
    const res = flow.teach('music', musicTemplate('sunny-arp'));
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'asleep');
    assert.match(res.message, /napping/);
    assert.equal(memory.lessons.length, 0);
    assert.equal(gallery.items.length, 0);
    assert.equal(flow.barState().visible, false);
    assert.equal(pet.isAsleep, true);
  });

  test('empty or unknown lessons are rejected', () => {
    const { flow } = setup();
    assert.equal(flow.teach('music', { notes: [], hits: [] }).reason, 'empty');
    assert.equal(flow.teach('drawing', { strokes: [] }).reason, 'empty');
    assert.equal(flow.teach('dance', {}).reason, 'bad-kind');
    assert.equal(flow.variation().ok, false);
  });

  test('redirecting the pet mid-lesson or mid-performance discards the unfinished attempt', () => {
    const { pet, memory, gallery, flow } = setup({ needs: { hunger: 50 } });
    flow.teach('music', musicTemplate('sunny-arp'));
    pet.update(1);
    pet.feed();
    assert.equal(flow.subject.phase, 'interrupted');
    assert.equal(flow.barState().visible, false);
    assert.equal(memory.pendingPlan, null);

    flow.teach('drawing', drawingTemplate('spiral'));
    runUntil(pet, (p) => p.activity.type === 'drawing');
    pet.update(2);
    pet.goTo('rug');
    assert.equal(flow.subject.phase, 'interrupted');
    assert.equal(gallery.list().filter((it) => it.origin === 'attempt').length, 0, 'unfinished work is never saved');
    assert.equal(gallery.list().filter((it) => it.origin === 'taught').length, 2, 'the lessons themselves are kept');
    assert.equal(pet.currentDrawing.complete, false);
  });

  test('performing a gallery item replays it without creating a duplicate', () => {
    const { pet, memory, gallery, flow } = setup();
    const res = flow.teach('music', musicTemplate('starlight-lullaby'));
    runUntil(pet, (p) => p.activity.type === 'idle' && flow.subject.phase === 'done', 90);
    const count = gallery.items.length;
    const p = flow.perform(res.taught.id);
    assert.equal(p.ok, true);
    assert.equal(p.plan.mode, 'replay');
    assert.equal(memory.signals.at(-1).kind, 'perform');
    runUntil(pet, (x) => x.activity.type === 'playing_music' && x.activity.plan?.ref === p.plan.ref, 30);
    assert.match(pet.snapshot().status.text, /saved song/);
    assert.deepEqual(flow.phraseFor(pet.activity), gallery.get(res.taught.id).data, 'it plays exactly what was taught');
    runUntil(pet, (x) => x.activity.type !== 'playing_music', 60);
    assert.equal(gallery.items.length, count);
    assert.equal(flow.barState().itemId, res.taught.id, 'feedback applies to the replayed item');
    assert.equal(flow.perform('item-missing-1').ok, false);
  });

  test("the pet's own starter creations become Starter items and can be loved", () => {
    const { pet, gallery, flow } = setup();
    pet.goPlayMusic();
    runUntil(pet, (p) => p.activity.type === 'playing_music');
    assert.equal(flow.subject.origin, 'starter');
    assert.equal(flow.barState().canFeedback, true);
    runUntil(pet, (p) => p.activity.type !== 'playing_music', 60);
    const item = gallery.list()[0];
    assert.equal(item.origin, 'starter');
    assert.equal(item.generator, STARTER_PHRASE_GENERATOR);
    assert.match(item.title, /little tune #1/);
    const love = flow.love();
    assert.equal(love.ok, true);
    assert.equal(love.item.id, item.id);
    assert.equal(gallery.items.length, 1);
  });

  test('a reload mid-performance resumes the planned attempt and still saves it', () => {
    const storage = new MemoryStorage();
    const { pet, memory, gallery, flow } = setup();
    const res = flow.teach('music', musicTemplate('sunny-arp'));
    runUntil(pet, (p) => p.activity.type === 'playing_music');
    pet.update(2);
    savePet(pet, storage, NOW);
    saveTeachingMemory(memory, storage, NOW);
    saveGallery(gallery, storage, NOW);

    const { pet: pet2 } = loadPet(storage, { now: NOW + 5000, clock: () => NOW + 5000 });
    pet2.autonomy = false;
    const { memory: memory2 } = loadTeachingMemory(storage, { petId: pet2.id });
    const { gallery: gallery2 } = loadGallery(storage);
    const flow2 = new CreationFlow({ pet: pet2, memory: memory2, gallery: gallery2 });
    assert.equal(pet2.activity.type, 'playing_music');
    assert.equal(pet2.activity.plan.ref, res.plan.ref);
    assert.deepEqual(flow2.phraseFor(pet2.activity), res.plan.data, 'the same attempt resumes');
    assert.equal(flow2.subject.phase, 'performing');
    runUntil(pet2, (p) => p.activity.type !== 'playing_music', 60);
    const attempt = gallery2.list().find((it) => it.origin === 'attempt');
    assert.ok(attempt);
    assert.equal(attempt.parentId, res.taught.id);
  });

  test('the feedback bar lingers after a creation, then hides; it can be dismissed', () => {
    const { pet, flow } = setup();
    flow.teach('drawing', drawingTemplate('sun'));
    runUntil(pet, (p) => p.activity.type === 'drawing');
    const b = flow.barState();
    assert.equal(b.visible, true);
    assert.ok(b.progress >= 0 && b.progress < 0.2);
    assert.equal(b.kind, 'drawing');
    assert.equal(b.origin, 'attempt');
    runUntil(pet, (p) => p.activity.type !== 'drawing', 60);
    assert.equal(flow.barState().progress, 1);
    pet.update(FLOW.barHoldSeconds - 2);
    assert.equal(flow.barState().visible, true);
    pet.update(4);
    assert.equal(flow.barState().visible, false, 'hidden after the hold time');
    flow.teach('music', musicTemplate('sunny-arp'));
    assert.equal(flow.barState().visible, true);
    flow.dismiss();
    assert.equal(flow.barState().visible, false);
  });

  test('two pets with different temperaments answer the same lesson differently', () => {
    const lesson = musicTemplate('bouncy-walk');
    const a = setup({ seed: 1, traits: { playful: 0.95, calm: 0.05, chaotic: 0.9, neat: 0.05 } });
    const b = setup({ seed: 1, traits: { playful: 0.05, calm: 0.95, chaotic: 0.05, neat: 0.95 } });
    const ra = a.flow.teach('music', lesson);
    const rb = b.flow.teach('music', lesson);
    assert.ok(ra.plan.data.tempo > rb.plan.data.tempo, 'the playful pet plays it faster');
    assert.ok(ra.plan.style.order > rb.plan.style.order);
  });
});
