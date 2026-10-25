/**
 * studio-scene.js: the cozy miniature studio diorama (Three.js).
 *
 * Warm cel-shaded room with soft shadows, wooden floorboards, pastel walls and
 * five interactive stations the pet walks to and uses (Music Corner, Drawing
 * Easel, Sleep Nook, Snack Bar, Bubble Bath), a gallery frame on the left wall
 * that shows the drawing hung from the Gallery (with a title plaque), all 22
 * playable keyboard keys, particles, a responsive camera rig with station
 * focus presets, and raycast picking of stations, frame and pet.
 * All geometry and textures are procedural and original.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { ROOM, STATIONS } from './studio-layout.js';
import { makeToonMaterial } from './toon.js';
import { ParticleSystem } from './particles.js';
import { DrawingSurface } from './drawing-surface.js';
import { drawIcon } from './canvas-icons.js';
import { paintDrawing } from './creation-render.js';

const TAU = Math.PI * 2;
const deg = (d) => (d * Math.PI) / 180;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const damp = (cur, target, lambda, dt) => cur + (target - cur) * (1 - Math.exp(-lambda * dt));

/** Camera presets exposed to the UI. */
export const CAMERA_VIEWS = Object.freeze([
  { id: 'overview', label: 'Overview', icon: 'home' },
  { id: 'pet', label: 'Pet Close-Up', icon: 'paw' },
  { id: 'music', label: 'Music Station', icon: 'music' },
  { id: 'easel', label: 'Easel', icon: 'draw' },
  { id: 'sleep', label: 'Sleep Nook', icon: 'sleep' },
]);

/** Extra camera presets used by the app (not shown in the view switcher). */
export const EXTRA_VIEWS = Object.freeze(['wall']);

/** White keys of the studio keyboard, C4..A5, matching the starter phrase range. */
export const KEYBOARD_MIDI = Object.freeze([60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81]);
/** Indices of the white keys each black key follows (C#, D#, F#, G#, A# in both octaves). */
const BLACK_AFTER = Object.freeze([0, 1, 3, 4, 5, 7, 8, 10, 11]);

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
function mesh(geo, mat, { pos, rot, scale, cast = true, receive = true } = {}) {
  const m = new THREE.Mesh(geo, mat);
  if (pos) m.position.set(...pos);
  if (rot) m.rotation.set(...rot);
  if (scale) (typeof scale === 'number' ? m.scale.setScalar(scale) : m.scale.set(...scale));
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}
const rbox = (w, h, d, r = 0.04, seg = 3) => new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2, h / 2, d / 2));

/** Cylinder spanning two points (legs, rails, poles). */
function limb(a, b, radius, mat, radialSegments = 10) {
  const va = new THREE.Vector3(...a);
  const vb = new THREE.Vector3(...b);
  const len = va.distanceTo(vb);
  const m = mesh(new THREE.CylinderGeometry(radius, radius, len, radialSegments), mat);
  m.position.copy(va).add(vb).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
  return m;
}

function canvasTexture(w, h, paint, { repeat = null, srgb = true } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  paint(canvas.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(canvas);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(...repeat);
  }
  return tex;
}

function seeded(seed) {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

// ---------------------------------------------------------------------------
// Procedural textures
// ---------------------------------------------------------------------------
function plankTexture() {
  return canvasTexture(1024, 1024, (ctx, S) => {
    const rand = seeded(11);
    const tones = ['#e0aa71', '#d8a067', '#e4b27d', '#d39a5f', '#dcaa74', '#e7b886'];
    const rows = 8;
    const rowH = S / rows;
    for (let r = 0; r < rows; r++) {
      let x = -rand() * S * 0.5;
      while (x < S) {
        const len = S * (0.38 + rand() * 0.4);
        ctx.fillStyle = tones[Math.floor(rand() * tones.length)];
        ctx.fillRect(x, r * rowH, len, rowH);
        ctx.strokeStyle = 'rgba(140, 86, 40, 0.13)';
        ctx.lineWidth = 2;
        for (let g = 0; g < 4; g++) {
          const gy = r * rowH + rowH * (0.18 + rand() * 0.64);
          ctx.beginPath();
          ctx.moveTo(x, gy);
          ctx.bezierCurveTo(x + len * 0.3, gy + (rand() - 0.5) * 10, x + len * 0.7, gy + (rand() - 0.5) * 10, x + len, gy);
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(120, 70, 30, 0.45)';
        ctx.fillRect(x, r * rowH, 3, rowH);
        x += len;
      }
      ctx.fillStyle = 'rgba(120, 70, 30, 0.5)';
      ctx.fillRect(0, r * rowH, S, 3);
    }
  }, { repeat: [1, 1] });
}

function wallpaperTexture(base, dot, stripe, repeat) {
  return canvasTexture(256, 256, (ctx, S) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = stripe;
    for (let x = 0; x < S; x += 64) ctx.fillRect(x + 28, 0, 8, S);
    ctx.fillStyle = dot;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        ctx.beginPath();
        ctx.arc(x * 64 + (y % 2 ? 0 : 32), y * 64 + 32, 7, 0, TAU);
        ctx.fill();
      }
    }
  }, { repeat });
}

function ringRugTexture(rings, dotColor) {
  return canvasTexture(512, 512, (ctx, S) => {
    const c = S / 2;
    rings.forEach((col, i) => {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(c, c, c * (1 - i / rings.length) - (i ? 0 : 0), 0, TAU);
      ctx.fill();
    });
    ctx.fillStyle = dotColor;
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * TAU;
      ctx.beginPath();
      ctx.arc(c + Math.cos(a) * c * 0.9, c + Math.sin(a) * c * 0.9, 7, 0, TAU);
      ctx.fill();
    }
  });
}

function skyTexture() {
  return canvasTexture(256, 256, (ctx, S) => {
    const g = ctx.createLinearGradient(0, 0, 0, S);
    g.addColorStop(0, '#8fcaf2');
    g.addColorStop(0.65, '#cfe8f7');
    g.addColorStop(1, '#ffe2cc');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    for (const [x, y, r] of [[60, 70, 22], [84, 62, 26], [108, 72, 20], [176, 120, 16], [196, 112, 20], [214, 122, 14]]) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    }
  });
}

function nightSkyTexture() {
  return canvasTexture(256, 200, (ctx, W, H) => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#3d3f8f');
    g.addColorStop(1, '#7a6cc9');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    drawIcon(ctx, 'sleep', 92, 92, 110);
    const rand = seeded(5);
    for (let i = 0; i < 14; i++) drawIcon(ctx, 'sparkle', 20 + rand() * (W - 40), 16 + rand() * (H - 32), 10 + rand() * 12);
  });
}

function posterTexture() {
  return canvasTexture(200, 256, (ctx, W, H) => {
    ctx.fillStyle = '#fff1d6';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#ffc2d1';
    ctx.beginPath();
    ctx.arc(W / 2, H * 0.45, 70, 0, TAU);
    ctx.fill();
    drawIcon(ctx, 'note', W / 2, H * 0.45, 120);
    for (const [x, y] of [[34, 40], [166, 60], [40, 200], [160, 214]]) drawIcon(ctx, 'sparkle', x, y, 26);
  });
}

function signTexture() {
  return canvasTexture(256, 320, (ctx, W, H) => {
    ctx.fillStyle = '#3f4b46';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 6;
    ctx.strokeRect(14, 14, W - 28, H - 28);
    ctx.fillStyle = '#fff6e6';
    ctx.font = 'bold 54px ui-rounded, "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('SNACKS', W / 2, 92);
    drawIcon(ctx, 'food', W / 2 - 50, 190, 80);
    drawIcon(ctx, 'heart', W / 2 + 52, 196, 64);
  });
}

function bathMatTexture() {
  return canvasTexture(128, 256, (ctx, W, H) => {
    ctx.fillStyle = '#ffc9d6';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#ffb0c4';
    for (let y = 8; y < H; y += 20) ctx.fillRect(0, y, W, 8);
  });
}

