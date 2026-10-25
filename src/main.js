/**
 * main.js: composition root for Pet Studio (Iteration 2).
 *
 * Wires the deterministic pet simulation (pet-state.js) to the 3D studio
 * (studio-scene.js + pet-model.js), audio (audio.js) and the DOM UI
 * (hud.js, customizer.js, teaching-workshop.js, gallery.js); connects the
 * teaching loop (creation-flow.js) to the teaching memory and the creation
 * gallery; persists everything to localStorage; and exposes
 * window.__PET_STUDIO__ for automated multi-device inspection.
 *
 * Learning boundary: nothing in Iteration 2 learns. Care, autonomy, the
 * starter repertoire and the pet's attempts at your lessons are authored,
 * deterministic rules (the attempts come from a seeded variation engine fed
 * by the teaching memory). Sleep Practice and the Inspector remain
 * placeholders for the genuine on-device learning of Iteration 3.
 */
import * as THREE from 'three';
import { PetState, loadPet, savePet, clearSavedPet, randomAppearance, randomTraits, hashSeed, SCHEMA_VERSION } from './pet-state.js';
import { StudioScene, CAMERA_VIEWS } from './studio-scene.js';
import { PetModel } from './pet-model.js';
import { generateStarterPhrase } from './starter-repertoire.js';
import { createRng } from './rng.js';
import { StudioAudio } from './audio.js';
import { Hud } from './hud.js';
import { Customizer } from './customizer.js';
import { noteColor, drumByMidi } from './teaching-core.js';
import { ENGINE_INFO, NUDGES } from './creative-engine.js';
import { CreationFlow } from './creation-flow.js';
import { loadTeachingMemory, saveTeachingMemory, clearTeachingMemory, TEACH_VERSION } from './teaching-memory.js';
import { loadGallery, saveGallery, clearGallery, GALLERY_LIMITS, GALLERY_VERSION } from './gallery-store.js';
import { installTeachingWorkshop } from './teaching-workshop.js';
import { installGallery } from './gallery.js';

/* global __PETSTUDIO_BUILD__ */
const BUILD = typeof __PETSTUDIO_BUILD__ !== 'undefined' ? __PETSTUDIO_BUILD__ : { version: 'dev', mode: 'unbundled', builtAt: null };
const params = new URLSearchParams(window.location.search);
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false;
const WORKSHOP_DRAFT_KEY = 'petstudio.workshop.v1';

const REACTION_ICON = {
  feed: 'i-feed', wash: 'i-wash', sleep: 'i-rest', wake: 'i-wake', pet: 'i-bond', praise: 'i-praise',
  music: 'i-music', draw: 'i-draw', listen: 'i-listen', complete: 'i-praise', lesson: 'i-teach', love: 'i-bond',
};
const REACTION_SOUND = {
  feed: 'feed', wash: 'wash', sleep: 'sleep', wake: 'wake', pet: 'pet', praise: 'praise',
  music: 'go', draw: 'go', listen: 'go', complete: 'complete', lesson: 'lesson', love: 'love',
};
const STATION_VIEW = { music: 'music', drawing: 'easel' };
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

/**
 * Feature hooks. Teach and Gallery are replaced by their real implementations
 * at boot (features.register in teaching-workshop.js and gallery.js); the
 * Iteration 3 hooks stay placeholders.
 */
