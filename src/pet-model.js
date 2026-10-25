/**
 * pet-model.js: stylised, procedurally built 3D pet (Three.js).
 *
 * Vinyl-toy proportions inspired by approachable avatar styles: a big round
 * head, an egg-shaped body, stubby limbs, cel-shaded materials with outlines,
 * an animated canvas-texture face and a floating mood/activity bubble.
 * Every motion here is procedural, authored animation driven by the
 * simulation snapshot (pet-state.js); nothing in this file learns.
 */
import * as THREE from 'three';
import { makeToonMaterial, addOutline, shadeHex, hexToRgba } from './toon.js';
import { drawIcon } from './canvas-icons.js';

const TAU = Math.PI * 2;
const OUTLINE = '#3d2838';
const INK = '#2b2034';
const FACE_W = 512;
const FACE_H = 384;

/** Facial parameter sets; the face eases between them for smooth transitions. */
export const EXPRESSION_PRESETS = Object.freeze({
  neutral: { eyeOpen: 1, eyeHappy: 0, eyeScale: 1, eyeScaleR: 1, sparkle: 0.15, brow: 0, browTilt: 0, mouthSmile: 0.45, mouthOpen: 0, mouthWidth: 0.8, blush: 0.5 },
  happy: { eyeOpen: 1, eyeHappy: 1, eyeScale: 1, eyeScaleR: 1, sparkle: 0, brow: 0.15, browTilt: 0, mouthSmile: 1, mouthOpen: 0.4, mouthWidth: 1, blush: 0.85 },
  curious: { eyeOpen: 1, eyeHappy: 0, eyeScale: 1.04, eyeScaleR: 1.16, sparkle: 0.35, brow: 0.35, browTilt: 1, mouthSmile: 0.05, mouthOpen: 0.26, mouthWidth: 0.42, blush: 0.45 },
  sleepy: { eyeOpen: 0.4, eyeHappy: 0, eyeScale: 1, eyeScaleR: 1, sparkle: 0, brow: -0.1, browTilt: 0, mouthSmile: 0.1, mouthOpen: 0.12, mouthWidth: 0.48, blush: 0.35 },
  asleep: { eyeOpen: 0, eyeHappy: 0, eyeScale: 1, eyeScaleR: 1, sparkle: 0, brow: 0, browTilt: 0, mouthSmile: 0.15, mouthOpen: 0.16, mouthWidth: 0.34, blush: 0.6 },
  proud: { eyeOpen: 1, eyeHappy: 0.85, eyeScale: 1, eyeScaleR: 1, sparkle: 0.4, brow: 0.55, browTilt: 0, mouthSmile: 0.95, mouthOpen: 0.14, mouthWidth: 1.05, blush: 0.75 },
  excited: { eyeOpen: 1, eyeHappy: 0, eyeScale: 1.22, eyeScaleR: 1, sparkle: 1, brow: 0.6, browTilt: 0, mouthSmile: 1, mouthOpen: 0.8, mouthWidth: 1.1, blush: 1 },
  pouty: { eyeOpen: 0.78, eyeHappy: 0, eyeScale: 0.95, eyeScaleR: 1, sparkle: 0, brow: -0.9, browTilt: 0, mouthSmile: -0.7, mouthOpen: 0, mouthWidth: 0.55, blush: 0.75 },
});

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const damp = (cur, target, lambda, dt) => lerp(cur, target, 1 - Math.exp(-lambda * dt));
function dampAngle(cur, target, lambda, dt) {
  const d = Math.atan2(Math.sin(target - cur), Math.cos(target - cur));
  return cur + d * (1 - Math.exp(-lambda * dt));
}
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

function sparklePath(ctx, x, y, r) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.quadraticCurveTo(x, y, x, y + r);
  ctx.quadraticCurveTo(x, y, x - r, y);
  ctx.quadraticCurveTo(x, y, x, y - r);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Face: a canvas texture redrawn only while something changes