/** Shared toon palette for the room (a handful of materials keeps draw state cheap). */
function makePalette(maxAniso) {
  const floorMap = plankTexture();
  floorMap.anisotropy = maxAniso;
  const backPaper = wallpaperTexture('#f8dccf', '#fff3ec', 'rgba(255,255,255,0.22)', [8, 3.4]);
  const leftPaper = wallpaperTexture('#d8eedf', '#f4fcf7', 'rgba(255,255,255,0.24)', [8, 3.4]);
  for (const t of [backPaper, leftPaper]) t.anisotropy = Math.min(8, maxAniso);
  const T = (color, extra = {}) => makeToonMaterial({ color, steps: 4, rim: 0.06, ...extra });
  return {
    floor: T('#ffffff', { map: floorMap, rim: 0 }),
    base: T('#a8704a'),
    baseTop: T('#c58a5c'),
    backWall: T('#ffffff', { map: backPaper, rim: 0 }),
    leftWall: T('#ffffff', { map: leftPaper, rim: 0 }),
    wallCap: T('#fff4ea'),
    backWainscot: T('#f1bfae'),
    leftWainscot: T('#b5dcc6'),
    trim: T('#fff7ef'),
    wood: T('#c98b5e', { rim: 0.1 }),
    woodLight: T('#e3b27a', { rim: 0.1 }),
    cream: T('#fff6ea'),
    white: T('#ffffff', { rim: 0.12, gloss: 0.2 }),
    ink: T('#3a3046'),
    curtain: T('#f6a9bf', { side: THREE.DoubleSide }),
    leaf: T('#6cc48a', { rim: 0.12 }),
    leafDark: T('#4faa72', { rim: 0.12 }),
    terracotta: T('#e08a5f'),
    soil: T('#7a5236'),
    lavender: T('#bba7f2', { rim: 0.12 }),
    lavenderSoft: T('#d9cdfb'),
    teal: T('#7cc7d4', { rim: 0.14, gloss: 0.25 }),
    coral: T('#ff9f9f', { rim: 0.12 }),
    peach: T('#ffc7a6'),
    mint: T('#9fdccf', { rim: 0.14, gloss: 0.3 }),
    water: T('#a8def7', { rim: 0.2, gloss: 0.5 }),
    foam: T('#ffffff', { rim: 0.25 }),
    gold: T('#f1c35d', { rim: 0.18, gloss: 0.45 }),
    silver: T('#cfd3de', { rim: 0.2, gloss: 0.5 }),
    yellow: T('#ffd84d', { rim: 0.15, gloss: 0.4 }),
    orange: T('#ffa94d', { rim: 0.12 }),
    red: T('#ff6b6b', { rim: 0.12, gloss: 0.35 }),
    kibble: T('#f6c27a'),
    glass: makeToonMaterial({ color: '#d8f1ff', steps: 4, rim: 0.3, transparent: true, opacity: 0.45, depthWrite: false }),
    canvasBoard: T('#f7efe4'),
    lampGlow: makeToonMaterial({ color: '#ffd59a', steps: 2, rim: 0, emissive: '#ffb055', emissiveIntensity: 0.6 }),
    led: makeToonMaterial({ color: '#7dffcf', steps: 2, rim: 0, emissive: '#3dffb5', emissiveIntensity: 0.2 }),
    sky: new THREE.MeshBasicMaterial({ map: skyTexture() }),
    night: T('#ffffff', { map: nightSkyTexture(), rim: 0 }),
    poster: T('#ffffff', { map: posterTexture(), rim: 0 }),
    sign: T('#ffffff', { map: signTexture(), rim: 0 }),
    bathMat: T('#ffffff', { map: bathMatTexture(), rim: 0 }),
    rug: T('#ffffff', { map: ringRugTexture(['#ffb3c1', '#fff3e0', '#ffc9a8', '#fff3e0', '#b7e4cf'], '#fff7ee'), rim: 0 }),
    stageRug: T('#ffffff', { map: ringRugTexture(['#b9a6f0', '#e6defd', '#cbbcf7', '#efe9ff'], '#ffffff'), rim: 0 }),
  };
}

// ---------------------------------------------------------------------------
// Room shell
// ---------------------------------------------------------------------------
function buildRoom(P) {
  const H = ROOM.half;
  const WH = ROOM.wallHeight;
  const WT = ROOM.wallThickness;
  const FT = ROOM.floorThickness;
  const g = new THREE.Group();
  g.name = 'room';
  P.floor.map.repeat.set(1.6, 1.6);

  g.add(mesh(new THREE.BoxGeometry(2 * H, 0.06, 2 * H), P.floor, { pos: [0, -0.03, 0], cast: false }));
  g.add(mesh(rbox(2 * H + 0.34, FT, 2 * H + 0.34, 0.1), P.base, { pos: [-0.04, -0.06 - FT / 2, -0.04], cast: false }));
  g.add(mesh(rbox(2 * H + 0.36, 0.07, 2 * H + 0.36, 0.03), P.baseTop, { pos: [-0.04, -0.1, -0.04], cast: false }));

  const cap = P.wallCap;
  const back = mesh(new THREE.BoxGeometry(2 * H + WT, WH, WT), [cap, cap, cap, cap, P.backWall, cap], { pos: [-WT / 2, WH / 2, -H - WT / 2] });
  const left = mesh(new THREE.BoxGeometry(WT, WH, 2 * H), [P.leftWall, cap, cap, cap, cap, cap], { pos: [-H - WT / 2, WH / 2, 0] });
  g.add(back, left);
  g.add(mesh(new THREE.BoxGeometry(2 * H, 0.9, 0.035), P.backWainscot, { pos: [0, 0.45, -H + 0.018] }));
  g.add(mesh(new THREE.BoxGeometry(0.035, 0.9, 2 * H), P.leftWainscot, { pos: [-H + 0.018, 0.45, 0] }));
  g.add(mesh(rbox(2 * H, 0.06, 0.07, 0.02), P.trim, { pos: [0, 0.9, -H + 0.035] }));
  g.add(mesh(rbox(0.07, 0.06, 2 * H, 0.02), P.trim, { pos: [-H + 0.035, 0.9, 0] }));
  g.add(mesh(new THREE.BoxGeometry(2 * H, 0.1, 0.05), P.trim, { pos: [0, 0.05, -H + 0.025] }));
  g.add(mesh(new THREE.BoxGeometry(0.05, 0.1, 2 * H), P.trim, { pos: [-H + 0.025, 0.05, 0] }));

  // Window with curtains on the back wall.
  const wx = -0.6;
  const wy = 1.62;
  const wz = -H;
  g.add(mesh(new THREE.PlaneGeometry(1.18, 0.88), P.sky, { pos: [wx, wy, wz + 0.012], cast: false, receive: false }));
  for (const [w, h, x, y] of [[1.32, 0.09, 0, 0.5], [1.32, 0.09, 0, -0.5], [0.09, 1.0, 0.62, 0], [0.09, 1.0, -0.62, 0]]) {
    g.add(mesh(rbox(w, h, 0.08, 0.025), P.trim, { pos: [wx + x, wy + y, wz + 0.04] }));
  }
  g.add(mesh(new THREE.BoxGeometry(0.04, 0.88, 0.03), P.trim, { pos: [wx, wy, wz + 0.03] }));
  g.add(mesh(new THREE.BoxGeometry(1.18, 0.04, 0.03), P.trim, { pos: [wx, wy, wz + 0.03] }));
  g.add(mesh(rbox(1.5, 0.06, 0.2, 0.025), P.trim, { pos: [wx, 1.1, wz + 0.1] }));
  g.add(mesh(new THREE.CylinderGeometry(0.07, 0.055, 0.1, 14), P.terracotta, { pos: [wx + 0.38, 1.18, wz + 0.1] }));
  for (let i = 0; i < 3; i++) {
    g.add(mesh(new THREE.SphereGeometry(0.05, 10, 8), P.leaf, { pos: [wx + 0.38 + (i - 1) * 0.035, 1.27, wz + 0.1], scale: [0.6, 1.4, 0.6], rot: [0, 0, (i - 1) * 0.5] }));
  }
  g.add(limb([wx - 0.85, 2.24, wz + 0.13], [wx + 0.85, 2.24, wz + 0.13], 0.022, P.gold));
  for (const side of [-1, 1]) {
    g.add(mesh(new THREE.SphereGeometry(0.04, 12, 10), P.gold, { pos: [wx + side * 0.87, 2.24, wz + 0.13] }));
    const geo = new THREE.PlaneGeometry(0.42, 1.3, 18, 1);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.sin(pos.getX(i) * 38) * 0.035);
    geo.computeVertexNormals();
    g.add(mesh(geo, P.curtain, { pos: [wx + side * 0.73, 1.57, wz + 0.11], receive: false }));
  }

  // Potted plant in the back-right corner.
  const plant = new THREE.Group();
  plant.position.set(H - 0.38, 0, -H + 0.38);
  plant.add(mesh(new THREE.CylinderGeometry(0.2, 0.15, 0.34, 20), P.terracotta, { pos: [0, 0.17, 0] }));
  plant.add(mesh(new THREE.TorusGeometry(0.2, 0.025, 8, 24), P.terracotta, { pos: [0, 0.34, 0], rot: [Math.PI / 2, 0, 0] }));
  plant.add(mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.02, 18), P.soil, { pos: [0, 0.33, 0], cast: false }));
  for (let i = 0; i < 8; i++) {
    const stem = new THREE.Group();
    stem.position.y = 0.33;
    stem.rotation.set(0.42 + (i % 2) * 0.18, (i / 8) * TAU, 0, 'YXZ');
    stem.add(mesh(new THREE.SphereGeometry(0.1, 12, 10), i % 2 ? P.leafDark : P.leaf, { pos: [0, 0.26, 0], scale: [0.55, 2.5, 0.22] }));
    plant.add(stem);
  }
  g.add(plant);

  // Pictures: a music poster, a night-sky print by the bed, and the latest drawing.
  g.add(mesh(rbox(0.6, 0.76, 0.04, 0.02), P.wood, { pos: [1.25, 1.86, -H + 0.022] }));
  g.add(mesh(new THREE.PlaneGeometry(0.5, 0.66), P.poster, { pos: [1.25, 1.86, -H + 0.046], cast: false }));
  g.add(mesh(rbox(0.04, 0.6, 0.76, 0.02), P.wood, { pos: [-H + 0.022, 1.88, -2.15] }));
  g.add(mesh(new THREE.PlaneGeometry(0.66, 0.5), P.night, { pos: [-H + 0.046, 1.88, -2.15], rot: [0, Math.PI / 2, 0], cast: false }));

  // Gallery wall frame: shows the drawing hung from the Gallery (or the latest one).
  const creationCanvas = document.createElement('canvas');
  creationCanvas.width = 512;
  creationCanvas.height = 512;
  const creationTexture = new THREE.CanvasTexture(creationCanvas);
  creationTexture.colorSpace = THREE.SRGBColorSpace;
  creationTexture.anisotropy = 4;
  const plaqueCanvas = document.createElement('canvas');
  plaqueCanvas.width = 512;
  plaqueCanvas.height = 96;
  const plaqueTexture = new THREE.CanvasTexture(plaqueCanvas);
  plaqueTexture.colorSpace = THREE.SRGBColorSpace;
  const frame = new THREE.Group();
  frame.name = 'gallery-frame';
  frame.userData.pickId = 'frame';
  frame.add(mesh(rbox(0.05, 0.84, 0.84, 0.025), P.woodLight, { pos: [-H + 0.025, 1.72, 1.0] }));
  frame.add(mesh(new THREE.PlaneGeometry(0.72, 0.72), makeToonMaterial({ color: '#ffffff', map: creationTexture, steps: 4, rim: 0 }), {
    pos: [-H + 0.054, 1.72, 1.0], rot: [0, Math.PI / 2, 0], cast: false,
  }));
  const plaque = new THREE.Group();
  plaque.add(mesh(rbox(0.03, 0.1, 0.52, 0.012), P.gold, { pos: [-H + 0.02, 1.2, 1.0] }));
  plaque.add(mesh(new THREE.PlaneGeometry(0.48, 0.084), makeToonMaterial({ color: '#ffffff', map: plaqueTexture, steps: 4, rim: 0 }), {
    pos: [-H + 0.037, 1.2, 1.0], rot: [0, Math.PI / 2, 0], cast: false,
  }));
  const rosette = new THREE.Group();
  rosette.position.set(-H + 0.07, 2.12, 1.36);
  rosette.add(mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.02, 20), P.coral, { rot: [0, 0, Math.PI / 2] }));
  rosette.add(mesh(new THREE.SphereGeometry(0.028, 12, 10), P.gold, { pos: [0.012, 0, 0] }));
  rosette.add(mesh(new THREE.BoxGeometry(0.012, 0.09, 0.025), P.coral, { pos: [0, -0.07, -0.015], rot: [0.25, 0, 0] }));
  rosette.add(mesh(new THREE.BoxGeometry(0.012, 0.09, 0.025), P.coral, { pos: [0, -0.07, 0.015], rot: [-0.25, 0, 0] }));
  plaque.visible = false;
  rosette.visible = false;
  frame.add(plaque, rosette);
  g.add(frame);
  const creation = {
    canvas: creationCanvas, ctx: creationCanvas.getContext('2d'), texture: creationTexture,
    plaque, rosette, plaqueCtx: plaqueCanvas.getContext('2d'), plaqueTexture, frame,
  };

  // Wall clock showing the real local time.
  const clock = new THREE.Group();
  clock.position.set(2.42, 1.95, -H + 0.03);
  clock.add(mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.05, 32), P.cream, { rot: [Math.PI / 2, 0, 0] }));
  clock.add(mesh(new THREE.TorusGeometry(0.24, 0.03, 8, 32), P.coral, { pos: [0, 0, 0.02] }));
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    clock.add(mesh(new THREE.SphereGeometry(i % 3 ? 0.011 : 0.018, 8, 6), P.ink, { pos: [Math.sin(a) * 0.19, Math.cos(a) * 0.19, 0.03], cast: false }));
  }
  const hands = {};
  for (const [name, len, w] of [['hour', 0.12, 0.028], ['minute', 0.18, 0.02]]) {
    const pivot = new THREE.Group();
    pivot.position.z = name === 'hour' ? 0.034 : 0.04;
    pivot.add(mesh(new THREE.BoxGeometry(w, len, 0.01), P.ink, { pos: [0, len / 2 - 0.02, 0], cast: false }));
    clock.add(pivot);
    hands[name] = pivot;
  }
  clock.add(mesh(new THREE.SphereGeometry(0.022, 10, 8), P.coral, { pos: [0, 0, 0.05], cast: false }));
  g.add(clock);

  const rug = mesh(new THREE.CircleGeometry(1.22, 64), P.rug, { pos: [STATIONS.rug.center.x, 0.006, STATIONS.rug.center.z], rot: [-Math.PI / 2, 0, 0], cast: false });
  P.rug.polygonOffset = true;
  P.rug.polygonOffsetFactor = -2;
  g.add(rug);

  return { group: g, hands, creation };
}

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------
function stationGroup(id, center, yaw = 0) {
  const g = new THREE.Group();
  g.name = `station-${id}`;
  g.position.set(center.x, 0, center.z);
  g.rotation.y = yaw;
  g.userData.pickId = `station:${id}`;
  return g;
}

