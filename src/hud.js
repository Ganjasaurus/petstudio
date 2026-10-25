/**
 * hud.js: the DOM heads-up display. Pet name and personality badges, the
 * activity status pill, camera view switcher, needs meters, action dock,
 * toasts, hover tips, the "More" sheet and the Creation Feedback Bar. Pure
 * presentation: it renders state snapshots and reports user intent through
 * callbacks.
 */
import { NEEDS, NEED_INFO, needWord, TRAIT_LABELS, topTraitsOf } from './pet-state.js';
import { ORIGIN_LABELS } from './gallery-store.js';
import { paintDrawing, paintPhraseRoll, fitCanvas } from './creation-render.js';

const NEED_ICON = { hunger: 'i-hunger', energy: 'i-energy', hygiene: 'i-hygiene', mood: 'i-mood', curiosity: 'i-curiosity', bond: 'i-bond' };
const STATUS_ICON = { idle: 'i-mood', walk: 'i-walk', food: 'i-hunger', bath: 'i-wash', sleep: 'i-rest', music: 'i-music', draw: 'i-draw', listen: 'i-listen', teach: 'i-teach' };
const FEEDBACK = Object.freeze(['love', 'variation', 'calmer', 'livelier', 'neater', 'wilder', 'dismiss', 'learn']);

/** One-line status for a piece made together with a visiting friend. */
function socialStatus(s) {
  const music = s.kind === 'music';
  const n = s.social.visitor;
  switch (s.phase) {
    case 'walking': return music ? `Heading to the Music Corner with ${n}…` : `Heading to the easel with ${n}…`;
    case 'performing':
      if (!music) return `Taking turns at the easel with ${n}…`;
      if (s.turn === 'visitor') return `${n} plays first. ${s.petName} listens…`;
      if (s.turn === 'host') return `${s.petName} answers ${n} in its own style…`;
      return `Jamming with ${n}…`;
    case 'done':
      if (s.learn?.learned) return `Saved, and ${n}'s idea is kept.`;
      return s.loved ? 'Loved and saved to your Gallery.' : `Saved. Keep ${n}'s idea too?`;
    default: return '';
  }
}

/** One-line status for the feedback bar. */
function barStatus(s) {
  const music = s.kind === 'music';
  if (s.social) return socialStatus(s);
  switch (s.phase) {
    case 'lesson': return music ? 'Listening to your tune…' : 'Studying your drawing…';
    case 'walking': return music ? 'Heading to the Music Corner…' : 'Heading to the easel…';
    case 'performing':
      if (s.mode === 'replay') return music ? 'Performing it from the gallery…' : 'Redrawing it from the gallery…';
      if (s.mode === 'variation') return music ? 'Trying a new idea on the keys…' : 'Trying a new idea at the easel…';
      if (s.mode === 'starter') return music ? 'Playing a little tune of its own…' : 'Painting a doodle of its own…';
      if (s.learned) return music ? 'Playing its take, shaped by practice…' : 'Drawing its take, shaped by practice…';
      return music ? 'Playing its own take…' : 'Drawing its own take…';
    case 'done': return s.loved ? 'Loved and saved to your Gallery.' : 'How was it? Love it, or guide the next try.';
    default: return '';
  }
}
const VIEW_ICON = { home: 'i-home', paw: 'i-paw', music: 'i-music', draw: 'i-draw', sleep: 'i-sleep' };
const BUSY = { feed: 'eating', wash: 'bathing', rest: 'sleeping', music: 'playing_music', draw: 'drawing' };

function svgIcon(id, cls = 'ico') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

export class Hud {
  constructor({ views, features = [], onAction, onView, onMute, onCustomize, onFeature, onFeedback } = {}) {
    const $ = (id) => document.getElementById(id);
    this.el = {
      name: $('pet-name'), avatar: $('pet-avatar'), badges: $('badges'),
      statusText: $('status-text'), statusSource: $('status-source'), statusIcon: $('status-icon'),
      meters: $('meters'), views: $('views'), mute: $('btn-mute'), customize: $('btn-customize'),
      dock: $('dock'), toasts: $('toasts'), tip: $('hover-tip'),
      nextSheet: $('next-sheet'), nextList: $('next-list'), nextButtons: $('next-buttons'),
      bar: $('creation-bar'),
    };
    const bar = this.el.bar;
    this.barEl = {
      thumb: bar.querySelector('.cb-thumb'), name: bar.querySelector('.cb-name'), origin: bar.querySelector('.cb-origin'), learned: bar.querySelector('.cb-learned'),
      social: bar.querySelector('.cb-social'), learn: bar.querySelector('[data-fb="learn"]'), learnLabel: bar.querySelector('.cb-learn-label'),
      status: bar.querySelector('.cb-status'), fill: bar.querySelector('.cb-progress i'), love: bar.querySelector('[data-fb="love"]'),
      buttons: [...bar.querySelectorAll('[data-fb]')].filter((b) => b.dataset.fb !== 'dismiss'),
    };
    this.barThumb = { key: null, progress: -1, playhead: null };
    this.cb = { onAction, onView, onMute, onCustomize, onFeature, onFeedback };
    this.meterEls = {};
    this.last = {};
    this.lastToast = { text: '', at: 0 };
    this._buildMeters();
    this._buildViews(views);
    this.setFeatures(features);
    this._wire();
  }