// ---------------------------------------------------------------------------
class FaceRenderer {
  constructor(cheekColor) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = FACE_W;
    this.canvas.height = FACE_H;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.expression = 'neutral';
    this.current = { ...EXPRESSION_PRESETS.neutral };
    this.target = { ...EXPRESSION_PRESETS.neutral };
    this.blink = 0;
    this.blinkPhase = -1;
    this.blinkTimer = 1.5 + Math.random() * 2;
    this.look = { x: 0, y: 0 };
    this.lookTarget = { x: 0, y: 0 };
    this.munch = 0;
    this.cheekColor = cheekColor;
    this.dirty = true;
  }

  setExpression(name) {
    if (name === this.expression) return;
    this.expression = name;
    this.target = { ...(EXPRESSION_PRESETS[name] ?? EXPRESSION_PRESETS.neutral) };
  }

  setCheekColor(color) {
    this.cheekColor = color;
    this.dirty = true;
  }

  update(dt, { lookX = 0, lookY = 0, munch = 0 } = {}) {
    let changed = this.dirty;
    const k = 1 - Math.exp(-dt * 11);
    for (const key of Object.keys(this.target)) {
      const d = this.target[key] - this.current[key];
      if (d === 0) continue;
      this.current[key] = Math.abs(d) < 0.002 ? this.target[key] : this.current[key] + d * k;
      changed = true;
    }
    this.blinkTimer -= dt;
    if (this.blinkPhase < 0 && this.blinkTimer <= 0) {
      if (this.current.eyeOpen > 0.3 && this.current.eyeHappy < 0.5) this.blinkPhase = 0;
      else this.blinkTimer = 0.8;
    }
    if (this.blinkPhase >= 0) {
      this.blinkPhase += dt / 0.18;
      this.blink = Math.sin(Math.min(1, this.blinkPhase) * Math.PI);
      if (this.blinkPhase >= 1) {
        this.blinkPhase = -1;
        this.blink = 0;
        this.blinkTimer = Math.random() < 0.2 ? 0.22 : 2.2 + Math.random() * 3.4; // sometimes a double blink
      }
      changed = true;
    }
    this.lookTarget.x = clamp(lookX, -1, 1);
    this.lookTarget.y = clamp(lookY, -1, 1);
    for (const axis of ['x', 'y']) {
      const d = this.lookTarget[axis] - this.look[axis];
      if (Math.abs(d) > 0.004) {
        this.look[axis] += d * (1 - Math.exp(-dt * 9));
        changed = true;
      }
    }
    if (Math.abs(munch - this.munch) > 0.004) {
      this.munch = munch;
      changed = true;
    }
    if (changed) {
      this.draw();
      this.texture.needsUpdate = true;
      this.dirty = false;
    }
  }

  draw() {
    const ctx = this.ctx;
    const p = this.current;
    ctx.clearRect(0, 0, FACE_W, FACE_H);
    const cx = FACE_W / 2 + this.look.x * 10;
    const eyeY = 150 + this.look.y * 9;

    // Cheeks: soft blush ovals.
    if (p.blush > 0.02) {
      for (const side of [-1, 1]) {
        const x = FACE_W / 2 + side * 148;
        const y = 222;
        const g = ctx.createRadialGradient(x, y, 6, x, y, 54);
        g.addColorStop(0, hexToRgba(this.cheekColor, 0.78 * p.blush));
        g.addColorStop(0.65, hexToRgba(this.cheekColor, 0.42 * p.blush));
        g.addColorStop(1, hexToRgba(this.cheekColor, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(x, y, 56, 36, 0, 0, TAU);
        ctx.fill();
      }
    }

    const open = Math.max(0, p.eyeOpen * (1 - this.blink));
    for (const side of [-1, 1]) {
      const scale = p.eyeScale * (side === 1 ? p.eyeScaleR : 1);
      const ex = cx + side * 90 + this.look.x * 8;
      const ey = eyeY;
      const rx = 26 * scale;
      const ry = 36 * scale;
      const roundAlpha = 1 - p.eyeHappy;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (roundAlpha > 0.01) {
        ctx.save();
        ctx.globalAlpha = roundAlpha;
        if (open > 0.07) {
          const lidY = ey - ry + (1 - open) * 2 * ry;
          ctx.save();
          ctx.beginPath();
          ctx.rect(ex - rx - 8, lidY, rx * 2 + 16, ry * 2 + 16);
          ctx.clip();
          ctx.fillStyle = INK;
          ctx.beginPath();
          ctx.ellipse(ex, ey, rx, ry, 0, 0, TAU);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.ellipse(ex - rx * 0.3 + this.look.x * 3, ey - ry * 0.36, rx * 0.36, ry * 0.3, -0.35, 0, TAU);
          ctx.fill();
          ctx.beginPath();
          ctx.arc(ex + rx * 0.34, ey + ry * 0.38, rx * 0.15, 0, TAU);
          ctx.fill();
          if (p.sparkle > 0.05) {
            sparklePath(ctx, ex + rx * 0.22, ey - ry * 0.02, rx * 0.5 * p.sparkle);
            ctx.fill();
          }
          ctx.restore();
          if (open < 0.95) {
            ctx.strokeStyle = INK;
            ctx.lineWidth = 7;
            ctx.beginPath();
            ctx.moveTo(ex - rx - 4, lidY + 3);
            ctx.quadraticCurveTo(ex, lidY - 5, ex + rx + 4, lidY + 3);
            ctx.stroke();
          }
        } else {
          // Closed eyes: a gentle downward curve.
          ctx.strokeStyle = INK;
          ctx.lineWidth = 9;
          ctx.beginPath();
          ctx.moveTo(ex - rx, ey + 4);
          ctx.quadraticCurveTo(ex, ey + 20, ex + rx, ey + 4);
          ctx.stroke();
        }
        ctx.restore();
      }
      if (p.eyeHappy > 0.01) {
        // Happy eyes: upside-down U arcs.
        ctx.save();
        ctx.globalAlpha = p.eyeHappy;
        ctx.strokeStyle = INK;
        ctx.lineWidth = 11;
        ctx.beginPath();
        ctx.moveTo(ex - rx * 1.05, ey + 12);
        ctx.quadraticCurveTo(ex, ey - ry * 1.1, ex + rx * 1.05, ey + 12);
        ctx.stroke();
        ctx.restore();
      }
      // Brows (only for expressive faces).
      const lift = p.brow + (side === 1 ? p.browTilt * 0.8 : 0);
      const browAlpha = smoothstep(0.2, 0.45, Math.abs(p.brow) + (side === 1 ? p.browTilt * 0.6 : 0));
      if (browAlpha > 0.01) {
        const by = ey - ry - 20 - Math.max(0, lift) * 12;
        const innerX = ex - side * rx * 0.85;
        const outerX = ex + side * rx * 0.85;
        const furrow = Math.max(0, -p.brow);
        ctx.save();
        ctx.globalAlpha = browAlpha;
        ctx.strokeStyle = INK;
        ctx.lineWidth = 8;
        ctx.beginPath();
        ctx.moveTo(outerX, by + 2 - furrow * 4);
        ctx.quadraticCurveTo(ex, by - 8 + furrow * 6, innerX, by + 2 + furrow * 14);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Mouth.
    const mx = cx;
    const my = 252 + this.look.y * 5;
    const w = 30 * p.mouthWidth + 6;
    const smile = p.mouthSmile;
    const mouthOpen = Math.max(p.mouthOpen, this.munch);
    ctx.strokeStyle = INK;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (mouthOpen < 0.07) {
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(mx - w, my - smile * 6);
      ctx.quadraticCurveTo(mx, my + smile * 22, mx + w, my - smile * 6);
      ctx.stroke();
    } else if (p.mouthWidth < 0.5) {
      // Small round "o" mouth (curious, snoozing, munching).
      const ry = 8 + mouthOpen * 26;
      ctx.fillStyle = '#6b2a3f';
      ctx.beginPath();
      ctx.ellipse(mx, my + 4, w * 0.62, ry * 0.6, 0, 0, TAU);
      ctx.fill();
      ctx.lineWidth = 6;
      ctx.stroke();
    } else {
      const topY = my - smile * 5;
      const cTop = my + smile * 9;
      const cBot = my + smile * 9 + 12 + mouthOpen * 46;
      const mouthPath = () => {
        ctx.beginPath();
        ctx.moveTo(mx - w, topY);
        ctx.quadraticCurveTo(mx, cTop, mx + w, topY);
        ctx.quadraticCurveTo(mx, cBot, mx - w, topY);
        ctx.closePath();
      };
      mouthPath();
      ctx.fillStyle = '#6b2a3f';
      ctx.fill();
      if (mouthOpen > 0.3) {
        ctx.save();
        mouthPath();
        ctx.clip();
        ctx.fillStyle = '#ff8fa8';
        ctx.beginPath();
        ctx.ellipse(mx, (topY + cBot) / 2 + 6 + mouthOpen * 10, w * 0.62, 10 + mouthOpen * 9, 0, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
      mouthPath();
      ctx.lineWidth = 6;
      ctx.stroke();
    }
  }

  dispose() {
    this.texture.dispose();
  }
}

// ---------------------------------------------------------------------------
// Floating mood / activity bubble (sprite that always faces the camera)
// ---------------------------------------------------------------------------
const easeOutBack = (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;

class MoodBubble {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 256;
    this.canvas.height = 256;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.SpriteMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false });
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.name = 'pet-bubble';
    this.sprite.renderOrder = 30;
    this.sprite.raycast = () => {};
    this.sprite.visible = false;
    this.key = null;
    this.icon = null;
    this.show = 0;
    this.target = 0;
    this.pop = 1;
    this.t = 0;
  }

  set(bubble) {
    const key = bubble ? `${bubble.key}|${bubble.icon}|${bubble.kind}` : null;
    if (key === this.key) return;
    this.key = key;
    if (!bubble) {
      this.target = 0;
      return;
    }
    this.icon = bubble.icon;
    this._paint(bubble.icon, bubble.kind);
    this.target = 1;
    this.pop = 0;
  }

  _paint(icon, kind) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, 256, 256);
    ctx.fillStyle = 'rgba(255, 253, 248, 0.97)';
    ctx.strokeStyle = 'rgba(61, 40, 56, 0.85)';
    ctx.lineWidth = 7;
    if (kind === 'thought') {
      for (const [x, y, r] of [[96, 214, 15], [74, 240, 9]]) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      ctx.moveTo(104, 176);
      ctx.lineTo(84, 236);
      ctx.lineTo(146, 186);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(128, 108, 88, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath(); // cover the tail seam inside the circle
    ctx.arc(128, 108, 84, 0, TAU);
    ctx.fill();
    drawIcon(ctx, icon, 128, 108, 118);
    this.texture.needsUpdate = true;
  }

  update(dt, y, reduced) {
    this.t += dt;
    this.show = damp(this.show, this.target, this.target ? 14 : 9, dt);
    this.pop = Math.min(1, this.pop + dt * 3);
    const pop = this.target && !reduced ? easeOutBack(this.pop) : 1;
    const s = 0.52 * this.show * pop;
    this.sprite.visible = s > 0.02;
    this.sprite.scale.set(s, s, 1);
    this.sprite.position.set(0, y + (reduced ? 0 : Math.sin(this.t * 2.2) * 0.03), 0);
    this.material.opacity = clamp(this.show * 1.5, 0, 1);
  }

  dispose() {
    this.texture.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// The pet
// ---------------------------------------------------------------------------
const BODY_R = 0.36;
const BODY_H = 1.1; // vertical stretch of the egg-shaped body
const BODY_CY = 0.44; // body centre height (before body scale)
const HEAD_R = 0.42;

function eggGeometry() {
  const pts = [];
  for (let i = 0; i <= 28; i++) {
    const th = Math.PI - (i / 28) * Math.PI;
    const r = BODY_R * Math.sin(th) * (1 - 0.1 * Math.cos(th));
    pts.push(new THREE.Vector2(Math.max(r, 1e-4), BODY_R * BODY_H * Math.cos(th)));
  }
  return new THREE.LatheGeometry(pts, 40);
}

function starShape(outer, inner, points = 5) {
  const shape = new THREE.Shape();
  for (let i = 0; i <= points * 2; i++) {
    const a = Math.PI / 2 + (i / (points * 2)) * TAU;
    const r = i % 2 ? inner : outer;
    if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  return shape;
}

export class PetModel {
  /**
   * @param {object} appearance  sanitised appearance from pet-state.js
   * @param {{reducedMotion?: boolean, brushHand?: 'right'|'left', pickId?: string}} [opts]
   *   `brushHand: 'left'` mirrors the painter (a visiting friend paints from the other side of the easel).
   */
  constructor(appearance, { reducedMotion = false, brushHand = 'right', pickId = 'pet' } = {}) {
    this.reducedMotion = reducedMotion;
    this.brushArm = brushHand === 'left' ? 0 : 1; // arm 0 = the pet's left (+x), 1 = its right
    this.paletteArm = 1 - this.brushArm;
    this.root = new THREE.Group();
    this.root.name = pickId;
    this.root.userData.pickId = pickId;
    this.pose = new THREE.Group();
    this.root.add(this.pose);
    this.geometries = new Set();
    this.mats = {
      body: makeToonMaterial({ color: appearance.bodyColor, rim: 0.24, gloss: 0.3 }),
      feet: makeToonMaterial({ color: shadeHex(appearance.bodyColor, -0.07), rim: 0.2, gloss: 0.2 }),
      accent: makeToonMaterial({ color: appearance.accentColor, rim: 0.18, gloss: 0.25 }),
      inner: makeToonMaterial({ color: shadeHex(appearance.cheekColor, 0.08), rim: 0.08 }),
      wood: makeToonMaterial({ color: '#d9a066', rim: 0.1 }),
      metal: makeToonMaterial({ color: '#c9ccd6', rim: 0.2, gloss: 0.4 }),
      paint: makeToonMaterial({ color: '#ff7fa3', rim: 0.1, gloss: 0.4 }),
      palette: makeToonMaterial({ color: '#f1d3a1', rim: 0.1 }),
    };
    this.face = new FaceRenderer(appearance.cheekColor);
    this.mats.face = makeToonMaterial({ color: '#ffffff', map: this.face.texture, transparent: true, depthWrite: false, rim: 0 });
    this.bubble = new MoodBubble();
    this.root.add(this.bubble.sprite);
    this.appearance = { ...appearance };
    this._buildBody();
    this._buildEars(appearance.earStyle);
    this._buildTail(appearance.tailStyle);
    this._applyProportions();
    this.anim = {
      t: 0, walkPhase: 0, heading: 0, init: false, hop: null, hopY: 0,
      pos: new THREE.Vector3(), goal: new THREE.Vector3(),
      headYaw: 0, headPitch: 0, headRoll: 0, glanceTimer: 0, glance: { cam: true, yaw: 0, pitch: 0 },
      ear: 0, earVel: 0, prevLift: 0, press: [0, 0], emote: null,
      w: { walk: 0, sleep: 0, sit: 0, play: 0, draw: 0, eat: 0, bath: 0, listen: 0, attend: 0 },
      arms: [{ x: 0.05, z: 0.3 }, { x: 0.05, z: -0.3 }],
    };
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
  }

  _geo(g) {
    this.geometries.add(g);
    return g;
  }

  _mesh(geo, mat, { outline = 0, shadow = true } = {}) {
    const m = new THREE.Mesh(this._geo(geo), mat);
    m.castShadow = shadow;
    m.receiveShadow = false;
    if (outline) addOutline(m, { color: OUTLINE, thickness: outline });
    return m;
  }

  _buildBody() {
    const { body, feet, accent, face, wood, metal, paint, palette } = this.mats;
    this.bodyGroup = new THREE.Group();
    this.pose.add(this.bodyGroup);
    this.bodyMesh = this._mesh(eggGeometry(), body, { outline: 0.014 });
    this.bodyMesh.position.y = BODY_CY;
    this.bodyGroup.add(this.bodyMesh);
    // A tighter sphere just in front of the egg: only its cap pokes through,
    // which reads as a clean oval tummy patch that follows the body curve.
    const belly = this._mesh(new THREE.SphereGeometry(0.26, 32, 24), accent, { shadow: false });
    belly.scale.set(1, 1.2, 1);
    belly.position.set(0, BODY_CY - 0.06, 0.124);
    this.bodyGroup.add(belly);

    // Arms pivot at the shoulders: index 0 = pet's left (+x), 1 = pet's right (-x).
    this.armPivots = [];
    for (const side of [1, -1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.3, BODY_CY + 0.13, 0.03);
      const arm = this._mesh(new THREE.CapsuleGeometry(0.068, 0.15, 6, 12), body, { outline: 0.012 });
      arm.position.y = -0.12;
      pivot.add(arm);
      this.bodyGroup.add(pivot);
      this.armPivots.push(pivot);
    }
    // Paintbrush (right hand) and palette (left hand), shown while drawing.
    this.brush = new THREE.Group();
    const handle = this._mesh(new THREE.CylinderGeometry(0.016, 0.02, 0.2, 8), wood, { outline: 0.008 });
    handle.position.y = -0.1;
    const ferrule = this._mesh(new THREE.CylinderGeometry(0.021, 0.021, 0.04, 8), metal);
    ferrule.position.y = -0.21;
    const tip = this._mesh(new THREE.ConeGeometry(0.024, 0.075, 10), paint);
    tip.rotation.x = Math.PI;
    tip.position.y = -0.265;
    this.brush.add(handle, ferrule, tip);
    this.brush.position.y = -0.2;
    this.brush.visible = false;
    this.armPivots[this.brushArm].add(this.brush);
    this.palette = new THREE.Group();
    const board = this._mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.018, 20), palette, { outline: 0.008 });
    board.scale.set(1, 1, 0.78);
    this.palette.add(board);
    ['#ff7fa3', '#ffbf3f', '#55b8ec', '#6ccf7f'].forEach((c, i) => {
      const dab = this._mesh(new THREE.SphereGeometry(0.022, 10, 8), makeToonMaterial({ color: c, rim: 0.05 }), { shadow: false });
      const a = (i / 4) * Math.PI + 0.3;
      dab.position.set(Math.cos(a) * 0.065, 0.012, Math.sin(a) * 0.05);
      dab.scale.y = 0.45;
      this.palette.add(dab);
    });
    this.palette.position.set(0, -0.25, 0.05);
    this.palette.rotation.x = 1.25;
    this.palette.visible = false;
    this.armPivots[this.paletteArm].add(this.palette);

    this.feetGroup = new THREE.Group();
    this.pose.add(this.feetGroup);
    this.feet = [1, -1].map((side) => {
      const foot = this._mesh(new THREE.SphereGeometry(0.1, 20, 14), feet, { outline: 0.01 });
      foot.scale.set(1, 0.55, 1.3);
      foot.position.set(side * 0.145, 0.05, 0.05);
      this.feetGroup.add(foot);
      return foot;
    });

    this.headPivot = new THREE.Group();
    this.headPivot.rotation.order = 'YXZ';
    this.pose.add(this.headPivot);
    this.headGroup = new THREE.Group();
    this.headPivot.add(this.headGroup);
    this.headMesh = this._mesh(new THREE.SphereGeometry(HEAD_R, 48, 36), body, { outline: 0.015 });
    this.headMesh.scale.set(1.06, 0.94, 1);
    this.headGroup.add(this.headMesh);
    const hw = 1.0;
    const faceGeo = new THREE.SphereGeometry(HEAD_R * 1.012, 48, 32, Math.PI / 2 - hw, hw * 2, Math.PI / 2 - 0.45, 1.2);
    this.faceMesh = this._mesh(faceGeo, face, { shadow: false });
    this.faceMesh.renderOrder = 2;
    this.headMesh.add(this.faceMesh);
  }

  _disposeGroup(group) {
    group.traverse((o) => {
      if (o.isMesh && !o.userData.isOutline && this.geometries.has(o.geometry)) {
        o.geometry.dispose();
        this.geometries.delete(o.geometry);
      }
    });
    group.removeFromParent();
  }

  _buildEars(style) {
    if (this.earsGroup) this._disposeGroup(this.earsGroup);
    const { body, inner, accent } = this.mats;
    this.earsGroup = new THREE.Group();
    this.headGroup.add(this.earsGroup);
    this.earPivots = [];
    this.earStyle = style;
    for (const side of [1, -1]) {
      const pivot = new THREE.Group();
      this.earsGroup.add(pivot);
      this.earPivots.push(pivot);
      let base = { x: 0, z: 0 };
      if (style === 'round') {
        pivot.position.set(side * 0.29, 0.27, -0.04);
        base = { x: 0, z: -side * 0.38 };
        const outer = this._mesh(new THREE.SphereGeometry(0.13, 22, 16), body, { outline: 0.012 });
        outer.scale.set(1, 1, 0.72);
        outer.position.y = 0.07;
        const innerEar = this._mesh(new THREE.SphereGeometry(0.078, 18, 12), inner, { shadow: false });
        innerEar.scale.set(1, 1, 0.35);
        innerEar.position.set(0, 0.07, 0.075);
        pivot.add(outer, innerEar);
      } else if (style === 'cat') {
        pivot.position.set(side * 0.23, 0.3, -0.03);
        base = { x: 0, z: -side * 0.34 };
        const outer = this._mesh(new THREE.ConeGeometry(0.135, 0.28, 24), body, { outline: 0.012 });
        outer.scale.z = 0.62;
        outer.position.y = 0.12;
        const innerEar = this._mesh(new THREE.ConeGeometry(0.075, 0.17, 18), inner, { shadow: false });
        innerEar.scale.z = 0.4;
        innerEar.position.set(0, 0.1, 0.05);
        pivot.add(outer, innerEar);
      } else if (style === 'horns') {
        pivot.position.set(side * 0.19, 0.33, 0.04);
        base = { x: -0.15, z: -side * 0.3 };
        const geo = new THREE.ConeGeometry(0.06, 0.25, 16, 10);
        const pos = geo.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          const y = pos.getY(i) + 0.125; // 0 at the base, 0.25 at the tip
          pos.setX(i, pos.getX(i) + side * 0.95 * y * y);
          pos.setZ(i, pos.getZ(i) - 0.5 * y * y);
        }
        geo.computeVertexNormals();
        const horn = this._mesh(geo, accent, { outline: 0.01 });
        horn.position.y = 0.11;
        pivot.add(horn);
      } else {
        // bunny
        pivot.position.set(side * 0.14, 0.33, -0.05);
        base = { x: -0.14, z: -side * 0.16 };
        const outer = this._mesh(new THREE.CapsuleGeometry(0.075, 0.34, 8, 16), body, { outline: 0.012 });
        outer.scale.z = 0.62;
        outer.position.y = 0.24;
        const innerEar = this._mesh(new THREE.CapsuleGeometry(0.042, 0.26, 6, 12), inner, { shadow: false });
        innerEar.scale.z = 0.35;
        innerEar.position.set(0, 0.24, 0.036);
        pivot.add(outer, innerEar);
      }
      pivot.userData.base = base;
      pivot.userData.side = side;
      pivot.rotation.set(base.x, 0, base.z);
    }
    this.earLift = style === 'bunny' ? 0.62 : style === 'horns' ? 0.36 : 0.3;
  }

  _buildTail(style) {
    if (this.tailGroup) this._disposeGroup(this.tailGroup);
    const { body, accent } = this.mats;
    this.tailGroup = new THREE.Group();
    this.tailGroup.position.set(0, 0.27, -0.31);
    this.bodyGroup.add(this.tailGroup);
    this.tailSegments = [];
    this.tailStyle = style;
    if (style === 'long') {
      let parent = this.tailGroup;
      for (let i = 0; i < 7; i++) {
        const seg = new THREE.Group();
        seg.position.set(0, i === 0 ? 0 : 0.028, i === 0 ? -0.02 : -0.07);
        seg.rotation.x = -0.3;
        const tip = i === 6;
        const r = tip ? 0.066 : lerp(0.058, 0.038, i / 6);
        seg.add(this._mesh(new THREE.SphereGeometry(r, 14, 10), tip ? accent : body, { outline: 0.009 }));
        parent.add(seg);
        this.tailSegments.push(seg);
        parent = seg;
      }
    } else if (style === 'star') {
      const stem = this._mesh(new THREE.CylinderGeometry(0.022, 0.03, 0.22, 10), body, { outline: 0.008 });
      stem.position.set(0, 0.07, -0.07);
      stem.rotation.x = -0.85;
      const star = this._mesh(new THREE.ExtrudeGeometry(starShape(0.15, 0.068), {
        depth: 0.05, bevelEnabled: true, bevelThickness: 0.018, bevelSize: 0.018, bevelSegments: 2, curveSegments: 4,
      }), accent, { outline: 0.01 });
      star.geometry.center();
      star.position.set(0, 0.17, -0.17);
      star.rotation.y = Math.PI / 2;
      this.tailGroup.add(stem, star);
      this.tailSegments.push(star);
    } else {
      // puff
      for (const [x, y, z, r] of [[0, 0, -0.04, 0.13], [0.075, 0.05, -0.02, 0.09], [-0.07, 0.045, -0.02, 0.085]]) {
        const puff = this._mesh(new THREE.SphereGeometry(r, 18, 14), accent, { outline: r > 0.1 ? 0.01 : 0 });
        puff.position.set(x, y, z);
        this.tailGroup.add(puff);
      }
    }
  }

  _applyProportions() {
    const bs = this.appearance.bodyScale;
    const hs = this.appearance.headScale;
    const bodyTop = (BODY_CY + BODY_R * BODY_H) * bs;
    const headCenterY = bodyTop + 0.25 * hs;
    this.dims = {
      bs,
      hs,
      bodyTop,
      headCenterY,
      headTopY: headCenterY + HEAD_R * 0.94 * hs,
    };
    this.headGroup.scale.setScalar(hs);
    this.feetGroup.scale.setScalar(0.85 + 0.15 * bs);
  }

  /** Live appearance updates from the customizer (colours, ears, tail, proportions). */
  setAppearance(a) {
    const prev = this.appearance;
    this.appearance = { ...a };
    if (a.bodyColor !== prev.bodyColor) {
      this.mats.body.color.set(a.bodyColor);
      this.mats.feet.color.set(shadeHex(a.bodyColor, -0.07));
    }
    if (a.accentColor !== prev.accentColor) this.mats.accent.color.set(a.accentColor);
    if (a.cheekColor !== prev.cheekColor) {
      this.mats.inner.color.set(shadeHex(a.cheekColor, 0.08));
      this.face.setCheekColor(a.cheekColor);
    }
    if (a.earStyle !== this.earStyle) this._buildEars(a.earStyle);
    if (a.tailStyle !== this.tailStyle) this._buildTail(a.tailStyle);
    this._applyProportions();
  }

  /** One-shot reaction animation (adapted to the current pose and reduced motion). */
  playEmote(name) {
    if (!name) return;
    const w = this.anim.w;
    let n = name;
    const bouncy = ['hop', 'jump', 'spin'].includes(n);
    if (w.sleep > 0.5 && n !== 'stretch') n = null;
    else if ((w.bath > 0.5 || w.sit > 0.5) && bouncy) n = 'wiggle';
    else if ((w.play > 0.5 || w.draw > 0.5 || w.eat > 0.5 || w.attend > 0.5) && bouncy) n = 'nod';
    if (n && this.reducedMotion && (n === 'spin' || n === 'jump')) n = 'hop';
    if (!n) return;
    const dur = { hop: 0.45, jump: 0.7, spin: 0.95, wiggle: 0.8, shake: 0.75, nod: 0.6, stretch: 1.1 }[n] ?? 0.6;
    this.anim.emote = { name: n, t: 0, dur };
  }

  /** Arm press for a played note (0 = pet's left arm, 1 = right arm). */
  pressKey(armIndex) {
    this.anim.press[armIndex === 0 ? 0 : 1] = 1;
  }

  /** Rotation that points arm `i` from its shoulder toward a world-space target. */
  _aimArm(i, target) {
    const pivot = this.armPivots[i];
    const d = this.bodyGroup.worldToLocal(this._v1.copy(target)).sub(pivot.position).normalize();
    return { x: clamp(Math.atan2(-d.z, -d.y), -2.7, 0.6), z: clamp(Math.asin(clamp(d.x, -1, 1)), -1.25, 1.25) };
  }

  _emote(e, dt, st) {
    e.t += dt;
    const p = Math.min(1, e.t / e.dur);
    const s = Math.sin(Math.PI * p);
    switch (e.name) {
      case 'hop':
        st.lift += s * 0.2;
        st.sy *= 1 + s * 0.08;
        break;
      case 'jump': {
        const air = clamp((p - 0.15) / 0.7, 0, 1);
        const squash = p < 0.15 ? Math.sin((p / 0.15) * Math.PI) : p > 0.85 ? Math.sin(((p - 0.85) / 0.15) * Math.PI) : 0;
        st.lift += Math.sin(Math.PI * air) * 0.45;
        st.sy *= 1 - 0.16 * squash + 0.1 * Math.sin(Math.PI * air);
        st.sx *= 1 + 0.1 * squash;
        st.arms[0].z += 1.1 * Math.sin(Math.PI * air);
        st.arms[1].z -= 1.1 * Math.sin(Math.PI * air);
        break;
      }
      case 'spin':
        st.lift += s * 0.3;
        st.rotY += easeInOut(p) * TAU;
        break;
      case 'wiggle':
        st.rotZ += Math.sin(p * TAU * 3) * 0.22 * (1 - p);
        break;
      case 'shake':
        st.headYaw += Math.sin(p * TAU * 3) * 0.42 * (1 - p);
        break;
      case 'nod':
        st.headPitch += Math.sin(p * TAU * 2) * 0.22 * (1 - p);
        break;
      case 'stretch':
        st.sy *= 1 + 0.14 * s;
        st.headPitch -= 0.3 * s;
        st.arms[0] = { x: lerp(st.arms[0].x, -2.8, s), z: lerp(st.arms[0].z, 0.25, s) };
        st.arms[1] = { x: lerp(st.arms[1].x, -2.8, s), z: lerp(st.arms[1].z, -0.25, s) };
        break;
      default:
        break;
    }
    return p >= 1;
  }

  /** Where the head wants to look (world point) or null for a free glance. */
  _lookTarget(act, ctx, dt) {
    const a = this.anim;
    a.glanceTimer -= dt;
    if (a.glanceTimer <= 0) {
      const camChance = act === 'idle' ? 0.55 : act === 'playing_music' ? 0.35 : act === 'drawing' ? 0.15 : 0.75;
      a.glance = { cam: Math.random() < camChance, yaw: (Math.random() - 0.5) * 1.5, pitch: (Math.random() - 0.5) * 0.35 };
      a.glanceTimer = 1.4 + Math.random() * 2.6;
    }
    if (ctx.lookAt) return ctx.lookAt; // a scripted focus: the friend it is jamming with, the shared canvas
    if (act === 'lesson' && ctx.cameraPosition) return ctx.cameraPosition; // attending to you, the teacher
    if (act === 'drawing' && ctx.penTarget && !a.glance.cam) return ctx.penTarget;
    if (act === 'playing_music' && ctx.keyTargets && !a.glance.cam) return ctx.keyTargets[0] ?? null;
    if (a.glance.cam && ctx.cameraPosition && act !== 'walking' && act !== 'eating') return ctx.cameraPosition;
    return null;
  }

  /**
   * Per-frame animation.
   * @param {number} dt seconds
   * @param {object} view  simulation snapshot: position, heading, elevation, activity,
   *                       walkSpeed, expression, bubble
   * @param {object} ctx   scene context: cameraPosition, penTarget, keyTargets[2],
   *                       beat (music beats), listenBeat, paintColor
   */
  update(dt, view, ctx = {}) {
    const a = this.anim;
    const reduced = this.reducedMotion;
    const act = view.activity;
    a.t += dt;

    // Locomotion: follow the simulation; hop when it jumps (into the tub, onto the bed).
    const goal = this._v2.set(view.position.x, view.elevation ?? 0, view.position.z);
    if (!a.init) {
      a.pos.copy(goal);
      a.goal.copy(goal);
      a.heading = view.heading;
      a.init = true;
    }
    if (goal.distanceTo(a.goal) > 0.3) {
      a.hop = { from: a.pos.clone(), to: goal.clone(), t: 0, dur: reduced ? 0.3 : 0.5, h: 0.4 + 0.6 * Math.abs(goal.y - a.pos.y) };
    }
    a.goal.copy(goal);
    if (a.hop) {
      a.hop.t += dt / a.hop.dur;
      const p = Math.min(1, a.hop.t);
      a.pos.lerpVectors(a.hop.from, a.hop.to, easeInOut(p));
      a.hopY = Math.sin(Math.PI * p) * a.hop.h;
      if (p >= 1) a.hop = null;
    } else {
      a.pos.x = damp(a.pos.x, goal.x, 16, dt);
      a.pos.z = damp(a.pos.z, goal.z, 16, dt);
      a.pos.y = damp(a.pos.y, goal.y, 10, dt);
      a.hopY = 0;
    }
    let heading = view.heading;
    if ((act === 'idle' || act === 'lesson') && ctx.cameraPosition) {
      heading = Math.atan2(ctx.cameraPosition.x - a.pos.x, ctx.cameraPosition.z - a.pos.z); // turns to look at you
    }
    a.heading = dampAngle(a.heading, heading, act === 'walking' || a.hop ? 10 : 3.5, dt);
    this.root.position.set(a.pos.x, a.pos.y + a.hopY, a.pos.z);
    this.root.rotation.y = a.heading;

    // Pose weights blend smoothly between activities.
    const W = a.w;
    const k = 1 - Math.exp(-dt * 7);
    const blend = (key, on) => {
      W[key] += ((on ? 1 : 0) - W[key]) * k;
    };
    blend('walk', act === 'walking');
    blend('sleep', act === 'sleeping');
    blend('bath', act === 'bathing');
    blend('sit', act === 'listening');
    blend('play', act === 'playing_music');
    blend('draw', act === 'drawing');
    blend('eat', act === 'eating');
    blend('attend', act === 'lesson');

    const st = {
      lift: 0, rotX: 0, rotY: 0, rotZ: 0, sx: 1, sy: 1, sz: 1, headYaw: 0, headPitch: 0, headRoll: 0,
      arms: [{ x: 0.05, z: 0.3 }, { x: 0.05, z: -0.3 }],
    };
    const feet = [{ y: 0, z: 0 }, { y: 0, z: 0 }];
    let earDroop = 0;
    let tailAmp = 0.28;
    let tailSpeed = 3.2;
    let munch = 0;

    const breath = Math.sin(a.t * (W.sleep > 0.5 ? 1.5 : 2.5));
    st.sy += breath * (0.016 + 0.022 * W.sleep);
    st.sx -= breath * 0.007;

    if (W.walk > 0.01) {
      a.walkPhase += dt * (view.walkSpeed ?? 1.2) * 5.6;
      const s = Math.sin(a.walkPhase);
      const ww = W.walk;
      const bounce = Math.abs(s) * 0.075 * ww;
      st.lift += bounce;
      st.rotZ += s * 0.08 * ww;
      st.rotX += 0.07 * ww;
      st.sy += bounce * 0.5;
      feet[0].z += s * 0.11 * ww;
      feet[0].y += Math.max(0, s) * 0.06 * ww;
      feet[1].z -= s * 0.11 * ww;
      feet[1].y += Math.max(0, -s) * 0.06 * ww;
      st.arms[0].x += s * 0.55 * ww;
      st.arms[1].x -= s * 0.55 * ww;
      tailSpeed += 3 * ww;
    }

    // Head look (eased), suppressed while asleep.
    const look = this._lookTarget(act, ctx, dt);
    let wantYaw = 0;
    let wantPitch = 0;
    if (look) {
      const hx = look.x - a.pos.x;
      const hy = look.y - (a.pos.y + this.dims.headCenterY);
      const hz = look.z - a.pos.z;
      const yawWorld = Math.atan2(hx, hz);
      wantYaw = Math.atan2(Math.sin(yawWorld - a.heading), Math.cos(yawWorld - a.heading));
      wantPitch = -Math.atan2(hy, Math.hypot(hx, hz));
    } else if (act !== 'walking') {
      wantYaw = a.glance.yaw;
      wantPitch = a.glance.pitch;
    }
    // Stage "cheat": when watching the brush or keys the head turns only part-way
    // and the eyes do the rest, so the face stays readable from the camera.
    const cheat = look && look !== ctx.cameraPosition ? (act === 'drawing' ? 0.5 : act === 'playing_music' ? 0.4 : 1) : 1;
    a.headYaw = damp(a.headYaw, clamp(wantYaw * cheat, -1.0, 1.0), 5, dt);
    a.headPitch = damp(a.headPitch, clamp(wantPitch * cheat, -0.45, 0.5), 5, dt);
    const awake = 1 - W.sleep;
    st.headYaw += a.headYaw * awake;
    st.headPitch += a.headPitch * awake;

    // Sleeping curl.
    if (W.sleep > 0.001) {
      const w = W.sleep;
      st.lift -= 0.17 * w;
      st.sy *= 1 - 0.2 * w;
      st.sx *= 1 + 0.12 * w;
      st.sz *= 1 + 0.08 * w;
      st.rotX += 0.04 * w;
      st.rotZ += 0.16 * w;
      st.headPitch += 0.08 * w;
      st.headYaw += 0.12 * w;
      st.headRoll += 0.5 * w;
      st.arms[0] = { x: lerp(st.arms[0].x, -0.7, w), z: lerp(st.arms[0].z, 0.05, w) };
      st.arms[1] = { x: lerp(st.arms[1].x, -0.7, w), z: lerp(st.arms[1].z, -0.05, w) };
      feet[0].z += 0.06 * w;
      feet[1].z += 0.06 * w;
      earDroop += w;
      tailAmp *= 1 - 0.85 * w;
      tailSpeed *= 1 - 0.6 * w;
    }
    // Sitting: listening on the rug or soaking in the tub.
    const sitW = Math.max(W.sit, W.bath);
    if (sitW > 0.001) {
      st.lift -= 0.07 * sitW;
      st.sy *= 1 - 0.05 * sitW;
      st.rotX -= 0.06 * sitW;
      for (const f of feet) {
        f.z += 0.13 * sitW;
        f.y += 0.03 * sitW;
      }
    }
    if (W.sit > 0.001) {
      const beat = ctx.listenBeat ?? a.t * 1.2;
      st.rotZ += Math.sin(beat * Math.PI) * 0.06 * W.sit;
      st.headRoll += Math.sin(a.t * 1.1) * 0.2 * W.sit;
      earDroop -= 0.3 * W.sit;
    }
    if (W.bath > 0.001) {
      st.rotZ += Math.sin(a.t * 1.7) * 0.07 * W.bath;
      const splash = Math.max(0, Math.sin(a.t * 0.9)) ** 6 * W.bath;
      st.arms[0] = { x: lerp(st.arms[0].x, -2.3 + Math.sin(a.t * 9) * 0.25, splash), z: lerp(st.arms[0].z, 0.5, splash) };
      st.arms[1] = { x: lerp(st.arms[1].x, -2.3 + Math.sin(a.t * 9 + 1) * 0.25, splash), z: lerp(st.arms[1].z, -0.5, splash) };
    }
    // Attending a lesson: head tilted, ears perked, leaning in with paws together, bobbing to the beat.
    if (W.attend > 0.001) {
      const w = W.attend;
      const beat = ctx.listenBeat ?? a.t * 1.1;
      st.headRoll += (0.24 + Math.sin(a.t * 1.3) * 0.06) * w;
      st.rotX += 0.06 * w;
      st.lift += Math.abs(Math.sin(beat * Math.PI)) * 0.025 * w;
      st.rotZ += Math.sin(beat * Math.PI) * 0.03 * w;
      earDroop -= 0.45 * w;
      st.arms[0] = { x: lerp(st.arms[0].x, -0.62, w), z: lerp(st.arms[0].z, 0.08, w) };
      st.arms[1] = { x: lerp(st.arms[1].x, -0.62, w), z: lerp(st.arms[1].z, -0.08, w) };
      tailSpeed += 2.5 * w;
    }
    // Eating: head dips to the bowl while munching.
    if (W.eat > 0.001) {
      const chew = Math.max(0, Math.sin(a.t * 8));
      st.headPitch += (0.3 + chew * 0.1) * W.eat;
      munch = (0.12 + 0.4 * chew) * W.eat;
      st.arms[0] = { x: lerp(st.arms[0].x, -0.55, W.eat), z: lerp(st.arms[0].z, 0.12, W.eat) };
      st.arms[1] = { x: lerp(st.arms[1].x, -0.55, W.eat), z: lerp(st.arms[1].z, -0.12, W.eat) };
      tailSpeed += 2 * W.eat;
    }
    // Music: arms reach for the keys, head bobs on the beat.
    if (W.play > 0.001) {
      const beat = ctx.beat ?? a.t * 2;
      const bob = Math.sin(beat * TAU);
      st.headPitch += (0.04 + bob * 0.07) * W.play;
      st.rotZ += Math.sin(beat * Math.PI) * 0.05 * W.play;
      st.lift += Math.abs(bob) * 0.015 * W.play;
      for (let i = 0; i < 2; i++) {
        const aim = ctx.keyTargets?.[i] ? this._aimArm(i, ctx.keyTargets[i]) : { x: -1.0, z: i === 0 ? 0.18 : -0.18 };
        st.arms[i] = { x: lerp(st.arms[i].x, aim.x + a.press[i] * 0.32, W.play), z: lerp(st.arms[i].z, aim.z, W.play) };
      }
      tailSpeed += 4 * W.play;
    }
    for (let i = 0; i < 2; i++) a.press[i] = Math.max(0, a.press[i] - dt * 6);
    // Drawing: the brush arm follows the pen on the canvas, the other arm holds the palette.
    if (W.draw > 0.001) {
      const b = this.brushArm;
      const p = this.paletteArm;
      const side = (i) => (i === 0 ? 1 : -1); // outward rotation sign of each arm
      const aim = ctx.penTarget ? this._aimArm(b, ctx.penTarget) : { x: -1.5, z: 0.3 * side(b) };
      st.arms[b] = { x: lerp(st.arms[b].x, aim.x, W.draw), z: lerp(st.arms[b].z, aim.z, W.draw) };
      st.arms[p] = { x: lerp(st.arms[p].x, -0.85, W.draw), z: lerp(st.arms[p].z, 0.5 * side(p), W.draw) };
      st.rotZ += Math.sin(a.t * 2.4) * 0.025 * W.draw;
    }
    this.brush.visible = W.draw > 0.5;
    this.palette.visible = W.draw > 0.5;
    if (ctx.paintColor) this.mats.paint.color.set(ctx.paintColor);

    if (a.emote && this._emote(a.emote, dt, st)) a.emote = null;

    // Ears: springy secondary motion driven by vertical movement.
    const vy = (st.lift + a.hopY - a.prevLift) / Math.max(dt, 1e-3);
    a.prevLift = st.lift + a.hopY;
    a.earVel += ((clamp(-vy * 0.3, -0.6, 0.6) - a.ear) * 90 - a.earVel * 10) * dt;
    a.ear += a.earVel * dt;
    for (const pivot of this.earPivots) {
      const { base, side } = pivot.userData;
      const floppy = this.earStyle === 'bunny' ? 1 : this.earStyle === 'horns' ? 0 : 0.45;
      pivot.rotation.x = base.x + (earDroop * 0.55 + a.ear * 0.3) * floppy;
      pivot.rotation.z = base.z - side * (earDroop * 0.3 + a.ear * 0.18) * floppy;
    }
    // Tail wag.
    if (this.tailStyle === 'long') {
      this.tailSegments.forEach((seg, i) => {
        seg.rotation.y = Math.sin(a.t * tailSpeed - i * 0.55) * tailAmp * 0.55;
        seg.rotation.x = -0.3 - 0.12 * W.sleep;
      });
      this.tailGroup.rotation.y = 0;
    } else {
      this.tailGroup.rotation.y = Math.sin(a.t * tailSpeed) * tailAmp;
      this.tailGroup.rotation.z = this.tailStyle === 'star' ? Math.sin(a.t * 2.1) * 0.15 : 0;
    }

    // Apply.
    const { bs } = this.dims;
    this.pose.position.y = st.lift;
    this.pose.rotation.set(st.rotX, st.rotY, st.rotZ);
    this.bodyGroup.scale.set(bs * st.sx, bs * st.sy, bs * st.sz);
    this.headPivot.position.set(0, this.dims.headCenterY * (1 + (st.sy - 1) * 0.85), 0.02);
    this.headPivot.rotation.set(st.headPitch, st.headYaw, st.headRoll);
    this.armPivots.forEach((p, i) => p.rotation.set(st.arms[i].x, 0, st.arms[i].z));
    this.feet.forEach((f, i) => {
      f.position.y = 0.05 + feet[i].y;
      f.position.z = 0.05 + feet[i].z;
    });

    this.face.setExpression(view.expression ?? 'neutral');
    this.face.update(dt, {
      lookX: clamp(wantYaw * 0.35 + (wantYaw - a.headYaw) * 0.9, -1, 1) * awake,
      lookY: clamp(wantPitch * 0.6 + (wantPitch - a.headPitch) * 1.4, -1, 1) * awake,
      munch,
    });
    this.bubble.set(view.bubble ?? null);
    this.bubble.update(dt, this.dims.headTopY + this.earLift * this.dims.hs * 0.7 + 0.34 + st.lift, reduced);
  }

  /** World position just above the head (for Zzz, hearts and sparkles). */
  getHeadWorldPosition(target = new THREE.Vector3()) {
    this.headGroup.getWorldPosition(target);
    target.y += HEAD_R * 0.8 * this.dims.hs;
    return target;
  }

  /**
   * World points on the pet's visible outline as seen from `camera`: the
   * head and body edges along the camera's right axis, the ear tips and the
   * feet. Their screen bounds approximate the silhouette far better than the
   * corners of a 3D box, which perspective inflates in close-ups.
   */
  getSilhouettePoints(camera) {
    const right = this._v1.setFromMatrixColumn(camera.matrixWorld, 0).normalize().clone();
    const p = this.root.position;
    const { bs, hs } = this.dims;
    const head = this.headGroup.getWorldPosition(new THREE.Vector3());
    const headR = HEAD_R * hs * 1.06;
    const body = new THREE.Vector3(p.x, p.y + this.pose.position.y + BODY_CY * bs, p.z);
    const bodyR = BODY_R * bs * 1.1;
    const feet = new THREE.Vector3(p.x, p.y, p.z);
    return [
      head.clone().addScaledVector(right, headR),
      head.clone().addScaledVector(right, -headR),
      head.clone().setY(head.y + HEAD_R * 0.94 * hs + this.earLift * hs),
      body.clone().addScaledVector(right, bodyR),
      body.clone().addScaledVector(right, -bodyR),
      feet.clone().addScaledVector(right, 0.26 * bs),
      feet.clone().addScaledVector(right, -0.26 * bs),
      feet,
    ];
  }

  /** Approximate world-space bounding box of the pet (for framing and layout checks). */
  getWorldBox(target = new THREE.Box3()) {
    const p = this.root.position;
    const r = 0.48 * Math.max(this.dims.bs, this.dims.hs);
    const top = this.dims.headTopY + this.earLift * this.dims.hs;
    target.min.set(p.x - r, p.y, p.z - r);
    target.max.set(p.x + r, p.y + top, p.z + r);
    return target;
  }

  dispose() {
    for (const g of this.geometries) g.dispose();
    this.geometries.clear();
    for (const m of Object.values(this.mats)) m.dispose();
    this.face.dispose();
    this.bubble.dispose();
    this.root.removeFromParent();
  }
}
