/**
 * learning-inspector.js: the Learning Inspector (the 'inspector' feature).
 *
 * Developer diagnostics for players and evaluators, kept out of the normal
 * flow: both networks' architecture and parameter counts, the weight norm
 * and how far training moved it from the untrained baseline, steps and the
 * blend weight; what feeds the trainer (lessons, love and direction signals,
 * training and held-out examples); an explicit table of what is authored,
 * remembered, shared or learned; checkpoints with rollback, save, reset and
 * "run 10 steps"; a fair before/after evidence check with fixed seeds; and
 * the training settings. Registered via features.register('inspector', ...).
 */
import { renderLossChart, LOSS_CHART_SVG } from './sleep-practice.js';
import { MODEL_KINDS, NEURAL_GENERATOR, NeuralEngine, PracticeSession, sanitizeSettings, MODEL_LIMITS } from './neural-engine.js';
import { HybridCreativeEngine } from './hybrid-engine.js';
import { lessonCloseness } from './teaching-core.js';
import { NUDGE_IDS, NUDGES } from './creative-engine.js';
import { hashSeed } from './rng.js';

const useIcon = (id) => `<svg class="ico" aria-hidden="true"><use href="#${id}"></use></svg>`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '–');
const int = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '–');
const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–');

export const LEARNED_VS_AUTHORED = Object.freeze([
  ['Needs, moods and care', 'Hand-written rules and per-second rates (pet-state.js)', 'authored'],
  ['Choosing what to do next', 'Utility scores and a seeded softmax (pet-state.js)', 'authored'],
  ['Walking between stations', 'Waypoint paths (studio-layout.js)', 'authored'],
  ['3D animation and expressions', 'Procedural animation (pet-model.js)', 'authored'],
  ['Starter songs and doodles', 'Seeded generators (starter-repertoire.js)', 'authored'],
  ['Teaching memory', 'Stored lessons and labelled feedback: retrieval only, no weights change', 'memory'],
  ['Variation rules (echo, sequence, wobble, tilt)', 'AuthoredCreativeEngine (creative-engine.js)', 'authored'],
  ['Features, smoothing, renderers, synthesiser', 'Fixed and shared by every pet (neural-engine.js, creation-render.js, audio.js)', 'shared'],
  ['Next note, duration, velocity, tempo', 'MusicPolicyNet: float32 weights trained by gradient descent', 'learned'],
  ['Stroke detail, pressure, width, colour, steadiness', 'StrokePolicyNet: float32 weights trained by gradient descent', 'learned'],
  ['Style-conditioned generation', 'Style inputs of both networks, trained on style copies weighted by your nudges', 'learned'],
  ['How much the networks steer (α)', 'A schedule over training steps and lesson practice', 'authored'],
  ['Visiting friends: walking, jamming, co-drawing', 'Authored choreography (social-studio.js); a visitor plays and draws from its own snapshot', 'authored'],
  ['Learning from a visitor', 'Its demonstration joins teaching memory at half weight (0.5×); Sleep Practice trains on it like a lesson', 'memory'],
]);
const TAG = { authored: 'Authored', memory: 'Memory', shared: 'Shared fixed', learned: 'Learned' };
/** Greek letters keep their case inside upper-cased headers ("α", not "Α", which reads as "A"). */
const sym = (s) => `<span class="in-sym">${s}</span>`;
/**
 * Responsive tables: on narrow screens every row becomes a stacked card (see
 * styles.css, .in-stack). Explicit ARIA roles keep the table semantics that
 * browsers drop once rows and cells are no longer laid out as a table, and
 * each cell carries its column name (data-label) for the card layout.
 */
const cell = (cls, label, html, extra = '') => `<td role="cell" class="${cls}"${label ? ` data-label="${esc(label)}"` : ''}${extra}>${html}</td>`;
const head = (cols) => `<thead role="rowgroup"><tr role="row">${cols.map((c) => `<th role="columnheader" scope="col">${c}</th>`).join('')}</tr></thead>`;

