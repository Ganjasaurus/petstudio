/**
 * hud.js: the DOM heads-up display. Pet name and personality badges, the
 * activity status pill, camera view switcher, needs meters, action dock,
 * toasts, hover tips and the "coming next" sheet. Pure presentation: it
 * renders simulation snapshots and reports user intent through callbacks.
 */
import { NEEDS, NEED_INFO, needWord, TRAIT_LABELS, topTraitsOf } from './pet-state.js';

const NEED_ICON = { hunger: 'i-hunger', energy: 'i-energy', hygiene: 'i-hygiene', mood: 'i-mood', curiosity: 'i-curiosity', bond: 'i-bond' };
const STATUS_ICON = { idle: 'i-mood', walk: 'i-walk', food: 'i-hunger', bath: 'i-wash', sleep: 'i-rest', music: 'i-music', draw: 'i-draw', listen: 'i-listen' };
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
  constructor({ views, features = [], onAction, onView, onMute, onCustomize, onFeature } = {}) {
    const $ = (id) => document.getElementById(id);
    this.el = {
      name: $('pet-name'), avatar: $('pet-avatar'), badges: $('badges'),
      statusText: $('status-text'), statusSource: $('status-source'), statusIcon: $('status-icon'),
      meters: $('meters'), views: $('views'), mute: $('btn-mute'), customize: $('btn-customize'),
      dock: $('dock'), toasts: $('toasts'), tip: $('hover-tip'),
      nextSheet: $('next-sheet'), nextList: $('next-list'), nextButtons: $('next-buttons'),
    };
    this.cb = { onAction, onView, onMute, onCustomize, onFeature };
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
      if (e.target === sheet || e.target.closest('[data-close]')) sheet.close();
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

  /** Iteration 2/3 placeholders: inline buttons on wide screens plus the "More" sheet. */
  setFeatures(features) {
    this.features = features;
    this.el.nextButtons.replaceChildren(...features.map((f) => {
      const b = el('button', f.available ? 'act' : 'act soon');
      b.type = 'button';
      b.dataset.feature = f.id;
      b.title = f.available ? f.label : `${f.label}: coming in Iteration ${f.iteration}`;
      b.setAttribute('aria-label', f.available ? f.label : `${f.label}, coming in Iteration ${f.iteration}`);
      b.append(svgIcon(`i-${f.icon}`), el('span', 'lbl', f.short ?? f.label));
      if (!f.available) b.append(el('span', 'tag', 'Soon'));
      return b;
    }));
    this.el.nextList.replaceChildren(...features.map((f) => {
      const li = el('li', 'next-item');
      li.dataset.feature = f.id;
      const wrap = el('span', 'ico-wrap');
      wrap.append(svgIcon(`i-${f.icon}`));
      const body = el('div');
      const h = el('h3', null, f.label);
      h.append(el('span', 'it-tag', f.available ? 'Available' : `Iteration ${f.iteration}`));
      body.append(h, el('p', null, f.description));
      li.append(wrap, body);
      return li;
    }));
  }

  openNext(focusId = null) {
    for (const li of this.el.nextList.children) li.classList.toggle('focus', li.dataset.feature === focusId);
    if (!this.el.nextSheet.open) this.el.nextSheet.showModal();
  }

  /** CSS-pixel rects of the overlay regions (for camera framing and layout checks). */
  rects() {
    const r = (node) => node.getBoundingClientRect();
    return { topbar: r(document.querySelector('.topbar')), meters: r(this.el.meters), dock: r(this.el.dock) };
  }
}
