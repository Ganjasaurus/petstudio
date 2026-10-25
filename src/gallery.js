/**
 * gallery.js: the Creation Gallery sheet (presentation over gallery-store.js).
 *
 * Browse the bounded Creation & Teaching History (songs and drawings), each
 * with its origin badge (Starter, Taught by You, Pet Attempt), timestamp,
 * title, favourite star and direction tags. Per item: Perform / Redraw (the
 * pet performs it in the studio), Hang on Wall (drawings, persisted), Listen
 * (songs, here in the sheet), Compare, Favourite and Delete. Compare shows two
 * songs or two drawings side by side, with playback / replay and a
 * descriptive similarity readout, e.g. a lesson next to the pet's attempt.
 * Registered as the real 'gallery' feature via features.register('gallery', ...).
 */
import { ORIGIN_LABELS, KIND_LABELS } from './gallery-store.js';
import { NUDGES } from './creative-engine.js';
import { paintDrawing, paintPhraseRoll, fitCanvas } from './creation-render.js';
import { phraseSimilarity, drawingSimilarity, drumByMidi } from './teaching-core.js';

const useIcon = (id) => `<svg class="ico" aria-hidden="true"><use href="#${id}"></use></svg>`;
const FILTERS = Object.freeze(['all', 'music', 'drawing', 'favorites']);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nowS = () => performance.now() / 1000;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** "Learned" badge for creations shaped by the trained networks (generator neural-v1). */
function learnedBadge(it) {
  if (it.generator !== 'neural-v1') return '';
  const detail = it.model ? `: ${it.model.steps} training steps, blend ${Math.round(it.model.alpha * 100)}%` : '';
  return `<span class="gl-learned" title="Shaped by the networks it trained in Sleep Practice${detail}">Learned</span>`;
}