export class LearningInspector {
  constructor({ dialog, app }) {
    this.dialog = dialog;
    this.app = app;
    this.engine = app.neural;
    this.confirmReset = 0;
    this.evidence = null;
    this.message = '';
    this._build();
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      this.close('escape');
    });
    this.engine.on(() => {
      if (this.isOpen) this.render();
    });
  }

  get isOpen() {
    return this.dialog.open;
  }

  _build() {
    this.dialog.innerHTML = `
      <div class="sheet-head in-head">
        <div><h2 id="in-title" tabindex="-1">Learning Inspector</h2><p class="sheet-sub" data-in-sub></p></div>
        <button class="icon-btn" type="button" data-in="close" aria-label="Close Inspector" title="Close">${useIcon('i-close')}</button>
      </div>
      <div class="in-body">
        <p class="in-msg" data-in-msg role="status" aria-live="polite"></p>
        <section class="in-sec" aria-labelledby="in-arch"><h3 id="in-arch">Networks and parameters</h3><div class="in-nets" data-in-nets></div><p class="in-total" data-in-total></p></section>
        <section class="in-sec" aria-labelledby="in-data"><h3 id="in-data">Replay buffer and signals</h3><div class="in-table-wrap"><table role="table" aria-labelledby="in-data" class="in-table in-stack in-data" data-in-data></table></div></section>
        <section class="in-sec" aria-labelledby="in-ckpt">
          <h3 id="in-ckpt">Checkpoints</h3>
          <div class="in-table-wrap"><table role="table" aria-labelledby="in-ckpt" class="in-table in-stack in-ckpts" data-in-ckpts></table></div>
          <div class="in-actions">
            <button type="button" class="btn primary" data-in="run">${useIcon('i-play')}<span>Run 10 Training Steps</span></button>
            <button type="button" class="btn" data-in="save">${useIcon('i-check')}<span>Save Checkpoint</span></button>
            <button type="button" class="btn in-danger" data-in="reset">${useIcon('i-trash')}<span data-label>Reset Model to Untrained</span></button>
          </div>
        </section>
        <section class="in-sec" aria-labelledby="in-curve"><h3 id="in-curve">Loss history</h3><figure class="sp-chart">${LOSS_CHART_SVG}<figcaption><span class="key train"></span>Training (batch average) <span class="key val"></span>Validation (held-out)</figcaption></figure></section>
        <section class="in-sec" aria-labelledby="in-evidence">
          <h3 id="in-evidence">Evidence: closeness to your lessons</h3>
          <p class="in-hint">Same four seeds for every column. "Untrained at the same α" uses the baseline weights with today's blend weight, separating what training learned from the blend schedule. Descriptive, not a score.</p>
          <div class="in-table-wrap"><table role="table" aria-labelledby="in-evidence" class="in-table in-stack in-evidence" data-in-evidence></table></div>
          <button type="button" class="btn" data-in="measure">${useIcon('i-compare')}<span>Measure now</span></button>
        </section>
        <section class="in-sec" aria-labelledby="in-split"><h3 id="in-split">What is learned and what is authored</h3><div class="in-table-wrap"><table role="table" aria-labelledby="in-split" class="in-table in-stack in-truth">
          ${head(['Part', 'How it works', 'Kind'])}
          <tbody role="rowgroup">${LEARNED_VS_AUTHORED.map(([part, how, kind]) => `<tr role="row">${cell('tr-part', '', esc(part).replace(/α/g, sym('α')))}${cell('tr-how', '', esc(how))}${cell('tr-kind', '', `<span class="in-kind" data-kind="${kind}">${TAG[kind]}</span>`)}</tr>`).join('')}</tbody>
        </table></div></section>
        <section class="in-sec" aria-labelledby="in-settings">
          <h3 id="in-settings">Training settings</h3>
          <div class="in-settings" data-in-settings></div>
          <button type="button" class="btn" data-in="apply">${useIcon('i-check')}<span>Apply settings</span></button>
        </section>
      </div>`;
    const q = (s) => this.dialog.querySelector(s);
    this.el = {
      title: q('#in-title'), sub: q('[data-in-sub]'), msg: q('[data-in-msg]'), nets: q('[data-in-nets]'), total: q('[data-in-total]'),
      data: q('[data-in-data]'), ckpts: q('[data-in-ckpts]'), chart: q('.loss-chart'), evidence: q('[data-in-evidence]'),
      settings: q('[data-in-settings]'), body: q('.in-body'), reset: q('[data-in="reset"]'), run: q('[data-in="run"]'),
    };
    this.dialog.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-in]');
      if (!b || b.disabled) return;
      this.app.audio.unlock();
      this.command(b.dataset.in, b.dataset.id ?? null);
    });
  }

  open() {
    if (!this.dialog.open) this.dialog.showModal();
    this.message = '';
    this.render();
    this.el.body.scrollTop = 0;
    this.el.title.focus({ preventScroll: true });
    this.app.onSheetOpen('inspector');
  }

  close(reason = 'close') {
    if (!this.dialog.open) return;
    this.dialog.close();
    this.app.onSheetClose('inspector', reason);
  }

  _busy() {
    const r = this.app.practice;
    return !!r.session && !r.session.decision;
  }

  command(cmd, id = null) {
    const e = this.engine;
    let res = null;
    switch (cmd) {
      case 'close': this.close('close'); return null;
      case 'run': res = this.runSteps(10); break;
      case 'save': {
        const cp = e.createCheckpoint('user', { name: `Snapshot ${new Date(e.clock()).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`, valLoss: e.computeValidationLoss().total });
        this.message = `Saved "${cp.name}" (${int(cp.steps.music + cp.steps.drawing)} steps in its weights).`;
        res = { ok: true, id: cp.id };
        break;
      }
      case 'rollback': res = this.rollback(id); break;
      case 'reset': res = this.reset(); break;
      case 'measure': this.evidence = this.measure(); res = this.evidence; break;
      case 'apply': res = this.applySettings(); break;
      default: break;
    }
    this.render();
    return res;
  }

  /** "Run 10 Training Steps": a short validation-gated session (developer action; no nap needed). */
  runSteps(n = 10) {
    if (this._busy()) {
      this.message = 'Sleep Practice is running: use its controls, or finish it first.';
      return { ok: false, reason: 'busy' };
    }
    const e = this.engine;
    if (!e.hasData()) {
      this.message = 'Nothing to train on yet: teach a tune or a drawing first.';
      return { ok: false, reason: 'no-data' };
    }
    const s = new PracticeSession(e, { maxSteps: n, evalEvery: n });
    s.begin();
    while (s.running) s.step();
    const d = s.finish();
    if (d.decision === 'rolled-back') e.commit(d.preVal ?? null);
    this.message = d.decision === 'committed'
      ? `Ran ${d.steps} steps: validation ${fmt(d.preVal)} → ${fmt(d.finalVal)}. Committed as the latest checkpoint.`
      : `Ran ${d.steps} steps, then rolled back (${d.reason}).`;
    this.app.onModelChanged('inspector-steps');
    return { ok: true, decision: d };
  }

  rollback(id) {
    if (this._busy()) {
      this.message = 'Finish or cancel Sleep Practice before rolling back.';
      return { ok: false, reason: 'busy' };
    }
    const cp = this.engine.getCheckpoint(id);
    if (!cp || !this.engine.rollbackTo(id)) return { ok: false, reason: 'missing' };
    this.message = `Rolled back to "${cp.name}".`;
    this.app.onModelChanged('rollback');
    return { ok: true };
  }

  reset() {
    if (this._busy()) {
      this.message = 'Finish or cancel Sleep Practice before resetting.';
      return { ok: false, reason: 'busy' };
    }
    const now = performance.now();
    if (now > this.confirmReset) {
      this.confirmReset = now + 3500;
      this.message = 'Tap Reset again to return both networks to the untrained baseline. Lessons and creations are kept.';
      setTimeout(() => this.isOpen && this.render(), 3600);
      return { ok: false, reason: 'confirm' };
    }
    this.confirmReset = 0;
    this.engine.resetUntrained();
    this.evidence = null;
    this.message = 'Both networks are back to the untrained baseline. Your lessons are kept in teaching memory.';
    this.app.onModelChanged('reset');
    return { ok: true };
  }

  applySettings() {
    const read = (k) => this.el.settings.querySelector(`[data-setting="${k}"]`);
    const next = { ...this.engine.settings };
    for (const k of ['learningRate', 'batchSize', 'sessionSteps', 'stepsPerSecond', 'replayOlder', 'anchor']) {
      const v = Number(read(k)?.value);
      if (Number.isFinite(v)) next[k] = v;
    }
    next.optimizer = read('optimizer')?.value === 'sgd' ? 'sgd' : 'adam';
    this.engine.settings = sanitizeSettings(next);
    this.message = 'Settings applied to the next training steps.';
    this.app.onModelChanged('settings');
    return { ok: true, settings: { ...this.engine.settings } };
  }

  /** Fair evidence: authored, learned now, and untrained weights at today's α, with fixed seeds. */
  measure() {
    const app = this.app;
    const baseline = new NeuralEngine();
    const control = new HybridCreativeEngine({ neural: baseline });
    const seeds = [11, 23, 37, 41];
    const rows = app.memory.lessons.slice(-6).reverse().map((l) => {
      const opts = (seed) => ({ seed: hashSeed(`evidence:${l.id}:${seed}`), style: app.memory.prefs, traits: app.pet.traits, colors: app.pet.appearance, lessonId: l.id });
      const alpha = app.creative.alphaFor(l.kind, l.id);
      const avg = (fn) => seeds.reduce((a, s) => a + lessonCloseness(l.kind, l.demo, fn(s)), 0) / seeds.length;
      return {
        id: l.id, kind: l.kind, title: l.title, alpha, social: l.source === 'social',
        authored: avg((s) => app.creative.compose(l.kind, l.demo, { ...opts(s), alpha: 0 })),
        learned: avg((s) => app.creative.compose(l.kind, l.demo, opts(s))),
        control: alpha > 0 ? avg((s) => control.compose(l.kind, l.demo, { ...opts(s), alpha })) : null,
      };
    });
    return { at: Date.now(), rows };
  }

  render() {
    if (!this.dialog.open) return;
    const e = this.engine;
    const st = e.stats();
    const app = this.app;
    this.el.sub.textContent = `${app.pet.name}'s on-device networks · ${int(e.totalSteps)} optimizer steps run here · ${e.sessions} practice session${e.sessions === 1 ? '' : 's'} committed`;
    this.el.msg.textContent = this.message;
    this.el.msg.hidden = !this.message;
    const val = e.computeValidationLoss();
    this.el.nets.innerHTML = MODEL_KINDS.map((kind) => {
      const n = st[kind];
      const learned = n.steps > 0;
      return `
        <article class="in-net" data-kind="${kind}">
          <header><h4>${n.name}</h4><span class="in-mode" data-mode="${learned ? 'learned' : 'authored'}">${learned ? NEURAL_GENERATOR : 'authored only'}</span></header>
          <dl>
            <div><dt>Layers</dt><dd>${n.dims[0]} → ${n.dims[1]} tanh → ${n.dims[2]}</dd></div>
            <div><dt>Parameters</dt><dd>${int(n.parameters)} float32</dd></div>
            <div><dt>‖θ‖</dt><dd>${fmt(n.norm)}</dd></div>
            <div><dt>‖θ − θ₀‖</dt><dd>${fmt(n.deltaNorm)}</dd></div>
            <div><dt>Steps in weights</dt><dd>${int(n.steps)}</dd></div>
            <div><dt>Step confidence</dt><dd>${Math.round(n.confidence * 100)}%</dd></div>
            <div><dt>Held-out loss</dt><dd>${fmt(val[kind])} <small>(${val.counts[kind] ?? 0} samples)</small></dd></div>
          </dl>
        </article>`;
    }).join('');
    this.el.total.textContent = `${int(st.parameters)} trainable float32 parameters in total (${(st.parameters * 4 / 1024).toFixed(1)} KiB per checkpoint) · ‖θ‖ ${fmt(st.norm)} · ‖θ − θ₀‖ ${fmt(st.deltaNorm)} · optimizer ${e.settings.optimizer === 'sgd' ? 'momentum SGD' : 'Adam'} · ${e.settings.batchSize} per batch`;
    const data = e.refreshData();
    const signals = app.memory.signals;
    const loves = signals.filter((s) => s.kind === 'love').length;
    const nudges = Object.fromEntries(NUDGE_IDS.map((id) => [id, app.memory.nudgeCounts[id] ?? 0]));
    const row = (label, music, drawing) => `<tr role="row"><th role="rowheader" scope="row">${label}</th>${cell('d-music', 'Music', music)}${cell('d-drawing', 'Drawing', drawing)}</tr>`;
    const wide = (label, value) => `<tr role="row"><th role="rowheader" scope="row">${label}</th>${cell('d-both', '', value, ' colspan="2"')}</tr>`;
    const ex = (kind) => data[kind].counts;
    const social = app.memory.lessons.filter((l) => l.source === 'social');
    this.el.data.innerHTML = `
      ${head(['<span class="sr-only">Signal</span>', 'Music', 'Drawing'])}
      <tbody role="rowgroup">
        ${row('Lessons (demonstrations)', data.music.lessons.length, data.drawing.lessons.length)}
        ${row('Training examples', `${data.music.train.length}`, `${data.drawing.train.length}`)}
        ${row('Held-out examples', data.music.val.length, data.drawing.val.length)}
        ${row('From demonstrations · style copies · preferences', `${ex('music').demo} · ${ex('music').style} · ${ex('music').pref}`, `${ex('drawing').demo} · ${ex('drawing').style} · ${ex('drawing').pref}`)}
        ${wide('Social inspiration (visitor lessons, half weight)', social.length ? social.map((l) => `${esc(l.title ?? 'Visitor idea')} (${l.kind}, ×${fmt(l.weight, 1)})`).join(' · ') : 'none yet: learn from a visiting friend')}
        ${wide('Love signals (preference, reward +1)', loves)}
        ${wide('Direction signals (nudges)', NUDGE_IDS.map((id) => `${NUDGES[id].label} ${nudges[id]}`).join(' · '))}
        ${wide('Style guidance (network style input)', `energy ${fmt(app.memory.prefs.energy, 2)} · order ${fmt(app.memory.prefs.order, 2)}`)}
        ${wide('Replay mix per batch', `newest ${Math.round(e.settings.replayRecent * 100)}% · older ${Math.round(e.settings.replayOlder * 100)}% · preference and style ${Math.round(e.settings.replayExtra * 100)}% · held out 1 in ${e.settings.holdout}`)}
      </tbody>`;
    const busy = this._busy();
    this.el.ckpts.innerHTML = `
      ${head(['Checkpoint', 'Steps', 'Saved', 'Val. loss', '<span class="sr-only">Action</span>'])}
      <tbody role="rowgroup">${e.listCheckpoints().map((c) => `
        <tr role="row" data-ckpt="${c.id}">
          ${cell('ck-name', '', `<strong>${esc(c.name)}</strong> <span class="in-ck" data-kind="${c.kind}">${c.kind}</span>`)}
          ${cell('ck-steps', 'Steps', `${int(c.steps.music)} / ${int(c.steps.drawing)}`)}
          ${cell('ck-saved', 'Saved', c.kind === 'untrained' ? 'built in' : when(c.createdAt))}
          ${cell('ck-val', 'Val. loss', fmt(c.valLoss))}
          ${cell('ck-act', '', `<button type="button" class="btn in-mini" data-in="rollback" data-id="${c.id}" ${busy ? 'disabled' : ''} aria-label="Rollback to ${esc(c.name)}">${useIcon('i-undo')}<span>Rollback</span></button>`)}
        </tr>`).join('')}</tbody>`;
    this.el.reset.querySelector('[data-label]').textContent = performance.now() < this.confirmReset ? 'Tap again to reset' : 'Reset Model to Untrained';
    this.el.reset.classList.toggle('confirm', performance.now() < this.confirmReset);
    this.el.reset.disabled = busy;
    this.el.run.disabled = busy;
    renderLossChart(this.el.chart, e.history.slice(-160));
    const ev = this.evidence;
    const A = sym('α');
    this.el.evidence.innerHTML = ev && ev.rows.length
      ? `${head(['Lesson', `Authored (${A} 0)`, `Untrained at same ${A}`, 'Learned now'])}
        <tbody role="rowgroup">${ev.rows.map((r) => `<tr role="row">${cell('ev-lesson', '', `${esc(r.title ?? (r.kind === 'music' ? 'Your tune' : 'Your drawing'))} <small>(${r.kind}${r.social ? ', from a visit' : ''}, ${A} ${Math.round(r.alpha * 100)}%)</small>`)}${cell('ev-num ev-authored', 'Authored (α 0)', `${Math.round(r.authored * 100)}%`)}${cell('ev-num ev-control', 'Untrained at same α', r.control == null ? '–' : `${Math.round(r.control * 100)}%`)}${cell('ev-num ev-learned', 'Learned now', `<strong>${Math.round(r.learned * 100)}%</strong>`)}</tr>`).join('')}</tbody>`
      : `<tbody role="rowgroup"><tr role="row">${cell('ev-empty', '', app.memory.lessons.length ? 'Press Measure now to compare.' : 'Teach a lesson first.')}</tr></tbody>`;
    const s = e.settings;
    const field = (k, label, attrs) => `<label class="in-field"><span>${label}</span><input type="number" data-setting="${k}" value="${s[k]}" ${attrs}></label>`;
    if (!this.el.settings.childElementCount || this.settingsKey !== JSON.stringify(s)) {
      this.settingsKey = JSON.stringify(s);
      this.el.settings.innerHTML = `
        ${field('learningRate', 'Learning rate', 'min="0.0001" max="0.1" step="0.001"')}
        ${field('batchSize', 'Batch size', 'min="4" max="128" step="1"')}
        ${field('sessionSteps', 'Steps per session', 'min="10" max="5000" step="10"')}
        ${field('stepsPerSecond', 'Practice pace (steps/s)', 'min="1" max="5000" step="1"')}
        ${field('replayOlder', 'Replay share, older lessons', 'min="0" max="1" step="0.05"')}
        ${field('anchor', 'Prior anchor (L2)', 'min="0" max="0.1" step="0.0001"')}
        <label class="in-field"><span>Optimizer</span><select data-setting="optimizer"><option value="adam"${s.optimizer === 'adam' ? ' selected' : ''}>Adam</option><option value="sgd"${s.optimizer === 'sgd' ? ' selected' : ''}>Momentum SGD</option></select></label>`;
    }
  }

  summary() {
    const e = this.engine;
    return {
      open: this.isOpen,
      architecture: e.architecture(),
      stats: e.stats(),
      checkpoints: e.listCheckpoints(),
      limits: MODEL_LIMITS,
      learnedVsAuthored: LEARNED_VS_AUTHORED.map(([part, how, kind]) => ({ part, how, kind })),
      evidence: this.evidence,
      message: this.message,
    };
  }
}

/** Creates the Inspector and plugs it into the feature registry: features.register('inspector', ...). */
export function installLearningInspector(app) {
  const view = new LearningInspector({ dialog: document.getElementById('inspector'), app });
  app.features.register('inspector', {
    label: 'Learning Inspector',
    short: 'Inspector',
    icon: 'inspector',
    shortcut: 'I',
    description: 'Developer diagnostics: network sizes, weights and how far they moved, training data, checkpoints with rollback, a fair before/after check, and what is learned versus authored.',
    open: () => view.open(),
  });
  return view;
}
