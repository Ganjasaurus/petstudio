/**
 * teaching-workshop.js: the Teaching Workshop sheet (teaching-example capture UI).
 *
 * Music tab: a touch/mouse keyboard (pentatonic by default, all 22 keys of
 * the studio keyboard when "All notes" is on), four rhythm pads, a live beat
 * timeline (8 or 16 beats; tap a note to remove it), starter tunes, Record
 * (count-in, metronome, overdub), Preview, Undo, Clear and tempo. Taps made
 * without Record are captured in free time, so anyone can just play.
 * Drawing tab: a pressure-aware stroke canvas (touch, pen, mouse) with
 * colours, brush sizes, Undo Stroke, Clear, Replay (with the original pen
 * timing) and shape templates that can be stamped or traced.
 * "Teach Pet" hands the demonstration to the creation flow; the sheet closes
 * so the pet can be watched listening, walking and performing its attempt.
 *
 * The sheet is positioned like the Customizer (bottom sheet on phones and
 * tablets, right drawer on desktop) so the pet stays visible in the studio.
 * Registered as the real 'teach' feature via features.register('teach', ...).
 */
import {
  PhraseRecorder, StrokeRecorder, keyboardNotes, noteName, noteColor, isBlackKey, isPentatonic, DRUMS, drumById,
  MUSIC_TEMPLATES, musicTemplate, DRAWING_TEMPLATES, drawingTemplate, templateStrokes, BRUSH_SIZES, DRAW_COLORS,
  PHRASE_LIMITS, sanitizePhrase, sanitizeDrawing, phraseIsEmpty, strokeLength, PAPER, KEY_RANGE,
} from './teaching-core.js';
import { paintDrawing, paintGuide, paintPhraseRoll, phraseRollLayout, fitCanvas, pressureWidth } from './creation-render.js';

const DRAFT_KEY = 'petstudio.workshop.v1';
const DRAFT_SCHEMA = 'petstudio.workshop';
const COLOR_NAMES = { '#4a3f6b': 'Plum ink', '#ff7fa3': 'Pink', '#ff8a4c': 'Orange', '#ffbf3f': 'Sunny yellow', '#6ccf7f': 'Leaf green', '#55b8ec': 'Sky blue', '#9a7bff': 'Lavender', '#a0785a': 'Cocoa' };
/** Musical typing on a computer keyboard (desktop): GarageBand-style layout from C4. */
const TYPING = { a: 60, w: 61, s: 62, e: 63, d: 64, f: 65, t: 66, g: 67, y: 68, h: 69, u: 70, j: 71, k: 72, o: 73, l: 74, p: 75, ';': 76, "'": 77 };
const TYPING_DRUMS = { z: 'kick', x: 'clap', c: 'hat', v: 'block' };
const useIcon = (id) => `<svg class="ico" aria-hidden="true"><use href="#${id}"></use></svg>`;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const nowS = () => performance.now() / 1000;

