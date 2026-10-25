/**
 * gallery-store.js: the Creation & Teaching History (storage).
 *
 * A bounded, versioned collection of songs and drawings, each with an origin:
 *   starter  the pet's built-in repertoire (authored generators),
 *   taught   a demonstration the player gave in the Teaching Workshop,
 *   attempt  the pet's own take on a lesson or creation (authored variation
 *            engine; tagged with its generator so it is never mistaken for
 *            learned behaviour).
 * Items keep their full musical / stroke data so they can be replayed,
 * compared and hung on the studio wall (one pinned drawing, persisted).
 *
 * Retention: at most 40 items and ~1.2 MB. Starter pieces are capped at 10
 * non-favourites. When room is needed the oldest non-favourite starter piece
 * goes first, then attempts, then lessons, then favourites; the pinned
 * drawing and the item just added are never evicted. Pure ES module.
 */
import { sanitizePhrase, sanitizeDrawing, phraseIsEmpty, drawingIsEmpty } from './teaching-core.js';
import { sanitizeStyle, sanitizeModelTag, NUDGE_IDS } from './creative-engine.js';
import { loadVersioned, saveVersioned, removeKeys } from './persist.js';
import { sanitizeText } from './teaching-memory.js';

export const GALLERY_SCHEMA = 'petstudio.gallery';
export const GALLERY_VERSION = 1;
export const GALLERY_KEY = 'petstudio.gallery.v1';
export const GALLERY_BACKUP_KEY = 'petstudio.gallery.v1.bak';
export const GALLERY_FUTURE_KEY = 'petstudio.gallery.future';
export const GALLERY_LIMITS = Object.freeze({ maxItems: 40, maxStarter: 10, maxBytes: 1_200_000, titleMax: 48, maxTags: 6, maxNudges: 8 });
export const ITEM_KINDS = Object.freeze(['music', 'drawing']);
export const KIND_LABELS = Object.freeze({ music: 'Song', drawing: 'Drawing' });
export const ORIGINS = Object.freeze(['starter', 'taught', 'attempt']);
export const ORIGIN_LABELS = Object.freeze({ starter: 'Starter', taught: 'Taught by You', attempt: 'Pet Attempt' });