/** Music Corner: a mini synth on an X-stand facing the audience, plus speakers. */
function buildMusicCorner(P) {
  const st = STATIONS.music;
  const g = stationGroup('music', st.center, st.facing);
  P.stageRug.polygonOffset = true;
  P.stageRug.polygonOffsetFactor = -2;
  g.add(mesh(new THREE.CircleGeometry(1, 48), P.stageRug, { pos: [0, 0.007, -0.3], rot: [-Math.PI / 2, 0, 0], scale: [1.3, 0.9, 1], cast: false }));
  for (const sx of [-0.5, 0.5]) {
    g.add(limb([sx, 0.03, -0.22], [sx, 0.57, 0.16], 0.024, P.ink));
    g.add(limb([sx, 0.03, 0.16], [sx, 0.57, -0.22], 0.024, P.ink));
    g.add(mesh(rbox(0.06, 0.04, 0.5, 0.015), P.ink, { pos: [sx, 0.02, -0.03] }));
  }
  g.add(mesh(rbox(1.36, 0.1, 0.44, 0.035), P.teal, { pos: [0, 0.62, 0] }));
  // The player stands at local -z facing +z, so low notes sit on its left (+x).
  const keys = KEYBOARD_MIDI.map((midi, i) => {
    const k = mesh(rbox(0.086, 0.035, 0.27, 0.01, 2), P.white, { pos: [0.564 - i * 0.094, 0.685, -0.05] });
    k.userData.baseY = 0.685;
    k.userData.press = 0;
    k.userData.tip = new THREE.Vector3(0, 0.03, -0.04);
    g.add(k);
    return k;
  });
  // Black keys press too, so chromatic lessons are played on real keys.
  const blackKeys = BLACK_AFTER.map((i) => {
    const k = mesh(rbox(0.05, 0.03, 0.15, 0.008, 2), P.ink, { pos: [0.564 - (i + 0.5) * 0.094, 0.712, 0.02] });
    k.userData.baseY = 0.712;
    k.userData.press = 0;
    k.userData.tip = new THREE.Vector3(0, 0.025, 0.0);
    g.add(k);
    return k;
  });
  const keyByMidi = new Map(KEYBOARD_MIDI.map((m, i) => [m, keys[i]]));
  BLACK_AFTER.forEach((i, j) => keyByMidi.set(KEYBOARD_MIDI[i] + 1, blackKeys[j]));
  const allKeys = [...keys, ...blackKeys];
  g.add(mesh(rbox(1.2, 0.03, 0.08, 0.012), P.ink, { pos: [0, 0.68, 0.17] }));
  [P.coral, P.yellow, P.lavender, P.mint].forEach((m, j) => {
    g.add(mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.03, 12), m, { pos: [0.4 - j * 0.11, 0.71, 0.17] }));
  });
  const leds = [-0.36, -0.46].map((x) => {
    const led = mesh(new THREE.SphereGeometry(0.018, 10, 8), P.led, { pos: [x, 0.705, 0.17], cast: false });
    g.add(led);
    return led;
  });

  // Speakers stand against the back wall (separate group, same pick id).
  const speakers = new THREE.Group();
  speakers.name = 'station-music-speakers';
  speakers.userData.pickId = 'station:music';
  const woofers = [];
  for (const [x, yaw] of [[0.18, 0.18], [2.42, -0.18]]) {
    const s = new THREE.Group();
    s.position.set(x, 0, -ROOM.half + 0.3);
    s.rotation.y = yaw;
    s.add(mesh(rbox(0.3, 0.12, 0.26, 0.03), P.ink, { pos: [0, 0.06, 0] }));
    s.add(mesh(rbox(0.44, 0.66, 0.36, 0.06), P.lavender, { pos: [0, 0.45, 0] }));
    const woofer = new THREE.Group();
    woofer.position.set(0, 0.36, 0.185);
    woofer.add(mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.03, 24), P.ink, { rot: [Math.PI / 2, 0, 0] }));
    woofer.add(mesh(new THREE.TorusGeometry(0.13, 0.018, 8, 24), P.cream, { pos: [0, 0, 0.012] }));
    woofer.add(mesh(new THREE.SphereGeometry(0.045, 12, 8), P.lavenderSoft, { pos: [0, 0, 0.012], scale: [1, 1, 0.5] }));
    s.add(woofer);
    s.add(mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.03, 16), P.ink, { pos: [0, 0.63, 0.185], rot: [Math.PI / 2, 0, 0] }));
    s.add(mesh(new THREE.TorusGeometry(0.055, 0.012, 6, 16), P.cream, { pos: [0, 0.63, 0.198] }));
    speakers.add(s);
    woofers.push(woofer);
  }

  let pulse = 0;
  let glow = 0;
  return {
    id: 'music',
    groups: [g, speakers],
    keyIndex(midi) {
      const i = KEYBOARD_MIDI.indexOf(midi);
      return i >= 0 ? i : 6;
    },
    /** The key mesh for any MIDI note on the keyboard (white or black). */
    keyFor(midi) {
      return keyByMidi.get(midi) ?? keys[this.keyIndex(midi)];
    },
    /** World position of a key's top surface (arm target). */
    keyWorld(midi, target = new THREE.Vector3()) {
      const k = this.keyFor(midi);
      return k.localToWorld(target.copy(k.userData.tip));
    },
    /** Arm that plays a key: 0 = pet's left (low notes, up to A#4), 1 = right. */
    armFor(midi) {
      return midi <= 70 ? 0 : 1;
    },
    speakerTop(i, target = new THREE.Vector3()) {
      return woofers[i % 2].localToWorld(target.set(0, 0.42, 0.05));
    },
    press(midi) {
      this.keyFor(midi).userData.press = 1;
      pulse = 1;
    },
    pulseSpeakers(amount = 1) {
      pulse = Math.max(pulse, amount);
    },
    update(dt, { active, listening }) {
      for (const k of allKeys) {
        k.userData.press = Math.max(0, k.userData.press - dt * 7);
        k.position.y = k.userData.baseY - k.userData.press * 0.014;
      }
      pulse = Math.max(0, pulse - dt * 5);
      for (const w of woofers) w.scale.setScalar(1 + pulse * 0.16);
      glow = damp(glow, active || listening ? 1 : 0, 4, dt);
      P.led.emissiveIntensity = 0.15 + glow * (1.1 + Math.sin(performance.now() / 160) * 0.25);
    },
  };
}

