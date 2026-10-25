/**
 * main.js: composition root for Pet Studio (Iteration 1).
 *
 * Wires the deterministic pet simulation (pet-state.js) to the 3D studio
 * (studio-scene.js + pet-model.js), audio (audio.js) and the DOM UI
 * (hud.js + customizer.js); persists to localStorage; and exposes
 * window.__PET_STUDIO__ for automated multi-device inspection.
 *
 * Learning boundary: nothing in Iteration 1 learns. Care, autonomy and the
 * starter songs and drawings are authored, deterministic rules. Hooks for the
 * Teaching Workshop, Gallery, Sleep Practice and Inspector are registered as
 * placeholders so later iterations can plug in without rewriting the UI.
 */
import * as THREE from 'three';
import { PetState, loadPet, savePet, clearSavedPet, randomAppearance, randomTraits, hashSeed, SCHEMA_VERSION } from './pet-state.js';
import { StudioScene, CAMERA_VIEWS } from './studio-scene.js';
import { PetModel } from './pet-model.js';
import { generateStarterDrawing, generateStarterPhrase, STARTER_DRAWING_GENERATOR } from './starter-repertoire.js';
import { createRng } from './rng.js';
import { StudioAudio } from './audio.js';
import { Hud } from './hud.js';
import { Customizer } from './customizer.js';

/* global __PETSTUDIO_BUILD__ */
const BUILD = typeof __PETSTUDIO_BUILD__ !== 'undefined' ? __PETSTUDIO_BUILD__ : { version: 'dev', mode: 'unbundled', builtAt: null };
const params = new URLSearchParams(window.location.search);
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false;

/** Pastel note colours by pitch class (C D E G A of the pentatonic scale). */
const NOTE_TINTS = { 0: '#ff8fa3', 2: '#ffb35c', 4: '#ffd84d', 5: '#9be08f', 7: '#7fd8c8', 9: '#8fc8ff', 11: '#c3a6ff' };
const REACTION_ICON = {
  feed: 'i-feed', wash: 'i-wash', sleep: 'i-rest', wake: 'i-wake', pet: 'i-bond', praise: 'i-praise',
  music: 'i-music', draw: 'i-draw', listen: 'i-listen', complete: 'i-praise',
};
const REACTION_SOUND = {
  feed: 'feed', wash: 'wash', sleep: 'sleep', wake: 'wake', pet: 'pet', praise: 'praise',
  music: 'go', draw: 'go', listen: 'go', complete: 'complete',
};
const LOW_NEED_HINT = {
  hunger: ['looks a little peckish.', 'i-hunger'],
  energy: ['is getting sleepy.', 'i-energy'],
  hygiene: ['could use a bubble bath.', 'i-hygiene'],
  curiosity: ['is itching to make something.', 'i-curiosity'],
  bond: ['would love some attention.', 'i-bond'],
};
const STATION_TIP = {
  food: 'Snack Bar: tap to feed',
  bath: 'Bubble Bath: tap to wash',
  bed: 'Sleep Nook: tap to rest',
  music: 'Music Corner: tap to play music',
  easel: 'Drawing Easel: tap to draw',
  rug: 'Cozy Rug: tap to sit and listen',
};

/** Placeholders for later iterations. Real implementations call features.register(id, { open }). */
const FEATURE_PLACEHOLDERS = [
  {
    id: 'teach', label: 'Teaching Workshop', short: 'Teach', icon: 'teach', iteration: 2,
    description: 'Play notes on a little keyboard and draw strokes on a touch canvas to show your pet ideas. Save, retry, correct and compare its attempts.',
  },
  {
    id: 'gallery', label: 'Creation Gallery', short: 'Gallery', icon: 'gallery', iteration: 2,
    description: 'Replay saved songs and drawings, delete ones you no longer want, and compare early and later attempts.',
  },
  {
    id: 'practice', label: 'Sleep Practice', short: 'Practice', icon: 'practice', iteration: 3,
    description: 'While your pet naps, a small on-device model genuinely trains on what you taught it, with honest progress you can pause or cancel.',
  },
  {
    id: 'inspector', label: 'Inspector', short: 'Inspector', icon: 'inspector', iteration: 3,
    description: 'Developer diagnostics: learned parameters, losses, checkpoints, and which behaviour is starter content versus learned.',
  },
];