export class TeachingWorkshop {
  /**
   * @param {object} deps
   * @param {HTMLDialogElement} deps.dialog
   * @param {import('./audio.js').StudioAudio} deps.audio
   * @param {Storage} deps.storage
   * @param {() => string} deps.petName
   * @param {(kind: string, data: object, meta: object) => {ok: boolean, message?: string}} deps.onTeach
   * @param {(kind: string) => void} [deps.onNotice] the pet reacts while you play or draw
   * @param {() => void} [deps.onOpen]
   * @param {(reason: string) => void} [deps.onClose]
   */
  constructor({ dialog, audio, storage, petName = () => 'your pet', onTeach, onNotice, onOpen, onClose, reducedMotion = false }) {
    this.dialog = dialog;
    this.audio = audio;
    this.storage = storage;
    this.petName = petName;
    this.cb = { onTeach, onNotice, onOpen, onClose };
    this.reduced = reducedMotion;
    this.music = new PhraseRecorder();
    this.drawing = new StrokeRecorder();
    this.tab = 'music';
    this.chromatic = false;
    this.brush = { id: 'medium', color: DRAW_COLORS[1], width: BRUSH_SIZES[1].width };
    this.mode = 'stamp';
    this.traceId = null;
    this.templateId = { music: null, drawing: null };
    this.stamps = []; // { id, before }: stamps still present in the drawing (for the lesson's template name)
    this.transport = null;
    this.replay = null;
    this.flashes = new Map();
    this.held = new Map();
    this.raf = 0;
    this.split = null;
    this._loadDraft();
    this._build();
    this.dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      this.close('escape');
    });
    globalThis.addEventListener?.('pagehide', () => {
      if (this.isOpen) this._saveDraft(); // a reload mid-lesson keeps the draft
    });
  }

  get isOpen() {
    return this.dialog.open;
  }

  /**
   * The sheet's resting rect for camera framing. Uses the layout box
   * (offset*), which ignores the slide-in transform: measuring mid-animation
   * with getBoundingClientRect would frame the pet behind the sheet.
   */
  panelRect() {
    const d = this.dialog;
    if (!d.open) return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    const { offsetLeft: left, offsetTop: top, offsetWidth: width, offsetHeight: height } = d;
    return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height };
  }

  // ----- DOM -------------------------------------------------------------------
  _build() {
    // Phones show short chip names (e.g. "Sun") so all five shapes fit on one row without clipping.
    const SHORT = { sun: 'Sun', 'sunny-arp': 'Sunny', 'bouncy-walk': 'Bouncy', 'starlight-lullaby': 'Lullaby', 'playful-hop': 'Playful' };
    const chips = (list, attr) => list.map((t) => `<button type="button" class="chip ws-chip" data-${attr}="${t.id}" aria-label="${t.name}">${SHORT[t.id] ? `<span class="chip-long">${t.name}</span><span class="chip-short">${SHORT[t.id]}</span>` : t.name}</button>`).join('');
    this.dialog.innerHTML = `
      <div class="ws-head">
        <h2 id="ws-title" tabindex="-1">Teach <span data-ws-name></span></h2>
        <div class="ws-tabs" role="tablist" aria-label="Lesson type">
          <button type="button" role="tab" id="ws-tab-music" aria-controls="ws-panel-music" data-tab="music">${useIcon('i-keys')}<span>Music</span></button>
          <button type="button" role="tab" id="ws-tab-drawing" aria-controls="ws-panel-drawing" data-tab="drawing">${useIcon('i-draw')}<span>Drawing</span></button>
        </div>
        <button class="icon-btn" type="button" data-ws="close" aria-label="Close Teaching Workshop" title="Close">${useIcon('i-close')}</button>
      </div>
      <div class="ws-body">
        <section id="ws-panel-music" class="ws-panel" role="tabpanel" aria-labelledby="ws-tab-music" data-panel="music">
          <div class="ws-templates" role="group" aria-label="Starter tunes"><span class="ws-label">Starter tunes</span><div class="ws-chips">${chips(MUSIC_TEMPLATES, 'template')}</div></div>
          <div class="ws-timeline-wrap">
            <canvas class="ws-timeline" role="img" aria-label="Beat timeline. Tap a note on it to remove that note."></canvas>
            <span class="ws-count" aria-hidden="true"></span>
          </div>
          <div class="ws-keys" role="group" aria-label="Keyboard: tap keys to play notes"></div>
          <div class="ws-pads" role="group" aria-label="Rhythm pads">
            ${DRUMS.map((d) => `<button type="button" class="ws-pad" data-drum="${d.id}" style="--pad:${d.color}" aria-label="${d.label} drum pad"><span>${d.label}</span></button>`).join('')}
          </div>
          <div class="ws-transport">
            <button type="button" class="btn ws-rec" data-ws="record" aria-pressed="false" aria-label="Record: count in, then play along with the beat">${useIcon('i-record')}<span data-label>Record</span></button>
            <button type="button" class="btn" data-ws="preview" aria-pressed="false" aria-label="Preview phrase">${useIcon('i-play')}<span data-label>Preview</span></button>
            <button type="button" class="btn" data-ws="undo-music" aria-label="Undo last change">${useIcon('i-undo')}<span>Undo</span></button>
            <button type="button" class="btn" data-ws="clear-music" aria-label="Clear the phrase">${useIcon('i-trash')}<span>Clear</span></button>
          </div>
          <div class="ws-settings">
            <label class="ws-tempo"><span>Tempo</span><input type="range" min="${PHRASE_LIMITS.tempo[0]}" max="${PHRASE_LIMITS.tempo[1]}" step="2" data-ws="tempo" aria-label="Tempo in beats per minute"><output data-ws-out="tempo"></output></label>
            <div class="ws-seg" role="radiogroup" aria-label="Phrase length">
              <button type="button" role="radio" data-beats="8">8 beats</button><button type="button" role="radio" data-beats="16">16 beats</button>
            </div>
            <button type="button" class="chip ws-toggle" data-ws="chromatic" aria-pressed="false" title="Show every key, including the black keys">All notes</button>
          </div>
        </section>
        <section id="ws-panel-drawing" class="ws-panel" role="tabpanel" aria-labelledby="ws-tab-drawing" data-panel="drawing" hidden>
          <div class="ws-templates" role="group" aria-label="Shapes">
            <span class="ws-label">Shapes</span><div class="ws-chips">${chips(DRAWING_TEMPLATES, 'shape')}</div>
            <div class="ws-seg ws-mode" role="radiogroup" aria-label="Shape mode">
              <button type="button" role="radio" data-mode="stamp" title="Stamp the shape onto your drawing">Stamp</button><button type="button" role="radio" data-mode="trace" title="Show a dotted guide to trace over">Trace</button>
            </div>
          </div>
          <div class="ws-draw">
            <div class="ws-canvas-wrap"><canvas class="ws-canvas" aria-label="Drawing canvas: draw with your finger, a pen or the mouse"></canvas></div>
            <div class="ws-tools">
              <div class="swatches ws-swatches" role="radiogroup" aria-label="Colour">
                ${DRAW_COLORS.map((c) => `<button type="button" class="swatch" role="radio" data-color="${c}" style="--sw:${c}" aria-label="${COLOR_NAMES[c] ?? c}"></button>`).join('')}
              </div>
              <div class="ws-seg ws-brushes" role="radiogroup" aria-label="Brush size">
                ${BRUSH_SIZES.map((b, i) => `<button type="button" role="radio" data-brush="${b.id}" aria-label="${b.label} brush" title="${b.label} brush"><i style="--d:${6 + i * 5}px"></i></button>`).join('')}
              </div>
              <div class="ws-draw-actions">
                <button type="button" class="btn" data-ws="undo-draw" aria-label="Undo stroke">${useIcon('i-undo')}<span class="lbl-long">Undo Stroke</span><span class="lbl-short">Undo</span></button>
                <button type="button" class="btn" data-ws="clear-draw" aria-label="Clear the drawing">${useIcon('i-eraser')}<span>Clear</span></button>
                <button type="button" class="btn" data-ws="replay" aria-pressed="false" aria-label="Replay strokes">${useIcon('i-replay')}<span class="lbl-long">Replay Strokes</span><span class="lbl-short">Replay</span></button>
              </div>
            </div>
          </div>
        </section>
        <p class="ws-note">Each lesson goes into your pet's teaching memory, and its first attempts riff on it with hand-written rules. In Sleep Practice its two small neural networks train on your lessons, so later attempts can move closer to what you taught.</p>
      </div>
      <div class="ws-foot">
        <p class="ws-note-compact">Kept in teaching memory · Sleep Practice trains on it</p>
        <p class="ws-hint" aria-live="polite"></p>
        <button type="button" class="btn primary ws-teach" data-ws="teach">${useIcon('i-teach')}<span>Teach Pet</span></button>
      </div>`;
    const q = (s) => this.dialog.querySelector(s);
    this.el = {
      name: q('[data-ws-name]'), title: q('#ws-title'), body: q('.ws-body'), hint: q('.ws-hint'), teach: q('[data-ws="teach"]'),
      timeline: q('.ws-timeline'), count: q('.ws-count'), keys: q('.ws-keys'), record: q('[data-ws="record"]'),
      preview: q('[data-ws="preview"]'), tempo: q('[data-ws="tempo"]'), tempoOut: q('[data-ws-out="tempo"]'),
      chromatic: q('[data-ws="chromatic"]'), canvas: q('.ws-canvas'), canvasWrap: q('.ws-canvas-wrap'), replay: q('[data-ws="replay"]'),
      undoMusic: q('[data-ws="undo-music"]'), clearMusic: q('[data-ws="clear-music"]'), undoDraw: q('[data-ws="undo-draw"]'), clearDraw: q('[data-ws="clear-draw"]'),
    };
    this._wire();
    if ('ResizeObserver' in globalThis) {
      this.ro = new ResizeObserver(() => this._resize());
      this.ro.observe(this.el.keys);
      this.ro.observe(this.el.timeline);
      this.ro.observe(this.el.canvasWrap);
    }
    this._renderKeys();
    this.setTab(this.tab);
  }

  _wire() {
    const d = this.dialog;
    d.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      this.audio.unlock();
      if (b.dataset.tab) this.setTab(b.dataset.tab);
      else if (b.dataset.template) this.loadTemplate(b.dataset.template);
      else if (b.dataset.shape) this.useShape(b.dataset.shape);
      else if (b.dataset.mode) this.setMode(b.dataset.mode);
      else if (b.dataset.color) this.setBrush({ color: b.dataset.color });
      else if (b.dataset.brush) this.setBrush({ id: b.dataset.brush });
      else if (b.dataset.beats) this.setBeats(Number(b.dataset.beats));
      else if (b.dataset.ws) this._command(b.dataset.ws);
    });
    d.querySelector('.ws-tabs').addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const next = this.tab === 'music' ? 'drawing' : 'music';
      this.setTab(next);
      d.querySelector(`[data-tab="${next}"]`).focus();
    });
    this.el.tempo.addEventListener('input', () => {
      this.music.setTempo(Number(this.el.tempo.value));
      this._sync();
    });
    this._wireKeys();
    this._wirePads();
    this._wireTimeline();
    this._wireCanvas();
    d.addEventListener('keydown', (e) => this._onKey(e, true));
    d.addEventListener('keyup', (e) => this._onKey(e, false));
    this.el.body.addEventListener('scroll', () => this._fade(), { passive: true });
  }

  /** Fades the bottom edge of the body while more content waits below, so nothing looks sliced. */
  _fade() {
    const b = this.el.body;
    b.classList.toggle('more-below', b.scrollHeight - b.scrollTop - b.clientHeight > 4);
  }

  _command(cmd) {
    switch (cmd) {
      case 'close': this.close('close'); break;
      case 'teach': this.teach(); break;
      case 'record': this.toggleRecord(); break;
      case 'preview': this.togglePreview(); break;
      case 'undo-music': this.stopTransport(); this.music.undo(); this._afterMusicEdit(); break;
      case 'clear-music':
        this.stopTransport();
        if (this.music.clear()) this.templateId.music = null;
        this._afterMusicEdit();
        break;
      case 'chromatic': this.setChromatic(!this.chromatic); break;
      case 'undo-draw': this.replay = null; this.drawing.undo(); this._syncStamps(); this._afterDrawEdit(); break;
      case 'clear-draw':
        this.replay = null;
        this.drawing.clear();
        this._syncStamps();
        this._afterDrawEdit();
        break;
      case 'replay': this.toggleReplay(); break;
      default: break;
    }
  }

  // ----- open / close ------------------------------------------------------------
  open({ tab } = {}) {
    if (tab === 'music' || tab === 'drawing') this.setTab(tab);
    this.el.name.textContent = this.petName();
    if (!this.dialog.open) this.dialog.showModal();
    this.el.body.scrollTop = 0;
    this.el.title.focus({ preventScroll: true });
    this.cb.onOpen?.();
    this._resize();
    this._sync();
    this._loop();
  }

  close(reason = 'close') {
    if (!this.dialog.open) return;
    this.stopTransport();
    this.replay = null;
    this.drawing.cancel();
    for (const [, h] of this.held) if (h.handle) this.music.noteOff(h.handle, nowS());
    this.held.clear();
    this._saveDraft();
    this.dialog.close();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.cb.onClose?.(reason);
  }

  setTab(tab) {
    if (tab !== 'music' && tab !== 'drawing') return;
    if (tab !== this.tab) {
      this.stopTransport();
      this.replay = null;
    }
    this.tab = tab;
    for (const b of this.dialog.querySelectorAll('[role="tab"]')) {
      const on = b.dataset.tab === tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    for (const p of this.dialog.querySelectorAll('[role="tabpanel"]')) p.hidden = p.dataset.panel !== tab;
    this.dialog.dataset.tab = tab;
    this._resize();
    this._sync();
  }

  // ----- music -------------------------------------------------------------------
  setChromatic(on) {
    this.chromatic = !!on;
    this._renderKeys();
    this._sync();
  }

  setBeats(beats) {
    this.stopTransport();
    this.music.setBeats(beats);
    this._afterMusicEdit();
  }

  loadTemplate(id) {
    const t = musicTemplate(id);
    if (!t) return false;
    this.stopTransport();
    this.music.load(t);
    this.templateId.music = id;
    this._afterMusicEdit();
    this.setHint(`${t.name} is ready. Preview it, play along, or teach it as is.`);
    this.togglePreview(true);
    return true;
  }

  /** Loads any phrase (automation and restore). */
  setPhrase(phrase) {
    this.stopTransport();
    this.music.load(phrase);
    this.templateId.music = null;
    this._afterMusicEdit();
  }

  _renderKeys() {
    const wrap = this.el.keys;
    const width = wrap.clientWidth || 360;
    const split = this.chromatic && width < 560;
    this.split = split;
    wrap.classList.toggle('chromatic', this.chromatic);
    wrap.classList.toggle('split', split);
    const button = (midi, { cls = '', style = '' } = {}) => {
      const name = noteName(midi);
      return `<button type="button" class="ws-key${isBlackKey(midi) ? ' black' : ''}${cls}" data-midi="${midi}" style="--tint:${noteColor(midi)};${style}" aria-label="${name}"><span>${name.replace(/\d+$/, '')}</span></button>`;
    };
    if (!this.chromatic) {
      // Pentatonic bars: C D E G A over the studio keyboard's range, coloured by note.
      wrap.innerHTML = `<div class="ws-octave penta">${keyboardNotes().map((m, i) => button(m, { cls: ' bar', style: `--i:${i}` })).join('')}</div>`;
    } else {
      // Piano layout; narrow sheets split it into two stacked octaves so keys stay big enough to tap.
      const blocks = split ? [[60, 71], [72, 81]] : [[60, 81]];
      wrap.innerHTML = blocks.map(([lo, hi]) => {
        const naturals = [];
        for (let m = lo; m <= hi; m++) if (!isBlackKey(m)) naturals.push(m);
        const cells = [];
        naturals.forEach((m, k) => {
          cells.push(button(m, { style: `grid-column:${2 * k + 1} / span 2;grid-row:1 / 3` }));
          if (m + 1 <= hi && isBlackKey(m + 1)) cells.push(button(m + 1, { style: `grid-column:${2 * k + 2} / span 2;grid-row:1` }));
        });
        return `<div class="ws-octave piano" style="grid-template-columns:repeat(${naturals.length * 2}, minmax(0, 1fr))">${cells.join('')}</div>`;
      }).join('');
    }
  }

  _wireKeys() {
    const wrap = this.el.keys;
    const keyAt = (x, y) => document.elementFromPoint(x, y)?.closest?.('.ws-key') ?? null;
    const press = (key, e) => {
      const midi = Number(key.dataset.midi);
      const r = key.getBoundingClientRect();
      const vel = clamp(0.45 + 0.5 * ((e.clientY - r.top) / Math.max(1, r.height)), 0.35, 0.95);
      return { key, midi, ...this.playNote(midi, { vel, t: e.timeStamp / 1000 }) };
    };
    wrap.addEventListener('pointerdown', (e) => {
      const key = e.target.closest('.ws-key');
      if (!key) return;
      e.preventDefault();
      this.audio.unlock();
      wrap.setPointerCapture?.(e.pointerId);
      this.held.set(e.pointerId, press(key, e));
    });
    wrap.addEventListener('pointermove', (e) => {
      const h = this.held.get(e.pointerId);
      if (!h) return;
      const key = keyAt(e.clientX, e.clientY);
      if (!key || key === h.key || !wrap.contains(key)) return;
      this.releaseNote(h, e.timeStamp / 1000); // glissando: slide onto the next key
      this.held.set(e.pointerId, press(key, e));
    });
    const up = (e) => {
      const h = this.held.get(e.pointerId);
      if (!h) return;
      this.held.delete(e.pointerId);
      this.releaseNote(h, e.timeStamp / 1000);
    };
    wrap.addEventListener('pointerup', up);
    wrap.addEventListener('pointercancel', up);
    wrap.addEventListener('lostpointercapture', up);
    // Keyboard activation (Tab to a key, then Enter or Space) arrives as a click with detail 0.
    wrap.addEventListener('click', (e) => {
      const key = e.target.closest('.ws-key');
      if (!key || e.detail !== 0) return;
      this.audio.unlock();
      const t = e.timeStamp / 1000;
      this.releaseNote(this.playNote(Number(key.dataset.midi), { vel: 0.72, t }), t + 0.2);
    });
  }

  _wirePads() {
    const pads = this.dialog.querySelector('.ws-pads');
    pads.addEventListener('pointerdown', (e) => {
      const pad = e.target.closest('.ws-pad');
      if (!pad) return;
      e.preventDefault();
      this.audio.unlock();
      this.hitDrum(pad.dataset.drum, { t: e.timeStamp / 1000 });
    });
    pads.addEventListener('click', (e) => {
      const pad = e.target.closest('.ws-pad');
      if (!pad || e.detail !== 0) return; // keyboard activation only; pointers are handled above
      this.audio.unlock();
      this.hitDrum(pad.dataset.drum, { t: e.timeStamp / 1000 });
    });
  }

  /** Plays and (when there is room) captures a note. Returns { handle, captured }. */
  playNote(midi, { vel = 0.7, t = nowS() } = {}) {
    if (!Number.isInteger(midi) || midi < KEY_RANGE.lo || midi > KEY_RANGE.hi) return { handle: null, captured: false };
    this.audio.pluck(midi, { duration: 0.5, velocity: vel });
    this._flashKey(midi, 0.18);
    const res = this.music.noteOn(midi, t, vel);
    if (res.captured) {
      this.cb.onNotice?.('music');
      this.transport?.skip?.add(`${res.beat}|${midi}`); // already heard: do not replay it this pass
    } else if (res.reason === 'full') {
      this.setHint('Your phrase is full. Clear it, or press Record to play over it.');
    }
    this._afterMusicEdit(false);
    return { handle: res.handle ?? null, captured: !!res.captured };
  }

  releaseNote(h, t = nowS()) {
    if (h?.handle) this.music.noteOff(h.handle, t);
    this._drawTimeline();
  }

  hitDrum(id, { vel = 0.82, t = nowS() } = {}) {
    const drum = drumById(id);
    if (!drum) return false;
    this.audio.drum(drum.id, { velocity: vel });
    const pad = this.dialog.querySelector(`[data-drum="${id}"]`);
    pad?.classList.remove('hit');
    void pad?.offsetWidth;
    pad?.classList.add('hit');
    const res = this.music.hit(drum.midi, t, vel);
    if (res.captured) {
      this.cb.onNotice?.('music');
      this.transport?.skip?.add(`${res.beat}|${drum.midi}`);
    } else if (res.reason === 'full') {
      this.setHint('Your phrase is full. Clear it, or press Record to play over it.');
    }
    this._afterMusicEdit(false);
    return res.captured;
  }

  _flashKey(midi, seconds) {
    const key = this.el.keys.querySelector(`[data-midi="${midi}"]`);
    if (!key) return;
    key.classList.add('on');
    this.flashes.set(key, nowS() + seconds);
  }

  _onKey(e, down) {
    if (this.tab !== 'music' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target instanceof HTMLInputElement) return;
    const k = e.key.toLowerCase();
    const id = `kbd:${k}`;
    if (TYPING[k] != null) {
      const midi = TYPING[k];
      if (!this.chromatic && !isPentatonic(midi)) return;
      e.preventDefault();
      if (down && !e.repeat) {
        this.audio.unlock();
        this.held.set(id, { midi, ...this.playNote(midi, { vel: 0.72, t: e.timeStamp / 1000 }) });
      } else if (!down && this.held.has(id)) {
        this.releaseNote(this.held.get(id), e.timeStamp / 1000);
        this.held.delete(id);
      }
    } else if (TYPING_DRUMS[k] && down && !e.repeat) {
      e.preventDefault();
      this.audio.unlock();
      this.hitDrum(TYPING_DRUMS[k], { t: e.timeStamp / 1000 });
    }
  }

  _wireTimeline() {
    this.el.timeline.addEventListener('pointerdown', (e) => {
      if (this.transport) return;
      const r = this.el.timeline.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const phrase = this.music.phrase;
      const L = phraseRollLayout(phrase, { w: r.width, h: r.height, labels: true });
      let best = null;
      let bestD = 14;
      for (const n of phrase.notes) {
        const q = L.noteRect(n);
        const dx = x < q.x ? q.x - x : x > q.x + q.w ? x - q.x - q.w : 0;
        const dy = y < q.y ? q.y - y : y > q.y + q.h ? y - q.y - q.h : 0;
        const dd = Math.hypot(dx, dy);
        if (dd < bestD) {
          bestD = dd;
          best = { ev: n, drum: false };
        }
      }
      for (const hh of phrase.hits) {
        const c = L.hitCenter(hh);
        const dd = Math.hypot(x - c.x, y - c.y) - 3;
        if (dd < bestD) {
          bestD = dd;
          best = { ev: hh, drum: true };
        }
      }
      if (best && this.music.remove(best.ev.beat, best.ev.midi, best.drum)) {
        this.audio.sfx('tap');
        this._afterMusicEdit();
        this.setHint('Removed that one. Undo brings it back.');
      }
    });
  }

  // ----- transport: preview and record --------------------------------------------
  togglePreview(force = null) {
    const playing = this.transport?.mode === 'preview';
    if (force === false || (force == null && playing)) {
      if (playing) this.stopTransport();
      return false;
    }
    if (this.music.isEmpty) {
      this.setHint('Nothing to preview yet. Tap some keys or pick a starter tune.');
      return false;
    }
    this.stopTransport();
    this.audio.unlock();
    this.transport = { mode: 'preview', t0: nowS() + 0.08, scheduled: -1, clicks: false, skip: new Set() };
    this.cb.onNotice?.('music');
    this._sync();
    return true;
  }

  toggleRecord() {
    if (this.transport && this.transport.mode !== 'preview') {
      this.stopTransport();
      this.setHint('Recording stopped.');
      return false;
    }
    this.stopTransport();
    this.audio.unlock();
    const spb = 60 / this.music.tempo;
    const t0 = nowS() + 4 * spb + 0.1; // one bar of count-in
    this.transport = { mode: 'record', t0, scheduled: -5, clicks: true, skip: new Set() };
    this.music.startPass(t0);
    this.setHint('Get ready… play along when the count reaches the start.');
    this._sync();
    return true;
  }

  stopTransport() {
    if (!this.transport) return;
    if (this.transport.mode === 'record') this.music.stopPass();
    this.transport = null;
    this.el.count.textContent = '';
    this.el.count.classList.remove('show');
    this._sync();
  }

  _tickTransport() {
    const tr = this.transport;
    if (!tr) return;
    const now = nowS();
    const phrase = this.music.phrase;
    const bps = phrase.tempo / 60;
    const beat = (now - tr.t0) * bps;
    const ahead = (now + 0.12 - tr.t0) * bps;
    // Schedule events (and metronome clicks) that fall inside the look-ahead window.
    const lo = tr.scheduled;
    if (tr.clicks) {
      // Count-in clicks at beats -4..-1, then one per beat (accent on each bar).
      for (let b = Math.floor(lo) + 1; b <= ahead && b < phrase.beats; b++) this.audio.click(b % 4 === 0, { when: tr.t0 + b / bps - now });
    }
    const due = (e) => e.beat > lo && e.beat <= ahead && e.beat >= 0 && !tr.skip.has(`${e.beat}|${e.midi}`);
    for (const n of phrase.notes) {
      if (!due(n)) continue;
      const when = tr.t0 + n.beat / bps - now;
      this.audio.pluck(n.midi, { when, duration: n.dur / bps, velocity: n.vel * 0.9 });
      setTimeout(() => this._flashKey(n.midi, Math.min(0.4, n.dur / bps)), Math.max(0, when * 1000));
    }
    for (const hh of phrase.hits) {
      if (!due(hh)) continue;
      const drum = DRUMS.find((dd) => dd.midi === hh.midi);
      this.audio.drum(drum.id, { when: tr.t0 + hh.beat / bps - now, velocity: hh.vel });
    }
    tr.scheduled = ahead;
    // Count-in display.
    if (beat < 0) {
      const n = Math.ceil(-beat);
      this.el.count.textContent = String(Math.min(4, n));
      this.el.count.classList.add('show');
    } else if (this.el.count.textContent) {
      this.el.count.textContent = '';
      this.el.count.classList.remove('show');
      if (tr.mode === 'record') this.setHint('Recording… play along with the beat.');
    }
    tr.beat = beat;
    if (beat >= phrase.beats + (tr.mode === 'preview' ? 0.6 : 0)) {
      const recorded = tr.mode === 'record';
      this.stopTransport();
      if (recorded) this.setHint(this._musicSummary('Recorded!'));
    }
  }

  // ----- drawing -----------------------------------------------------------------
  setBrush({ id, color } = {}) {
    if (color && DRAW_COLORS.includes(color)) this.brush.color = color;
    const size = BRUSH_SIZES.find((b) => b.id === id);
    if (size) {
      this.brush.id = size.id;
      this.brush.width = size.width;
    }
    this._sync();
  }

  setMode(mode) {
    this.mode = mode === 'trace' ? 'trace' : 'stamp';
    if (this.mode === 'stamp') this.traceId = null;
    this._renderCanvas();
    this._sync();
  }

  /** Stamps a shape in the current colour and brush, or shows it as a trace guide. */
  useShape(id) {
    if (!DRAWING_TEMPLATES.some((t) => t.id === id)) return false;
    this.replay = null;
    if (this.mode === 'trace') {
      this.traceId = this.traceId === id ? null : id;
      this._renderCanvas();
      this._sync();
      if (this.traceId) this.setHint('Trace over the dotted guide with your own strokes.');
      return true;
    }
    const before = this.drawing.strokes.reduce((a, s) => a + strokeLength(s), 0);
    const added = this.drawing.addStrokes(templateStrokes(id, { color: this.brush.color, width: this.brush.width }));
    if (!added) {
      this.setHint('The drawing is full. Clear it or undo a stroke first.');
      return false;
    }
    this.stamps.push({ id, before: this.drawing.strokes.length - added });
    this.templateId.drawing = id;
    const total = this.drawing.strokes.reduce((a, s) => a + strokeLength(s), 0);
    this.replay = { start: nowS(), from: before / Math.max(1e-6, total), duration: this.reduced ? 0.01 : 0.9, timed: false };
    this.cb.onNotice?.('drawing');
    this._afterDrawEdit(false);
    const name = DRAWING_TEMPLATES.find((t) => t.id === id).name;
    this.setHint(`${name} stamped. Add your own strokes or change colours to make it yours.`);
    return true;
  }

  /** Replaces the drawing (automation and restore). */
  setDrawing(drawing) {
    this.replay = null;
    this.drawing.load(drawing);
    this.stamps = [];
    this.templateId.drawing = null;
    this._afterDrawEdit();
  }

  /** Keeps the drawing's template name in step with the stamps still in it. */
  _syncStamps() {
    this.stamps = this.stamps.filter((s) => s.before < this.drawing.strokes.length);
    this.templateId.drawing = this.stamps.length ? this.stamps[this.stamps.length - 1].id : this.drawing.strokes.length ? this.templateId.drawing : null;
  }

  toggleReplay() {
    if (this.replay) {
      this.replay = null;
      this._renderCanvas();
      this._sync();
      return false;
    }
    const strokes = this.drawing.strokes;
    if (!strokes.length) {
      this.setHint('Nothing to replay yet.');
      return false;
    }
    // Replays with the original pen timing (pauses kept), squeezed into at most 8 s.
    const last = strokes[strokes.length - 1];
    const real = (last.t0 ?? 0) + (last.dur ?? 0);
    const duration = this.reduced ? 0.01 : clamp(real, 1.2, 8);
    this.replay = { start: nowS(), from: 0, duration, timed: real > 0, scale: real > 0 ? real / duration : 1 };
    this._sync();
    return true;
  }

  _replayProgress() {
    const r = this.replay;
    const u = clamp((nowS() - r.start) / r.duration, 0, 1);
    if (!r.timed) return r.from + (1 - r.from) * u;
    // Time-faithful: map elapsed pen time to drawn length.
    const t = u * r.duration * r.scale;
    let drawn = 0;
    let total = 0;
    for (const s of this.drawing.strokes) {
      const len = strokeLength(s);
      total += len;
      const t0 = s.t0 ?? 0;
      const dur = Math.max(0.05, s.dur ?? 0.3);
      drawn += len * clamp((t - t0) / dur, 0, 1);
    }
    return total > 0 ? drawn / total : 1;
  }

  _wireCanvas() {
    const cv = this.el.canvas;
    let active = null;
    const sample = (e) => ({
      x: e.clientX, y: e.clientY, t: e.timeStamp / 1000,
      pressure: e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5,
    });
    cv.addEventListener('pointerdown', (e) => {
      if (active != null || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();
      this.audio.unlock();
      this.replay = null;
      const rect = cv.getBoundingClientRect();
      if (!this.drawing.begin(sample(e), rect, this.brush)) {
        this.setHint('The drawing is full. Clear it or undo a stroke first.');
        return;
      }
      active = e.pointerId;
      cv.setPointerCapture?.(e.pointerId);
      this.live = { rect, last: this.drawing.activeSamples[0] };
      this._paintLiveDot(this.live.last);
    });
    cv.addEventListener('pointermove', (e) => {
      if (e.pointerId !== active || !this.live) return;
      const events = e.getCoalescedEvents?.() ?? [e];
      for (const ev of events.length ? events : [e]) {
        if (!this.drawing.move(sample(ev), this.live.rect)) continue;
        const samples = this.drawing.activeSamples;
        const next = samples[samples.length - 1];
        this._paintLiveSegment(this.live.last, next);
        this.live.last = next;
      }
    });
    const end = (e) => {
      if (e.pointerId !== active) return;
      active = null;
      const stroke = this.drawing.end(e.type === 'pointerup' ? sample(e) : null, this.live?.rect ?? cv.getBoundingClientRect());
      this.live = null;
      if (stroke) this.cb.onNotice?.('drawing');
      this._afterDrawEdit();
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
  }

  _canvasCtx() {
    const cv = this.el.canvas;
    const size = cv.clientWidth || 300;
    const ctx = cv.getContext('2d');
    const dpr = cv.width / Math.max(1, size);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, size };
  }

  _paintLiveDot(s) {
    const { ctx, size } = this._canvasCtx();
    ctx.fillStyle = this.brush.color;
    ctx.beginPath();
    ctx.arc(s.x * size, s.y * size, Math.max(1, (this.brush.width * size * (0.55 + 0.9 * s.pressure)) / 2), 0, Math.PI * 2);
    ctx.fill();
  }

  _paintLiveSegment(a, b) {
    const { ctx, size } = this._canvasCtx();
    ctx.strokeStyle = this.brush.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, this.brush.width * size * pressureWidth([a.x, a.y, a.pressure], [b.x, b.y, b.pressure], 0.5));
    ctx.beginPath();
    ctx.moveTo(a.x * size, a.y * size);
    ctx.lineTo(b.x * size, b.y * size);
    ctx.stroke();
  }

  _renderCanvas(progress = 1) {
    const { ctx, size } = this._canvasCtx();
    paintDrawing(ctx, { paper: PAPER, strokes: [] }, size);
    if (this.traceId && this.mode === 'trace') paintGuide(ctx, drawingTemplate(this.traceId), size);
    paintDrawing(ctx, this.drawing.drawing, size, { progress, paper: false });
  }

  // ----- teach -------------------------------------------------------------------
  /** Hands the current demonstration to the creation flow. */
  teach(kind = this.tab) {
    const data = kind === 'music' ? this.music.snapshot() : this.drawing.drawing;
    const empty = kind === 'music' ? phraseIsEmpty(data) : !data.strokes.length;
    if (empty) {
      this.setHint(kind === 'music' ? 'Play a few notes first, or pick a starter tune.' : 'Draw something first, or stamp a shape.');
      this.el.teach.classList.remove('nudge');
      void this.el.teach.offsetWidth;
      this.el.teach.classList.add('nudge');
      return { ok: false, reason: 'empty' };
    }
    this.stopTransport();
    this.replay = null;
    const res = this.cb.onTeach?.(kind, data, { templateId: this.templateId[kind] }) ?? { ok: false, reason: 'no-handler' };
    if (res.ok) {
      this._saveDraft();
      this.close('teach');
    } else if (res.message) {
      this.setHint(res.message);
    }
    return res;
  }

  // ----- state sync and rendering --------------------------------------------------
  setHint(text) {
    this.hintUntil = nowS() + 4;
    this.el.hint.textContent = text;
  }

  _musicSummary(prefix = '') {
    const p = this.music.phrase;
    const n = p.notes.length;
    const h = p.hits.length;
    const parts = [];
    if (n) parts.push(`${n} note${n === 1 ? '' : 's'}`);
    if (h) parts.push(`${h} beat${h === 1 ? '' : 's'} on the pads`);
    return `${prefix ? `${prefix} ` : ''}${parts.join(' and ')}. Press Teach Pet when you are ready.`;
  }

  _defaultHint() {
    if (this.tab === 'music') {
      if (this.transport?.mode === 'record') return 'Recording… play along with the beat.';
      if (this.music.isEmpty) return 'Tap the keys or pads to add notes, or pick a starter tune.';
      return this._musicSummary();
    }
    const n = this.drawing.strokes.length;
    if (!n) return 'Draw with your finger, a pen or the mouse, or tap a shape.';
    return `${n} stroke${n === 1 ? '' : 's'}. Press Teach Pet when you are ready.`;
  }

  _afterMusicEdit(resetHint = true) {
    if (resetHint) this.hintUntil = 0;
    this._drawTimeline();
    this._sync();
  }

  _afterDrawEdit(resetHint = true) {
    if (resetHint) this.hintUntil = 0;
    if (!this.replay) this._renderCanvas();
    this._sync();
  }

  _sync() {
    const d = this.dialog;
    const music = this.music;
    const tr = this.transport;
    this.el.tempo.value = String(music.tempo);
    this.el.tempoOut.textContent = `${music.tempo} BPM`;
    for (const b of d.querySelectorAll('[data-beats]')) b.setAttribute('aria-checked', String(Number(b.dataset.beats) === music.beats));
    for (const b of d.querySelectorAll('[data-template]')) b.setAttribute('aria-pressed', String(this.templateId.music === b.dataset.template));
    this.el.chromatic.setAttribute('aria-pressed', String(this.chromatic));
    const recording = !!tr && tr.mode === 'record';
    this.el.record.setAttribute('aria-pressed', String(recording));
    this.el.record.classList.toggle('live', recording);
    this.el.record.querySelector('[data-label]').textContent = recording ? 'Stop' : 'Record';
    this.el.record.querySelector('use').setAttribute('href', recording ? '#i-stop' : '#i-record');
    const previewing = !!tr && tr.mode === 'preview';
    this.el.preview.setAttribute('aria-pressed', String(previewing));
    this.el.preview.querySelector('[data-label]').textContent = previewing ? 'Stop' : 'Preview';
    this.el.preview.querySelector('use').setAttribute('href', previewing ? '#i-stop' : '#i-play');
    this.el.undoMusic.disabled = !music.canUndo || recording;
    this.el.clearMusic.disabled = music.isEmpty || recording;
    for (const b of d.querySelectorAll('[data-color]')) b.setAttribute('aria-checked', String(b.dataset.color === this.brush.color));
    for (const b of d.querySelectorAll('[data-brush]')) b.setAttribute('aria-checked', String(b.dataset.brush === this.brush.id));
    for (const b of d.querySelectorAll('[data-mode]')) b.setAttribute('aria-checked', String(b.dataset.mode === this.mode));
    for (const b of d.querySelectorAll('[data-shape]')) b.setAttribute('aria-pressed', String(this.mode === 'trace' && this.traceId === b.dataset.shape));
    d.querySelector('.ws-brushes').style.setProperty('--brush', this.brush.color);
    this.el.undoDraw.disabled = !this.drawing.canUndo;
    this.el.clearDraw.disabled = this.drawing.isEmpty;
    this.el.replay.disabled = this.drawing.isEmpty;
    this.el.replay.setAttribute('aria-pressed', String(!!this.replay));
    const empty = this.tab === 'music' ? music.isEmpty : this.drawing.isEmpty;
    this.el.teach.classList.toggle('ready', !empty);
    this.el.teach.setAttribute('aria-disabled', String(empty));
    if (!this.hintUntil || nowS() > this.hintUntil) this.el.hint.textContent = this._defaultHint();
  }

  _resize() {
    if (!this.dialog.open) return;
    requestAnimationFrame(() => this._fade());
    if (this.tab === 'music') {
      const w = this.el.keys.clientWidth;
      const wantSplit = this.chromatic && w > 0 && w < 560;
      if (this.chromatic && wantSplit !== this.split) this._renderKeys();
      this._drawTimeline();
    } else {
      const cv = this.el.canvas;
      const size = cv.clientWidth;
      if (size > 0) {
        fitCanvas(cv, size, size);
        if (!this.replay) this._renderCanvas();
      }
    }
  }

  _drawTimeline() {
    const cv = this.el.timeline;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (!w || !h) return;
    const dpr = fitCanvas(cv, w, h);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const tr = this.transport;
    const playhead = tr && tr.beat != null && tr.beat >= 0 ? tr.beat : null;
    paintPhraseRoll(ctx, this.music.phrase, { w, h, playhead, labels: true, background: '#ffffff', radius: 12 });
    if (this.music.isEmpty && !tr) {
      ctx.fillStyle = 'rgba(118, 97, 122, 0.75)';
      ctx.font = '700 12.5px ui-rounded, "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Your notes appear here', w / 2, h * 0.46);
    }
  }

  _loop() {
    cancelAnimationFrame(this.raf);
    const step = () => {
      if (!this.dialog.open) return;
      this.raf = requestAnimationFrame(step);
      const now = nowS();
      for (const [key, until] of this.flashes) {
        if (now > until) {
          key.classList.remove('on');
          this.flashes.delete(key);
        }
      }
      if (this.transport) {
        this._tickTransport();
        this._drawTimeline();
      }
      if (this.replay && this.tab === 'drawing') {
        const p = this._replayProgress();
        this._renderCanvas(p);
        if (nowS() - this.replay.start >= this.replay.duration) {
          this.replay = null;
          this._renderCanvas();
          this._sync();
        }
      }
      if (this.hintUntil && now > this.hintUntil) {
        this.hintUntil = 0;
        this.el.hint.textContent = this._defaultHint();
      }
    };
    this.raf = requestAnimationFrame(step);
  }

  // ----- draft persistence (the unfinished lesson survives a reload) ----------------
  _loadDraft() {
    let obj = null;
    try {
      obj = JSON.parse(this.storage?.getItem(DRAFT_KEY) ?? 'null');
    } catch {
      obj = null;
    }
    if (!obj || obj.schema !== DRAFT_SCHEMA || obj.version !== 1) return;
    if (obj.music) this.music.phrase = sanitizePhrase(obj.music);
    if (obj.drawing) this.drawing.strokes = sanitizeDrawing(obj.drawing).strokes;
    this.tab = obj.tab === 'drawing' ? 'drawing' : 'music';
    this.chromatic = obj.chromatic === true;
    if (DRAW_COLORS.includes(obj.brush?.color)) this.brush.color = obj.brush.color;
    const size = BRUSH_SIZES.find((b) => b.id === obj.brush?.id);
    if (size) Object.assign(this.brush, { id: size.id, width: size.width });
    const ok = (v, list) => (typeof v === 'string' && list.some((t) => t.id === v) ? v : null);
    this.templateId = { music: ok(obj.templateId?.music, MUSIC_TEMPLATES), drawing: ok(obj.templateId?.drawing, DRAWING_TEMPLATES) };
  }

  _saveDraft() {
    try {
      this.storage?.setItem(DRAFT_KEY, JSON.stringify({
        schema: DRAFT_SCHEMA, version: 1, tab: this.tab, chromatic: this.chromatic,
        music: this.music.snapshot(), drawing: this.drawing.drawing,
        brush: { id: this.brush.id, color: this.brush.color }, templateId: this.templateId,
      }));
    } catch {
      /* storage full or blocked: the draft only lives for this session */
    }
  }

  /** Client coordinates of an event on the timeline (automation: tap-to-delete). */
  timelinePoint(beat, midi, drum = false) {
    const r = this.el.timeline.getBoundingClientRect();
    const phrase = this.music.phrase;
    const L = phraseRollLayout(phrase, { w: r.width, h: r.height, labels: true });
    const ev = (drum ? phrase.hits : phrase.notes).find((e) => Math.abs(e.beat - beat) < 1e-6 && e.midi === midi);
    if (!ev) return null;
    if (drum) {
      const c = L.hitCenter(ev);
      return { x: r.left + c.x, y: r.top + c.y };
    }
    const q = L.noteRect(ev);
    return { x: r.left + q.x + q.w / 2, y: r.top + q.y + q.h / 2 };
  }

  /** Automation and inspection surface (window.__PET_STUDIO__.teach). */
  state() {
    return {
      open: this.isOpen,
      tab: this.tab,
      chromatic: this.chromatic,
      recording: this.transport?.mode === 'record',
      previewing: this.transport?.mode === 'preview',
      replaying: !!this.replay,
      templateId: { ...this.templateId },
      phrase: this.music.snapshot(),
      drawing: this.drawing.drawing,
      brush: { ...this.brush },
      mode: this.mode,
      traceId: this.traceId,
    };
  }
}

/**
 * Creates the workshop and plugs it into the feature registry, replacing the
 * placeholder hook: features.register('teach', { open }).
 */
export function installTeachingWorkshop(app, { reducedMotion = false } = {}) {
  const ws = new TeachingWorkshop({
    dialog: document.getElementById('workshop'),
    audio: app.audio,
    storage: app.storage,
    petName: () => app.pet.name,
    onTeach: (kind, data, meta) => app.teach(kind, data, meta),
    onNotice: (kind) => app.petNotice(kind),
    onOpen: () => app.onSheetOpen('workshop'),
    onClose: (reason) => app.onSheetClose('workshop', reason),
    reducedMotion,
  });
  app.features.register('teach', {
    label: 'Teaching Workshop',
    short: 'Teach',
    icon: 'teach',
    shortcut: 'T',
    description: 'Play notes and rhythms or draw strokes to show your pet an idea. It listens, then performs its own take at the Music Corner or Easel.',
    open: () => ws.open(),
  });
  return ws;
}