/** Drawing Easel: A-frame easel whose canvas is a live texture of the pet's drawing. */
function buildEasel(P, maxAniso) {
  const st = STATIONS.easel;
  const g = stationGroup('easel', st.center, st.canvasYaw);
  g.add(limb([-0.36, 0, 0.2], [-0.03, 1.66, 0.02], 0.028, P.wood));
  g.add(limb([0.36, 0, 0.2], [0.03, 1.66, 0.02], 0.028, P.wood));
  g.add(limb([0, 0, -0.5], [0, 1.58, -0.02], 0.026, P.wood));
  g.add(mesh(rbox(0.92, 0.05, 0.13, 0.02), P.wood, { pos: [0, 0.6, 0.17] }));
  const board = new THREE.Group();
  board.position.set(0, 1.04, 0.14);
  board.rotation.x = -0.09;
  g.add(board);
  board.add(mesh(rbox(0.86, 0.86, 0.035, 0.012), P.canvasBoard));
  const surface = new DrawingSurface(512);
  const texture = new THREE.CanvasTexture(surface.canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, maxAniso);
  const paper = mesh(new THREE.PlaneGeometry(0.8, 0.8), makeToonMaterial({ color: '#ffffff', map: texture, steps: 4, rim: 0 }), {
    pos: [0, 0, 0.019], cast: false,
  });
  board.add(paper);
  board.add(mesh(rbox(0.3, 0.06, 0.07, 0.02), P.wood, { pos: [0, 0.45, 0.01] }));

  // Little stool with a brush jar and paint pots (on the side away from the painter).
  const stool = new THREE.Group();
  stool.position.set(-0.78, 0, 0.28);
  stool.add(mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.05, 20), P.woodLight, { pos: [0, 0.42, 0] }));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + 0.4;
    stool.add(limb([Math.cos(a) * 0.15, 0, Math.sin(a) * 0.15], [Math.cos(a) * 0.09, 0.41, Math.sin(a) * 0.09], 0.018, P.wood));
  }
  stool.add(mesh(new THREE.CylinderGeometry(0.06, 0.055, 0.15, 16), P.glass, { pos: [-0.05, 0.52, 0], cast: false }));
  [['#ff7fa3', -0.03], ['#55b8ec', 0], ['#ffbf3f', 0.03]].forEach(([c, dx], i) => {
    stool.add(limb([-0.05 + dx, 0.47, dx], [-0.05 + dx * 2.2, 0.72, dx * 1.5 + (i - 1) * 0.02], 0.009, P.wood, 6));
    stool.add(mesh(new THREE.SphereGeometry(0.018, 8, 6), makeToonMaterial({ color: c, rim: 0.1 }), { pos: [-0.05 + dx * 2.2, 0.73, dx * 1.5 + (i - 1) * 0.02], scale: [1, 1.6, 1] }));
  });
  ['#9a7bff', '#6ccf7f', '#ff8a4c'].forEach((c, i) => {
    stool.add(mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.05, 12), makeToonMaterial({ color: c, rim: 0.12 }), { pos: [0.08, 0.47, -0.08 + i * 0.075] }));
  });
  g.add(stool);

  let uploadTimer = 0;
  return {
    id: 'easel',
    groups: [g],
    surface,
    texture,
    paper,
    /** World position of the brush tip on the canvas, or null when not painting. */
    penWorld(target = new THREE.Vector3()) {
      const pen = surface.pen;
      if (!pen) return null;
      return paper.localToWorld(target.set((pen.u - 0.5) * 0.8, (0.5 - pen.v) * 0.8, 0.02));
    },
    centerWorld(target = new THREE.Vector3()) {
      return paper.localToWorld(target.set(0, 0, 0.02));
    },
    update(dt) {
      uploadTimer -= dt;
      if (surface.changed && uploadTimer <= 0) {
        texture.needsUpdate = true; // throttled uploads keep mobile GPUs happy
        surface.changed = false;
        uploadTimer = 1 / 24;
      }
    },
  };
}

/** Sleep Nook: round cushion bed, pillow, folded blanket and a mushroom nightlight. */
function buildSleepNook(P) {
  const st = STATIONS.bed;
  const g = stationGroup('bed', st.center);
  g.add(mesh(new THREE.CylinderGeometry(0.84, 0.88, 0.14, 40), P.wood, { pos: [0, 0.07, 0] }));
  g.add(mesh(new THREE.TorusGeometry(0.72, 0.17, 16, 48), P.lavender, { pos: [0, 0.22, 0], rot: [Math.PI / 2, 0, 0] }));
  g.add(mesh(new THREE.CylinderGeometry(0.74, 0.74, 0.12, 40), P.cream, { pos: [0, 0.18, 0] }));
  g.add(mesh(rbox(0.5, 0.13, 0.3, 0.06), P.white, { pos: [-0.26, 0.31, -0.3], rot: [0, 0.75, 0.08] }));
  g.add(mesh(rbox(0.62, 0.05, 0.3, 0.02), P.peach, { pos: [0.22, 0.27, 0.42], rot: [0, -0.55, 0.03] }));

  const lamp = new THREE.Group();
  lamp.position.set(-2.95 - st.center.x, 0, -1.15 - st.center.z);
  lamp.add(mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.36, 14), P.cream, { pos: [0, 0.18, 0] }));
  lamp.add(mesh(new THREE.SphereGeometry(0.24, 24, 12, 0, TAU, 0, Math.PI / 2), P.lampGlow, { pos: [0, 0.34, 0], scale: [1, 0.75, 1] }));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU + 0.3;
    const r = i % 2 ? 0.15 : 0.12;
    lamp.add(mesh(new THREE.SphereGeometry(0.028, 8, 6), P.white, { pos: [Math.cos(a) * r, 0.34 + 0.75 * Math.sqrt(0.0576 - r * r), Math.sin(a) * r], cast: false }));
  }
  const light = new THREE.PointLight(0xffb36b, 0.8, 4.2, 1.6);
  light.position.set(0.1, 0.5, 0.1);
  lamp.add(light);
  g.add(lamp);

  let night = 0;
  return {
    id: 'bed',
    groups: [g],
    light,
    get night() {
      return night;
    },
    update(dt, { sleeping }) {
      night = damp(night, sleeping ? 1 : 0, 1.5, dt);
      light.intensity = 0.8 + night * 3.2;
      P.lampGlow.emissiveIntensity = 0.55 + night * 1.2;
    },
  };
}