class FeatureRegistry {
  constructor(defs) {
    this.map = new Map(defs.map((d) => [d.id, { ...d, available: false, open: null }]));
    this.listeners = new Set();
  }

  /** Serializable list for the UI and inspection (no functions). */
  list() {
    return [...this.map.values()].map(({ open, ...rest }) => rest);
  }

  get(id) {
    return this.map.get(id) ?? null;
  }

  /** Plugs a real implementation into a hook: register('teach', { open(app) {...} }). */
  register(id, impl = {}) {
    const prev = this.map.get(id) ?? { id, label: id, short: id, icon: 'more', iteration: null, description: '' };
    const next = { ...prev, ...impl, id, available: typeof impl.open === 'function' };
    this.map.set(id, next);
    for (const fn of this.listeners) fn();
    return next;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

function probeStorage() {
  try {
    const s = window.localStorage;
    s.setItem('__petstudio_probe__', '1');
    s.removeItem('__petstudio_probe__');
    return s;
  } catch {
    return null;
  }
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

const rectOf = (node) => {
  if (!node) return null;
  const r = node.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
};

class App {
  constructor() {
    const storage = probeStorage();
    this.memoryOnly = !storage;
    this.storage = storage ?? memoryStorage();
    const speed = Number(params.get('speed'));
    this.timeScale = Number.isFinite(speed) && speed > 0 ? Math.min(60, speed) : 1;
    this.audio = new StudioAudio({ storage: this.storage });
    if (params.get('mute') === '1') this.audio.setMuted(true);
    this.features = new FeatureRegistry(FEATURE_PLACEHOLDERS);
    this.session = { drawing: null, music: null, listen: null, keyTargets: [null, null] };
    this.dirty = false;
    this.lastSave = 0;
    this.lastHud = 0;
    this.hudDirty = true;
    this.lastLowHint = -Infinity;
    this.ready = false;
    this.last = 0;
    this.prevView = 'overview';
    this.perf = { acc: 0, frames: 0, fps: 0, dpr: Math.min(window.devicePixelRatio || 1, 2) };
    this.tmp = { head: new THREE.Vector3(), pen: new THREE.Vector3(), focus: new THREE.Vector3() };
    this.vm = { position: null, heading: 0, elevation: 0, activity: 'idle', walkSpeed: 1, expression: 'neutral', bubble: null };
    this.ctx = { cameraPosition: null, penTarget: null, keyTargets: null, beat: null, listenBeat: null, paintColor: null };
  }

  boot() {
    if (params.get('reset') === '1') clearSavedPet(this.storage);
    const now = Date.now();
    const loaded = loadPet(this.storage, { now });
    this.loadStatus = loaded.status;
    let firstRun = false;
    if (loaded.pet) {
      this.pet = loaded.pet;
    } else {
      const seedParam = params.get('seed');
      const seed = seedParam ? hashSeed(seedParam) : undefined;
      const rand = seed != null ? createRng(seed).next : Math.random;
      this.pet = PetState.create({ appearance: randomAppearance(rand), traits: randomTraits(rand), seed, now });
      firstRun = true;
    }
    this.pet.on((e) => this.onSimEvent(e));

    this.hud = new Hud({
      views: CAMERA_VIEWS,
      features: this.features.list(),
      onAction: (a) => this.action(a),
      onView: (v) => this.setView(v),
      onMute: () => this.toggleMute(),
      onCustomize: () => this.openCustomizer(),
      onFeature: (id) => this.openFeature(id),
    });
    this.features.onChange(() => this.hud.setFeatures(this.features.list()));
    this.customizer = new Customizer({
      onPreview: (a, t) => this.previewAppearance(a, t),
      onClose: (r) => this.closeCustomizer(r),
    });

    try {
      this.studio = new StudioScene(document.getElementById('scene'), { reducedMotion, lowPower: coarsePointer });
      this.model = new PetModel(this.pet.appearance, { reducedMotion });
      this.studio.setPet(this.model);
      this.studio.onPick = (hit) => this.onPick(hit);
      this.studio.onHover = (hit, at) => this.onHover(hit, at);
    } catch (err) {
      console.error('[petstudio] 3D studio unavailable', err);
      this.studio = null;
      this.model = null;
      document.getElementById('gl-error').hidden = false;
    }
    this.restoreCreativeState();

    this.hud.setMuted(this.audio.muted);
    const view = params.get('view');
    this.setView(CAMERA_VIEWS.some((v) => v.id === view) ? view : 'overview', { instant: true });
    this.bindGlobalEvents();
    this.layout();
    this.hud.render(this.pet.snapshot(), true);

    if (loaded.status === 'restored-backup') {
      this.hud.toast('The last save was damaged, so the previous good save was restored.', { tone: 'warn', icon: 'i-praise', duration: 5000 });
    } else if (loaded.status === 'future-version') {
      this.hud.toast('A save from a newer version was kept safe. Starting a fresh pet here.', { tone: 'warn', duration: 5000 });
    }
    if (this.memoryOnly) this.hud.toast('This browser blocks storage, so progress will not be saved.', { tone: 'warn', duration: 5000 });
    if (loaded.away) this.hud.toast(loaded.away.text, { icon: 'i-wake', duration: 5200 });

    if (firstRun && !params.has('skipIntro')) this.openCustomizer({ firstRun: true });
    else this.save();

    this.exposeApi();
    requestAnimationFrame((t) => {
      this.last = t;
      this.frame(t);
    });
  }

  /** Re-shows the saved drawing on the easel and resumes music sessions after a reload. */
  restoreCreativeState() {
    const rec = this.pet.currentDrawing;
    if (this.studio && rec) {
      const drawing = this.drawingFor(rec);
      this.studio.showDrawing(drawing, rec.progress);
      if (rec.complete) this.studio.showCreation();
      if (this.pet.activity.type === 'drawing' && this.pet.activity.seed === rec.seed) this.session.drawing = drawing;
    }
    const a = this.pet.activity;
    if (a.type === 'playing_music' || a.type === 'listening') this.beginSession(a.type, a.seed);
  }

  drawingFor(rec) {
    const style = rec.style ?? { traits: this.pet.traits, colors: this.pet.appearance };
    return generateStarterDrawing({ seed: rec.seed, traits: style.traits, colors: style.colors });
  }

  beginSession(type, seed) {
    const s = this.session;
    if (type === 'drawing' && this.pet.currentDrawing) {
      const rec = this.pet.currentDrawing;
      if (!rec.style) {
        const { bodyColor, accentColor, cheekColor } = this.pet.appearance;
        rec.style = { generator: STARTER_DRAWING_GENERATOR, traits: { ...this.pet.traits }, colors: { bodyColor, accentColor, cheekColor } };
      }
      s.drawing = this.drawingFor(rec);
      this.studio?.showDrawing(s.drawing, rec.progress);
    } else if (type === 'playing_music') {
      s.music = { phrase: generateStarterPhrase({ seed, traits: this.pet.traits }), cursor: 0 };
      if (this.studio) {
        const m = this.studio.stations.music;
        s.keyTargets = [m.keyWorld(67), m.keyWorld(76)];
      }
    } else if (type === 'listening') {
      s.listen = { phrase: generateStarterPhrase({ seed, mode: 'lullaby' }), cursor: 0 };
    }
  }

  // ----- simulation events -> presentation ---------------------------------------
  onSimEvent(e) {
    switch (e.type) {
      case 'reaction': this.onReaction(e); break;
      case 'activity':
        this.beginSession(e.to, e.seed);
        this.hudDirty = true;
        this.markDirty();
        break;
      case 'activity:end': this.onActivityEnd(e); break;
      case 'need:low': this.onNeedLow(e); break;
      default: this.markDirty(); break;
    }
  }

  onReaction(e) {
    this.model?.playEmote(e.emote);
    if (e.ok && this.studio && this.model) {
      const head = this.model.getHeadWorldPosition(this.tmp.head);
      if (e.kind === 'pet') this.studio.emit('heart', head, { count: e.expression === 'asleep' ? 2 : 5 });
      if (e.kind === 'praise' || (e.kind === 'complete' && e.expression === 'proud')) this.studio.emit('sparkle', head, { count: 10 });
    }
    if (e.message) this.hud.toast(e.message, { tone: e.ok ? 'good' : 'warn', icon: REACTION_ICON[e.kind] ?? 'i-curiosity' });
    let sound = e.ok ? REACTION_SOUND[e.kind] : e.reason === 'refused' ? 'refuse' : 'decline';
    if (e.kind === 'complete' && !e.message) sound = null;
    if (sound) this.audio.sfx(sound);
    this.hudDirty = true;
    this.markDirty();
  }

  onActivityEnd(e) {
    if (e.activity === 'drawing') {
      if (e.completed && this.studio) {
        this.studio.setDrawingProgress(1);
        this.studio.showCreation();
      }
      this.session.drawing = null;
    } else if (e.activity === 'playing_music') {
      this.session.music = null;
    } else if (e.activity === 'listening') {
      this.session.listen = null;
    }
    this.markDirty();
  }

  onNeedLow(e) {
    const now = performance.now();
    const hint = LOW_NEED_HINT[e.need];
    if (!hint || now - this.lastLowHint < 45000) return;
    this.lastLowHint = now;
    this.hud.toast(`${this.pet.name} ${hint[0]}`, { tone: 'warn', icon: hint[1], duration: 3600 });
  }

  // ----- player intent ------------------------------------------------------------
  action(name) {
    this.audio.unlock();
    const p = this.pet;
    let result = null;
    switch (name) {
      case 'feed': result = p.feed(); break;
      case 'wash': result = p.wash(); break;
      case 'rest': result = p.isAsleep ? p.wake() : p.sleep(); break;
      case 'sleep': result = p.sleep(); break;
      case 'wake': result = p.wake(); break;
      case 'pet': result = p.pet(); break;
      case 'praise': result = p.praise(); break;
      case 'music': result = p.goPlayMusic(); break;
      case 'draw': result = p.goDraw(); break;
      case 'listen': result = p.goTo('rug'); break;
      case 'customize': this.openCustomizer(); return null;
      default: return null;
    }
    this.hudDirty = true;
    return result;
  }

  onPick(hit) {
    this.audio.unlock();
    if (!hit) return;
    if (hit.id === 'pet') {
      this.action('pet');
      return;
    }
    const station = hit.id.replace('station:', '');
    const map = { food: 'feed', bath: 'wash', bed: this.pet.isAsleep ? 'wake' : 'sleep', music: 'music', easel: 'draw', rug: 'listen' };
    if (map[station]) this.action(map[station]);
  }

  onHover(hit, at) {
    if (!hit || !at) {
      this.hud.hideTip();
      return;
    }
    const text = hit.id === 'pet' ? `${this.pet.name}: tap to pet` : STATION_TIP[hit.id.replace('station:', '')];
    this.hud.showTip(text, at.x, at.y);
  }

  setView(id, opts) {
    if (this.studio && !this.studio.setView(id, opts)) return;
    this.hud.setView(id);
  }

  toggleMute() {
    this.audio.unlock();
    const muted = this.audio.toggleMute();
    this.hud.setMuted(muted);
    this.hud.toast(muted ? 'Sound off' : 'Sound on', { icon: muted ? 'i-mute' : 'i-sound', duration: 1600 });
  }

  openFeature(id) {
    const f = this.features.get(id);
    if (f?.available) f.open(this.api);
    else this.hud.openNext(id);
  }

  // ----- customizer -----------------------------------------------------------------
  openCustomizer({ firstRun = false } = {}) {
    if (this.customizer.isOpen) return;
    this.prevView = this.studio?.view ?? 'overview';
    this.pet.autonomy = false; // hold still (and face you) while being customised
    this.customizer.open({ appearance: this.pet.appearance, traits: this.pet.traits, firstRun });
    this.setView('pet');
    this.layoutSoon();
  }

  previewAppearance(appearance, traits) {
    this.model?.setAppearance(appearance);
    this.hud.previewIdentity(appearance, traits);
  }

  closeCustomizer({ saved, firstRun, appearance, traits }) {
    if (saved) {
      this.pet.setAppearance(appearance);
      this.pet.setTraits(traits);
      this.save();
      this.hud.toast(firstRun ? `Welcome to the studio, ${this.pet.name}!` : `Looking good, ${this.pet.name}!`, { icon: 'i-praise' });
      if (firstRun) {
        setTimeout(() => this.hud.toast('Tip: tap your pet to pet it, or tap a station to send it there.', { icon: 'i-paw', duration: 4200 }), 1600);
      }
    }
    this.model?.setAppearance(this.pet.appearance);
    this.pet.autonomy = true;
    this.setView(firstRun ? 'overview' : this.prevView);
    this.hud.render(this.pet.snapshot(), true);
    this.layoutSoon();
  }

  // ----- layout: frame the studio inside the area the UI leaves free ---------------
  computeSafeRect() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = 0;
    let bottom = vh;
    let left = 0;
    let right = vw;
    const { topbar, meters, dock } = this.hud.rects();
    top = Math.max(top, topbar.bottom);
    const sidePanel = meters.width > 0 && meters.width < vw * 0.4 && meters.height > meters.width * 0.75;
    if (sidePanel) left = Math.max(left, meters.right);
    else top = Math.max(top, meters.bottom);
    bottom = Math.min(bottom, dock.top);
    if (this.customizer?.isOpen) {
      const r = this.customizer.panelRect();
      if (r.width > 0) {
        if (r.left > vw * 0.35) right = Math.min(right, r.left);
        else bottom = Math.min(bottom, r.top);
      }
    }
    const pad = 6;
    const w = Math.max(120, right - left - 2 * pad);
    const h = Math.max(120, bottom - top - 2 * pad);
    return { x: Math.min(left + pad, vw - w), y: Math.min(top + pad, vh - h), w, h };
  }

  layout() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const dock = document.getElementById('dock').getBoundingClientRect();
    document.documentElement.style.setProperty('--toast-bottom', `${Math.round(vh - dock.top + 10)}px`);
    this.safeRect = this.computeSafeRect();
    this.studio?.resize(vw, vh, this.safeRect, this.perf.dpr);
  }

  layoutSoon() {
    if (this.layoutQueued) return;
    this.layoutQueued = true;
    requestAnimationFrame(() => {
      this.layoutQueued = false;
      this.layout();
    });
  }

  // ----- frame loop ---------------------------------------------------------------
  frame(t) {
    requestAnimationFrame((tt) => this.frame(tt));
    const dt = Math.min(0.1, Math.max(0, (t - this.last) / 1000));
    this.last = t;
    const pet = this.pet;
    pet.update(dt * this.timeScale);
    const a = pet.activity;

    if (this.studio && this.model) {
      const ctx = this.ctx;
      ctx.cameraPosition = this.studio.camera.position;
      ctx.penTarget = null;
      ctx.paintColor = null;
      ctx.keyTargets = null;
      ctx.beat = null;
      ctx.listenBeat = null;
      if (a.type === 'drawing' && this.session.drawing) {
        this.studio.setDrawingProgress(a.duration > 0 ? a.elapsed / a.duration : 1);
        ctx.penTarget = this.studio.penWorld(this.tmp.pen);
        ctx.paintColor = this.studio.paintColor;
      } else if (a.type === 'playing_music' && this.session.music) {
        this.stepPhrase(this.session.music, a.elapsed, ctx, false);
      } else if (a.type === 'listening' && this.session.listen) {
        this.stepPhrase(this.session.listen, a.elapsed, ctx, true);
      }
      const vm = this.vm;
      vm.position = pet.position;
      vm.heading = pet.heading;
      vm.elevation = pet.elevation;
      vm.activity = a.type;
      vm.walkSpeed = pet.walkSpeed() * this.timeScale;
      vm.expression = pet.getExpression();
      vm.bubble = pet.getBubble();
      this.model.update(dt, vm, ctx);
      this.studio.update(dt, {
        activity: a.type,
        petHead: this.model.getHeadWorldPosition(this.tmp.head),
        petFocus: this.tmp.focus.copy(this.model.root.position),
      });
      this.studio.render();
      this.trackPerf(dt);
    }

    if (this.hudDirty || t - this.lastHud > 160) {
      this.hud.render(pet.snapshot());
      this.lastHud = t;
      this.hudDirty = false;
    }
    if ((this.dirty && t - this.lastSave > 4000) || t - this.lastSave > 20000) this.save();
    if (!this.ready) {
      this.ready = true;
      document.getElementById('splash')?.classList.add('hide');
      if (window.__PET_STUDIO__) window.__PET_STUDIO__.ready = true;
    }
  }

  /**
   * Plays due notes of an authored starter phrase, looping with a one-beat rest.
   * Visuals (key press, arm, floating note) and sound are driven by the same event.
   */
  stepPhrase(s, elapsed, ctx, lullaby) {
    const ph = s.phrase;
    const spb = 60 / ph.tempo;
    const beat = elapsed / spb;
    const loopBeats = ph.beats + 1;
    for (let guard = 0; guard < 64; guard++) {
      const note = ph.notes[s.cursor % ph.notes.length];
      const at = Math.floor(s.cursor / ph.notes.length) * loopBeats + note.beat;
      if (at > beat) break;
      if (beat - at < 0.6) {
        const tint = NOTE_TINTS[note.midi % 12] ?? '#c3a6ff';
        if (lullaby) {
          if (s.cursor % 2 === 0) this.studio.speakerNote(tint);
          this.audio.pluck(note.midi, { duration: note.dur * spb, velocity: note.vel * 0.75, pan: s.cursor % 2 ? 0.35 : -0.35 });
        } else {
          const r = this.studio.playNote(note.midi, tint);
          this.session.keyTargets[r.arm] = r.key;
          this.model.pressKey(r.arm);
          this.audio.pluck(note.midi, { duration: note.dur * spb, velocity: note.vel, pan: r.arm === 0 ? -0.2 : 0.2 });
        }
      }
      s.cursor++;
    }
    if (lullaby) ctx.listenBeat = beat;
    else {
      ctx.beat = beat;
      ctx.keyTargets = this.session.keyTargets;
    }
  }

  /** Lowers the pixel ratio if frames are slow (simple adaptive quality). */
  trackPerf(dt) {
    const p = this.perf;
    p.acc += dt;
    p.frames++;
    if (p.acc < 2.5) return;
    const avg = p.acc / p.frames;
    p.fps = Math.round(1 / avg);
    p.acc = 0;
    p.frames = 0;
    if (avg > 1 / 40 && p.dpr > 1) {
      p.dpr = Math.max(1, Math.round((p.dpr - 0.25) * 100) / 100);
      this.layout();
    }
  }

  markDirty() {
    this.dirty = true;
  }

  save() {
    const res = savePet(this.pet, this.storage);
    this.lastSave = performance.now();
    this.dirty = false;
    if (!res.ok && !this.saveWarned) {
      this.saveWarned = true;
      this.hud.toast('Could not save right now. Your pet is fine in this session.', { tone: 'warn', duration: 4000 });
    }
    return res;
  }

  // ----- lifecycle ----------------------------------------------------------------
  bindGlobalEvents() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.hiddenAt = Date.now();
        this.save();
        return;
      }
      if (!this.hiddenAt) return;
      const away = (Date.now() - this.hiddenAt) / 1000;
      this.hiddenAt = 0;
      if (away > 60) {
        const summary = this.pet.applyElapsed(away); // bounded, gentle time-based care only
        if (summary) this.hud.toast(summary.text, { icon: 'i-wake', duration: 5000 });
      } else if (away > 0.5) {
        this.pet.update(away * this.timeScale);
      }
      this.last = performance.now();
      this.hudDirty = true;
    });
    window.addEventListener('pagehide', () => this.save());
    window.addEventListener('resize', () => this.layoutSoon());
    window.visualViewport?.addEventListener('resize', () => this.layoutSoon());
    if ('ResizeObserver' in window) {
      const ro = new ResizeObserver(() => this.layoutSoon());
      for (const sel of ['.topbar', '#meters', '#dock', '#customizer']) {
        const node = document.querySelector(sel);
        if (node) ro.observe(node);
      }
    }
    // pointerup / touchend count as user activation for touch (iOS); keydown for keyboards.
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerup', unlock, { passive: true });
    window.addEventListener('touchend', unlock, { passive: true });
    window.addEventListener('keydown', (e) => {
      unlock();
      this.onKey(e);
    });
  }

  onKey(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (document.querySelector('dialog[open]')) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const key = e.key.toLowerCase();
    const actions = { f: 'feed', w: 'wash', r: 'rest', p: 'pet', g: 'praise', j: 'music', d: 'draw', l: 'listen', c: 'customize' };
    if (actions[key]) {
      e.preventDefault();
      this.action(actions[key]);
    } else if (key === 'm') {
      this.toggleMute();
    } else if (key >= '1' && key <= String(CAMERA_VIEWS.length)) {
      this.setView(CAMERA_VIEWS[Number(key) - 1].id);
    } else if (key === 'v') {
      const i = CAMERA_VIEWS.findIndex((v) => v.id === (this.studio?.view ?? 'overview'));
      this.setView(CAMERA_VIEWS[(i + 1) % CAMERA_VIEWS.length].id);
    }
  }

  // ----- inspection -----------------------------------------------------------------
  /** Geometry report for automated multi-device checks (overflow, clipping, framing). */
  layoutReport() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const doc = document.documentElement;
    const visible = (node) => {
      if (node.closest('dialog:not([open])') || node.closest('[hidden]')) return false;
      const r = node.getBoundingClientRect();
      const cs = getComputedStyle(node);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const describe = (node) => ({ label: node.getAttribute('aria-label') || node.textContent.trim().slice(0, 40), rect: rectOf(node) });
    // Controls inside a scrollable container (e.g. the customizer body) are reachable by scrolling.
    const inScroller = (node) => {
      for (let p = node.parentElement; p && p !== document.body; p = p.parentElement) {
        const oy = getComputedStyle(p).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 1) return true;
      }
      return false;
    };
    const controls = [...document.querySelectorAll('button, input, [role="radio"]')].filter(visible);
    const clipped = controls.filter((node) => {
      const r = node.getBoundingClientRect();
      return (r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5) && !inScroller(node);
    });
    const small = controls.filter((node) => {
      const r = node.getBoundingClientRect();
      return Math.min(r.width, r.height) < 34;
    });
    const safe = this.safeRect ?? this.computeSafeRect();
    const inside = (r) => !!r && r.x >= safe.x - 2 && r.y >= safe.y - 2 && r.x + r.width <= safe.x + safe.w + 2 && r.y + r.height <= safe.y + safe.h + 2;
    const petRect = this.studio && this.model ? this.studio.screenRect(this.model.getWorldBox()) : null;
    const overlays = this.hud.rects();
    const overlap = (a, b) => !!a && !!b && a.x < b.right && a.x + a.width > b.left && a.y < b.bottom && a.y + a.height > b.top;
    const round = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
    return {
      viewport: { width: vw, height: vh, devicePixelRatio: window.devicePixelRatio || 1, renderPixelRatio: this.perf.dpr },
      view: this.studio?.view ?? null,
      horizontalOverflow: doc.scrollWidth > vw + 0.5 || document.body.scrollWidth > vw + 0.5,
      verticalOverflow: doc.scrollHeight > vh + 0.5,
      safeRect: { x: Math.round(safe.x), y: Math.round(safe.y), width: Math.round(safe.w), height: Math.round(safe.h) },
      overlays: { topbar: rectOf(document.querySelector('.topbar')), meters: rectOf(document.getElementById('meters')), dock: rectOf(document.getElementById('dock')) },
      controls: controls.length,
      clippedControls: clipped.map(describe),
      smallTouchTargets: small.map(describe),
      pet: petRect && { rect: round(petRect), insideSafeRect: inside(petRect), overlapsUI: Object.values(overlays).some((o) => overlap(petRect, o)) },
      fps: this.perf.fps,
    };
  }

  exposeApi() {
    const app = this;
    const api = {
      version: `${BUILD.version}-iteration-1`,
      build: BUILD,
      iteration: 1,
      schemaVersion: SCHEMA_VERSION,
      ready: false,
      learning: 'none: Iteration 1 uses authored, deterministic care/autonomy rules and starter content only',
      get pet() { return app.pet; },
      get state() { return app.pet.snapshot(); },
      get record() { return app.pet.toJSON(); },
      actions: {
        feed: () => app.action('feed'), wash: () => app.action('wash'), rest: () => app.action('rest'),
        sleep: () => app.action('sleep'), wake: () => app.action('wake'), pet: () => app.action('pet'),
        praise: () => app.action('praise'), goPlayMusic: () => app.action('music'), goDraw: () => app.action('draw'),
        listen: () => app.action('listen'), goTo: (id) => app.pet.goTo(id),
      },
      camera: {
        views: CAMERA_VIEWS.map((v) => v.id),
        get view() { return app.studio?.view ?? null; },
        setView: (id, opts) => { app.setView(id, opts); return app.studio?.view ?? null; },
      },
      customize: {
        open: () => app.openCustomizer(),
        close: (save = false) => app.customizer.close(save),
        get isOpen() { return app.customizer.isOpen; },
        apply: (partial) => {
          app.pet.setAppearance(partial);
          app.model?.setAppearance(app.pet.appearance);
          app.hudDirty = true;
          return app.pet.appearance;
        },
        setTraits: (partial) => { app.hudDirty = true; return app.pet.setTraits(partial); },
      },
      setNeeds: (partial) => { app.hudDirty = true; return app.pet.setNeeds(partial); },
      setTimeScale: (x) => { app.timeScale = Math.min(60, Math.max(0, Number(x) || 0)); return app.timeScale; },
      get timeScale() { return app.timeScale; },
      layout: () => app.layoutReport(),
      relayout: () => app.layout(),
      renderInfo: () => app.studio?.info() ?? null,
      audio: {
        get muted() { return app.audio.muted; },
        setMuted: (m) => { app.audio.setMuted(m); app.hud.setMuted(app.audio.muted); },
      },
      features: app.features,
      save: () => app.save(),
      reset: () => { clearSavedPet(app.storage); window.location.reload(); },
      scene: app.studio,
      model: app.model,
    };
    this.api = api;
    window.__PET_STUDIO__ = api;
  }
}

const app = new App();
app.boot();