export function relativeTime(ts, now = Date.now()) {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 2 * 86400) return 'yesterday';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export class GalleryView {
  constructor({ dialog, store, audio, onPerform, onHang, onUnhang, onDelete, onFavorite, onOpen, onClose, reducedMotion = false }) {
    this.dialog = dialog;
    this.store = store;
    this.audio = audio;
    this.cb = { onPerform, onHang, onUnhang, onDelete, onFavorite, onOpen, onClose };
    this.reduced = reducedMotion;
    this.filter = 'all';
    this.selected = [];
    this.comparing = null;
    this.player = null;
    this.replay = null;
    this.confirmDelete = null;
    this.raf = 0;
    this._build();
    store.onChange(() => {
      if (this.dialog.open) this.render();
    });
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      if (this.comparing) this.closeCompare();
      else this.close('escape');
    });
  }

  get isOpen() {
    return this.dialog.open;
  }

  _build() {
    this.dialog.innerHTML = `
      <div class="sheet-head gl-head">
        <div><h2 id="gl-title" tabindex="-1">Creation Gallery</h2><p class="sheet-sub" data-gl-sub></p></div>
        <button class="icon-btn" type="button" data-gl="close" aria-label="Close Gallery" title="Close">${useIcon('i-close')}</button>
      </div>
      <div class="gl-toolbar">
        <div class="ws-seg gl-filter" role="radiogroup" aria-label="Show">
          <button type="button" role="radio" data-filter="all">All</button>
          <button type="button" role="radio" data-filter="music">Songs</button>
          <button type="button" role="radio" data-filter="drawing">Drawings</button>
          <button type="button" role="radio" data-filter="favorites" aria-label="Favourites">${useIcon('i-praise')}<span>Favourites</span></button>
        </div>
      </div>
      <div class="gl-body">
        <ul class="gl-grid" aria-label="Creations"></ul>
        <div class="gl-empty" hidden></div>
        <section class="gl-compare" hidden aria-labelledby="gl-compare-title">
          <div class="gl-compare-head">
            <button type="button" class="btn" data-gl="back">${useIcon('i-back')}<span>Back</span></button>
            <h3 id="gl-compare-title">Side by side</h3>
          </div>
          <div class="gl-pair"></div>
          <p class="gl-sim"></p>
          <div class="gl-compare-actions"></div>
        </section>
      </div>
      <div class="gl-foot"><p class="gl-hint" aria-live="polite"></p></div>`;
    const q = (s) => this.dialog.querySelector(s);
    this.el = {
      sub: q('[data-gl-sub]'), grid: q('.gl-grid'), empty: q('.gl-empty'), compare: q('.gl-compare'), pair: q('.gl-pair'),
      sim: q('.gl-sim'), compareActions: q('.gl-compare-actions'), hint: q('.gl-hint'), toolbar: q('.gl-toolbar'), title: q('#gl-title'),
      body: q('.gl-body'),
    };
    this.dialog.addEventListener('click', (e) => this._onClick(e));
    if ('ResizeObserver' in globalThis) {
      this.ro = new ResizeObserver(() => this._paintThumbs());
      this.ro.observe(this.el.grid);
    }
  }

  open({ filter } = {}) {
    if (FILTERS.includes(filter)) this.filter = filter;
    this.selected = this.selected.filter((id) => this.store.has(id));
    this.comparing = null;
    if (!this.dialog.open) this.dialog.showModal();
    this.render();
    this.el.body.scrollTop = 0;
    this.el.title.focus({ preventScroll: true });
    this.cb.onOpen?.();
    this._loop();
  }

  close(reason = 'close') {
    if (!this.dialog.open) return;
    this.player = null;
    this.replay = null;
    this.dialog.close();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.cb.onClose?.(reason);
  }

  setFilter(f) {
    if (!FILTERS.includes(f)) return;
    this.filter = f;
    this.render();
  }

  _items() {
    if (this.filter === 'favorites') return this.store.list({ favorites: true });
    return this.store.list({ kind: this.filter });
  }

  render() {
    const c = this.store.counts();
    this.el.sub.textContent = c.total
      ? `${c.music} song${c.music === 1 ? '' : 's'} and ${c.drawing} drawing${c.drawing === 1 ? '' : 's'} · ${c.favorites} favourite${c.favorites === 1 ? '' : 's'}`
      : 'Songs and drawings your pet makes, and the lessons you give it, appear here.';
    for (const b of this.dialog.querySelectorAll('[data-filter]')) b.setAttribute('aria-checked', String(b.dataset.filter === this.filter));
    const inCompare = !!this.comparing;
    this.el.compare.hidden = !inCompare;
    if (inCompare) this.el.compare.dataset.kind = this.store.get(this.comparing[0])?.kind ?? 'drawing';
    this.el.grid.hidden = inCompare;
    this.el.toolbar.hidden = inCompare;
    if (inCompare) {
      this.el.empty.hidden = true;
      this._renderCompare();
      return;
    }
    const items = this._items();
    const wall = this.store.wall;
    this.el.grid.innerHTML = items.map((it) => this._card(it, wall)).join('');
    this.el.empty.hidden = items.length > 0;
    if (!items.length) {
      this.el.empty.innerHTML = this.filter === 'favorites'
        ? `<p><strong>No favourites yet.</strong> Tap the star on a creation, or press Love It when your pet makes something you like.</p>`
        : `<p><strong>Nothing here yet.</strong> Teach your pet a tune or a drawing in the Teaching Workshop, or send it to the Music Corner or the Easel.</p>`;
    }
    this._hint();
    requestAnimationFrame(() => this._paintThumbs());
  }

  _hint(text = null) {
    if (text) {
      this.el.hint.textContent = text;
      return;
    }
    const sel = this.selected.map((id) => this.store.get(id)).filter(Boolean);
    if (sel.length === 1) this.el.hint.textContent = `Now pick another ${sel[0].kind === 'music' ? 'song' : 'drawing'} to compare with "${sel[0].title}".`;
    else this.el.hint.textContent = 'Tip: press the compare button on two songs or two drawings to see them side by side.';
  }

  _card(it, wall) {
    const pinned = it.id === wall;
    const selected = this.selected.includes(it.id);
    const parent = it.origin === 'attempt' && it.parentId ? this.store.get(it.parentId) : null;
    const tags = it.tags.map((t) => `<span class="gl-tag" data-tag="${t}">${NUDGES[t]?.label ?? t}</span>`).join('');
    const isDrawing = it.kind === 'drawing';
    const confirming = this.confirmDelete?.id === it.id;
    return `
      <li class="gl-card${selected ? ' selected' : ''}" data-id="${it.id}" data-kind="${it.kind}" data-origin="${it.origin}">
        <div class="gl-thumb">
          <canvas aria-hidden="true"></canvas>
          <button type="button" class="gl-star" data-gl="favorite" aria-pressed="${it.favorite}" aria-label="${it.favorite ? 'Remove from favourites' : 'Add to favourites'}: ${esc(it.title)}" title="${it.favorite ? 'Favourite' : 'Add to favourites'}">${useIcon('i-praise')}</button>
          ${pinned ? `<span class="gl-pinned" title="Hanging on the studio wall">${useIcon('i-frame')}<span>On wall</span></span>` : ''}
        </div>
        <div class="gl-meta">
          <h3 class="gl-title">${esc(it.title)}</h3>
          <div class="gl-badges"><span class="gl-origin" data-origin="${it.origin}">${ORIGIN_LABELS[it.origin]}</span>${learnedBadge(it)}<span class="gl-kind">${KIND_LABELS[it.kind]}</span>${tags}</div>
          <time datetime="${new Date(it.createdAt).toISOString()}">${relativeTime(it.createdAt)}</time>
        </div>
        <div class="gl-actions">
          <button type="button" class="btn gl-perform" data-gl="perform" aria-label="${isDrawing ? 'Redraw on the easel' : 'Perform at the Music Corner'}: ${esc(it.title)}">${useIcon('i-play')}<span>${isDrawing ? 'Redraw' : 'Perform'}</span></button>
          ${isDrawing
            ? `<button type="button" class="btn gl-act" data-gl="wall" aria-pressed="${pinned}" aria-label="${pinned ? 'Take down from the wall' : 'Hang on Wall'}" title="${pinned ? 'Take down from the studio wall' : 'Hang on the studio wall'}">${useIcon('i-frame')}<span class="gl-lbl">${pinned ? 'Take Down' : 'Hang on Wall'}</span></button>`
            : `<button type="button" class="btn gl-act" data-gl="listen" aria-label="Listen here" title="Listen here without the pet">${useIcon('i-listen')}<span class="gl-lbl">Listen</span></button>`}
          <button type="button" class="btn gl-act gl-mini" data-gl="compare" aria-pressed="${selected}" aria-label="Compare" title="Pick two to compare side by side">${useIcon('i-compare')}<span class="gl-lbl">Compare</span></button>
          <button type="button" class="btn gl-act gl-mini gl-del${confirming ? ' confirm' : ''}" data-gl="delete" aria-label="${confirming ? 'Tap again to delete' : 'Delete'}" title="${confirming ? 'Tap again to delete' : 'Delete'}">${useIcon('i-trash')}<span class="gl-lbl">${confirming ? 'Sure?' : 'Delete'}</span></button>
        </div>
        ${parent ? `<button type="button" class="gl-link" data-gl="vs-lesson">${useIcon('i-compare')}Compare with your lesson</button>` : ''}
      </li>`;
  }

  _paintThumbs() {
    if (!this.dialog.open || this.comparing) return;
    for (const li of this.el.grid.querySelectorAll('.gl-card')) {
      const it = this.store.get(li.dataset.id);
      const cv = li.querySelector('canvas');
      if (!it || !cv) continue;
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      if (!w || !h) continue;
      const key = `${it.id}|${w}x${h}`;
      if (cv.dataset.key === key) continue;
      cv.dataset.key = key;
      const dpr = fitCanvas(cv, w, h);
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (it.kind === 'drawing') {
        const s = Math.min(w, h);
        ctx.fillStyle = '#f6efe6';
        ctx.fillRect(0, 0, w, h);
        paintDrawing(ctx, it.data, s, { x: (w - s) / 2, y: (h - s) / 2, border: false });
      } else {
        paintPhraseRoll(ctx, it.data, { w, h, pad: 6, radius: 0, background: '#fffdf9' });
      }
    }
  }

  _onClick(e) {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    this.audio.unlock();
    if (b.dataset.filter) {
      this.setFilter(b.dataset.filter);
      return;
    }
    const action = b.dataset.gl;
    if (!action) return;
    const id = b.closest('.gl-card')?.dataset.id ?? null;
    switch (action) {
      case 'close': this.close('close'); break;
      case 'back': this.closeCompare(); break;
      case 'favorite': this.cb.onFavorite?.(id, !this.store.get(id)?.favorite); break;
      case 'perform': {
        // A refusal (napping, too sleepy) is shown here: toasts sit behind this sheet on phones.
        const res = this.cb.onPerform?.(id);
        if (res && !res.ok && res.message) this._hint(res.message);
        break;
      }
      case 'wall':
        if (this.store.wall === id) this.cb.onUnhang?.();
        else this.cb.onHang?.(id);
        break;
      case 'listen': this.listen(id); break;
      case 'compare': this.toggleSelect(id); break;
      case 'vs-lesson': {
        const it = this.store.get(id);
        if (it?.parentId) this.compare(it.parentId, id);
        break;
      }
      case 'delete': this._delete(id); break;
      case 'play-a': this._playSide(0); break;
      case 'play-b': this._playSide(1); break;
      case 'play-both': this._playBoth(); break;
      case 'replay-both': this._replayBoth(); break;
      case 'stop': this.player = null; this._renderCompareState(); break;
      default: break;
    }
  }

  _delete(id) {
    const it = this.store.get(id);
    if (!it) return;
    if (this.confirmDelete?.id === id && performance.now() < this.confirmDelete.until) {
      this.confirmDelete = null;
      this.selected = this.selected.filter((x) => x !== id);
      this.cb.onDelete?.(id);
      return;
    }
    this.confirmDelete = { id, until: performance.now() + 3500 };
    this.render();
    setTimeout(() => {
      if (this.confirmDelete?.id === id && performance.now() >= this.confirmDelete.until) {
        this.confirmDelete = null;
        if (this.dialog.open) this.render();
      }
    }, 3600);
  }

  toggleSelect(id) {
    const it = this.store.get(id);
    if (!it) return;
    if (this.selected.includes(id)) {
      this.selected = this.selected.filter((x) => x !== id);
    } else {
      const first = this.store.get(this.selected[0]);
      if (first && first.kind !== it.kind) {
        this.selected = [];
        this._hint('Compare two songs or two drawings. Starting a new pair.');
      }
      this.selected.push(id);
      if (this.selected.length > 2) this.selected.shift();
    }
    if (this.selected.length === 2) this.compare(this.selected[0], this.selected[1]);
    else this.render();
  }

  /** Opens the side-by-side view for two items of the same kind (older on the left). */
  compare(idA, idB) {
    const a = this.store.get(idA);
    const b = this.store.get(idB);
    if (!a || !b || a.kind !== b.kind || a.id === b.id) return false;
    const pair = a.createdAt <= b.createdAt ? [a.id, b.id] : [b.id, a.id];
    this.comparing = pair;
    this.selected = [...pair];
    this.player = null;
    this.replay = null;
    this.render();
    this.el.body.scrollTop = 0;
    return true;
  }

  closeCompare() {
    this.comparing = null;
    this.selected = [];
    this.player = null;
    this.replay = null;
    this.render();
  }

  _renderCompare() {
    const [a, b] = this.comparing.map((id) => this.store.get(id));
    if (!a || !b) {
      this.comparing = null;
      this.render();
      return;
    }
    const side = (it, label, key) => `
      <figure class="gl-side" data-side="${key}">
        <span class="gl-side-tag">${label}</span>
        <canvas aria-label="${esc(it.title)}"></canvas>
        <figcaption>
          <strong>${esc(it.title)}</strong>
          <span class="gl-badges"><span class="gl-origin" data-origin="${it.origin}">${ORIGIN_LABELS[it.origin]}</span>${learnedBadge(it)}${it.tags.map((t) => `<span class="gl-tag">${NUDGES[t]?.label ?? t}</span>`).join('')}</span>
          <time datetime="${new Date(it.createdAt).toISOString()}">${relativeTime(it.createdAt)}</time>
        </figcaption>
        ${it.kind === 'music' ? `<button type="button" class="btn" data-gl="play-${key}">${useIcon('i-play')}<span>Play</span></button>` : ''}
      </figure>`;
    const labels = a.origin === 'taught' && b.origin === 'attempt' ? ['Your lesson', 'Pet attempt'] : ['Earlier', 'Later'];
    this.el.pair.innerHTML = side(a, labels[0], 'a') + side(b, labels[1], 'b');
    if (a.kind === 'music') {
      const s = phraseSimilarity(a.data, b.data);
      this.el.sim.textContent = `Shared rhythm ${Math.round(s.rhythm * 100)}% · Similar melody ${Math.round(s.melody * 100)}% · Tempo ${a.data.tempo} vs ${b.data.tempo} BPM`;
      this.el.compareActions.innerHTML = `<button type="button" class="btn primary" data-gl="play-both">${useIcon('i-play')}<span>Play one after the other</span></button>`;
    } else {
      const s = drawingSimilarity(a.data, b.data);
      this.el.sim.textContent = `Shape overlap ${Math.round(s * 100)}% · ${a.data.strokes.length} vs ${b.data.strokes.length} strokes`;
      this.el.compareActions.innerHTML = `<button type="button" class="btn primary" data-gl="replay-both">${useIcon('i-replay')}<span>Replay both</span></button>`;
    }
    this.el.hint.textContent = 'Similarity numbers describe the two pieces; they are not a score.';
    requestAnimationFrame(() => this._paintCompare());
  }

  _paintCompare(progress = [1, 1], playheads = [null, null]) {
    if (!this.comparing) return;
    this.comparing.forEach((id, i) => {
      const it = this.store.get(id);
      const cv = this.el.pair.querySelectorAll('canvas')[i];
      if (!it || !cv) return;
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      if (!w || !h) return;
      const dpr = fitCanvas(cv, w, h);
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (it.kind === 'drawing') {
        const s = Math.min(w, h);
        paintDrawing(ctx, it.data, s, { x: (w - s) / 2, y: (h - s) / 2, progress: progress[i] });
      } else {
        paintPhraseRoll(ctx, it.data, { w, h, playhead: playheads[i], labels: true, radius: 12 });
      }
    });
  }

  _renderCompareState() {
    for (const [i, key] of ['a', 'b'].entries()) {
      const btn = this.el.pair.querySelector(`[data-gl="play-${key}"]`);
      if (!btn) continue;
      const on = this.player?.side === i;
      btn.querySelector('span').textContent = on ? 'Playing…' : 'Play';
    }
    this._paintCompare();
  }

  /** Plays a song here in the sheet (no pet involved). */
  listen(id) {
    const it = this.store.get(id);
    if (!it || it.kind !== 'music') return false;
    this.player = { queue: [{ data: it.data, side: null }], t0: null, scheduled: -1 };
    this._startNext();
    this._hint(`Playing "${it.title}"…`);
    return true;
  }

  _playSide(i) {
    const it = this.store.get(this.comparing?.[i]);
    if (!it) return;
    this.player = { queue: [{ data: it.data, side: i }], t0: null, scheduled: -1 };
    this._startNext();
  }

  _playBoth() {
    const items = this.comparing.map((id) => this.store.get(id));
    this.player = { queue: items.map((it, i) => ({ data: it.data, side: i })), t0: null, scheduled: -1 };
    this._startNext();
  }

  _startNext() {
    const p = this.player;
    if (!p || !p.queue.length) {
      this.player = null;
      if (this.comparing) this._renderCompareState();
      return;
    }
    const next = p.queue.shift();
    Object.assign(p, { data: next.data, side: next.side, t0: nowS() + 0.25, scheduled: -1 });
    if (this.comparing) this._renderCompareState();
  }

  _replayBoth() {
    this.replay = { start: nowS(), duration: this.reduced ? 0.01 : 4 };
  }

  _tickPlayer() {
    const p = this.player;
    if (!p) return;
    const now = nowS();
    const bps = p.data.tempo / 60;
    const beat = (now - p.t0) * bps;
    const ahead = (now + 0.12 - p.t0) * bps;
    for (const n of p.data.notes) {
      if (n.beat > p.scheduled && n.beat <= ahead) this.audio.pluck(n.midi, { when: p.t0 + n.beat / bps - now, duration: n.dur / bps, velocity: n.vel });
    }
    for (const h of p.data.hits) {
      if (h.beat > p.scheduled && h.beat <= ahead) this.audio.drum(drumByMidi(h.midi)?.id ?? 'block', { when: p.t0 + h.beat / bps - now, velocity: h.vel });
    }
    p.scheduled = ahead;
    if (this.comparing && p.side != null) {
      const heads = [null, null];
      heads[p.side] = clamp(beat, 0, p.data.beats);
      this._paintCompare([1, 1], heads);
    }
    if (beat > p.data.beats + 0.5) this._startNext();
  }

  _loop() {
    cancelAnimationFrame(this.raf);
    const step = () => {
      if (!this.dialog.open) return;
      this.raf = requestAnimationFrame(step);
      if (this.player) this._tickPlayer();
      if (this.replay && this.comparing) {
        const u = clamp((nowS() - this.replay.start) / this.replay.duration, 0, 1);
        this._paintCompare([u, u]);
        if (u >= 1) this.replay = null;
      }
    };
    this.raf = requestAnimationFrame(step);
  }

  state() {
    return {
      open: this.isOpen,
      filter: this.filter,
      selected: [...this.selected],
      comparing: this.comparing ? [...this.comparing] : null,
      playing: !!this.player,
      replaying: !!this.replay,
    };
  }
}

/**
 * Creates the gallery view and plugs it into the feature registry, replacing
 * the placeholder hook: features.register('gallery', { open }).
 */
export function installGallery(app, { reducedMotion = false } = {}) {
  const view = new GalleryView({
    dialog: document.getElementById('gallery'),
    store: app.gallery,
    audio: app.audio,
    onPerform: (id) => app.performItem(id),
    onHang: (id) => app.hangItem(id),
    onUnhang: () => app.unhangWall(),
    onDelete: (id) => app.deleteItem(id),
    onFavorite: (id, on) => app.favoriteItem(id, on),
    onOpen: () => app.onSheetOpen('gallery'),
    onClose: (reason) => app.onSheetClose('gallery', reason),
    reducedMotion,
  });
  app.features.register('gallery', {
    label: 'Creation Gallery',
    short: 'Gallery',
    icon: 'gallery',
    shortcut: 'Y',
    description: 'Replay saved songs and drawings, hang a drawing on the studio wall, favourite or delete pieces, and compare a lesson with your pet\'s attempt.',
    open: () => view.open(),
  });
  return view;
}