/** Snack Bar: little round table with a food bowl, fruit, a cookie jar and a sign. */
function buildSnackBar(P) {
  const st = STATIONS.food;
  const g = stationGroup('food', st.center);
  g.add(mesh(new THREE.CylinderGeometry(0.52, 0.5, 0.06, 36), P.woodLight, { pos: [0, 0.57, 0] }));
  g.add(mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.52, 12), P.wood, { pos: [0, 0.29, 0] }));
  g.add(mesh(new THREE.CylinderGeometry(0.28, 0.3, 0.04, 24), P.wood, { pos: [0, 0.02, 0] }));

  const dir = new THREE.Vector2(st.anchor.x - st.center.x, st.anchor.z - st.center.z).normalize();
  const bowl = new THREE.Group();
  bowl.position.set(dir.x * 0.25, 0.6, dir.y * 0.25);
  g.add(bowl);
  bowl.add(mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.012, 28), P.coral, { pos: [0, 0.006, 0], cast: false }));
  const prof = [[0.001, 0.012], [0.11, 0.012], [0.16, 0.04], [0.19, 0.12], [0.175, 0.125], [0.15, 0.06], [0.1, 0.035], [0.001, 0.035]]
    .map(([x, y]) => new THREE.Vector2(x, y));
  bowl.add(mesh(new THREE.LatheGeometry(prof, 32), P.white));
  const food = new THREE.Group();
  food.position.y = 0.065;
  bowl.add(food);
  food.add(mesh(new THREE.SphereGeometry(0.14, 20, 12), P.kibble, { scale: [1, 0.42, 1] }));
  [[0.04, 0.02, P.red], [-0.05, 0.03, P.lavender], [0.01, -0.05, P.red], [-0.02, 0.07, P.orange]].forEach(([x, z, m]) => {
    food.add(mesh(new THREE.SphereGeometry(0.026, 10, 8), m, { pos: [x, 0.055, z], cast: false }));
  });

  g.add(mesh(new THREE.SphereGeometry(0.075, 16, 12), P.red, { pos: [0.16, 0.665, -0.24] }));
  g.add(limb([0.16, 0.73, -0.24], [0.17, 0.78, -0.24], 0.008, P.wood, 6));
  g.add(mesh(new THREE.SphereGeometry(0.03, 8, 6), P.leaf, { pos: [0.2, 0.765, -0.24], scale: [1.4, 0.5, 0.8] }));
  g.add(mesh(new THREE.SphereGeometry(0.066, 16, 12), P.orange, { pos: [0.02, 0.66, -0.33] }));
  const jar = new THREE.Group();
  jar.position.set(0.3, 0.6, 0.06);
  jar.add(mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.22, 20), P.glass, { pos: [0, 0.11, 0], cast: false }));
  jar.add(mesh(new THREE.CylinderGeometry(0.106, 0.106, 0.03, 20), P.coral, { pos: [0, 0.235, 0] }));
  jar.add(mesh(new THREE.SphereGeometry(0.028, 10, 8), P.coral, { pos: [0, 0.262, 0] }));
  for (let i = 0; i < 3; i++) {
    jar.add(mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.022, 16), P.kibble, { pos: [0, 0.03 + i * 0.045, 0], rot: [0.2 * (i - 1), 0, 0.15], cast: false }));
  }
  g.add(jar);

  const sign = new THREE.Group();
  sign.position.set(0.65, 0, 1.0);
  sign.rotation.y = 0.5;
  for (const tilt of [0.22, -0.22]) {
    sign.add(mesh(rbox(0.44, 0.58, 0.03, 0.015), P.wood, { pos: [0, 0.28, tilt * 0.4], rot: [tilt, 0, 0] }));
  }
  sign.add(mesh(new THREE.PlaneGeometry(0.36, 0.48), P.sign, { pos: [0, 0.28, 0.11], rot: [0.22, 0, 0], cast: false }));
  g.add(sign);

  let amount = 1;
  return {
    id: 'food',
    groups: [g],
    bowlWorld(target = new THREE.Vector3()) {
      return bowl.localToWorld(target.set(0, 0.12, 0));
    },
    update(dt, { eating }) {
      amount = clamp(amount + (eating ? -0.1 : 0.05) * dt, 0.25, 1);
      const s = Math.sqrt(amount);
      food.scale.set(0.55 + 0.45 * s, amount, 0.55 + 0.45 * s);
    },
  };
}

/** Bubble Bath: clawfoot tub with foam, a faucet, a rubber duck and a bath mat. */
function buildBath(P) {
  const st = STATIONS.bath;
  const g = stationGroup('bath', st.center);
  const prof = [[0.001, 0.12], [0.36, 0.12], [0.47, 0.16], [0.53, 0.3], [0.545, 0.6], [0.54, 0.64], [0.49, 0.64], [0.48, 0.34], [0.4, 0.23], [0.001, 0.23]]
    .map(([x, y]) => new THREE.Vector2(x, y));
  g.add(mesh(new THREE.LatheGeometry(prof, 48), P.mint, { scale: [1.5, 1, 1] }));
  g.add(mesh(new THREE.TorusGeometry(0.515, 0.04, 10, 48), P.white, { pos: [0, 0.645, 0], rot: [Math.PI / 2, 0, 0], scale: [1.5, 1, 1] }));
  for (const [x, z] of [[-0.58, -0.27], [0.58, -0.27], [-0.58, 0.27], [0.58, 0.27]]) {
    g.add(mesh(new THREE.SphereGeometry(0.065, 12, 10), P.gold, { pos: [x, 0.07, z], scale: [1, 0.9, 1] }));
  }
  const water = mesh(new THREE.CircleGeometry(0.48, 40), P.water, { pos: [0, 0.54, 0], rot: [-Math.PI / 2, 0, 0], scale: [1.5, 1, 1], cast: false });
  g.add(water);

  // Foam: a ring along the rim plus a cosy collar around where the pet sits.
  const rand = seeded(23);
  const anchor = { x: st.anchor.x - st.center.x, z: st.anchor.z - st.center.z };
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * TAU;
    const r = 0.07 + rand() * 0.05;
    g.add(mesh(new THREE.SphereGeometry(r, 12, 10), P.foam, { pos: [Math.cos(a) * 0.66, 0.57, Math.sin(a) * 0.42], scale: [1, 0.65, 1], cast: false }));
  }
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * TAU + 0.2;
    const r = 0.08 + rand() * 0.04;
    g.add(mesh(new THREE.SphereGeometry(r, 12, 10), P.foam, { pos: [anchor.x + Math.cos(a) * 0.36, 0.58, anchor.z + Math.sin(a) * 0.3], scale: [1, 0.7, 1], cast: false }));
  }

  g.add(limb([-0.8, 0.6, 0], [-0.8, 0.93, 0], 0.03, P.silver));
  g.add(limb([-0.8, 0.93, 0], [-0.62, 0.9, 0], 0.025, P.silver));
  for (const z of [-0.1, 0.1]) g.add(mesh(new THREE.SphereGeometry(0.035, 10, 8), P.silver, { pos: [-0.8, 0.82, z] }));

  const duck = new THREE.Group();
  duck.position.set(0.45, 0.56, -0.16);
  duck.add(mesh(new THREE.SphereGeometry(0.075, 14, 10), P.yellow, { scale: [1.25, 0.85, 1] }));
  duck.add(mesh(new THREE.SphereGeometry(0.05, 12, 10), P.yellow, { pos: [0.06, 0.075, 0] }));
  duck.add(mesh(new THREE.ConeGeometry(0.022, 0.05, 8), P.orange, { pos: [0.115, 0.07, 0], rot: [0, 0, -Math.PI / 2] }));
  for (const z of [-0.025, 0.025]) duck.add(mesh(new THREE.SphereGeometry(0.008, 6, 4), P.ink, { pos: [0.095, 0.09, z], cast: false }));
  duck.rotation.y = 2.4;
  g.add(duck);

  const matMesh = mesh(rbox(0.5, 0.02, 0.8, 0.01), P.bathMat, { pos: [st.approach.x - st.center.x, 0.012, st.approach.z - st.center.z], cast: false });
  g.add(matMesh);

  let t = 0;
  let splash = 0;
  return {
    id: 'bath',
    groups: [g],
    /** A random point on the water near the pet (for soap bubbles). */
    waterPoint(target = new THREE.Vector3()) {
      const a = Math.random() * TAU;
      const r = 0.15 + Math.random() * 0.35;
      return g.localToWorld(target.set(anchor.x + Math.cos(a) * r, 0.62, anchor.z + Math.sin(a) * r * 0.7));
    },
    update(dt, { bathing }) {
      t += dt;
      splash = damp(splash, bathing ? 1 : 0, 3, dt);
      duck.position.y = 0.56 + Math.sin(t * 2.4) * (0.008 + 0.018 * splash);
      duck.rotation.z = Math.sin(t * 1.9) * (0.05 + 0.15 * splash);
      water.position.y = 0.54 + Math.sin(t * 3.1) * 0.006 * splash;
    },
  };
}