  _buildMeters() {
    for (const key of NEEDS) {
      const info = NEED_INFO[key];
      const m = el('div', 'meter');
      m.dataset.need = key;
      m.setAttribute('role', 'meter');
      m.setAttribute('aria-label', info.label);
      m.setAttribute('aria-valuemin', '0');
      m.setAttribute('aria-valuemax', '100');
      m.title = `${info.label}: ${info.hint}`;
      const value = el('span', 'm-value', '-');
      const state = el('span', 'm-state');
      const bar = el('span', 'm-bar');
      const fill = el('span', 'm-fill');
      bar.append(fill);
      m.append(svgIcon(NEED_ICON[key]), el('span', 'm-label', info.label), state, value, bar);
      this.el.meters.append(m);
      this.meterEls[key] = { m, value, state, fill, last: null };
    }
  }

  _buildViews(views = []) {
    for (const v of views) {
      const b = el('button', 'view-btn');
      b.type = 'button';
      b.dataset.view = v.id;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.setAttribute('aria-label', v.label);
      b.title = v.label;
      b.append(svgIcon(VIEW_ICON[v.icon] ?? 'i-home'), el('span', 'vlabel', v.label));
      this.el.views.append(b);
    }
  }

  _wire() {
    this.el.dock.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.feature) {
        this.cb.onFeature?.(b.dataset.feature);
        return;
      }
      if (b.dataset.action === 'next') this.openNext();
      else if (b.dataset.action) this.cb.onAction?.(b.dataset.action);
    });
    this.el.views.addEventListener('click', (e) => {
      const b = e.target.closest('[data-view]');
      if (b) this.cb.onView?.(b.dataset.view);
    });
    this.el.views.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      const buttons = [...this.el.views.querySelectorAll('[data-view]')];
      const i = buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true');
      const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
      const next = buttons[(i + step + buttons.length) % buttons.length];
      next.focus();
      this.cb.onView?.(next.dataset.view);
    });
    this.el.mute.addEventListener('click', () => this.cb.onMute?.());
    this.el.customize.addEventListener('click', () => this.cb.onCustomize?.());
    const sheet = this.el.nextSheet;
    sheet.addEventListener('click', (e) => {
      const open = e.target.closest('button[data-feature]');
      if (open) {
        sheet.close();
        this.cb.onFeature?.(open.dataset.feature);
        return;
      }
      if (e.target === sheet || e.target.closest('[data-close]')) sheet.close();
    });
    this.el.bar.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-fb]');
      if (b && !b.disabled && FEEDBACK.includes(b.dataset.fb)) this.cb.onFeedback?.(b.dataset.fb);
    });
  }

  /** Renders a pet-state snapshot (cheap: only touches the DOM when something changed). */
  render(snap, force = false) {
    if (force) this.last = {};
    this.renderIdentity(snap.appearance, snap.topTraits);
    this.renderStatus(snap);
    this.renderNeeds(snap.needs);
    this.renderDock(snap);
  }

  renderIdentity(appearance, topTraits) {
    const key = `${appearance.name}|${appearance.bodyColor}|${appearance.accentColor}|${topTraits.join(',')}`;
    if (key === this.last.identity) return;
    this.last.identity = key;
    this.el.name.textContent = appearance.name;
    document.title = `${appearance.name} · Pet Studio`;
    this.el.avatar.style.setProperty('--pet-body', appearance.bodyColor);
    this.el.avatar.style.setProperty('--pet-accent', appearance.accentColor);
    this.el.badges.replaceChildren(...topTraits.map((t) => {
      const li = el('li', 'badge', TRAIT_LABELS[t]);
      li.dataset.trait = t;
      return li;
    }));
  }

  /** Live preview while customising (before the change is saved). */
  previewIdentity(appearance, traits) {
    this.renderIdentity(appearance, topTraitsOf(traits));
  }

  renderStatus(snap) {
    const st = snap.status;
    const source = snap.activity.type === 'idle' ? '' : snap.activity.source === 'player' ? 'you asked' : 'on its own';
    const key = `${st.text}|${source}`;
    if (key === this.last.status) return;
    this.last.status = key;
    this.el.statusText.replaceChildren(el('span', 's-long', st.text), el('span', 's-short', st.short ?? st.text));
    this.el.statusIcon.setAttribute('href', `#${STATUS_ICON[st.icon] ?? 'i-mood'}`);
    this.el.statusSource.textContent = source;
  }

  renderNeeds(needs) {
    for (const k of NEEDS) {
      const v = Math.round(needs[k]);
      const m = this.meterEls[k];
      if (m.last === v) continue;
      m.last = v;
      const word = needWord(k, v);
      m.value.textContent = String(v);
      m.state.textContent = word;
      m.fill.style.setProperty('--v', `${v}%`);
      m.m.setAttribute('aria-valuenow', String(v));
      m.m.setAttribute('aria-valuetext', `${v} of 100, ${word}`);
      m.m.classList.toggle('low', v < 25);
    }
  }

  renderDock(snap) {
    const asleep = snap.asleep;
    if (asleep !== this.last.asleep) {
      this.last.asleep = asleep;
      const rest = this.el.dock.querySelector('[data-action="rest"]');
      rest.querySelector('use').setAttribute('href', asleep ? '#i-wake' : '#i-rest');
      rest.querySelector('.lbl').textContent = asleep ? 'Wake' : 'Rest';
      rest.title = asleep ? 'Wake up (R)' : 'Rest (R)';
      rest.setAttribute('aria-label', asleep ? 'Wake up' : 'Rest');
    }
    const act = snap.activity.type;
    if (act !== this.last.busy) {
      this.last.busy = act;
      for (const [action, activity] of Object.entries(BUSY)) {
        this.el.dock.querySelector(`[data-action="${action}"]`)?.classList.toggle('busy', act === activity);
      }
    }
  }

  setView(id) {
    for (const b of this.el.views.querySelectorAll('[data-view]')) {
      const on = b.dataset.view === id;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }

  setMuted(muted) {
    const b = this.el.mute;
    b.setAttribute('aria-pressed', String(muted));
    b.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
    b.title = muted ? 'Unmute sound (M)' : 'Mute sound (M)';
    b.querySelector('use').setAttribute('href', muted ? '#i-mute' : '#i-sound');
  }

  /** Small transient message above the dock. */
  toast(message, { tone = 'good', icon = 'i-curiosity', duration = 2800 } = {}) {
    if (!message) return;
    const now = performance.now();
    if (message === this.lastToast.text && now - this.lastToast.at < 1500) return;
    this.lastToast = { text: message, at: now };
    const t = el('div', `toast ${tone}`);
    if (icon) t.append(svgIcon(icon));
    t.append(el('span', null, message));
    this.el.toasts.prepend(t);
    while (this.el.toasts.children.length > 3) this.el.toasts.lastElementChild.remove();
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 320);
    }, duration);
  }

  showTip(text, x, y) {
    const tip = this.el.tip;
    if (!text) {
      this.hideTip();
      return;
    }
    tip.textContent = text;
    tip.hidden = false;
    const half = tip.offsetWidth / 2;
    tip.style.left = `${Math.min(window.innerWidth - half - 8, Math.max(half + 8, x))}px`;
    tip.style.top = `${Math.max(tip.offsetHeight + 20, y)}px`;
  }

  hideTip() {
    this.el.tip.hidden = true;
  }

  /** Workshop features: inline dock buttons on wide screens plus the "More" sheet. */
  setFeatures(features) {
    this.features = features;
    this.el.nextButtons.replaceChildren(...features.map((f) => {
      const b = el('button', f.available ? 'act' : 'act soon');
      b.type = 'button';
      b.dataset.feature = f.id;
      const key = f.shortcut ? ` (${f.shortcut})` : '';
      b.title = f.available ? `${f.label}${key}` : `${f.label}: coming in Iteration ${f.iteration}`;
      b.setAttribute('aria-label', f.available ? f.label : `${f.label}, coming in Iteration ${f.iteration}`);
      b.append(svgIcon(`i-${f.icon}`), el('span', 'lbl', f.short ?? f.label));
      if (!f.available) b.append(el('span', 'tag', 'Soon'));
      return b;
    }));
    this.el.nextList.replaceChildren(...features.map((f) => {
      const li = el('li', f.available ? 'next-row' : 'next-item');
      li.dataset.feature = f.id;
      const wrap = el('span', 'ico-wrap');
      wrap.append(svgIcon(`i-${f.icon}`));
      const body = el('div');
      const h = el('h3', null, f.label);
      h.append(el('span', 'it-tag', f.available ? 'Open' : `Iteration ${f.iteration}`));
      body.append(h, el('p', null, f.description));
      if (f.available) {
        // Available features are real buttons: tapping opens them.
        const b = el('button', 'next-item next-open');
        b.type = 'button';
        b.dataset.feature = f.id;
        b.setAttribute('aria-label', `Open ${f.label}`);
        b.append(wrap, body);
        li.append(b);
      } else {
        li.append(wrap, body);
      }
      return li;
    }));
  }

  /**
   * Renders the Creation Feedback Bar from CreationFlow.barState(). Returns
   * true when its visibility changed (the studio framing must be updated).
   */
  renderCreationBar(state) {
    const bar = this.el.bar;
    const show = !!state?.visible;
    const changed = show === bar.hidden;
    if (!show) {
      if (!bar.hidden) bar.hidden = true;
      this.last.bar = null;
      return changed;
    }
    bar.hidden = false;
    const E = this.barEl;
    const social = state.social ?? null;
    const learn = state.learn ?? null;
    const key = [state.phase, state.title, state.origin, state.loved, state.canFeedback, state.kind, state.mode, state.petName, state.ref, state.learned,
      social?.label ?? '', state.turn ?? '', learn ? `${learn.ok}:${learn.learned}` : ''].join('|');
    if (key !== this.last.bar) {
      this.last.bar = key;
      bar.dataset.phase = state.phase;
      bar.dataset.kind = state.kind;
      bar.classList.toggle('social', !!social);
      E.name.textContent = state.title;
      E.origin.textContent = ORIGIN_LABELS[state.origin] ?? '';
      E.origin.dataset.origin = state.origin;
      E.learned.hidden = !state.learned || state.phase === 'lesson';
      // Made together with a friend: a "Duet with ..." chip, and Learn From <Visitor> in place of the retry controls.
      E.social.hidden = !social;
      E.social.textContent = social?.label ?? '';
      E.learn.hidden = !social;
      E.status.textContent = barStatus(state);
      for (const b of E.buttons) b.disabled = !state.canFeedback;
      E.love.disabled = !state.canFeedback || state.loved;
      E.love.setAttribute('aria-pressed', String(!!state.loved));
      E.love.querySelector('span').textContent = state.loved ? 'Loved' : 'Love It';
      if (social) {
        const done = !!learn?.learned;
        E.learn.disabled = !learn?.ok || done || !state.canFeedback;
        E.learn.setAttribute('aria-pressed', String(done));
        E.learnLabel.textContent = done ? 'Learned' : `Learn From ${social.visitor}`;
        E.learn.setAttribute('aria-label', done ? `Learned from ${social.visitor}` : `Learn From ${social.visitor}`);
      }
      this.barThumb.key = null;
    }
    E.fill.style.width = `${Math.round(state.progress * 1000) / 10}%`;
    this._paintBarThumb(state);
    return changed;
  }

  _paintBarThumb(state) {
    const canvas = this.barEl.thumb;
    const css = canvas.clientWidth || 48;
    const t = this.barThumb;
    let playhead = null;
    if (state.kind === 'music' && state.data && state.phase !== 'done' && state.phase !== 'walking') {
      const beat = (state.elapsed * state.data.tempo) / 60;
      const loop = state.phase === 'performing' ? state.data.beats + 1 : Infinity;
      const b = beat % loop;
      playhead = b <= state.data.beats ? b : null;
    }
    const drawingProgress = state.phase === 'done' || state.phase === 'walking' ? 1 : state.progress;
    const key = `${this.last.bar}|${css}`;
    if (t.key === key && Math.abs(t.progress - drawingProgress) < 0.01 && (playhead == null ? t.playhead == null : Math.abs((t.playhead ?? -9) - playhead) < 0.05)) return;
    t.key = key;
    t.progress = drawingProgress;
    t.playhead = playhead;
    const dpr = fitCanvas(canvas, css, css);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, css, css);
    if (!state.data) return;
    if (state.kind === 'drawing') paintDrawing(ctx, state.data, css, { progress: drawingProgress, border: false });
    else paintPhraseRoll(ctx, state.data, { w: css, h: css, playhead, pad: 4, radius: 8 });
  }

  openNext(focusId = null) {
    for (const li of this.el.nextList.children) li.classList.toggle('focus', li.dataset.feature === focusId);
    if (!this.el.nextSheet.open) this.el.nextSheet.showModal();
  }

  /** CSS-pixel rects of the overlay regions (for camera framing and layout checks). */
  rects() {
    const r = (node) => node.getBoundingClientRect();
    const out = { topbar: r(document.querySelector('.topbar')), meters: r(this.el.meters), dock: r(this.el.dock) };
    if (!this.el.bar.hidden) out.bar = r(this.el.bar);
    return out;
  }
}
