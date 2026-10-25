/**
 * sleep-practice.js: the Sleep Practice drawer (the 'practice' feature).
 *
 * Opening it sends the pet to the Sleep Nook; once it is asleep the
 * PracticeRunner (practice-runner.js) trains its networks in time-sliced
 * steps while dream notes drift up in the studio. The drawer is non-modal,
 * so the sleeping pet stays visible and touchable. It shows what the pet is
 * dreaming about (a live preview of the network's own version of that
 * lesson, redrawn as the weights change), live counters, a loss chart,
 * the controls (Start / Resume, Pause, Step +1, Cancel & Rollback, Wake &
 * Finish) and, after a session, the pet's attempt before and after practice
 * with the same seed. Registered via features.register('practice', ...).
 */
import { paintDrawing, paintPhraseRoll, fitCanvas } from './creation-render.js';
import { KIND_LABELS } from './gallery-store.js';

const useIcon = (id) => `<svg class="ico" aria-hidden="true"><use href="#${id}"></use></svg>`;
const fmt = (v, digits = 3) => (Number.isFinite(v) ? v.toFixed(digits) : '–');
/** "Your Sunny Arp" for your lessons; a visitor's lesson keeps its own name ("Mochi's Moonlit Lullaby"). */
export function lessonName(lesson, kind = lesson?.kind) {
  if (lesson?.source === 'social') return lesson.title ?? `${lesson.from?.name ?? 'A friend'}'s ${kind === 'music' ? 'tune' : 'drawing'}`;
  return lesson?.title ? `Your ${lesson.title}` : kind === 'music' ? 'Your tune' : 'Your drawing';
}
const pct = (v) => `${Math.round((Number.isFinite(v) ? v : 0) * 100)}%`;