// ---------------------------------------------------------------------------
// Camera rig: presets, responsive framing inside the UI-free area, damping
// ---------------------------------------------------------------------------
const YAW_RANGE = [deg(2), deg(88)];
const PITCH_RANGE = [deg(8), deg(68)];
const ZOOM_RANGE = [0.55, 1.45];

/** Points that must stay on screen in the overview: diorama base corners and wall tops. */
function overviewPoints() {
  const H = ROOM.half;
  const WT = ROOM.wallThickness;
  const WH = ROOM.wallHeight;
  const B = -0.06 - ROOM.floorThickness;
  const lo = -H - WT - 0.02;
  const hi = H + 0.15;
  return [
    [lo, B, lo], [hi, B, lo], [lo, B, hi], [hi, B, hi],
    [lo, WH, lo], [H, WH, lo], [H, WH, -H], [lo, WH, H], [-H, WH, H],
  ].map((p) => new THREE.Vector3(...p));
}

function spherePoints(radius) {
  const pts = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map((v) => new THREE.Vector3(...v));
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) pts.push(new THREE.Vector3(sx, sy, sz).normalize());
  return pts.map((p) => p.multiplyScalar(radius));
}

export class CameraRig {
  constructor(camera, dom, { reducedMotion = false } = {}) {
    this.camera = camera;
    this.dom = dom;
    this.reduced = reducedMotion;
    this.view = 'overview';
    this.user = { yaw: 0, pitch: 0, zoom: 1 };
    this.state = { yaw: deg(42), pitch: deg(32), dist: 16, target: new THREE.Vector3(0, 1, 0) };
    this.viewport = { w: 1, h: 1, safe: { x: 0, y: 0, w: 1, h: 1 } };
    this.layoutVersion = 0;
    this.fitCache = new Map();
    this.scratch = new THREE.PerspectiveCamera();
    this.overview = overviewPoints();
    this.spheres = new Map();
    this.snap = true;
    this.dragging = false;
    this.onTap = null;
    this.onHover = null;
    this._v = new THREE.Vector3();
    this._goal = new THREE.Vector3();
    this._bindPointer();
  }

  /** Viewport size plus the screen rect not covered by UI; the scene is framed inside it. */
  setViewport(w, h, safe) {
    this.viewport = { w, h, safe };
    const dx = safe.x + safe.w / 2 - w / 2;
    const dy = safe.y + safe.h / 2 - h / 2;
    const fullW = w + 2 * Math.abs(dx);
    const fullH = h + 2 * Math.abs(dy);
    const aspect = safe.w / Math.max(1, safe.h);
    this.camera.fov = aspect < 0.8 ? 40 : aspect < 1.25 ? 35 : 30;
    this.camera.aspect = fullW / fullH;
    this.camera.setViewOffset(fullW, fullH, dx < 0 ? -2 * dx : 0, dy < 0 ? -2 * dy : 0, w, h);
    this.camera.updateProjectionMatrix();
    this.layoutVersion++;
    this.fitCache.clear();
    this.settled = false; // only a rendered frame that reaches the new framing settles it again
  }

  setView(id, { instant = false } = {}) {
    if (!CAMERA_VIEWS.some((v) => v.id === id) && !EXTRA_VIEWS.includes(id)) return false;
    this.view = id;
    this.user = { yaw: 0, pitch: 0, zoom: 1 };
    this.settled = false;
    if (instant || this.reduced) this.snap = true;
    return true;
  }

  _preset(id, petPos) {
    const portrait = this.viewport.safe.w < this.viewport.safe.h * 0.9;
    switch (id) {
      case 'pet': {
        const p = petPos ?? new THREE.Vector3(STATIONS.rug.anchor.x, 0, STATIONS.rug.anchor.z);
        return { id, target: new THREE.Vector3(p.x, p.y + 0.98, p.z), yaw: deg(36), pitch: deg(portrait ? 16 : 13), radius: 1.22 };
      }
      case 'music': {
        const c = STATIONS.music.center;
        return { id, target: new THREE.Vector3(c.x - 0.12, 0.85, c.z - 0.25), yaw: deg(26), pitch: deg(21), radius: 1.5 };
      }
      case 'easel': {
        const c = STATIONS.easel.center;
        const a = STATIONS.easel.anchor;
        return { id, target: new THREE.Vector3((c.x + a.x) / 2, 0.98, (c.z + a.z) / 2), yaw: deg(52), pitch: deg(15), radius: 1.38 };
      }
      case 'sleep': {
        // Centred a little above the cushion so a pet curled up in it (ears and all) stays in frame.
        const c = STATIONS.bed.center;
        return { id, target: new THREE.Vector3(c.x + 0.2, 0.78, c.z + 0.3), yaw: deg(44), pitch: deg(33), radius: 1.62 };
      }
      case 'wall':
        // The gallery frame on the left wall (faces +x), seen from inside the room.
        return { id, target: new THREE.Vector3(-ROOM.half + 0.06, 1.66, 1.0), yaw: deg(76), pitch: deg(9), radius: 0.66 };
      default:
        return { id: 'overview', target: new THREE.Vector3(-0.1, 1.0, -0.1), yaw: deg(42), pitch: deg(portrait ? 44 : 30), points: this.overview, center: true };
    }
  }

  _place(cam, offset, yaw, pitch, dist) {
    const cp = Math.cos(pitch);
    cam.position.set(offset.x + Math.sin(yaw) * cp * dist, offset.y + Math.sin(pitch) * dist, offset.z + Math.cos(yaw) * cp * dist);
    cam.lookAt(offset);
    cam.updateMatrixWorld(true);
  }

  /** Screen-space bounds (px) of points given relative to the camera target. */
  _bounds(rel, offset, yaw, pitch, dist) {
    const cam = this.scratch;
    cam.copy(this.camera);
    this._place(cam, offset, yaw, pitch, dist);
    const { w, h } = this.viewport;
    const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, behind: false };
    for (const p of rel) {
      const v = this._v.copy(p).project(cam);
      if (v.z > 1 || v.z < -1) b.behind = true;
      const px = ((v.x + 1) / 2) * w;
      const py = ((1 - v.y) / 2) * h;
      b.minX = Math.min(b.minX, px);
      b.maxX = Math.max(b.maxX, px);
      b.minY = Math.min(b.minY, py);
      b.maxY = Math.max(b.maxY, py);
    }
    return b;
  }

  /** Smallest distance at which every point fits inside the safe rect (binary search). */
  _searchDistance(rel, offset, yaw, pitch) {
    const { safe } = this.viewport;
    const m = Math.max(6, Math.min(18, Math.min(safe.w, safe.h) * 0.035));
    let lo = 0.5;
    let hi = 120;
    for (let i = 0; i < 26; i++) {
      const mid = (lo + hi) / 2;
      const b = this._bounds(rel, offset, yaw, pitch, mid);
      const fits = !b.behind && b.minX >= safe.x + m && b.maxX <= safe.x + safe.w - m && b.minY >= safe.y + m && b.maxY <= safe.y + safe.h - m;
      if (fits) hi = mid;
      else lo = mid;
    }
    return hi;
  }

  _fit(preset, yaw, pitch) {
    const key = `${preset.id}|${yaw.toFixed(3)}|${pitch.toFixed(3)}|${this.layoutVersion}`;
    const cached = this.fitCache.get(key);
    if (cached) return cached;
    let rel;
    if (preset.points) rel = preset.points.map((p) => p.clone().sub(preset.target));
    else {
      if (!this.spheres.has(preset.radius)) this.spheres.set(preset.radius, spherePoints(preset.radius));
      rel = this.spheres.get(preset.radius);
    }
    const offset = new THREE.Vector3();
    let dist = this._searchDistance(rel, offset, yaw, pitch);
    if (preset.center) {
      // Re-centre the projected bounds inside the safe rect (perspective makes them lopsided).
      const { safe } = this.viewport;
      const right = new THREE.Vector3();
      const up = new THREE.Vector3();
      for (let i = 0; i < 3; i++) {
        const b = this._bounds(rel, offset, yaw, pitch, dist);
        const dxPx = (b.minX + b.maxX) / 2 - (safe.x + safe.w / 2);
        const dyPx = (b.minY + b.maxY) / 2 - (safe.y + safe.h / 2);
        const fullH = this.camera.view ? this.camera.view.fullHeight : this.viewport.h;
        const worldPerPx = (2 * dist * Math.tan(deg(this.camera.fov) / 2)) / fullH;
        this.scratch.matrixWorld.extractBasis(right, up, this._v);
        offset.addScaledVector(right, dxPx * worldPerPx).addScaledVector(up, -dyPx * worldPerPx);
        dist = this._searchDistance(rel, offset, yaw, pitch);
      }
    }
    const result = { dist, offset };
    if (this.fitCache.size > 300) this.fitCache.clear();
    this.fitCache.set(key, result);
    return result;
  }

  update(dt, petPos) {
    const preset = this._preset(this.view, petPos);
    const yaw = clamp(preset.yaw + this.user.yaw, ...YAW_RANGE);
    const pitch = clamp(preset.pitch + this.user.pitch, ...PITCH_RANGE);
    this.user.yaw = yaw - preset.yaw;
    this.user.pitch = pitch - preset.pitch;
    const fit = this._fit(preset, yaw, pitch);
    const goal = this._goal.copy(preset.target).add(fit.offset);
    const goalDist = fit.dist * this.user.zoom;
    const s = this.state;
    if (this.snap) {
      s.yaw = yaw;
      s.pitch = pitch;
      s.dist = goalDist;
      s.target.copy(goal);
      this.snap = false;
    } else {
      const k = 1 - Math.exp(-dt * (this.reduced ? 16 : this.dragging ? 14 : 4.2));
      s.yaw += (yaw - s.yaw) * k;
      s.pitch += (pitch - s.pitch) * k;
      s.dist += (goalDist - s.dist) * k;
      s.target.lerp(goal, k);
    }
    // Settled once the damped camera has (nearly) reached its framing goal.
    this.settled = Math.abs(goalDist - s.dist) / goalDist + s.target.distanceTo(goal) / goalDist + Math.abs(yaw - s.yaw) + Math.abs(pitch - s.pitch) < 0.004;
    const cp = Math.cos(s.pitch);
    this.camera.position.set(s.target.x + Math.sin(s.yaw) * cp * s.dist, s.target.y + Math.sin(s.pitch) * s.dist, s.target.z + Math.cos(s.yaw) * cp * s.dist);
    this.camera.lookAt(s.target);
  }

  _bindPointer() {
    const el = this.dom;
    const pointers = new Map();
    let start = null;
    let pinch = null;
    let moved = false;
    let lastHover = 0;
    const spread = () => {
      const [a, b] = [...pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      el.setPointerCapture?.(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        // Event timestamps measure the real press, even if the main thread is busy.
        start = { x: e.clientX, y: e.clientY, t: e.timeStamp };
        moved = false;
      } else if (pointers.size === 2) {
        pinch = { d: spread(), zoom: this.user.zoom };
        moved = true;
      }
    });
    el.addEventListener('pointermove', (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) {
        const now = performance.now();
        if (e.pointerType === 'mouse' && now - lastHover > 70) {
          lastHover = now;
          this.onHover?.(e.clientX, e.clientY);
        }
        return;
      }
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (pointers.size === 1 && start) {
        if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) moved = true;
        if (moved) {
          this.dragging = true;
          this.user.yaw -= dx * 0.0065;
          this.user.pitch += dy * 0.0045;
        }
      } else if (pointers.size === 2 && pinch) {
        this.user.zoom = clamp((pinch.zoom * pinch.d) / Math.max(1, spread()), ...ZOOM_RANGE);
      }
    });
    const end = (e) => {
      const had = pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (had && pointers.size === 0) {
        if (e.type === 'pointerup' && start && !moved && e.timeStamp - start.t < 650) this.onTap?.(e.clientX, e.clientY);
        start = null;
        this.dragging = false;
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !pointers.size) this.onHover?.(null, null);
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.user.zoom = clamp(this.user.zoom * Math.exp(e.deltaY * 0.0011), ...ZOOM_RANGE);
    }, { passive: false });
  }
}