const ID_RE = /^[a-z0-9-]{3,64}$/i;
const isId = (v) => typeof v === 'string' && ID_RE.test(v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const TEMPLATE_RE = /^[a-z0-9-]{1,32}$/;
const GENERATOR_RE = /^[a-z0-9-]{1,40}$/;

export function defaultTitle(kind, origin) {
  if (origin === 'taught') return kind === 'music' ? 'Your tune' : 'Your drawing';
  if (origin === 'attempt') return kind === 'music' ? 'Pet attempt (song)' : 'Pet attempt (drawing)';
  return kind === 'music' ? 'Little tune' : 'Doodle';
}

export function sanitizeItem(it) {
  if (!it || typeof it !== 'object' || !isId(it.id) || !ITEM_KINDS.includes(it.kind) || !ORIGINS.includes(it.origin)) return null;
  const data = it.kind === 'music' ? sanitizePhrase(it.data) : sanitizeDrawing(it.data);
  if (it.kind === 'music' ? phraseIsEmpty(data) : drawingIsEmpty(data)) return null;
  const fb = it.feedback && typeof it.feedback === 'object' ? it.feedback : {};
  return {
    id: it.id,
    kind: it.kind,
    origin: it.origin,
    title: sanitizeText(it.title, GALLERY_LIMITS.titleMax) || defaultTitle(it.kind, it.origin),
    createdAt: Number.isFinite(it.createdAt) ? it.createdAt : 0,
    favorite: it.favorite === true,
    tags: Array.isArray(it.tags) ? [...new Set(it.tags.filter((t) => NUDGE_IDS.includes(t)))].slice(0, GALLERY_LIMITS.maxTags) : [],
    petId: typeof it.petId === 'string' && /^[a-z0-9-]{4,48}$/i.test(it.petId) ? it.petId : null,
    petName: sanitizeText(it.petName, 16) || null,
    lessonId: isId(it.lessonId) ? it.lessonId : null,
    parentId: isId(it.parentId) ? it.parentId : null,
    templateId: typeof it.templateId === 'string' && TEMPLATE_RE.test(it.templateId) ? it.templateId : null,
    seed: Number.isInteger(it.seed) ? it.seed >>> 0 : null,
    generator: typeof it.generator === 'string' && GENERATOR_RE.test(it.generator) ? it.generator : null,
    style: it.style ? sanitizeStyle(it.style) : null,
    model: sanitizeModelTag(it.model),
    feedback: {
      reward: Number.isFinite(fb.reward) ? clamp(fb.reward, -1, 1) : 0,
      loves: Number.isInteger(fb.loves) && fb.loves >= 0 ? Math.min(fb.loves, 1e6) : 0,
      nudges: Array.isArray(fb.nudges) ? fb.nudges.filter((n) => NUDGE_IDS.includes(n)).slice(-GALLERY_LIMITS.maxNudges) : [],
    },
    data,
  };
}

export function sanitizeGalleryRecord(r) {
  const src = r && typeof r === 'object' ? r : {};
  const seen = new Set();
  const items = (Array.isArray(src.items) ? src.items : [])
    .slice(-GALLERY_LIMITS.maxItems * 2)
    .map(sanitizeItem)
    .filter((it) => it && !seen.has(it.id) && seen.add(it.id));
  const wallItem = items.find((it) => it.id === src.wall && it.kind === 'drawing');
  return {
    createdAt: Number.isFinite(src.createdAt) ? src.createdAt : null,
    seq: Number.isInteger(src.seq) && src.seq >= 0 ? Math.min(src.seq, 1e9) : 0,
    items,
    wall: wallItem ? wallItem.id : null,
  };
}

export class GalleryStore {
  constructor(record = {}, { clock = () => Date.now() } = {}) {
    this._clock = clock;
    const r = sanitizeGalleryRecord(record);
    this.createdAt = r.createdAt ?? clock();
    this.seq = r.seq;
    this.items = r.items;
    this.wall = r.wall;
    this.lastEvicted = [];
    this.listeners = new Set();
    this._sizes = new WeakMap();
    this._retain(null);
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _changed(what, id = null) {
    for (const fn of this.listeners) {
      try {
        fn(what, id);
      } catch (err) {
        if (typeof console !== 'undefined') console.error('[gallery-store] listener error', err);
      }
    }
  }

  _id() {
    this.seq += 1;
    return `item-${Math.floor(this._clock()).toString(36)}-${this.seq.toString(36)}`;
  }

  /** Adds a creation and applies the retention policy. Returns the item or null. */
  add(input = {}) {
    const item = sanitizeItem({ ...input, id: this._id(), createdAt: this._clock(), feedback: input.feedback ?? null });
    if (!item) return null;
    this.items.push(item);
    this._retain(item.id);
    this._changed('add', item.id);
    return item;
  }

  get(id) {
    return this.items.find((it) => it.id === id) ?? null;
  }

  has(id) {
    return this.items.some((it) => it.id === id);
  }

  /** Items newest first; kind 'all' | 'music' | 'drawing'; favorites only when asked. */
  list({ kind = 'all', favorites = false } = {}) {
    return this.items
      .filter((it) => (kind === 'all' || it.kind === kind) && (!favorites || it.favorite))
      .sort((a, b) => b.createdAt - a.createdAt || (b.id > a.id ? 1 : -1));
  }

  counts() {
    const c = { total: this.items.length, music: 0, drawing: 0, favorites: 0, starter: 0, taught: 0, attempt: 0 };
    for (const it of this.items) {
      c[it.kind] += 1;
      c[it.origin] += 1;
      if (it.favorite) c.favorites += 1;
    }
    return c;
  }

  setFavorite(id, on = true) {
    const it = this.get(id);
    if (!it) return false;
    it.favorite = !!on;
    this._changed('favorite', id);
    return true;
  }

  toggleFavorite(id) {
    const it = this.get(id);
    return it ? this.setFavorite(id, !it.favorite) && it.favorite : false;
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((it) => it.id !== id);
    if (this.items.length === before) return false;
    if (this.wall === id) this.wall = null;
    this._changed('remove', id);
    return true;
  }

  /** Pins a drawing to the studio wall frame. */
  pin(id) {
    const it = this.get(id);
    if (!it || it.kind !== 'drawing') return false;
    this.wall = id;
    this._changed('wall', id);
    return true;
  }

  unpin() {
    if (!this.wall) return false;
    this.wall = null;
    this._changed('wall', null);
    return true;
  }

  get wallItem() {
    return this.wall ? this.get(this.wall) : null;
  }

  latestDrawing() {
    return this.list({ kind: 'drawing' })[0] ?? null;
  }

  /** Feedback bookkeeping on a creation: reward (preference), love count, nudges given. */
  recordFeedback(id, { reward = null, love = false, nudge = null } = {}) {
    const it = this.get(id);
    if (!it) return null;
    if (Number.isFinite(reward)) it.feedback.reward = clamp(reward, -1, 1);
    if (love) it.feedback.loves += 1;
    if (NUDGE_IDS.includes(nudge)) {
      it.feedback.nudges.push(nudge);
      if (it.feedback.nudges.length > GALLERY_LIMITS.maxNudges) it.feedback.nudges.shift();
    }
    this._changed('feedback', id);
    return it;
  }

  _size(it) {
    let s = this._sizes.get(it);
    if (s == null) {
      s = JSON.stringify(it).length + 1;
      this._sizes.set(it, s);
    }
    return s;
  }

  bytes() {
    return this.items.reduce((a, it) => a + this._size(it), 64);
  }

  _victim(filter, protectId) {
    const pool = this.items.filter((it) => it.id !== protectId && it.id !== this.wall && filter(it));
    const tiers = [
      (it) => !it.favorite && it.origin === 'starter',
      (it) => !it.favorite && it.origin === 'attempt',
      (it) => !it.favorite && it.origin === 'taught',
      (it) => it.favorite,
    ];
    for (const tier of tiers) {
      const tierItems = pool.filter(tier);
      if (tierItems.length) return tierItems.reduce((a, b) => (b.createdAt < a.createdAt ? b : a));
    }
    return null;
  }

  _evict(it) {
    this.items = this.items.filter((x) => x !== it);
    this.lastEvicted.push(it.id);
  }

  _retain(protectId) {
    const L = GALLERY_LIMITS;
    this.lastEvicted = [];
    const looseStarters = () => this.items.filter((it) => it.origin === 'starter' && !it.favorite).length;
    while (looseStarters() > L.maxStarter) {
      const v = this._victim((it) => it.origin === 'starter' && !it.favorite, protectId);
      if (!v) break;
      this._evict(v);
    }
    while (this.items.length > L.maxItems || this.bytes() > L.maxBytes) {
      const v = this._victim(() => true, protectId);
      if (!v) break;
      this._evict(v);
    }
    return this.lastEvicted;
  }

  /** Frees room after a storage quota error. Returns how many items were dropped. */
  shrink(count) {
    let dropped = 0;
    for (let i = 0; i < count; i++) {
      const v = this._victim((it) => !it.favorite, null);
      if (!v) break;
      this._evict(v);
      dropped++;
    }
    if (dropped) this._changed('shrink');
    return dropped;
  }

  toJSON(now = this._clock()) {
    return { schema: GALLERY_SCHEMA, version: GALLERY_VERSION, createdAt: this.createdAt, savedAt: now, seq: this.seq, wall: this.wall, items: this.items };
  }

  /** Light summary list for inspection (no stroke or note payloads). */
  summaries() {
    return this.list().map((it) => ({
      id: it.id, kind: it.kind, origin: it.origin, originLabel: ORIGIN_LABELS[it.origin], title: it.title,
      createdAt: it.createdAt, favorite: it.favorite, tags: [...it.tags], pinned: it.id === this.wall,
      lessonId: it.lessonId, parentId: it.parentId, generator: it.generator, reward: it.feedback.reward,
      size: it.kind === 'music' ? it.data.notes.length + it.data.hits.length : it.data.strokes.length,
    }));
  }
}

export function loadGallery(storage, { clock } = {}) {
  const res = loadVersioned({
    storage, key: GALLERY_KEY, backupKey: GALLERY_BACKUP_KEY, futureKey: GALLERY_FUTURE_KEY,
    schema: GALLERY_SCHEMA, version: GALLERY_VERSION, sanitize: sanitizeGalleryRecord,
  });
  return { gallery: new GalleryStore(res.record ?? {}, { clock }), status: res.status };
}

/**
 * Saves the gallery. On a quota error it first drops the backup copy, then
 * the oldest non-favourite items, and retries (bounded).
 */
export function saveGallery(gallery, storage = globalThis.localStorage, now = Date.now()) {
  let res = { ok: false, reason: 'not-attempted' };
  for (let attempt = 0; attempt < 5; attempt++) {
    let json;
    try {
      json = JSON.stringify(gallery.toJSON(now));
    } catch (err) {
      return { ok: false, reason: `serialize-failed: ${err?.message ?? err}` };
    }
    res = saveVersioned({ storage, key: GALLERY_KEY, backupKey: attempt === 0 ? GALLERY_BACKUP_KEY : null, json, schema: GALLERY_SCHEMA, version: GALLERY_VERSION });
    if (res.ok || !res.quota) return { ...res, shrunk: attempt };
    if (attempt === 0) {
      removeKeys(storage, [GALLERY_BACKUP_KEY]);
      continue;
    }
    if (!gallery.shrink(Math.max(2, Math.ceil(gallery.items.length * 0.15)))) break;
  }
  return res;
}

export function clearGallery(storage = globalThis.localStorage) {
  return removeKeys(storage, [GALLERY_KEY, GALLERY_BACKUP_KEY]);
}
