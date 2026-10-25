/**
 * Tests for the persistent teaching memory (replay buffer) and the creation
 * gallery: versioned records, last-known-good backups, future-version
 * preservation, sanitisation of hostile data, bounded retention and storage
 * quota handling.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TeachingMemory, loadTeachingMemory, saveTeachingMemory, clearTeachingMemory, sanitizeMemoryRecord,
  TEACH_KEY, TEACH_BACKUP_KEY, TEACH_FUTURE_KEY, TEACH_ORPHAN_KEY, TEACH_SCHEMA, TEACH_VERSION, MEMORY_LIMITS, SIGNAL_LABELS,
} from '../src/teaching-memory.js';
import {
  GalleryStore, loadGallery, saveGallery, clearGallery, sanitizeItem,
  GALLERY_KEY, GALLERY_BACKUP_KEY, GALLERY_FUTURE_KEY, GALLERY_SCHEMA, GALLERY_VERSION, GALLERY_LIMITS, ORIGIN_LABELS,
} from '../src/gallery-store.js';
import { musicTemplate, drawingTemplate, templateStrokes } from '../src/teaching-core.js';

const NOW = 1_760_000_000_000;

class MemoryStorage {
  constructor({ quota = Infinity } = {}) {
    this.map = new Map();
    this.quota = quota;
  }
  get used() {
    let n = 0;
    for (const [k, v] of this.map) n += k.length + v.length;
    return n;
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    const s = String(v);
    const after = this.used - (this.map.get(k)?.length ?? 0) - (this.map.has(k) ? k.length : 0) + k.length + s.length;
    if (after > this.quota) {
      const err = new Error('The quota has been exceeded.');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.map.set(k, s);
  }
  removeItem(k) {
    this.map.delete(k);
  }
}

function ticking(start = NOW) {
  let t = start;
  return () => (t += 1000);
}

const tune = () => musicTemplate('sunny-arp');
const star = () => drawingTemplate('star', { color: '#ff7fa3' });

describe('teaching memory (replay buffer)', () => {
  test('stores demonstrations in the full note-event and stroke representation and round-trips', () => {
    const storage = new MemoryStorage();
    const mem = new TeachingMemory({}, { clock: ticking(), petId: 'pet-abc123', sessionId: 'session-test' });
    const music = mem.addLesson('music', tune(), { templateId: 'sunny-arp', title: 'Sunny Arp', petName: 'Mochi' });
    const drawing = mem.addLesson('drawing', star());
    assert.ok(music && drawing);
    assert.equal(music.session, 'session-test', 'lessons remember their originating session');
    assert.deepEqual(Object.keys(music.demo.notes[0]).sort(), ['beat', 'dur', 'midi', 'vel']);
    assert.equal(drawing.demo.strokes[0].points[0].length, 4, 'strokes keep x, y, pressure, dt');
    assert.equal(mem.addLesson('music', { notes: [] }), null, 'empty demonstrations are not stored');
    mem.linkAttempt(music.id, 'item-xyz-1');
    assert.equal(saveTeachingMemory(mem, storage, NOW).ok, true);
    const { memory, status } = loadTeachingMemory(storage, { petId: 'pet-abc123' });
    assert.equal(status, 'loaded');
    assert.equal(memory.lessons.length, 2);
    assert.deepEqual(memory.getLesson(music.id).demo, music.demo);
    assert.deepEqual(memory.getLesson(music.id).attempts, ['item-xyz-1']);
    assert.equal(memory.lessonsOf('drawing')[0].id, drawing.id);
  });

  test('feedback signals carry explicit semantic labels (a love is a preference, not a target label)', () => {
    const mem = new TeachingMemory({}, { clock: ticking() });
    const love = mem.recordSignal({ kind: 'love', itemId: 'item-a-1', reward: 1 });
    const nudge = mem.recordSignal({ kind: 'nudge', nudge: 'calmer', itemId: 'item-a-1' });
    const again = mem.recordSignal({ kind: 'variation', itemId: 'item-a-1' });
    assert.equal(love.label, 'preference');
    assert.equal(love.reward, 1);
    assert.equal(nudge.label, 'direction');
    assert.equal(nudge.nudge, 'calmer');
    assert.equal(again.label, 'request');
    assert.equal(again.reward, null);
    assert.equal(mem.recordSignal({ kind: 'telepathy' }), null);
    assert.deepEqual(SIGNAL_LABELS, { love: 'preference', nudge: 'direction', variation: 'request', perform: 'request' });
  });

  test('nudges accumulate style guidance with counts', () => {
    const mem = new TeachingMemory({}, { clock: ticking() });
    mem.applyNudge('calmer');
    mem.applyNudge('calmer');
    mem.applyNudge('wilder');
    assert.ok(mem.prefs.energy < -0.6 && mem.prefs.order > 0.3);
    assert.deepEqual(mem.nudgeCounts, { calmer: 2, livelier: 0, neater: 0, wilder: 1 });
  });

  test('retention keeps at most 12 lessons per kind (newest) and 200 signals', () => {
    const mem = new TeachingMemory({}, { clock: ticking() });
    const ids = [];
    for (let i = 0; i < 20; i++) ids.push(mem.addLesson('music', { ...tune(), tempo: 70 + i }).id);
    mem.addLesson('drawing', star());
    assert.equal(mem.lessonsOf('music').length, MEMORY_LIMITS.lessonsPerKind);
    assert.ok(!mem.getLesson(ids[0]), 'the oldest lesson was dropped');
    assert.ok(mem.getLesson(ids.at(-1)));
    assert.equal(mem.lessonsOf('drawing').length, 1, 'kinds are bounded independently');
    for (let i = 0; i < 260; i++) mem.recordSignal({ kind: 'variation' });
    assert.equal(mem.signals.length, MEMORY_LIMITS.signals);
  });

  test('a torn save falls back to the backup; a newer version is preserved', () => {
    const storage = new MemoryStorage();
    const mem = new TeachingMemory({}, { clock: ticking(), petId: 'pet-abc123' });
    mem.addLesson('music', tune());
    saveTeachingMemory(mem, storage, NOW);
    mem.addLesson('drawing', star());
    saveTeachingMemory(mem, storage, NOW + 1);
    storage.setItem(TEACH_KEY, '{"schema":"petstudio.teach","version":1,"lessons":[');
    const restored = loadTeachingMemory(storage, { petId: 'pet-abc123' });
    assert.equal(restored.status, 'restored-backup');
    assert.equal(restored.memory.lessons.length, 1, 'the previous good save');

    const future = JSON.stringify({ schema: TEACH_SCHEMA, version: TEACH_VERSION + 1, lessons: [] });
    const s2 = new MemoryStorage();
    s2.setItem(TEACH_KEY, future);
    const res = loadTeachingMemory(s2);
    assert.equal(res.status, 'future-version');
    assert.equal(s2.getItem(TEACH_FUTURE_KEY), future);
    assert.equal(res.memory.lessons.length, 0);
    assert.equal(loadTeachingMemory(null).status, 'unavailable');
  });

  test('hostile records are sanitised', () => {
    const r = sanitizeMemoryRecord({
      petId: '<script>',
      prefs: { energy: 40, order: Number.NaN },
      lessons: [
        { id: 'lesson-1', kind: 'music', demo: { tempo: 5000, notes: [{ beat: 0, midi: 60 }, { beat: 1, midi: 999 }] }, title: '<b>Hi</b>\u0000' },
        { id: 'bad id!', kind: 'music', demo: tune() },
        { id: 'lesson-2', kind: 'sculpture', demo: {} },
        { id: 'lesson-3', kind: 'drawing', demo: { strokes: [] } },
        'junk',
      ],
      signals: [{ id: 'signal-1', kind: 'love', reward: 50, itemId: '../../etc' }, { id: 'signal-2', kind: 'hack' }],
      pendingPlan: { ref: 'a b', kind: 'music', data: tune() },
      nudgeCounts: { calmer: -4, wilder: 2.5 },
    });
    assert.equal(r.petId, null);
    assert.deepEqual(r.prefs, { energy: 1, order: 0 });
    assert.equal(r.lessons.length, 1);
    assert.equal(r.lessons[0].demo.tempo, 160);
    assert.equal(r.lessons[0].demo.notes.length, 1);
    assert.equal(r.lessons[0].title, 'bHi/b');
    assert.equal(r.signals.length, 1);
    assert.equal(r.signals[0].reward, 1);
    assert.equal(r.signals[0].itemId, null);
    assert.equal(r.pendingPlan, null);
    assert.deepEqual(r.nudgeCounts, { calmer: 0, livelier: 0, neater: 0, wilder: 0 });
  });

  test("another pet's memory is moved aside instead of being reused", () => {
    const storage = new MemoryStorage();
    const mem = new TeachingMemory({}, { clock: ticking(), petId: 'pet-old111' });
    mem.addLesson('music', tune());
    saveTeachingMemory(mem, storage, NOW);
    const res = loadTeachingMemory(storage, { petId: 'pet-new222' });
    assert.equal(res.status, 'other-pet');
    assert.equal(res.memory.lessons.length, 0);
    assert.equal(res.memory.petId, 'pet-new222');
    assert.match(storage.getItem(TEACH_ORPHAN_KEY), /pet-old111/);
    assert.equal(clearTeachingMemory(storage), true);
    assert.equal(storage.getItem(TEACH_KEY), null);
    assert.equal(storage.getItem(TEACH_BACKUP_KEY), null);
  });

  test('pending plans survive a save so a performance can resume after a reload', () => {
    const storage = new MemoryStorage();
    const mem = new TeachingMemory({}, { clock: ticking() });
    mem.setPendingPlan({ ref: 'a-1-1', kind: 'music', mode: 'attempt', data: tune(), seed: 42, tags: ['calmer', 'bogus'] });
    saveTeachingMemory(mem, storage, NOW);
    const { memory } = loadTeachingMemory(storage);
    assert.equal(memory.pendingPlan.ref, 'a-1-1');
    assert.equal(memory.pendingPlan.seed, 42);
    assert.deepEqual(memory.pendingPlan.tags, ['calmer']);
    assert.equal(memory.clearPendingPlan('other'), false);
    assert.equal(memory.clearPendingPlan('a-1-1'), true);
  });
});

describe('creation gallery', () => {
  const add = (g, origin, kind = 'drawing', extra = {}) => g.add({
    kind, origin, data: kind === 'music' ? tune() : star(), title: `${origin} ${kind}`, petId: 'pet-abc123', petName: 'Mochi', ...extra,
  });

  test('items carry origin badges, timestamps, titles, favourites and direction tags', () => {
    const g = new GalleryStore({}, { clock: ticking() });
    const taught = add(g, 'taught', 'music', { title: 'Your Sunny Arp', templateId: 'sunny-arp' });
    const attempt = add(g, 'attempt', 'music', { parentId: taught.id, tags: ['calmer', 'calmer', 'nonsense'] });
    assert.equal(ORIGIN_LABELS[taught.origin], 'Taught by You');
    assert.equal(ORIGIN_LABELS[attempt.origin], 'Pet Attempt');
    assert.equal(ORIGIN_LABELS.starter, 'Starter');
    assert.ok(attempt.createdAt > taught.createdAt);
    assert.deepEqual(attempt.tags, ['calmer']);
    assert.equal(attempt.parentId, taught.id);
    assert.equal(g.list()[0].id, attempt.id, 'newest first');
    assert.equal(g.toggleFavorite(taught.id), true);
    assert.deepEqual(g.list({ favorites: true }).map((x) => x.id), [taught.id]);
    assert.equal(g.list({ kind: 'drawing' }).length, 0);
    g.recordFeedback(attempt.id, { reward: 1, love: true, nudge: 'wilder' });
    assert.deepEqual(g.get(attempt.id).feedback, { reward: 1, loves: 1, nudges: ['wilder'] });
    assert.equal(g.add({ kind: 'music', origin: 'taught', data: { notes: [] } }), null, 'empty creations are rejected');
    assert.equal(g.add({ kind: 'poem', origin: 'taught', data: tune() }), null);
  });

  test('bounded to 40 items: oldest starter pieces go first; favourites and the pinned drawing survive', () => {
    const g = new GalleryStore({}, { clock: ticking() });
    const fav = add(g, 'taught');
    g.setFavorite(fav.id, true);
    const pinned = add(g, 'attempt');
    g.pin(pinned.id);
    const firstTaught = add(g, 'taught');
    for (let i = 0; i < 8; i++) add(g, 'starter');
    for (let i = 0; i < 40; i++) add(g, i % 2 ? 'attempt' : 'taught');
    // 51 items were added: 22 lessons, 21 attempts, 8 starter pieces -> 11 must go.
    assert.equal(g.items.length, GALLERY_LIMITS.maxItems);
    assert.ok(g.get(fav.id), 'favourites are kept');
    assert.ok(g.get(pinned.id), 'the pinned drawing is kept');
    assert.equal(g.counts().starter, 0, 'all 8 starter pieces were evicted first');
    assert.equal(g.counts().attempt, 21 - 3, 'then the 3 oldest attempts');
    assert.equal(g.counts().taught, 22, 'lessons outlast attempts');
    assert.ok(g.get(firstTaught.id));
  });

  test('starter pieces are capped at 10 non-favourites', () => {
    const g = new GalleryStore({}, { clock: ticking() });
    const kept = add(g, 'starter');
    g.setFavorite(kept.id, true);
    for (let i = 0; i < 15; i++) add(g, 'starter', i % 2 ? 'music' : 'drawing');
    const loose = g.items.filter((x) => x.origin === 'starter' && !x.favorite);
    assert.equal(loose.length, GALLERY_LIMITS.maxStarter);
    assert.ok(g.get(kept.id), 'a favourite starter piece is not counted against the cap');
  });

  test('pin, unpin and delete; only drawings hang on the wall', () => {
    const g = new GalleryStore({}, { clock: ticking() });
    const song = add(g, 'taught', 'music');
    const art = add(g, 'attempt', 'drawing');
    assert.equal(g.pin(song.id), false);
    assert.equal(g.pin(art.id), true);
    assert.equal(g.wallItem.id, art.id);
    assert.equal(g.remove(art.id), true);
    assert.equal(g.wall, null, 'deleting the pinned drawing takes it down');
    assert.equal(g.remove(art.id), false);
    const art2 = add(g, 'taught', 'drawing');
    g.pin(art2.id);
    assert.equal(g.unpin(), true);
    assert.equal(g.wallItem, null);
    assert.equal(g.latestDrawing().id, art2.id);
  });

  test('persistence: round trip, backup fallback, future version kept, hostile data cleaned', () => {
    const storage = new MemoryStorage();
    const g = new GalleryStore({}, { clock: ticking() });
    const art = add(g, 'taught');
    g.pin(art.id);
    add(g, 'attempt', 'music', { tags: ['livelier'] });
    assert.equal(saveGallery(g, storage, NOW).ok, true);
    const loaded = loadGallery(storage);
    assert.equal(loaded.status, 'loaded');
    assert.equal(loaded.gallery.items.length, 2);
    assert.equal(loaded.gallery.wall, art.id, 'the wall frame persists across reloads');
    assert.deepEqual(loaded.gallery.get(art.id).data, g.get(art.id).data);

    add(g, 'starter', 'music');
    saveGallery(g, storage, NOW + 1);
    storage.setItem(GALLERY_KEY, 'garbage{');
    const restored = loadGallery(storage);
    assert.equal(restored.status, 'restored-backup');
    assert.equal(restored.gallery.items.length, 2);
    const good = storage.getItem(GALLERY_BACKUP_KEY);
    saveGallery(restored.gallery, storage, NOW + 2);
    assert.equal(storage.getItem(GALLERY_BACKUP_KEY), good, 'a corrupt main record never overwrites the good backup');

    const s2 = new MemoryStorage();
    const future = JSON.stringify({ schema: GALLERY_SCHEMA, version: GALLERY_VERSION + 2, items: [] });
    s2.setItem(GALLERY_KEY, future);
    assert.equal(loadGallery(s2).status, 'future-version');
    assert.equal(s2.getItem(GALLERY_FUTURE_KEY), future);

    const hostile = new GalleryStore({
      wall: 'item-x-1',
      items: [
        { id: 'item-x-1', kind: 'music', origin: 'taught', data: tune(), title: '<img src=x onerror=alert(1)>' },
        { id: 'item-x-2', kind: 'drawing', origin: 'alien', data: star() },
        { id: 'item-x-3', kind: 'drawing', origin: 'starter', data: { strokes: 'none' } },
        { id: 'item-x-1', kind: 'music', origin: 'taught', data: tune() },
        { id: 'item-x-4', kind: 'drawing', origin: 'attempt', data: star(), favorite: 'yes', tags: ['wilder', 7], seed: -1 },
      ],
    });
    assert.deepEqual(hostile.items.map((x) => x.id), ['item-x-1', 'item-x-4']);
    assert.equal(hostile.wall, null, 'only a drawing can be on the wall');
    assert.ok(!/[<>]/.test(hostile.get('item-x-1').title));
    assert.equal(hostile.get('item-x-4').favorite, false);
    assert.deepEqual(hostile.get('item-x-4').tags, ['wilder']);
    assert.equal(sanitizeItem(null), null);
    assert.equal(clearGallery(storage), true);
    assert.equal(loadGallery(storage).status, 'new');
  });

  test('a storage quota error drops the backup copy, then old items, and retries', () => {
    const big = () => ({ paper: '#fffaf1', strokes: Array.from({ length: 12 }, (_, i) => ({ color: '#ff7fa3', width: 0.02, points: templateStrokes('spiral')[0].points.map((p) => [p[0], (p[1] + i * 0.01) % 1, 0.5, 0.01]) })) });
    const storage = new MemoryStorage({ quota: 200_000 });
    const g = new GalleryStore({}, { clock: ticking() });
    let lastOk = true;
    for (let i = 0; i < 25; i++) {
      g.add({ kind: 'drawing', origin: i % 3 ? 'attempt' : 'taught', data: big(), title: `big ${i}` });
      const res = saveGallery(g, storage, NOW + i);
      lastOk = res.ok;
      assert.ok(res.ok, `save ${i} succeeded (${res.reason ?? ''})`);
    }
    assert.ok(lastOk);
    assert.ok(storage.used <= 200_000);
    assert.ok(g.items.length < 25, 'old items were dropped to make room');
    assert.equal(loadGallery(storage).gallery.items.length, g.items.length);
  });

  test('the byte budget evicts large items before favourites', () => {
    const g = new GalleryStore({}, { clock: ticking() });
    const fav = add(g, 'taught');
    g.setFavorite(fav.id, true);
    const huge = { paper: '#fffaf1', strokes: Array.from({ length: 60 }, () => ({ color: '#ff7fa3', width: 0.02, points: Array.from({ length: 40 }, (_, i) => [i / 40, 0.123456, 0.55, 0.012]) })) };
    for (let i = 0; i < 40; i++) g.add({ kind: 'drawing', origin: 'attempt', data: huge });
    assert.ok(g.bytes() <= GALLERY_LIMITS.maxBytes);
    assert.ok(g.get(fav.id));
  });
});