// ---------------------------------------------------------------------------
// The studio
// ---------------------------------------------------------------------------
const HOVER_RADIUS = { food: 0.78, bath: 1.0, bed: 1.0, music: 1.0, easel: 0.85, rug: 1.3, pet: 0.55 };

export class StudioScene {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{reducedMotion?: boolean, lowPower?: boolean}} [opts]
   */
  constructor(canvas, { reducedMotion = false, lowPower = false } = {}) {
    this.canvas = canvas;
    this.reducedMotion = reducedMotion;
    this.lowPower = lowPower;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 200);
    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    this.palette = makePalette(maxAniso);
    this._buildLights();

    const room = buildRoom(this.palette);
    this.scene.add(room.group);
    this.hands = room.hands;
    this.creation = room.creation;
    this.stations = {
      music: buildMusicCorner(this.palette),
      easel: buildEasel(this.palette, maxAniso),
      bed: buildSleepNook(this.palette),
      food: buildSnackBar(this.palette),
      bath: buildBath(this.palette),
    };
    this.pickables = [];
    for (const st of Object.values(this.stations)) {
      for (const g of st.groups) {
        this.scene.add(g);
        this.pickables.push(g);
      }
    }
    const rug = room.group.children.find((c) => c.material === this.palette.rug);
    if (rug) {
      rug.userData.pickId = 'station:rug';
      this.pickables.push(rug);
    }
    this.pickables.push(this.creation.frame);
    this.wallArt = { hasArt: false, pinned: false, title: '' };
    this.setWallArt(null);

    this.hoverRing = new THREE.Mesh(
      new THREE.RingGeometry(0.86, 1, 56),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false }),
    );
    this.hoverRing.rotation.x = -Math.PI / 2;
    this.hoverRing.position.y = 0.025;
    this.hoverRing.renderOrder = 5;
    this.hoverRing.raycast = () => {};
    this.scene.add(this.hoverRing);
    this.hover = null;

    this.particles = new ParticleSystem(this.scene, { reducedMotion });
    this.rig = new CameraRig(this.camera, canvas, { reducedMotion });
    this.rig.onTap = (x, y) => this.onPick?.(this.pick(x, y), { x, y });
    this.rig.onHover = (x, y) => this._hover(x, y);
    this.raycaster = new THREE.Raycaster();
    this.timers = { zzz: 0, bubble: 0, crumb: 0, dream: 0 };
    this.dreamSeq = 0;
    this.time = 0;
    this.pet = null;
    this.onPick = null;
    this.onHover = null;
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
  }

  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0xfff3e6, 0xe2c2a8, 1.55);
    const key = new THREE.DirectionalLight(0xfff0dc, 2.5);
    key.position.set(-4.5, 9.5, 6);
    key.castShadow = true;
    const size = this.lowPower ? 1024 : 2048;
    key.shadow.mapSize.set(size, size);
    Object.assign(key.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 30 });
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.025;
    this.key = key;
    const fill = new THREE.DirectionalLight(0xdfe6ff, 0.55);
    fill.position.set(6, 4, -1);
    this.windowGlow = new THREE.PointLight(0xfff1d6, 1.2, 5, 1.5);
    this.windowGlow.position.set(-0.6, 1.7, -ROOM.half + 0.6);
    this.scene.add(this.hemi, key, key.target, fill, this.windowGlow);
  }

  /** Adds the pet model to the studio (it becomes pickable). */
  setPet(petModel) {
    if (this.pet) this.pet.root.removeFromParent();
    this.pet = petModel;
    this.scene.add(petModel.root);
  }

  resize(width, height, safe, pixelRatio = 1) {
    // Re-assigning a canvas size clears it even when nothing changed, so only touch it on a real change.
    const size = `${width}x${height}@${pixelRatio}`;
    if (size !== this._size) {
      this._size = size;
      this.renderer.setPixelRatio(pixelRatio);
      this.renderer.setSize(width, height, false);
    }
    this.rig.setViewport(width, height, safe);
  }

  setView(id, opts) {
    return this.rig.setView(id, opts);
  }

  get view() {
    return this.rig.view;
  }

  /** Raycasts a screen point. Returns { id: 'pet' | 'station:<id>', point } or null. */
  pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const targets = this.pet ? [this.pet.root, ...this.pickables] : this.pickables;
    for (const hit of this.raycaster.intersectObjects(targets, true)) {
      let o = hit.object;
      while (o && !o.userData.pickId) o = o.parent;
      if (o) return { id: o.userData.pickId, point: hit.point.clone() };
    }
    return null;
  }

  _hover(x, y) {
    const hit = x == null ? null : this.pick(x, y);
    this.hover = hit ? hit.id : null;
    this.canvas.style.cursor = hit ? 'pointer' : '';
    this.onHover?.(hit, x == null ? null : { x, y });
  }

  /** Floating particles at a world position (notes, zzz, bubble, heart, sparkle, crumb). */
  emit(kind, position, opts) {
    this.particles.emit(kind, position, opts);
  }

  /** Visual side of one played note: key press, speaker pulse, a floating note. */
  playNote(midi, tint) {
    const m = this.stations.music;
    m.press(midi);
    this.particles.emit('note', m.keyWorld(midi, this._v).add(this._v2.set(0, 0.3, 0)), { tint });
    if (Math.random() < 0.5) this.particles.emit('note', m.speakerTop(Math.random() < 0.5 ? 0 : 1, this._v), { tint });
    return { arm: m.armFor(midi), key: m.keyWorld(midi, new THREE.Vector3()) };
  }

  /** Soft speaker note while the pet listens on the rug. */
  speakerNote(tint) {
    const m = this.stations.music;
    m.pulseSpeakers();
    this.particles.emit('note', m.speakerTop(Math.random() < 0.5 ? 0 : 1, this._v), { tint });
  }

  /** Visual side of a percussion hit: the speakers thump (kicks hardest). */
  drumHit(kind, tint) {
    const m = this.stations.music;
    m.pulseSpeakers(kind === 'kick' ? 1 : kind === 'hat' ? 0.35 : 0.65);
    if (Math.random() < 0.3) this.particles.emit('note', m.speakerTop(Math.random() < 0.5 ? 0 : 1, this._v), { tint });
  }

  // ----- easel ---------------------------------------------------------------
  startDrawing(drawing) {
    this.stations.easel.surface.start(drawing);
  }

  setDrawingProgress(progress) {
    this.stations.easel.surface.setProgress(progress);
  }

  showDrawing(drawing, progress = 1) {
    this.stations.easel.surface.show(drawing, progress);
  }

  penWorld(target = new THREE.Vector3()) {
    return this.stations.easel.penWorld(target);
  }

  get paintColor() {
    return this.stations.easel.surface.pen?.color ?? null;
  }

  /** Copies the easel picture into the wall frame (fallback when nothing is hung from the Gallery). */
  showCreation() {
    if (this.wallArt.pinned) return;
    const { ctx, canvas, texture } = this.creation;
    ctx.fillStyle = '#fffaf1';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(this.stations.easel.surface.canvas, 0, 0, canvas.width, canvas.height);
    texture.needsUpdate = true;
    this.wallArt = { hasArt: true, pinned: false, title: '' };
  }

  /**
   * Shows a drawing in the gallery frame on the left wall. `pinned` adds the
   * brass title plaque and a rosette (the player hung it from the Gallery).
   * `null` shows the empty frame.
   */
  setWallArt(drawing, { title = '', pinned = false } = {}) {
    const { ctx, canvas, texture, plaque, rosette, plaqueCtx, plaqueTexture } = this.creation;
    const S = canvas.width;
    const has = !!drawing?.strokes?.length;
    if (has) {
      paintDrawing(ctx, drawing, S, { border: false });
    } else {
      ctx.fillStyle = '#fffaf1';
      ctx.fillRect(0, 0, S, S);
      ctx.save();
      ctx.strokeStyle = 'rgba(170, 140, 110, 0.5)';
      ctx.setLineDash([20, 16]);
      ctx.lineWidth = 8;
      ctx.strokeRect(S * 0.094, S * 0.094, S * 0.812, S * 0.812);
      ctx.restore();
    }
    texture.needsUpdate = true;
    const show = has && pinned;
    plaque.visible = show;
    rosette.visible = show;
    if (show) {
      const W = plaqueCtx.canvas.width;
      const Hh = plaqueCtx.canvas.height;
      const g = plaqueCtx.createLinearGradient(0, 0, 0, Hh);
      g.addColorStop(0, '#f8d77a');
      g.addColorStop(1, '#dfae45');
      plaqueCtx.fillStyle = g;
      plaqueCtx.fillRect(0, 0, W, Hh);
      plaqueCtx.strokeStyle = 'rgba(120, 80, 20, 0.45)';
      plaqueCtx.lineWidth = 6;
      plaqueCtx.strokeRect(5, 5, W - 10, Hh - 10);
      plaqueCtx.fillStyle = '#5a3c12';
      plaqueCtx.textAlign = 'center';
      plaqueCtx.textBaseline = 'middle';
      let size = 44;
      const text = title || 'Untitled';
      plaqueCtx.font = `800 ${size}px ui-rounded, "Segoe UI", system-ui, sans-serif`;
      while (size > 26 && plaqueCtx.measureText(text).width > W - 48) {
        size -= 2;
        plaqueCtx.font = `800 ${size}px ui-rounded, "Segoe UI", system-ui, sans-serif`;
      }
      let shown = text;
      while (shown.length > 3 && plaqueCtx.measureText(shown).width > W - 48) shown = `${shown.slice(0, -2)}…`;
      plaqueCtx.fillText(shown, W / 2, Hh / 2 + 2);
      plaqueTexture.needsUpdate = true;
    }
    this.wallArt = { hasArt: has, pinned: show, title: show ? title : '' };
  }

  /**
   * Per-frame update.
   * @param {number} dt
   * @param {{activity: string, petHead?: THREE.Vector3, petFocus?: THREE.Vector3, dream?: 'music'|'drawing'|null}} frame
   */
  update(dt, frame) {
    this.time += dt;
    const act = frame.activity;
    const s = this.stations;
    s.music.update(dt, { active: act === 'playing_music', listening: act === 'listening' });
    s.easel.update(dt);
    s.bed.update(dt, { sleeping: act === 'sleeping' });
    s.food.update(dt, { eating: act === 'eating' });
    s.bath.update(dt, { bathing: act === 'bathing' });

    // Cozy night mood while the pet sleeps.
    const n = s.bed.night;
    this.hemi.intensity = 1.55 - 0.5 * n;
    this.key.intensity = 2.5 - 1.15 * n;
    this.windowGlow.intensity = 1.2 - 0.8 * n;

    const t = this.timers;
    if (act !== this.lastActivity) {
      // Let the pet finish hopping into bed or the tub before the first Zzz / bubbles.
      if (act === 'sleeping') t.zzz = 1.2;
      if (act === 'bathing') t.bubble = 0.6;
      this.lastActivity = act;
    }
    for (const k of Object.keys(t)) t[k] -= dt;
    if (act === 'sleeping' && frame.petHead && t.zzz <= 0) {
      this.particles.emit('zzz', this._v.copy(frame.petHead).add(this._v2.set(0.15, 0.12, 0.05)));
      t.zzz = 1.5;
    }
    // Sleep Practice: little dream notes (music) or sparkles (drawing) drift up while it trains.
    if (act === 'sleeping' && frame.dream && frame.petHead && t.dream <= 0) {
      const tints = ['#b9a6ff', '#ffb3d1', '#9fd6ff', '#ffd98a'];
      this.dreamSeq += 1;
      this.particles.emit(frame.dream === 'drawing' ? 'dreamStar' : 'dreamNote', this._v.copy(frame.petHead).add(this._v2.set(-0.12, 0.2, 0.08)), { tint: tints[this.dreamSeq % tints.length] });
      t.dream = 0.65;
    }
    if (act === 'bathing' && t.bubble <= 0) {
      this.particles.emit('bubble', s.bath.waterPoint(this._v));
      t.bubble = 0.17;
    }
    if (act === 'eating' && t.crumb <= 0) {
      this.particles.emit('crumb', s.food.bowlWorld(this._v), { count: 2, tint: '#f2b866' });
      t.crumb = 0.5;
    }
    this.particles.update(dt);

    const now = new Date();
    const hours = (now.getHours() % 12) + now.getMinutes() / 60;
    const minutes = now.getMinutes() + now.getSeconds() / 60;
    this.hands.hour.rotation.z = -(hours / 12) * TAU;
    this.hands.minute.rotation.z = -(minutes / 60) * TAU;

    // Hover ring under the hovered station or pet.
    const ring = this.hoverRing;
    let target = 0;
    if (this.hover) {
      const id = this.hover === 'pet' ? 'pet' : this.hover.replace('station:', '');
      const c = id === 'pet' ? frame.petFocus : STATIONS[id]?.center;
      if (c) {
        ring.position.x = c.x;
        ring.position.z = c.z;
        ring.scale.setScalar(HOVER_RADIUS[id] ?? 1);
        target = 0.45 + Math.sin(this.time * 5) * 0.12;
      }
    }
    ring.material.opacity = damp(ring.material.opacity, target, 12, dt);
    ring.visible = ring.material.opacity > 0.01;

    this.rig.update(dt, frame.petFocus);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  /** Projects a world point to CSS pixels (relative to the canvas). */
  toScreen(point) {
    const v = this._v.copy(point).project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height, visible: v.z < 1 };
  }

  /** Screen rect (CSS px) covering a list of world points. */
  screenRectOfPoints(points) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      const s = this.toScreen(p);
      minX = Math.min(minX, s.x);
      maxX = Math.max(maxX, s.x);
      minY = Math.min(minY, s.y);
      maxY = Math.max(maxY, s.y);
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /** Screen rect (CSS px) covering a world-space Box3. */
  screenRect(box) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < 8; i++) {
      const p = this._v2.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      const s = this.toScreen(p);
      minX = Math.min(minX, s.x);
      maxX = Math.max(maxX, s.x);
      minY = Math.min(minY, s.y);
      maxY = Math.max(maxY, s.y);
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  info() {
    const r = this.renderer.info;
    return {
      calls: r.render.calls,
      triangles: r.render.triangles,
      geometries: r.memory.geometries,
      textures: r.memory.textures,
      programs: r.programs?.length ?? 0,
      pixelRatio: this.renderer.getPixelRatio(),
      particles: this.particles.activeCount,
      wallArt: { ...this.wallArt },
    };
  }

  dispose() {
    this.particles.dispose();
    this.scene.traverse((o) => {
      if (o.isMesh) o.geometry?.dispose();
    });
    this.renderer.dispose();
  }
}