const FEATURE_PLACEHOLDERS = [
  {
    id: 'teach', label: 'Teaching Workshop', short: 'Teach', icon: 'teach', iteration: 2,
    description: 'Play notes and rhythms or draw strokes to show your pet an idea. It listens, then performs its own take.',
  },
  {
    id: 'gallery', label: 'Creation Gallery', short: 'Gallery', icon: 'gallery', iteration: 2,
    description: 'Replay saved songs and drawings, hang one on the wall, and compare your lessons with your pet\'s attempts.',
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
    this.session = { drawing: null, music: null, listen: null, lesson: null, keyTargets: [null, null] };
    this.flowCam = null; // camera follows a teaching flow until the player picks a view
    this.sheet = null; // which of the workshop / gallery sheets is open
    this.storesDirty = false;
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
    if (params.get('reset') === '1') this.clearAllSaves();
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

    // Teaching memory (per pet) and the creation gallery, then the teaching loop.
    // The flow subscribes to the simulation before the presentation does, so it
    // has decided what is being performed by the time a session begins.
    const mem = loadTeachingMemory(this.storage, { petId: this.pet.id });
    const gal = loadGallery(this.storage);
    this.memory = mem.memory;
    this.gallery = gal.gallery;
    this.storeStatus = { memory: mem.status, gallery: gal.status };
    this.flow = new CreationFlow({ pet: this.pet, memory: this.memory, gallery: this.gallery });
    this.flow.on((e) => this.onFlowEvent(e));
    this.memory.onChange(() => this.scheduleStoreSave());
    this.gallery.onChange((what) => {
      this.scheduleStoreSave();
      if (what !== 'feedback' && what !== 'favorite') this.refreshWallArt();
    });
    this.pet.on((e) => this.onSimEvent(e));

    this.hud = new Hud({
      views: CAMERA_VIEWS,
      features: this.features.list(),
      onAction: (a) => this.action(a),
      onView: (v) => this.setView(v),
      onMute: () => this.toggleMute(),
      onCustomize: () => this.openCustomizer(),
      onFeature: (id) => this.openFeature(id),
      onFeedback: (kind) => this.feedback(kind),
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
    this.workshop = installTeachingWorkshop(this, { reducedMotion });
    this.galleryView = installGallery(this, { reducedMotion });
    this.restoreCreativeState();
    this.refreshWallArt();

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
    if (Object.values(this.storeStatus).includes('restored-backup')) {
      this.hud.toast('Some lessons or creations were damaged, so their last good copy was restored.', { tone: 'warn', icon: 'i-gallery', duration: 5000 });
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
      const drawing = this.flow.drawingFor(rec);
      if (drawing) this.studio.showDrawing(drawing, rec.progress);
      if (drawing && this.pet.activity.type === 'drawing' && this.pet.activity.seed === rec.seed) this.session.drawing = drawing;
    }
    const a = this.pet.activity;
    if (a.type === 'playing_music' || a.type === 'listening') this.beginSession(a.type, a.seed);
  }

  /** What the studio renders comes from the creation flow: a planned piece or a starter one. */
  beginSession(type, seed) {
    const s = this.session;
    if (type === 'drawing' && this.pet.currentDrawing) {
      const rec = this.pet.currentDrawing;
      s.drawing = this.flow.drawingFor(rec);
      if (s.drawing) this.studio?.showDrawing(s.drawing, rec.progress);
    } else if (type === 'playing_music') {
      s.music = { phrase: this.flow.phraseFor(this.pet.activity), cursor: 0, hitCursor: 0, lead: 0.5 };
      if (this.studio) {
        const m = this.studio.stations.music;
        s.keyTargets = [m.keyWorld(67), m.keyWorld(76)];
      }
    } else if (type === 'listening') {
      s.listen = { phrase: generateStarterPhrase({ seed, mode: 'lullaby' }), cursor: 0, hitCursor: 0 };
    } else if (type === 'lesson') {
      // The demonstrated tune plays once from the speakers while the pet listens.
      const lesson = this.flow.lessonData();
      s.lesson = lesson?.kind === 'music' ? { phrase: lesson.data, cursor: 0, hitCursor: 0, once: true, lead: 0.4 } : null;
    }
  }

  // ----- simulation events -> presentation ---------------------------------------
  onSimEvent(e) {
    switch (e.type) {
      case 'reaction': this.onReaction(e); break;
      case 'activity':
        this.beginSession(e.to, e.seed);
        // A teaching flow shows the performance: switch to the station once the pet starts.
        if (this.flowCam && e.plan?.ref === this.flowCam.ref && STATION_VIEW[e.plan.kind] && (e.to === 'playing_music' || e.to === 'drawing')) {
          this.setView(STATION_VIEW[e.plan.kind], { auto: true });
        }
        this.hudDirty = true;
        this.markDirty();
        break;
      case 'activity:end': this.onActivityEnd(e); break;
      case 'need:low': this.onNeedLow(e); break;
      default: this.markDirty(); break;
    }
  }

  /** Teaching-loop events: wall art follows new drawings; stores save; the HUD updates. */
  onFlowEvent(e) {
    if (e.type === 'creation') {
      if (e.item?.kind === 'drawing') this.refreshWallArt();
      this.scheduleStoreSave(0);
    }
    this.hudDirty = true;
  }

  onReaction(e) {
    this.model?.playEmote(e.emote);
    if (e.ok && this.studio && this.model) {
      const head = this.model.getHeadWorldPosition(this.tmp.head);
      if (e.kind === 'pet' || e.kind === 'love') this.studio.emit('heart', head, { count: e.expression === 'asleep' ? 2 : e.kind === 'love' ? 7 : 5 });
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
        this.refreshWallArt();
      }
      this.session.drawing = null;
    } else if (e.activity === 'playing_music') {
      this.session.music = null;
    } else if (e.activity === 'listening') {
      this.session.listen = null;
    } else if (e.activity === 'lesson') {
      this.session.lesson = null;
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
    if (hit.id === 'frame') {
      this.openFeature('gallery');
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
    let text;
    if (hit.id === 'pet') text = `${this.pet.name}: tap to pet`;
    else if (hit.id === 'frame') text = this.studio?.wallArt.pinned ? `"${this.studio.wallArt.title}": tap to open the Gallery` : 'Gallery wall: tap to open the Gallery';
    else text = STATION_TIP[hit.id.replace('station:', '')];
    this.hud.showTip(text, at.x, at.y);
  }

  /** `auto` = chosen by a teaching flow; a view the player picks takes the camera back. */
  setView(id, { auto = false, instant = false } = {}) {
    if (!auto) this.flowCam = null;
    if (this.studio && !this.studio.setView(id, { instant })) return;
    this.hud.setView(id);
  }

  toggleMute() {
    this.audio.unlock();
    const muted = this.audio.toggleMute();
    this.hud.setMuted(muted);
    this.hud.toast(muted ? 'Sound off' : 'Sound on', { icon: muted ? 'i-mute' : 'i-sound', duration: 1600 });
  }

  openFeature(id) {
    if (this.customizer?.isOpen || this.workshop?.isOpen || this.galleryView?.isOpen) return;
    this.audio.unlock();
    const f = this.features.get(id);
    if (f?.available) f.open(this.api);
    else this.hud.openNext(id);
  }

  // ----- teaching loop (Teaching Workshop, Gallery, feedback bar) ---------------------
  /** Called by the Teaching Workshop's "Teach Pet". */
  teach(kind, data, meta = {}) {
    const res = this.flow.teach(kind, data, meta);
    if (res.ok) {
      this.flowCam = { ref: res.plan.ref };
      this.saveStores();
      this.save();
    }
    this.hudDirty = true;
    return res;
  }

  /** The pet glances over with interest while the player plays or draws. */
  petNotice(kind) {
    this.pet.notice(kind);
  }

  performItem(id) {
    const res = this.flow.perform(id);
    if (res.ok) {
      this.flowCam = { ref: res.plan.ref };
      this.galleryView.close('perform');
      this.setView(STATION_VIEW[res.plan.kind], { auto: true });
    } else if (res.reason === 'missing') {
      this.hud.toast(res.message, { tone: 'warn', icon: 'i-gallery' });
    }
    return res;
  }

  hangItem(id) {
    const item = this.gallery.get(id);
    if (!item || !this.gallery.pin(id)) return false;
    this.saveStores();
    this.refreshWallArt();
    this.galleryView.close('hang');
    this.setView('wall', { auto: true });
    this.audio.sfx('hang');
    this.hud.toast(`"${item.title}" is now hanging on the studio wall.`, { icon: 'i-frame', duration: 3600 });
    return true;
  }

  unhangWall() {
    const item = this.gallery.wallItem;
    if (!this.gallery.unpin()) return false;
    this.saveStores();
    this.refreshWallArt();
    this.hud.toast(item ? `Took "${item.title}" down from the wall.` : 'Took the picture down.', { icon: 'i-frame', duration: 2400 });
    return true;
  }

  deleteItem(id) {
    const item = this.gallery.get(id);
    if (!item || !this.gallery.remove(id)) return false;
    this.saveStores();
    this.hud.toast(`Deleted "${item.title}".`, { icon: 'i-gallery', duration: 2200 });
    return true;
  }

  favoriteItem(id, on) {
    if (!this.gallery.setFavorite(id, on)) return false;
    this.saveStores();
    return true;
  }

  /** Creation Feedback Bar actions. */
  feedback(kind) {
    this.audio.unlock();
    let res;
    if (kind === 'love') res = this.flow.love();
    else if (kind === 'variation') res = this.flow.variation();
    else if (NUDGES[kind]) res = this.flow.nudge(kind);
    else if (kind === 'dismiss') res = { ok: this.flow.dismiss() };
    else return { ok: false, reason: 'unknown' };
    if (res.ok && (kind === 'variation' || NUDGES[kind])) this.flowCam = { ref: res.plan.ref };
    if (!res.ok && res.message && res.reason !== 'asleep' && res.reason !== 'too-tired') this.hud.toast(res.message, { tone: 'warn' });
    if (res.ok) this.saveStores();
    this.hudDirty = true;
    return res;
  }

  /** Workshop and Gallery sheets: the workshop keeps the pet in view like the Customizer. */
  onSheetOpen(name) {
    this.sheet = name;
    document.body.classList.add(`${name}-open`);
    if (name === 'workshop') {
      this.prevView = this.studio?.view ?? 'overview';
      this.pet.autonomy = false; // stay put and attentive while being taught
      this.setView('pet', { auto: true });
    }
    this.hudDirty = true;
    this.layoutSoon();
  }

  onSheetClose(name, reason) {
    this.sheet = null;
    document.body.classList.remove(`${name}-open`);
    if (name === 'workshop') {
      this.pet.autonomy = true;
      if (reason !== 'teach') this.setView(this.prevView === 'wall' ? 'overview' : this.prevView);
    }
    this.hudDirty = true;
    this.layoutSoon();
  }

  /** The wall frame shows the pinned drawing, else the newest drawing (or the easel's last finished one). */
  refreshWallArt() {
    if (!this.studio) return;
    const pinned = this.gallery.wallItem;
    if (pinned) {
      this.studio.setWallArt(pinned.data, { title: pinned.title, pinned: true });
      return;
    }
    const latest = this.gallery.latestDrawing();
    if (latest) this.studio.setWallArt(latest.data, { pinned: false });
    else if (this.pet.currentDrawing?.complete) {
      this.studio.setWallArt(null);
      this.studio.showCreation();
    } else this.studio.setWallArt(null);
  }

  scheduleStoreSave(delay = 250) {
    this.storesDirty = true;
    clearTimeout(this.storeTimer);
    this.storeTimer = setTimeout(() => this.saveStores(), delay);
  }

  saveStores() {
    clearTimeout(this.storeTimer);
    this.storesDirty = false;
    const now = Date.now();
    const a = saveTeachingMemory(this.memory, this.storage, now);
    const b = saveGallery(this.gallery, this.storage, now);
    if ((!a.ok || !b.ok) && !this.storeWarned && !this.memoryOnly) {
      this.storeWarned = true;
      this.hud?.toast('Could not save lessons or creations right now. They are fine in this session.', { tone: 'warn', duration: 4500 });
    }
    return { memory: a, gallery: b };
  }

  clearAllSaves() {
    clearSavedPet(this.storage);
    clearTeachingMemory(this.storage);
    clearGallery(this.storage);
    try {
      this.storage.removeItem(WORKSHOP_DRAFT_KEY);
    } catch {
      /* ignore */
    }
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
    const { topbar, meters, dock, bar } = this.hud.rects();
    top = Math.max(top, topbar.bottom);
    const sidePanel = meters.width > 0 && meters.width < vw * 0.4 && meters.height > meters.width * 0.75;
    if (meters.width > 0 && meters.height > 0) {
      if (sidePanel) left = Math.max(left, meters.right);
      else top = Math.max(top, meters.bottom);
    }
    bottom = Math.min(bottom, dock.top);
    // The feedback bar floats above the dock: frame the studio above it so it never covers the pet.
    if (bar && bar.width > 0 && bar.height > 0) bottom = Math.min(bottom, bar.top);
    const panel = this.customizer?.isOpen ? this.customizer.panelRect() : this.workshop?.isOpen ? this.workshop.panelRect() : null;
    if (panel && panel.width > 0) {
      if (panel.left > vw * 0.35) right = Math.min(right, panel.left);
      else bottom = Math.min(bottom, panel.top);
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
    const bar = document.getElementById('creation-bar');
    document.documentElement.style.setProperty('--dock-top', `${Math.round(vh - dock.top + 8)}px`);
    const barTop = bar.hidden ? dock.top : Math.min(dock.top, bar.getBoundingClientRect().top);
    document.documentElement.style.setProperty('--toast-bottom', `${Math.round(vh - barTop + 10)}px`);
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
        this.stepPhrase(this.session.music, a.elapsed, ctx, 'perform');
      } else if (a.type === 'listening' && this.session.listen) {
        this.stepPhrase(this.session.listen, a.elapsed, ctx, 'lullaby');
      } else if (a.type === 'lesson' && this.session.lesson) {
        this.stepPhrase(this.session.lesson, a.elapsed, ctx, 'lesson');
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
      // The feedback bar hides while a sheet covers the studio; its appearance reframes the camera.
      const bar = this.sheet || this.customizer.isOpen ? { visible: false } : this.flow.barState();
      if (this.hud.renderCreationBar(bar)) this.layoutSoon();
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
   * Plays the due events of a phrase. `perform`: the pet plays the studio
   * keyboard (looping with a one-beat rest); `lullaby` and `lesson`: the
   * phrase comes from the speakers while the pet listens (lessons play once).
   * Visuals (key press, arm, floating note, speaker thump) and sound are
   * driven by the same note events; percussion hits thump the speakers.
   */
  stepPhrase(s, elapsed, ctx, mode) {
    const ph = s.phrase;
    const spb = 60 / ph.tempo;
    const beat = elapsed / spb - (s.lead ?? 0);
    const loopBeats = ph.beats + 1;
    const speaker = mode !== 'perform';
    const due = (list, cursorKey, play) => {
      if (!list.length) return;
      for (let guard = 0; guard < 64; guard++) {
        const i = s[cursorKey];
        if (s.once && i >= list.length) break;
        const ev = list[i % list.length];
        const at = (s.once ? 0 : Math.floor(i / list.length) * loopBeats) + ev.beat;
        if (at > beat) break;
        if (beat - at < 0.6) play(ev, i);
        s[cursorKey] = i + 1;
      }
    };
    due(ph.notes, 'cursor', (note, i) => {
      const tint = noteColor(note.midi);
      if (speaker) {
        if (i % 2 === 0) this.studio.speakerNote(tint);
        this.audio.pluck(note.midi, { duration: note.dur * spb, velocity: note.vel * (mode === 'lullaby' ? 0.75 : 0.9), pan: i % 2 ? 0.35 : -0.35 });
      } else {
        const r = this.studio.playNote(note.midi, tint);
        this.session.keyTargets[r.arm] = r.key;
        this.model.pressKey(r.arm);
        this.audio.pluck(note.midi, { duration: note.dur * spb, velocity: note.vel, pan: r.arm === 0 ? -0.2 : 0.2 });
      }
    });
    s.hitCursor ??= 0;
    due(ph.hits ?? [], 'hitCursor', (hit) => {
      const drum = drumByMidi(hit.midi);
      if (!drum) return;
      this.audio.drum(drum.id, { velocity: hit.vel * (speaker ? 0.85 : 1) });
      this.studio.drumHit(drum.id, drum.color);
    });
    if (speaker) ctx.listenBeat = beat;
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
    if (this.resetting) return { ok: false, reason: 'resetting' };
    const res = savePet(this.pet, this.storage);
    if (this.storesDirty) this.saveStores();
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
      for (const sel of ['.topbar', '#meters', '#dock', '#customizer', '#workshop', '#creation-bar']) {
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
    } else if (key === 't' || key === 'y') {
      e.preventDefault();
      this.openFeature(key === 't' ? 'teach' : 'gallery');
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
    /**
     * A control is clipped when an ancestor cuts it off without being able to
     * scroll it into view on that axis, or when it ends up outside the
     * viewport. Controls inside a scroller (sheet bodies, chip rows) count as
     * reachable; the scroller itself must then be fully visible.
     */
    const clippedNode = (node) => {
      // Fully transparent hit areas (e.g. the native colour input stretched over a
      // round swatch) are meant to overhang their clipping parent; the visible
      // affordance is the parent itself.
      if (getComputedStyle(node).opacity === '0') return false;
      const r = node.getBoundingClientRect();
      let box = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      for (let p = node.parentElement; p && p !== doc; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const pr = p.getBoundingClientRect();
        const outX = box.left < pr.left - 0.5 || box.right > pr.right + 0.5;
        const outY = box.top < pr.top - 0.5 || box.bottom > pr.bottom + 0.5;
        if (!outX && !outY) continue;
        const scrollX = /auto|scroll/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1;
        const scrollY = /auto|scroll/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1;
        if ((outX && !scrollX) || (outY && !scrollY)) return true;
        box = { left: pr.left, right: pr.right, top: pr.top, bottom: pr.bottom };
      }
      return box.left < -0.5 || box.top < -0.5 || box.right > vw + 0.5 || box.bottom > vh + 0.5;
    };
    const controls = [...document.querySelectorAll('button, input, [role="radio"], [role="tab"]')].filter(visible);
    const clipped = controls.filter(clippedNode);
    // Labels that spill out of their own button (text wider than the control).
    const overflowing = controls.filter((node) => node.tagName === 'BUTTON' && node.scrollWidth > node.clientWidth + 1);
    const small = controls.filter((node) => {
      const r = node.getBoundingClientRect();
      return Math.min(r.width, r.height) < 34;
    });
    const safe = this.safeRect ?? this.computeSafeRect();
    const inside = (r) => !!r && r.x >= safe.x - 2 && r.y >= safe.y - 2 && r.x + r.width <= safe.x + safe.w + 2 && r.y + r.height <= safe.y + safe.h + 2;
    // The silhouette (outline points) decides; the 3D box is reported for reference only.
    const petRect = this.studio && this.model ? this.studio.screenRectOfPoints(this.model.getSilhouettePoints(this.studio.camera)) : null;
    const petBox = this.studio && this.model ? this.studio.screenRect(this.model.getWorldBox()) : null;
    const hudRects = this.hud.rects();
    const panel = this.workshop?.isOpen ? this.workshop.panelRect() : this.customizer?.isOpen ? this.customizer.panelRect() : null;
    // The gallery is a full sheet over the studio, so the pet is not expected to be visible then.
    const blockers = { ...hudRects, ...(panel ? { panel } : {}) };
    const overlap = (a, b) => !!a && !!b && b.width > 0 && a.x < b.right && a.x + a.width > b.left && a.y < b.bottom && a.y + a.height > b.top;
    const round = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
    const bar = document.getElementById('creation-bar');
    return {
      viewport: { width: vw, height: vh, devicePixelRatio: window.devicePixelRatio || 1, renderPixelRatio: this.perf.dpr },
      view: this.studio?.view ?? null,
      horizontalOverflow: doc.scrollWidth > vw + 0.5 || document.body.scrollWidth > vw + 0.5,
      verticalOverflow: doc.scrollHeight > vh + 0.5,
      safeRect: { x: Math.round(safe.x), y: Math.round(safe.y), width: Math.round(safe.w), height: Math.round(safe.h) },
      overlays: {
        topbar: rectOf(document.querySelector('.topbar')), meters: rectOf(document.getElementById('meters')), dock: rectOf(document.getElementById('dock')),
        creationBar: bar.hidden ? null : rectOf(bar),
        workshop: this.workshop?.isOpen ? rectOf(this.workshop.dialog) : null,
        gallery: this.galleryView?.isOpen ? rectOf(this.galleryView.dialog) : null,
      },
      sheet: this.sheet ?? (this.customizer?.isOpen ? 'customizer' : null),
      controls: controls.length,
      clippedControls: clipped.map(describe),
      overflowingLabels: overflowing.map(describe),
      smallTouchTargets: small.map(describe),
      cameraSettled: this.studio?.rig.settled ?? true,
      pet: petRect && {
        rect: round(petRect),
        box: round(petBox),
        insideSafeRect: inside(petRect),
        overlapsUI: Object.values(blockers).some((o) => overlap(petRect, o)),
        overlapsCreationBar: overlap(petRect, hudRects.bar),
      },
      fps: this.perf.fps,
    };
  }

  exposeApi() {
    const app = this;
    const ws = app.workshop;
    const gv = app.galleryView;
    const api = {
      version: `${BUILD.version}-iteration-2`,
      build: BUILD,
      iteration: 2,
      schemaVersion: SCHEMA_VERSION,
      schemas: { pet: SCHEMA_VERSION, teach: TEACH_VERSION, gallery: GALLERY_VERSION },
      ready: false,
      learning: 'none: Iteration 2 adds teaching memory (stored demonstrations and labelled feedback) and an authored, seeded variation engine for the pet\'s attempts. No trainable parameters exist yet; genuine on-device learning arrives with Sleep Practice in Iteration 3.',
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
        get settled() { return app.studio?.rig.settled ?? true; },
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
      /** Teaching Workshop + teaching memory (replay buffer). Memory is not learning. */
      teach: {
        open: (tab) => { app.openFeature('teach'); if (tab) ws.setTab(tab); return ws.isOpen; },
        close: () => ws.close('api'),
        get isOpen() { return ws.isOpen; },
        get state() { return ws.state(); },
        setTab: (tab) => ws.setTab(tab),
        templates: {
          music: ['sunny-arp', 'bouncy-walk', 'starlight-lullaby', 'playful-hop'],
          drawing: ['star', 'heart', 'flower', 'sun', 'spiral'],
        },
        loadTemplate: (id) => ws.loadTemplate(id),
        stampShape: (id) => ws.useShape(id),
        setChromatic: (on) => ws.setChromatic(on),
        setBeats: (n) => ws.setBeats(n),
        setTempo: (bpm) => { ws.music.setTempo(bpm); ws._sync(); return ws.music.tempo; },
        playNote: (midi, vel) => ws.playNote(midi, { vel }),
        hit: (drum) => ws.hitDrum(drum),
        record: () => ws.toggleRecord(),
        preview: () => ws.togglePreview(),
        clear: () => (ws.tab === 'music' ? ws._command('clear-music') : ws._command('clear-draw')),
        undo: () => (ws.tab === 'music' ? ws._command('undo-music') : ws._command('undo-draw')),
        setPhrase: (phrase) => ws.setPhrase(phrase),
        setDrawing: (drawing) => ws.setDrawing(drawing),
        get phrase() { return ws.music.snapshot(); },
        get drawing() { return ws.drawing.drawing; },
        timelinePoint: (beat, midi, drum = false) => ws.timelinePoint(beat, midi, drum),
        /** Teaches the current draft (`kind` defaults to the open tab). */
        teach: (kind) => ws.teach(kind),
        /** Teaches a given phrase or drawing directly, bypassing the sheet. */
        teachData: (kind, data, meta) => app.teach(kind, data, meta),
        get memory() { return app.memory.snapshot(); },
        get lessons() { return app.memory.lessons.map((l) => ({ ...l })); },
        get prefs() { return { ...app.memory.prefs }; },
        get signals() { return app.memory.signals.map((s) => ({ ...s })); },
        engine: ENGINE_INFO,
        learning: 'none: lessons are stored examples; attempts come from the authored variation engine',
      },
      /** Creation Gallery (bounded, versioned history) and the studio wall frame. */
      gallery: {
        open: (filter) => { app.openFeature('gallery'); if (filter) gv.setFilter(filter); return gv.isOpen; },
        close: () => gv.close('api'),
        get isOpen() { return gv.isOpen; },
        get state() { return gv.state(); },
        get items() { return app.gallery.summaries(); },
        get: (id) => app.gallery.get(id),
        get counts() { return app.gallery.counts(); },
        get wall() { return app.gallery.wall; },
        get wallArt() { return app.studio?.wallArt ?? null; },
        limits: GALLERY_LIMITS,
        get bytes() { return app.gallery.bytes(); },
        filter: (f) => gv.setFilter(f),
        favorite: (id, on = true) => app.favoriteItem(id, on),
        remove: (id) => app.deleteItem(id),
        perform: (id) => app.performItem(id),
        hang: (id) => app.hangItem(id),
        unhang: () => app.unhangWall(),
        compare: (a, b) => { if (!gv.isOpen) app.openFeature('gallery'); return gv.compare(a, b); },
      },
      /** The Creation Feedback Bar and the creation currently in focus. */
      creation: {
        get bar() { const s = app.flow.barState(); return s.visible ? { ...s, data: undefined } : s; },
        get subject() { const s = app.flow.subject; return s ? { ref: s.ref, kind: s.kind, origin: s.origin, mode: s.mode, phase: s.phase, title: s.title, itemId: s.itemId ?? null, loved: !!s.loved, tags: [...(s.tags ?? [])] } : null; },
        love: () => app.feedback('love'),
        variation: () => app.feedback('variation'),
        nudge: (id) => app.feedback(id),
        dismiss: () => app.feedback('dismiss'),
      },
      save: () => { app.saveStores(); return app.save(); },
      reset: () => {
        app.resetting = true; // the reload's pagehide must not save the cleared pet again
        app.clearAllSaves();
        window.location.reload();
      },
      scene: app.studio,
      model: app.model,
    };
    this.api = api;
    window.__PET_STUDIO__ = api;
  }
}

const app = new App();
app.boot();
