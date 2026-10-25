/**
 * visit-sheet.js: the Visit / Jam sheet (the 'visit' feature, Iteration 4).
 *
 * Invite one of the three built-in friends (Mochi, Bongo, Lyra) or an
 * imported pet snapshot; while a friend visits: Jam Together, Co-Draw
 * Together, Learn From <Visitor> and Send <Visitor> Home. Share your own pet
 * as a petstudio.snapshot.v1 file (download or copy) and import a friend's
 * (file picker or paste). The sheet is non-modal, like Sleep Practice, so the
 * studio stays live: on phones and tablets it is a bottom sheet, on desktops
 * a side drawer. Starting a session closes it so both pets are in full view.
 * Registered via features.register('visit', ...).
 */
import { TRAIT_LABELS, topTraitsOf } from './pet-state.js';
import { snapshotSummary } from './pet-snapshot.js';

const useIcon = (id) => `<svg class="ico" aria-hidden="true"><use href="#${id}"></use></svg>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const kb = (n) => `${Math.max(1, Math.round(n / 1024))} KB`;

/** A small 2D portrait of a pet: its colours, ear style and a friendly face. */
export function paintPortrait(canvas, appearance, cssSize = 56) {
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const px = Math.round(cssSize * dpr);
  if (canvas.width !== px) {
    canvas.width = px;
    canvas.height = px;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const s = cssSize;
  ctx.clearRect(0, 0, s, s);
  const a = appearance;
  ctx.fillStyle = a.accentColor;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s * 0.48, 0, Math.PI * 2);
  ctx.fill();
  const cx = s / 2;
  const cy = s * 0.58;
  const r = s * 0.27;
  ctx.fillStyle = a.bodyColor;
  ctx.strokeStyle = 'rgba(61, 40, 56, 0.55)';
  ctx.lineWidth = Math.max(1, s * 0.025);
  const shape = (draw) => {
    ctx.beginPath();
    draw();
    ctx.fill();
    ctx.stroke();
  };
  for (const side of [-1, 1]) {
    if (a.earStyle === 'bunny') shape(() => ctx.ellipse(cx + side * r * 0.45, cy - r * 1.35, r * 0.24, r * 0.62, side * 0.12, 0, Math.PI * 2));
    else if (a.earStyle === 'cat') {
      shape(() => {
        ctx.moveTo(cx + side * r * 0.25, cy - r * 0.8);
        ctx.lineTo(cx + side * r * 0.82, cy - r * 1.45);
        ctx.lineTo(cx + side * r * 0.95, cy - r * 0.45);
        ctx.closePath();
      });
    } else if (a.earStyle === 'horns') {
      ctx.save();
      ctx.fillStyle = a.accentColor === '#ffffff' ? '#f3d27a' : a.accentColor;
      shape(() => {
        ctx.moveTo(cx + side * r * 0.3, cy - r * 0.85);
        ctx.quadraticCurveTo(cx + side * r * 0.75, cy - r * 1.55, cx + side * r * 1.0, cy - r * 1.35);
        ctx.quadraticCurveTo(cx + side * r * 0.75, cy - r * 1.05, cx + side * r * 0.62, cy - r * 0.7);
        ctx.closePath();
      });
      ctx.restore();
    } else shape(() => ctx.arc(cx + side * r * 0.72, cy - r * 0.78, r * 0.36, 0, Math.PI * 2));
  }
  shape(() => ctx.ellipse(cx, cy, r * 1.08, r, 0, 0, Math.PI * 2));
  ctx.fillStyle = a.cheekColor;
  ctx.globalAlpha = 0.55;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + side * r * 0.62, cy + r * 0.28, r * 0.2, r * 0.13, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#2b2034';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + side * r * 0.36, cy - r * 0.05, r * 0.11, r * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = '#2b2034';
  ctx.lineWidth = Math.max(1, s * 0.03);
  ctx.beginPath();
  ctx.arc(cx, cy + r * 0.2, r * 0.22, Math.PI * 0.15, Math.PI * 0.85);
  ctx.stroke();
}

const traitLine = (snap) => topTraitsOf(snap.traits, 2, 0.55).map((t) => TRAIT_LABELS[t]).join(' · ');

export class VisitSheet {
  constructor({ dialog, app, reducedMotion = false }) {
    this.dialog = dialog;
    this.app = app;
    this.reduced = reducedMotion;
    this.message = null;
    this.highlight = null;
    this.raf = 0;
    this.lastRender = 0;
    this._build();
    // A non-modal dialog gets no 'cancel' event, so Escape is handled here (unless a modal sheet is on top).
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.isOpen) return;
      let modal = false;
      try {
        modal = !!document.querySelector('dialog:modal');
      } catch {
        modal = [...document.querySelectorAll('dialog[open]')].some((d) => d !== this.dialog && d.id !== 'practice');
      }
      if (modal) return;
      e.preventDefault();
      this.close('escape');
    });
  }

  get isOpen() {
    return this.dialog.open;
  }

  /** Resting rect for camera framing (layout box: ignores the slide-in transform). */
  panelRect() {
    const d = this.dialog;
    if (!d.open) return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    const { offsetLeft: left, offsetTop: top, offsetWidth: width, offsetHeight: height } = d;
    return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height };
  }

  _build() {
    this.dialog.innerHTML = `
      <div class="vs-head">
        <span class="vs-badge" aria-hidden="true">${useIcon('i-visit')}</span>
        <div class="vs-titles">
          <h2 id="vs-title" tabindex="-1">Visit / Jam</h2>
          <p class="vs-status" data-vs-status role="status" aria-live="polite"></p>
        </div>
        <button class="icon-btn" type="button" data-vs="close" aria-label="Close Visit / Jam" title="Close (the visit goes on)">${useIcon('i-close')}</button>
      </div>
      <div class="vs-body">
        <p class="vs-msg" data-vs-msg role="alert" hidden></p>
        <section class="vs-visitor" data-vs-visitor hidden aria-labelledby="vs-vname">
          <canvas class="vs-portrait vs-portrait-lg" aria-hidden="true"></canvas>
          <div class="vs-vinfo">
            <p class="vs-kicker">Visiting now</p>
            <h3 id="vs-vname" data-vs-vname></h3>
            <p class="vs-traits" data-vs-vtraits></p>
            <p class="vs-prov" data-vs-prov></p>
          </div>
        </section>
        <div class="vs-actions" data-vs-actions hidden>
          <button type="button" class="btn primary" data-vs="jam">${useIcon('i-music')}<span>Jam Together</span></button>
          <button type="button" class="btn primary vs-draw" data-vs="codraw">${useIcon('i-draw')}<span>Co-Draw Together</span></button>
          <button type="button" class="btn" data-vs="learn">${useIcon('i-teach')}<span class="vs-ellip" data-label>Learn From</span></button>
          <button type="button" class="btn" data-vs="home">${useIcon('i-home')}<span class="vs-ellip" data-label>Send Home</span></button>
        </div>
        <section class="vs-sec" aria-labelledby="vs-friends-title">
          <h3 id="vs-friends-title">Friends</h3>
          <ul class="vs-list" data-vs-list></ul>
        </section>
        <section class="vs-sec" aria-labelledby="vs-share-title">
          <h3 id="vs-share-title">Share your pet</h3>
          <p class="vs-note" data-vs-share-note></p>
          <div class="vs-row">
            <button type="button" class="btn" data-vs="export">${useIcon('i-download')}<span>Download Snapshot</span></button>
            <button type="button" class="btn" data-vs="copy">${useIcon('i-copy')}<span>Copy</span></button>
          </div>
          <div class="vs-row">
            <button type="button" class="btn" data-vs="import">${useIcon('i-upload')}<span>Import File</span></button>
            <button type="button" class="btn" data-vs="paste-toggle" aria-expanded="false" aria-controls="vs-paste">${useIcon('i-paste')}<span>Paste</span></button>
          </div>
          <input type="file" accept=".json,application/json" data-vs-file hidden>
          <div class="vs-paste" id="vs-paste" hidden>
            <label class="vs-paste-label" for="vs-paste-text">Paste a friend's snapshot (petstudio.snapshot.v1)</label>
            <textarea id="vs-paste-text" data-vs-paste rows="3" spellcheck="false" autocomplete="off"></textarea>
            <button type="button" class="btn primary" data-vs="paste-import">${useIcon('i-check')}<span>Import Pasted Snapshot</span></button>
          </div>
        </section>
        <p class="vs-honest">Visits happen in this studio on this device. Snapshots travel as files or copied text; nearby wireless exchange is not part of this web version.</p>
      </div>`;
    const q = (s) => this.dialog.querySelector(s);
    this.el = {
      title: q('#vs-title'), status: q('[data-vs-status]'), msg: q('[data-vs-msg]'), body: q('.vs-body'),
      visitor: q('[data-vs-visitor]'), portrait: q('.vs-portrait-lg'), vname: q('[data-vs-vname]'), vtraits: q('[data-vs-vtraits]'), prov: q('[data-vs-prov]'),
      actions: q('[data-vs-actions]'), jam: q('[data-vs="jam"]'), codraw: q('[data-vs="codraw"]'), learn: q('[data-vs="learn"]'), home: q('[data-vs="home"]'),
      list: q('[data-vs-list]'), shareNote: q('[data-vs-share-note]'), file: q('[data-vs-file]'), paste: q('.vs-paste'), pasteText: q('[data-vs-paste]'),
      pasteToggle: q('[data-vs="paste-toggle"]'),
    };
    this.dialog.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-vs]');
      if (!b || b.disabled) return;
      this.app.audio.unlock();
      this.command(b.dataset.vs, b.dataset.id ?? null);
    });
    this.el.file.addEventListener('change', async () => {
      const file = this.el.file.files?.[0];
      this.el.file.value = '';
      if (!file) return;
      if (file.size > 300_000) {
        this.say({ tone: 'warn', text: 'That file is too large to be a pet snapshot (the limit is 256 KB).' });
        return;
      }
      let text = '';
      try {
        text = await file.text();
      } catch {
        this.say({ tone: 'warn', text: 'That file could not be read.' });
        return;
      }
      this._imported(this.app.importSnapshot(text));
    });
  }

  say(message) {
    this.message = message;
    this.render(true);
  }

  command(cmd, id = null) {
    const app = this.app;
    let res = null;
    switch (cmd) {
      case 'close': this.close('close'); return null;
      case 'invite':
        res = app.inviteFriend(id);
        this.say(res.ok ? null : { tone: 'warn', text: res.message ?? 'That friend could not visit right now.' });
        break;
      case 'remove':
        res = { ok: app.removeFriend(id) };
        this.say(res.ok ? { tone: 'good', text: 'Removed that friend from this studio.' } : null);
        break;
      case 'jam':
      case 'codraw':
        res = app.startSocial(cmd);
        if (!res.ok) this.say({ tone: 'warn', text: res.message ?? 'Not right now.' });
        break;
      case 'learn':
        res = app.learnFromVisitor();
        this.say({ tone: res.ok ? 'good' : 'warn', text: res.message });
        break;
      case 'home':
        res = app.sendVisitorHome();
        this.say(null);
        break;
      case 'export':
        res = app.exportSnapshot({ download: true });
        this.say(res.ok ? { tone: 'good', text: `Saved ${res.fileName} (${kb(res.bytes)}): look, temperament, style, learned weights and up to two of its own songs and drawings.` } : { tone: 'warn', text: res.message });
        break;
      case 'copy':
        res = app.copySnapshot();
        Promise.resolve(res).then((r) => this.say(r.ok ? { tone: 'good', text: `Copied the snapshot (${kb(r.bytes)}). Paste it into a friend's Pet Studio.` } : { tone: 'warn', text: r.message }));
        break;
      case 'import':
        this.el.file.click();
        break;
      case 'paste-toggle': {
        const open = this.el.paste.hidden;
        this.el.paste.hidden = !open;
        this.el.pasteToggle.setAttribute('aria-expanded', String(open));
        if (open) this.el.pasteText.focus({ preventScroll: true });
        break;
      }
      case 'paste-import':
        res = app.importSnapshot(this.el.pasteText.value);
        this._imported(res);
        if (res.ok) this.el.pasteText.value = '';
        break;
      default: break;
    }
    this.render(true);
    return res;
  }

  _imported(res) {
    if (res.ok) {
      this.highlight = res.friendId;
      const extra = res.warnings?.includes('weights-invalid') ? ' Its learned weights were damaged, so it visits with authored behaviour.' : '';
      this.say({ tone: 'good', text: `${res.existing ? 'Updated' : 'Added'} ${res.name}${res.copy ? ' (a copy of your own pet)' : ''} to your friends. Tap Invite to bring it over.${extra}` });
    } else {
      this.say({ tone: 'warn', text: res.message ?? 'That snapshot could not be imported.' });
    }
  }

  open() {
    if (!this.dialog.open) this.dialog.show();
    this.dialog.classList.add('open');
    this.message = null;
    this.el.body.scrollTop = 0;
    this.el.title.focus({ preventScroll: true });
    this.app.onVisitOpen();
    this.render(true);
    this._loop();
  }

  close(reason = 'close') {
    if (!this.dialog.open) return;
    this.dialog.close();
    this.dialog.classList.remove('open');
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.app.onVisitClose(reason);
  }

  _loop() {
    cancelAnimationFrame(this.raf);
    const step = (t) => {
      if (!this.dialog.open) return;
      this.raf = requestAnimationFrame(step);
      if (t - this.lastRender > 250) this.render(false, t);
    };
    this.raf = requestAnimationFrame(step);
  }

  render(force = false, t = performance.now()) {
    if (!this.dialog.open) return;
    this.lastRender = t;
    const app = this.app;
    const st = app.social.state();
    const v = st.visitor;
    const s = st.session;
    const name = v?.displayName ?? '';
    this.el.status.textContent = this._status(st);
    this.dialog.dataset.visiting = v ? (v.leaving ? 'leaving' : 'yes') : 'no';
    // Message line (import results, refusals).
    const m = this.message;
    this.el.msg.hidden = !m;
    if (m) {
      this.el.msg.textContent = m.text;
      this.el.msg.dataset.tone = m.tone ?? 'good';
    }
    // The visitor card and its actions.
    this.el.visitor.hidden = !v;
    this.el.actions.hidden = !v;
    if (v) {
      const key = `${v.id}|${v.leaving}`;
      if (force || this.visitorKey !== key) {
        this.visitorKey = key;
        const snap = app.social.visitor?.snapshot;
        if (snap) {
          paintPortrait(this.el.portrait, snap.pet, 64);
          this.el.vname.textContent = name;
          this.el.vtraits.textContent = `${traitLine(snap)}${snap.blurb ? ` · ${snap.blurb}` : ''}`;
          this.el.prov.textContent = this._provenance(v, snap);
        }
      }
      const learnable = app.social.canLearn();
      const busy = !!s || v.leaving || !v.arrived;
      this.el.jam.disabled = busy;
      this.el.codraw.disabled = busy;
      this.el.learn.disabled = !learnable.ok || learnable.learned;
      this.el.home.disabled = v.leaving;
      this._label(this.el.learn, learnable.learned ? `Learned From ${v.name}` : `Learn From ${v.name}`);
      this._label(this.el.home, v.leaving ? `${v.name} Is Leaving` : `Send ${v.name} Home`);
      this.el.learn.title = learnable.ok ? `Keep ${v.name}'s demonstration as inspiration (half weight); practise it in Sleep Practice` : 'Jam or draw together first';
    }
    // Friends list (rebuilt only when something changed).
    const friends = app.friends.all();
    const listKey = JSON.stringify([friends.map((f) => f.id), v?.id ?? null, v?.leaving ?? null, this.highlight, !!s]);
    if (force || listKey !== this.listKey) {
      this.listKey = listKey;
      this._renderFriends(friends, v, !!s);
    }
    this.el.shareNote.textContent = `A snapshot is a small file with ${app.pet.name}'s look, temperament, style, learned weights (${app.neural.parameterCount.toLocaleString('en-US')} numbers) and up to two of its own songs and drawings. Your lessons stay here.`;
  }

  _label(button, text) {
    const span = button.querySelector('[data-label]');
    if (span.textContent !== text) span.textContent = text;
    button.setAttribute('aria-label', text);
  }

  _status(st) {
    const v = st.visitor;
    const s = st.session;
    const host = this.app.pet.name;
    if (!v) return 'Invite a friend over, or share your pet as a snapshot.';
    const n = v.displayName;
    if (v.leaving) return `${n} is heading home.`;
    if (!v.arrived) return `${n} is on the way in…`;
    if (s?.phase === 'gathering') return s.mode === 'jam' ? `${host} and ${n} head to the Music Corner…` : `${host} and ${n} head to the easel…`;
    if (s?.phase === 'performing' || s?.phase === 'starting') return s.mode === 'jam' ? `${n} plays first, then ${host} answers.` : `${host} and ${n} take turns at the easel.`;
    if (s?.phase === 'done') return `Made together and saved to your Gallery: ${s.title}.`;
    return `${n} is visiting. Jam or draw together!`;
  }

  _provenance(v, snap) {
    const sum = snapshotSummary(snap);
    if (v.origin === 'builtin') return 'Built-in friend: authored songs and drawings, no trained weights.';
    const when = snap.createdAt ? new Date(snap.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'an unknown date';
    const copy = snap.source?.petId && snap.source.petId === this.app.pet.id ? ' A copy of your own pet with its own identity here.' : '';
    const learned = sum.learned.trained
      ? `Brought its learned weights (${sum.learned.steps.music + sum.learned.steps.drawing} training steps at home); they never train here.`
      : 'No trained weights: it plays and draws with authored rules.';
    return `Imported snapshot from ${when}. ${learned}${copy}`;
  }

  _renderFriends(friends, v, busy) {
    this.el.list.innerHTML = friends.map((f) => {
      const snap = f.snapshot;
      const here = v?.id === f.id;
      const isNew = this.highlight === f.id;
      const imported = f.origin === 'import';
      const learned = !!snap.neural?.weights;
      const copy = snap.source?.petId && snap.source.petId === this.app.pet.id;
      const tags = [imported ? '<span class="vs-tag" data-tag="import">Imported</span>' : '<span class="vs-tag">Built-in</span>'];
      if (learned) tags.push('<span class="vs-tag" data-tag="learned">Learned weights</span>');
      if (copy) tags.push('<span class="vs-tag" data-tag="copy">Your copy</span>');
      if (isNew) tags.push('<span class="vs-tag" data-tag="new">New</span>');
      const label = here ? 'Visiting' : v ? 'Invite Instead' : 'Invite';
      return `
        <li class="vs-friend${here ? ' here' : ''}${isNew ? ' new' : ''}" data-friend="${esc(f.id)}">
          <canvas class="vs-portrait" aria-hidden="true" data-portrait="${esc(f.id)}"></canvas>
          <div class="vs-finfo">
            <h4>${esc(snap.pet.name)}${copy ? ' (copy)' : ''}</h4>
            <p class="vs-ftraits">${esc(traitLine(snap))}</p>
            <p class="vs-fblurb">${esc(snap.blurb ?? `${snap.phrases.length} songs and ${snap.drawings.length} drawings`)}</p>
            <div class="vs-tags">${tags.join('')}</div>
          </div>
          <div class="vs-fact">
            <button type="button" class="btn${here ? '' : ' primary'} vs-invite" data-vs="invite" data-id="${esc(f.id)}" ${here || busy ? 'disabled' : ''} aria-label="${esc(`${label}: ${snap.pet.name}`)}">${here ? useIcon('i-check') : useIcon('i-visit')}<span>${label}</span></button>
            ${imported ? `<button type="button" class="icon-btn vs-remove" data-vs="remove" data-id="${esc(f.id)}" ${here ? 'disabled' : ''} aria-label="Remove ${esc(snap.pet.name)}" title="Remove from this studio">${useIcon('i-trash')}</button>` : ''}
          </div>
        </li>`;
    }).join('');
    for (const cv of this.el.list.querySelectorAll('canvas[data-portrait]')) {
      const f = friends.find((x) => x.id === cv.dataset.portrait);
      if (f) paintPortrait(cv, f.snapshot.pet, 48);
    }
  }

  state() {
    return {
      open: this.isOpen,
      status: this.el.status.textContent,
      message: this.message ? { ...this.message } : null,
      friends: [...this.el.list.querySelectorAll('.vs-friend')].map((li) => li.dataset.friend),
      pasteOpen: !this.el.paste.hidden,
    };
  }
}

/** Creates the Visit / Jam sheet and plugs it into the feature registry: features.register('visit', ...). */
export function installVisitSheet(app, { reducedMotion = false } = {}) {
  const view = new VisitSheet({ dialog: document.getElementById('visit'), app, reducedMotion });
  app.features.register('visit', {
    label: 'Visit / Jam',
    short: 'Visit',
    icon: 'visit',
    shortcut: 'B',
    description: 'Invite a friend pet (Mochi, Bongo, Lyra or an imported snapshot) into your studio: jam together, draw together, and keep a little inspiration. Share your own pet as a snapshot file.',
    open: () => view.open(),
  });
  return view;
}