/** Small SVG loss chart (log scale) shared with the Inspector; its viewBox follows its CSS size. */
export function renderLossChart(svg, history) {
  const width = Math.max(160, Math.round(svg.clientWidth || 320));
  const height = Math.max(80, Math.round(svg.clientHeight || 120));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const plot = svg.querySelector('.plot');
  plot.setAttribute('width', String(width - 42));
  plot.setAttribute('height', String(height - 26));
  const pts = history.filter((h) => Number.isFinite(h.train) || Number.isFinite(h.val));
  const train = svg.querySelector('[data-line="train"]');
  const val = svg.querySelector('[data-line="val"]');
  const marks = svg.querySelector('[data-marks]');
  const axis = svg.querySelector('[data-axis]');
  const empty = svg.querySelector('[data-empty]');
  empty.setAttribute('x', String(34 + (width - 42) / 2));
  empty.setAttribute('y', String(8 + (height - 26) / 2));
  if (pts.length < 2) {
    train.setAttribute('points', '');
    val.setAttribute('points', '');
    marks.replaceChildren();
    axis.replaceChildren();
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';
  const pad = { l: 34, r: 8, t: 8, b: 18 };
  const values = pts.flatMap((h) => [h.train, h.val]).filter((v) => Number.isFinite(v) && v > 0);
  const lo = Math.log10(Math.max(1e-3, Math.min(...values)));
  const hi = Math.log10(Math.max(...values));
  const span = Math.max(0.3, hi - lo);
  const s0 = pts[0].step;
  const s1 = Math.max(s0 + 1, pts[pts.length - 1].step);
  const x = (step) => pad.l + ((step - s0) / (s1 - s0)) * (width - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (Math.log10(Math.max(1e-3, v)) - (lo - 0.05 * span)) / (span * 1.1)) * (height - pad.t - pad.b);
  const line = (key) => pts.filter((h) => Number.isFinite(h[key]) && h[key] > 0).map((h) => `${x(h.step).toFixed(1)},${y(h[key]).toFixed(1)}`).join(' ');
  train.setAttribute('points', line('train'));
  val.setAttribute('points', line('val'));
  const ns = 'http://www.w3.org/2000/svg';
  marks.replaceChildren(...history.filter((h) => h.mark && h.step >= s0).map((h) => {
    const l = document.createElementNS(ns, 'line');
    const xx = x(h.step).toFixed(1);
    l.setAttribute('x1', xx);
    l.setAttribute('x2', xx);
    l.setAttribute('y1', String(pad.t));
    l.setAttribute('y2', String(height - pad.b));
    l.setAttribute('class', `mark mark-${h.mark}`);
    return l;
  }));
  const label = (text, xx, yy, anchor = 'end') => {
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', String(xx));
    t.setAttribute('y', String(yy));
    t.setAttribute('text-anchor', anchor);
    t.textContent = text;
    return t;
  };
  const top = 10 ** (lo - 0.05 * span + span * 1.1);
  const bottom = 10 ** (lo - 0.05 * span);
  axis.replaceChildren(
    label(top >= 10 ? top.toFixed(0) : top.toPrecision(2), pad.l - 4, pad.t + 8),
    label(bottom >= 10 ? bottom.toFixed(0) : bottom.toPrecision(2), pad.l - 4, height - pad.b),
    label(`step ${s0}`, pad.l, height - 4, 'start'),
    label(`${s1}`, width - pad.r, height - 4),
  );
}

export const LOSS_CHART_SVG = `
  <svg class="loss-chart" viewBox="0 0 320 120" role="img" aria-label="Training and validation loss over training steps">
    <rect x="34" y="8" width="278" height="94" rx="6" class="plot"></rect>
    <g data-marks></g>
    <polyline data-line="train" class="line train" points=""></polyline>
    <polyline data-line="val" class="line val" points=""></polyline>
    <g data-axis class="axis"></g>
    <text data-empty x="173" y="60" text-anchor="middle" class="empty">The curve appears as your pet practises</text>
  </svg>`;

const STATUS_TEXT = {
  idle: (n) => `${n} is ready to practise whenever you are.`,
  'no-data': () => 'Nothing to practise yet: teach a tune or a drawing first.',
  waiting: (n) => `${n} is heading to the Sleep Nook…`,
  practicing: (n) => `${n} is practising in its dreams.`,
  complete: () => 'Practice complete.',
  'rolled-back': () => 'Practice did not help this time, so the previous version was kept.',
  cancelled: () => 'Rolled back to how it was before practice.',
};
const PAUSE_TEXT = {
  player: 'Paused.',
  woke: 'Paused: your pet woke up. Resume sends it back to bed.',
  ready: 'Asleep and ready to practise.',
  step: 'Paused: stepping one batch at a time.',
};
const DECISION_TEXT = {
  committed: 'Kept: validation stayed within the safety margin.',
  'kept-best': 'Kept its best moment: later steps were overfitting.',
  'rolled-back': 'Rolled back: held-out loss got worse.',
};

export class SleepPracticeView {
  constructor({ dialog, app, runner, engine, reducedMotion = false }) {
    this.dialog = dialog;
    this.app = app;
    this.runner = runner;
    this.engine = engine;
    this.reduced = reducedMotion;
    this.raf = 0;
    this.lastStats = 0;
    this.lastChart = 0;
    this.lastPreview = 0;
    this.previewKey = null;
    this.compareKey = null;
    this._build();
    runner.on((e) => {
      if (!this.isOpen) return;
      if (e.type === 'status' || e.type === 'session-end' || e.type === 'dream') this.render(true);
    });
    // A non-modal dialog gets no 'cancel' event, so Escape is handled here (unless a modal sheet is on top).
    const modalOnTop = () => {
      try {
        return !!document.querySelector('dialog:modal');
      } catch {
        return [...document.querySelectorAll('dialog[open]')].some((d) => d !== this.dialog);
      }
    };
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen && !modalOnTop()) {
        e.preventDefault();
        this.close('escape');
      }
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
      <div class="sp-head">
        <span class="sp-moon" aria-hidden="true">${useIcon('i-practice')}</span>
        <div class="sp-titles">
          <h2 id="sp-title" tabindex="-1">Sleep Practice</h2>
          <p class="sp-status" data-sp-status role="status" aria-live="polite"></p>
        </div>
        <button class="icon-btn" type="button" data-sp="close" aria-label="Close Sleep Practice" title="Close (practice keeps going while your pet sleeps)">${useIcon('i-close')}</button>
      </div>
      <div class="sp-body">
        <section class="sp-empty" hidden>
          <p><strong>Nothing to practise yet.</strong> Sleep Practice trains your pet's small neural networks on the tunes and drawings you teach it.</p>
          <button type="button" class="btn primary" data-sp="teach">${useIcon('i-teach')}<span>Open the Teaching Workshop</span></button>
        </section>
        <section class="sp-dream" aria-labelledby="sp-dream-title">
          <canvas class="sp-dream-canvas" role="img" aria-label="The network's own version of the lesson it is practising"></canvas>
          <div class="sp-dream-info">
            <p class="sp-kicker">Dreaming about</p>
            <h3 id="sp-dream-title" data-sp-dream>–</h3>
            <p class="sp-dream-sub" data-sp-dream-sub></p>
          </div>
        </section>
        <dl class="sp-stats">
          <div><dt>Training steps</dt><dd data-stat="steps">0</dd></div>
          <div><dt>Epoch · batch</dt><dd data-stat="epoch">–</dd></div>
          <div><dt>Training loss</dt><dd data-stat="train">–</dd></div>
          <div><dt>Validation loss</dt><dd data-stat="val">–</dd></div>
          <div><dt>Weight change ‖Δθ‖</dt><dd data-stat="delta">0.000</dd></div>
          <div><dt>Learned confidence</dt><dd data-stat="conf">0%</dd></div>
        </dl>
        <figure class="sp-chart">
          ${LOSS_CHART_SVG}
          <figcaption><span class="key train"></span>Training loss <span class="key val"></span>Validation loss (held-out notes and stroke points)</figcaption>
        </figure>
        <div class="sp-tools">
          <button type="button" class="btn" data-sp="step" title="Run exactly one mini-batch">${useIcon('i-play')}<span>Step +1</span></button>
          <button type="button" class="btn" data-sp="cancel" title="Restore the weights from before this practice">${useIcon('i-undo')}<span>Cancel &amp; Rollback</span></button>
        </div>
        <section class="sp-compare" hidden aria-labelledby="sp-compare-title">
          <h3 id="sp-compare-title">Before practice vs after practice</h3>
          <p class="sp-compare-sub" data-sp-compare-sub></p>
          <div class="sp-pair">
            <figure data-side="before"><canvas aria-hidden="true"></canvas><figcaption><span class="sp-tag">Before</span><span data-close-text></span></figcaption></figure>
            <figure data-side="after"><canvas aria-hidden="true"></canvas><figcaption><span class="sp-tag learned">After</span><span data-close-text></span></figcaption></figure>
          </div>
          <button type="button" class="btn primary sp-perform" data-sp="perform">${useIcon('i-praise')}<span>Have Pet Perform New Learned Version</span></button>
        </section>
        <p class="sp-note">Training runs on this device, only while Pet Studio is open and your pet naps here. Nothing is learned while the app is closed. Each network is checked on held-out notes and stroke points; a session that makes them worse is rolled back.</p>
      </div>
      <div class="sp-foot">
        <button type="button" class="btn primary" data-sp="start">${useIcon('i-play')}<span data-label>Start Practice</span></button>
        <button type="button" class="btn" data-sp="pause">${useIcon('i-stop')}<span>Pause</span></button>
        <button type="button" class="btn sp-wake" data-sp="finish">${useIcon('i-wake')}<span>Wake &amp; Finish</span></button>
      </div>`;
    const q = (s) => this.dialog.querySelector(s);
    this.el = {
      title: q('#sp-title'), status: q('[data-sp-status]'), body: q('.sp-body'), empty: q('.sp-empty'), dream: q('.sp-dream'),
      dreamTitle: q('[data-sp-dream]'), dreamSub: q('[data-sp-dream-sub]'), preview: q('.sp-dream-canvas'), stats: q('.sp-stats'),
      chart: q('.loss-chart'), compare: q('.sp-compare'), compareSub: q('[data-sp-compare-sub]'), tools: q('.sp-tools'),
      start: q('[data-sp="start"]'), pause: q('[data-sp="pause"]'), step: q('[data-sp="step"]'), cancel: q('[data-sp="cancel"]'),
      finish: q('[data-sp="finish"]'), perform: q('[data-sp="perform"]'), chartFig: q('.sp-chart'),
    };
    this.stat = Object.fromEntries([...this.dialog.querySelectorAll('[data-stat]')].map((n) => [n.dataset.stat, n]));
    this.dialog.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-sp]');
      if (!b || b.disabled) return;
      this.app.audio.unlock();
      this.command(b.dataset.sp);
    });
  }

  command(cmd) {
    const r = this.runner;
    let res = null;
    switch (cmd) {
      case 'close': this.close('close'); break;
      case 'start': res = r.start(); break;
      case 'pause': res = r.pause('player'); break;
      case 'step': res = r.stepOnce(); break;
      case 'cancel': res = r.cancel(); break;
      case 'finish': res = this.app.finishPractice(); break;
      case 'perform': res = this.app.performLearned(); break;
      case 'teach': this.close('teach'); this.app.openFeature('teach'); break;
      default: break;
    }
    this.render(true);
    return res;
  }

  open() {
    if (!this.dialog.open) this.dialog.show();
    this.dialog.classList.add('open');
    this.el.body.scrollTop = 0;
    this.el.title.focus({ preventScroll: true });
    this.app.onPracticeOpen();
    this.previewKey = null;
    this.compareKey = null;
    this.render(true);
    this._loop();
  }

  close(reason = 'close') {
    if (!this.dialog.open) return;
    this.dialog.close();
    this.dialog.classList.remove('open');
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.app.onPracticeClose(reason);
  }

  _loop() {
    cancelAnimationFrame(this.raf);
    const step = (t) => {
      if (!this.dialog.open) return;
      this.raf = requestAnimationFrame(step);
      this.render(false, t);
    };
    this.raf = requestAnimationFrame(step);
  }

  render(force = false, t = performance.now()) {
    if (!this.dialog.open) return;
    const st = this.runner.state();
    const name = this.app.pet.name;
    if (force || t - this.lastStats > 140) {
      this.lastStats = t;
      this._renderStatus(st, name);
      this._renderStats(st);
      this._renderControls(st);
    }
    if (force || t - this.lastChart > 450) {
      this.lastChart = t;
      renderLossChart(this.el.chart, st.history);
    }
    if (force || (st.status === 'practicing' && t - this.lastPreview > (this.reduced ? 1500 : 650))) {
      this.lastPreview = t;
      this._renderPreview(st);
    }
    this._renderCompare(st);
  }

  _renderStatus(st, name) {
    let text = st.status === 'paused' ? PAUSE_TEXT[st.reason] ?? 'Paused.' : (STATUS_TEXT[st.status] ?? STATUS_TEXT.idle)(name);
    if (st.status === 'practicing') text += ` Step ${st.sessionSteps} of up to ${st.maxSteps}.`;
    if (st.status === 'complete' && st.result) {
      const v = st.result;
      text = v.decision === 'committed'
        ? `Practice complete after ${v.steps} steps: validation ${fmt(v.preVal)} → ${fmt(v.finalVal)}.`
        : v.decision === 'nothing' ? 'No steps were taken.' : text;
    }
    if (st.status === 'rolled-back' && st.result?.reason === 'diverged') text = 'The numbers went wrong (not finite), so the previous version was restored.';
    if (st.status === 'idle' && st.reason === 'got-up') text = `${name} got up before practice began.`;
    this.el.status.textContent = text;
    this.dialog.dataset.status = st.status;
  }

  _renderStats(st) {
    const noData = st.status === 'no-data' || !this.engine.hasData();
    this.el.empty.hidden = !noData;
    for (const node of [this.el.dream, this.el.stats, this.el.chartFig, this.el.tools]) node.hidden = noData;
    if (noData) return;
    this.stat.steps.textContent = `${st.sessionSteps}`;
    this.stat.steps.title = `${st.totalSteps} optimizer steps on this device in total`;
    this.stat.epoch.textContent = st.batchesPerEpoch ? `${st.epoch} · ${st.batch}/${st.batchesPerEpoch}` : '–';
    this.stat.train.textContent = fmt(st.trainLoss);
    this.stat.val.textContent = Number.isFinite(st.valLoss) ? `${fmt(st.valLoss)}${Number.isFinite(st.preVal) ? ` (was ${fmt(st.preVal)})` : ''}` : '–';
    this.stat.delta.textContent = fmt(st.deltaNorm);
    this.stat.conf.textContent = pct(st.confidence);
    this.stat.conf.title = 'Blend weight of the learned network for this lesson: grows with practice steps and with how often this lesson was practised. A schedule, not a quality score.';
    const d = st.dream;
    const lesson = d ? this.app.memory.getLesson(d.lessonId) : null;
    this.el.dreamTitle.textContent = d ? lessonName(lesson, d.kind) : '–';
    const replay = st.replaying.length;
    const newest = this.app.memory.lessonsOf(d?.kind ?? 'music')[0]?.id === d?.lessonId;
    this.el.dreamSub.textContent = d
      ? `${KIND_LABELS[d.kind]} lesson${lesson?.source === 'social' ? ` from ${lesson.from?.name ?? 'a friend'}'s visit (half weight)` : newest ? ' · newest' : ''}${replay ? ` · also replaying ${replay} other${replay === 1 ? '' : 's'}` : ''}${st.frozen.length ? ` · ${st.frozen.join(' and ')} paused (held-out loss rising)` : ''}`
      : '';
  }

  _renderControls(st) {
    const r = this.runner;
    const sessionOpen = !!r.session && !r.session.decision;
    const noData = !this.engine.hasData();
    const label = this.el.start.querySelector('[data-label]');
    label.textContent = sessionOpen && st.status === 'paused' ? 'Resume' : st.status === 'complete' || st.status === 'rolled-back' || st.status === 'cancelled' ? 'Practise Again' : 'Start Practice';
    this.el.start.disabled = noData || st.status === 'practicing' || st.status === 'waiting';
    this.el.pause.disabled = !(st.status === 'practicing' || st.status === 'waiting');
    this.el.step.disabled = noData || st.status === 'practicing' || st.status === 'waiting' || !st.asleep;
    this.el.cancel.disabled = !sessionOpen;
  }

  _renderPreview(st) {
    const d = st.dream;
    const lesson = d ? this.app.memory.getLesson(d.lessonId) : null;
    const cv = this.el.preview;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (!lesson || !w || !h) return;
    const key = `${lesson.id}|${this.engine.stepsFor(lesson.kind)}|${w}x${h}`;
    if (key === this.previewKey) return;
    this.previewKey = key;
    const dpr = fitCanvas(cv, w, h);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const prefs = this.app.memory.prefs;
    const traits = this.app.pet.traits;
    if (lesson.kind === 'music') {
      const net = this.engine.composeMusic(lesson.demo, { seed: 7, prefs, traits, alpha: 1 });
      ctx.globalAlpha = 0.28;
      paintPhraseRoll(ctx, lesson.demo, { w, h, pad: 6, radius: 10, background: '#ffffff' });
      ctx.globalAlpha = 1;
      paintPhraseRoll(ctx, net, { w, h, pad: 6, radius: 10, background: 'rgba(255,255,255,0)' });
    } else {
      const s = Math.min(w, h);
      const x = (w - s) / 2;
      ctx.fillStyle = '#f6efe6';
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 0.25;
      paintDrawing(ctx, lesson.demo, s, { x, border: false });
      ctx.globalAlpha = 1;
      paintDrawing(ctx, this.engine.reconstructDrawing(lesson.demo, { prefs, traits }), s, { x, paper: false });
    }
  }

  _renderCompare(st) {
    const c = this.runner.result?.comparison ?? null;
    const show = !!c && (st.status === 'complete');
    this.el.compare.hidden = !show;
    if (!show) return;
    const key = `${c.lessonId}|${c.after.alpha}|${c.before.alpha}|${this.el.compare.clientWidth}`;
    if (key === this.compareKey) return;
    this.compareKey = key;
    const lesson = this.app.memory.getLesson(c.lessonId);
    this.el.compareSub.textContent = `${lessonName(lesson, c.kind)}: same seeds and style before and after. Closeness to the lesson, averaged over ${c.seeds} tries:`;
    for (const side of ['before', 'after']) {
      const fig = this.el.compare.querySelector(`[data-side="${side}"]`);
      const cv = fig.querySelector('canvas');
      const v = c[side];
      fig.querySelector('[data-close-text]').textContent = `${pct(v.closeness)} · ${v.generator === 'neural-v1' ? `learned (α ${Math.round(v.alpha * 100)}%)` : 'authored rules'}`;
      requestAnimationFrame(() => {
        const w = cv.clientWidth;
        const h = cv.clientHeight;
        if (!w || !h) return;
        const dpr = fitCanvas(cv, w, h);
        const ctx = cv.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        if (c.kind === 'music') paintPhraseRoll(ctx, v.data, { w, h, pad: 5, radius: 10, background: '#ffffff' });
        else {
          const s = Math.min(w, h);
          ctx.fillStyle = '#f6efe6';
          ctx.fillRect(0, 0, w, h);
          paintDrawing(ctx, v.data, s, { x: (w - s) / 2, border: false });
        }
      });
    }
    this.el.perform.disabled = false;
  }

  state() {
    return { open: this.isOpen, ...this.runner.state(), history: undefined };
  }
}

/**
 * Creates the Sleep Practice drawer and plugs it into the feature registry:
 * features.register('practice', { open }).
 */
export function installSleepPractice(app, { reducedMotion = false } = {}) {
  const view = new SleepPracticeView({
    dialog: document.getElementById('practice'),
    app,
    runner: app.practice,
    engine: app.neural,
    reducedMotion,
  });
  app.features.register('practice', {
    label: 'Sleep Practice',
    short: 'Practice',
    icon: 'practice',
    shortcut: 'Z',
    description: 'Your pet naps while its two small neural networks genuinely train on what you taught it. Watch the loss fall, pause or cancel any time, then hear or see the difference.',
    open: () => view.open(),
  });
  return view;
}
