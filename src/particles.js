/**
 * particles.js: tiny pooled sprite particles for the studio: floating music
 * notes, sleepy Zzz, soap bubbles, hearts, sparkles, snack crumbs and the
 * dreamy notes and sparkles that drift up while the pet practises in its sleep.
 */
import * as THREE from 'three';
import { drawIcon } from './canvas-icons.js';

const TAU = Math.PI * 2;

const KINDS = {
  note: { icon: 'note', size: [0.2, 0.28], life: [1.8, 2.4], vel: [0, 0.55, 0], spread: 0.22, sway: 0.35, grow: 0.15, tint: true },
  zzz: { icon: 'zzz', size: [0.13, 0.18], life: [2.4, 3], vel: [0.1, 0.3, 0.06], spread: 0.04, sway: 0.12, grow: 1.1 },
  bubble: { icon: 'bubble', size: [0.07, 0.17], life: [1.4, 2.4], vel: [0, 0.42, 0], spread: 0.32, sway: 0.3, grow: 0.3, pop: true },
  heart: { icon: 'heart', size: [0.14, 0.2], life: [1.0, 1.4], vel: [0, 0.75, 0], spread: 0.4, sway: 0.2, grow: 0.2 },
  sparkle: { icon: 'sparkle', size: [0.12, 0.2], life: [0.7, 1.0], vel: [0, 0.4, 0], spread: 0.1, sway: 0, grow: -0.3, spin: true, radial: true },
  crumb: { icon: 'dot', size: [0.03, 0.05], life: [0.5, 0.8], vel: [0, 0.45, 0], spread: 0.3, sway: 0, grow: 0, gravity: 2.4, tint: true },
  dreamNote: { icon: 'note', size: [0.1, 0.15], life: [2.6, 3.4], vel: [0.08, 0.24, 0.05], spread: 0.08, sway: 0.28, grow: 0.55, tint: true },
  dreamStar: { icon: 'sparkle', size: [0.09, 0.14], life: [2.2, 3], vel: [0.06, 0.22, 0.06], spread: 0.1, sway: 0.22, grow: 0.35, tint: true, spin: true },
};

const rand = (lo, hi) => lo + Math.random() * (hi - lo);

export class ParticleSystem {
  constructor(scene, { capacity = 90, reducedMotion = false } = {}) {
    this.reduced = reducedMotion;
    this.group = new THREE.Group();
    this.group.name = 'particles';
    scene.add(this.group);
    this.textures = new Map();
    this.pool = [];
    this.active = [];
    const placeholder = this._texture('dot');
    for (let i = 0; i < capacity; i++) {
      const mat = new THREE.SpriteMaterial({ map: placeholder, transparent: true, depthWrite: false });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.raycast = () => {};
      sprite.renderOrder = 12;
      this.group.add(sprite);
      this.pool.push({ sprite, mat, pos: new THREE.Vector3(), vel: new THREE.Vector3() });
    }
  }

  _texture(icon) {
    if (this.textures.has(icon)) return this.textures.get(icon);
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    drawIcon(canvas.getContext('2d'), icon, 64, 64, 100);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.textures.set(icon, tex);
    return tex;
  }

  /** Emits `count` particles of `kind` at a world position. */
  emit(kind, position, { count = 1, tint = null } = {}) {
    const k = KINDS[kind];
    if (!k || !position) return;
    const n = this.reduced ? Math.ceil(count / 2) : count;
    for (let i = 0; i < n; i++) {
      const p = this.pool.pop();
      if (!p) return;
      p.kind = k;
      p.age = 0;
      p.life = rand(...k.life);
      p.size = rand(...k.size);
      p.phase = Math.random() * TAU;
      p.mat.map = this._texture(k.icon);
      p.mat.color.set(k.tint && tint ? tint : '#ffffff');
      p.mat.rotation = 0;
      p.mat.opacity = 0;
      p.pos.set(position.x + rand(-k.spread, k.spread), position.y + rand(-k.spread, k.spread) * 0.4, position.z + rand(-k.spread, k.spread));
      if (k.radial) {
        const a = (i / n) * TAU + Math.random() * 0.4;
        p.vel.set(Math.cos(a) * 1.3, rand(0.2, 0.7), Math.sin(a) * 1.3);
      } else {
        p.vel.set(k.vel[0] + rand(-0.12, 0.12), k.vel[1] * rand(0.8, 1.2), k.vel[2] + rand(-0.12, 0.12));
      }
      p.sprite.visible = true;
      this.active.push(p);
    }
  }

  update(dt) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i];
      p.age += dt;
      const t = p.age / p.life;
      if (t >= 1) {
        p.sprite.visible = false;
        this.active.splice(i, 1);
        this.pool.push(p);
        continue;
      }
      const k = p.kind;
      if (k.gravity) p.vel.y -= k.gravity * dt;
      if (k.radial) p.vel.multiplyScalar(1 - Math.min(0.9, 2.6 * dt));
      p.pos.addScaledVector(p.vel, dt);
      const sway = Math.sin(p.age * 3 + p.phase) * k.sway;
      p.sprite.position.set(p.pos.x + sway * 0.3, p.pos.y, p.pos.z - sway * 0.2);
      let s = p.size * (1 + k.grow * t);
      if (k.pop && t > 0.85) s *= 1 + (t - 0.85) * 4;
      p.sprite.scale.set(s, s, 1);
      p.mat.opacity = Math.min(1, t * 6) * (1 - Math.max(0, (t - 0.7) / 0.3));
      if (k.spin) p.mat.rotation += dt * 3;
    }
  }

  get activeCount() {
    return this.active.length;
  }

  dispose() {
    for (const p of [...this.pool, ...this.active]) p.mat.dispose();
    for (const t of this.textures.values()) t.dispose();
    this.group.removeFromParent();
  }
}
