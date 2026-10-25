/**
 * neural-engine.js: genuine on-device learning for Pet Studio (Iteration 3).
 *
 * LEARNED, NOT AUTHORED. Each pet owns two compact neural networks that are
 * trained here, in the page, with Float32Array tensors, analytic
 * backpropagation and Adam (or momentum SGD). No ML library is used.
 *
 *  - MusicPolicyNet (75 -> 32 tanh -> 26, 3,290 parameters). An
 *    autoregressive next-note model on the eighth-note grid. For every slot
 *    it predicts whether a note starts (onset), its pitch (22 keys, C4..A5),
 *    its duration, its velocity and a tempo modulation, conditioned on the
 *    previous notes, the beat phase, the pet's temperament, the player's
 *    style guidance and a fixed embedding of the lesson being attempted.
 *    Loss: binary and categorical cross-entropy plus squared error.
 *  - StrokePolicyNet (38 -> 40 tanh -> 13, 2,093 parameters). A stroke
 *    deformation and style residual model. Along every stroke it predicts
 *    offsets (tangent, normal) from a smoothed reference path, pen pressure,
 *    width, a colour choice and a steadiness value, conditioned on the
 *    position t along the stroke, fixed stroke features, temperament and
 *    style. Loss: squared error plus cross-entropy terms.
 *
 * Shared fixed parts (never trained): the feature extractors below, the
 * phrase and stroke representations (teaching-core.js), the renderers and
 * the synthesiser. The untrained baseline is a seeded Xavier initialisation
 * whose output biases come from statistics of the bundled starter repertoire
 * (starter phrases and tune templates); its output layer starts at zero, so
 * an untrained network predicts exactly that prior.
 *
 * Training data comes from the teaching memory: demonstrations are the
 * supervised targets (weight 1.0; a visiting friend's demonstration kept as
 * social inspiration weighs 0.5 and never takes the newest-lesson share of a
 * batch from your own lessons); loved creations join as reward-weighted
 * preference examples (never as corrected labels); style nudges add
 * documented style augmentations of each lesson. Held-out notes and stroke
 * samples (1 in 5, chosen by hash before any augmentation) form the
 * validation set. Mini-batches mix the newest lesson with replayed older
 * lessons and preference examples, and an L2 anchor pulls the weights toward
 * the untrained baseline, so a new lesson does not erase earlier ones.
 * A practice session that produces NaN/Infinity, or ends with a validation
 * loss worse than where it started (beyond a margin), is rolled back.
 *
 * Pure ES module: no DOM, deterministic, testable in Node.
 */
import { createRng, hashSeed } from './rng.js';
import {
  sanitizePhrase, sanitizeDrawing, KEY_RANGE, PENTATONIC_SCALE, isPentatonic, DRAW_COLORS, PAPER,
  phraseIsEmpty, drawingIsEmpty, MUSIC_TEMPLATES, roundTo,
} from './teaching-core.js';
import { generateStarterPhrase } from './starter-repertoire.js';
import { sanitizeStyle } from './creative-engine.js';
import { loadVersioned, saveVersioned, removeKeys } from './persist.js';

// ---------------------------------------------------------------------------
// Identity, versions and limits
// ---------------------------------------------------------------------------
export const MODEL_SCHEMA = 'petstudio.model';
export const MODEL_VERSION = 1;
export const MODEL_KEY = 'petstudio.model.v1';
export const MODEL_BACKUP_KEY = 'petstudio.model.v1.bak';
export const MODEL_FUTURE_KEY = 'petstudio.model.future';
export const MODEL_ORPHAN_KEY = 'petstudio.model.orphan';
export const NEURAL_GENERATOR = 'neural-v1';
export const FEATURE_SCHEMA = 'pet-features-v1';
export const BASELINE_ID = 'starter-prior-v1';
export const MODEL_KINDS = Object.freeze(['music', 'drawing']);
export const CHECKPOINT_KINDS = Object.freeze(['untrained', 'pre-sleep', 'latest', 'user']);
export const MODEL_LIMITS = Object.freeze({ checkpoints: 5, userCheckpoints: 2, history: 240, lessonKeys: 32, maxWeight: 1000, prefsPerKind: 8 });
/** Blend schedule: alpha = (1 - e^(-steps/ALPHA_TAU)) * (0.25 + 0.75 * familiarity). */
export const ALPHA_TAU = 100;
/** Familiarity with one lesson: 1 - e^(-stepsThatIncludedIt / FAMILIARITY_TAU). */
export const FAMILIARITY_TAU = 40;

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const sigmoid = (x) => (x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x)));
const logit = (p) => Math.log(p / (1 - p));
const ID_RE = /^[a-z0-9-]{3,64}$/i;
const TRAIT_KEYS = Object.freeze(['playful', 'calm', 'curious', 'dramatic', 'stubborn', 'neat', 'chaotic']);

// ---------------------------------------------------------------------------
// Developer settings (configurable in the Inspector)
// ---------------------------------------------------------------------------
export const DEFAULT_SETTINGS = Object.freeze({
  optimizer: 'adam', // 'adam' | 'sgd' (momentum SGD)
  learningRate: 0.008,
  momentum: 0.9,
  batchSize: 24,
  sessionSteps: 240, // most optimizer steps in one practice session
  stepsPerSecond: 16, // practice pacing (and never more than 4 ms of a frame)
  evalEvery: 20, // validation cadence (steps)
  patience: 3, // consecutive worsening checks before a network stops practising
  rollbackMargin: 0.1, // a session may end at most 10% above its starting validation loss
  anchor: 0.0002, // L2 pull toward the untrained baseline (prior anchor)
  clip: 4, // global gradient-norm clip
  holdout: 5, // 1 in N notes / stroke samples is held out for validation
  replayRecent: 0.5, // mini-batch share: newest lesson
  replayOlder: 0.35, // share: replayed older lessons
  replayExtra: 0.15, // share: preference and style examples
});
const SETTING_RULES = Object.freeze({
  learningRate: [1e-4, 0.1], momentum: [0, 0.99], batchSize: [4, 128, true], sessionSteps: [10, 5000, true],
  stepsPerSecond: [1, 5000], evalEvery: [5, 500, true], patience: [1, 50, true], rollbackMargin: [0, 1],
  anchor: [0, 0.1], clip: [0.1, 100], holdout: [3, 10, true], replayRecent: [0, 1], replayOlder: [0, 1], replayExtra: [0, 1],
});

export function sanitizeSettings(s) {
  const src = s && typeof s === 'object' ? s : {};
  const out = { optimizer: src.optimizer === 'sgd' ? 'sgd' : 'adam' };
  for (const [k, [lo, hi, int]] of Object.entries(SETTING_RULES)) {
    let v = clamp(num(src[k], DEFAULT_SETTINGS[k]), lo, hi);
    if (int) v = Math.round(v);
    out[k] = v;
  }
  if (out.replayRecent + out.replayOlder + out.replayExtra <= 0) {
    out.replayRecent = DEFAULT_SETTINGS.replayRecent;
    out.replayOlder = DEFAULT_SETTINGS.replayOlder;
    out.replayExtra = DEFAULT_SETTINGS.replayExtra;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Float32 <-> base64 (little-endian, environment independent)
// ---------------------------------------------------------------------------
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

export function encodeFloat32(arr) {
  const bytes = new Uint8Array(arr.length * 4);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < arr.length; i++) dv.setFloat32(i * 4, arr[i], true);
  const out = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const rest = bytes.length - i;
    const triple = (bytes[i] << 16) | ((rest > 1 ? bytes[i + 1] : 0) << 8) | (rest > 2 ? bytes[i + 2] : 0);
    out.push(B64[(triple >> 18) & 63], B64[(triple >> 12) & 63], rest > 1 ? B64[(triple >> 6) & 63] : '=', rest > 2 ? B64[triple & 63] : '=');
  }
  return out.join('');
}

/** Decodes base64 into a Float32Array of exactly `length` values, or null when malformed. */
export function decodeFloat32(str, length) {
  if (typeof str !== 'string' || !Number.isInteger(length) || length <= 0 || str.length % 4 !== 0) return null;
  const pad = str.endsWith('==') ? 2 : str.endsWith('=') ? 1 : 0;
  const byteLen = (str.length / 4) * 3 - pad;
  if (byteLen !== length * 4) return null;
  const bytes = new Uint8Array(byteLen + 3);
  let j = 0;
  for (let i = 0; i < str.length; i += 4) {
    let triple = 0;
    for (let k = 0; k < 4; k++) {
      const code = str.charCodeAt(i + k);
      let v;
      if (code === 61) {
        if (i + k < str.length - pad) return null; // '=' only as trailing padding
        v = 0;
      } else {
        v = code < 128 ? B64_INDEX[code] : -1;
        if (v < 0) return null;
      }
      triple = (triple << 6) | v;
    }
    bytes[j++] = (triple >> 16) & 255;
    bytes[j++] = (triple >> 8) & 255;
    bytes[j++] = triple & 255;
  }
  const dv = new DataView(bytes.buffer);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

// ---------------------------------------------------------------------------
// A two-layer perceptron on flat Float32Array parameters
// ---------------------------------------------------------------------------
/**
 * y = W2 · tanh(W1 · x + b1) + b2. Parameters live in one Float32Array laid
 * out as [W1 (hidden x in, row-major), b1, W2 (out x hidden), b2]; gradients
 * accumulate in a Float64Array of the same layout.
 */
export class MLP {
  constructor(inDim, hidden, outDim) {
    this.inDim = inDim;
    this.hidden = hidden;
    this.outDim = outDim;
    this.oW1 = 0;
    this.oB1 = hidden * inDim;
    this.oW2 = this.oB1 + hidden;
    this.oB2 = this.oW2 + outDim * hidden;
    this.size = this.oB2 + outDim;
  }

  get dims() {
    return [this.inDim, this.hidden, this.outDim];
  }

  /** Forward pass: hidden activations into h, outputs into y. */
  forward(p, x, h, y) {
    const { inDim, hidden, outDim, oB1, oW2, oB2 } = this;
    for (let j = 0; j < hidden; j++) {
      let s = p[oB1 + j];
      const row = j * inDim;
      for (let i = 0; i < inDim; i++) {
        const xi = x[i];
        if (xi !== 0) s += p[row + i] * xi;
      }
      h[j] = Math.tanh(s);
    }
    for (let k = 0; k < outDim; k++) {
      let s = p[oB2 + k];
      const row = oW2 + k * hidden;
      for (let j = 0; j < hidden; j++) s += p[row + j] * h[j];
      y[k] = s;
    }
  }

  /** Backward pass: adds dL/dθ to g given dL/dy (dy) at input x (dh is scratch). */
  backward(p, x, h, dy, g, dh) {
    const { inDim, hidden, outDim, oB1, oW2, oB2 } = this;
    dh.fill(0);
    for (let k = 0; k < outDim; k++) {
      const d = dy[k];
      if (d === 0) continue;
      g[oB2 + k] += d;
      const row = oW2 + k * hidden;
      for (let j = 0; j < hidden; j++) {
        g[row + j] += d * h[j];
        dh[j] += d * p[row + j];
      }
    }
    for (let j = 0; j < hidden; j++) {
      const dz = dh[j] * (1 - h[j] * h[j]);
      if (dz === 0) continue;
      g[oB1 + j] += dz;
      const row = j * inDim;
      for (let i = 0; i < inDim; i++) {
        const xi = x[i];
        if (xi !== 0) g[row + i] += dz * xi;
      }
    }
  }
}

function bceTerms(p, t) {
  const q = clamp(p, 1e-7, 1 - 1e-7);
  const loss = -(t * Math.log(q) + (1 - t) * Math.log(1 - q));
  // Minus the target's own entropy, so a perfect fit scores 0 (KL divergence).
  const tt = clamp(t, 1e-7, 1 - 1e-7);
  const entropy = t > 0 && t < 1 ? -(tt * Math.log(tt) + (1 - tt) * Math.log(1 - tt)) : 0;
  return loss - entropy;
}

// ---------------------------------------------------------------------------
// Policy networks
// ---------------------------------------------------------------------------
export const MUSIC_SPEC = Object.freeze({
  id: 'music-policy-v1', name: 'MusicPolicyNet', inDim: 75, hidden: 32, outDim: 26,
  inputs: 'previous pitch (23), last interval (2), gap since the last onset (6), beat phase (8), bar (4), phrase position (3), temperament (7), style (2), lesson embedding (20)',
  outputs: 'onset (1), pitch over 22 keys (22), log duration (1), velocity (1), tempo modulation (1)',
});
export const DRAW_SPEC = Object.freeze({
  id: 'stroke-policy-v1', name: 'StrokePolicyNet', inDim: 42, hidden: 40, outDim: 13,
  inputs: 'position t and Fourier features (9), smoothed reference point, tangent and curvature here and either side (7), stroke features (9), colour (8), temperament (7), style (2)',
  outputs: 'normal and tangent offsets (2), pressure (1), log width (1), steadiness (1), colour over 8 paints (8)',
});

/** Input layout of MusicPolicyNet. */
const MI = Object.freeze({ prev: 0, interval: 23, hasInterval: 24, gap: 25, slot: 31, bar: 39, pos: 43, sin: 44, cos: 45, traits: 46, style: 53, lesson: 55 });
/** Output layout of MusicPolicyNet. */
const MO = Object.freeze({ onset: 0, pitch: 1, dur: 23, vel: 24, tempo: 25 });
const KEYS = KEY_RANGE.hi - KEY_RANGE.lo + 1; // 22
/** Input layout of StrokePolicyNet. */
const DI = Object.freeze({ t: 0, fourier: 1, ref: 9, tangent: 11, curv: 13, index: 16, length: 17, closed: 18, bbox: 19, centroid: 21, width: 23, dot: 24, color: 25, traits: 33, style: 40 });
/** Curvature is also read this far (in t) either side of each sample, for corner context. */
const CURV_SPAN = 0.04;
/** Output layout of StrokePolicyNet. */
const DO = Object.freeze({ dn: 0, dt: 1, pressure: 2, width: 3, steady: 4, color: 5 });
/** Stroke offsets are predicted in units of 2% of the canvas. */
export const OFFSET_SCALE = 0.02;
const BASE_WIDTH = 0.022;
const REF_POINTS = 96;
const REF_PASSES = 4;
/** Onset logit of the authored prior in the blend: the scale of a trained, smoothed network (logit 0.95). */
const PRIOR_ONSET = 3;
/** The network gets its full blend weight once it is this sure: onset |2p - 1| and top pitch probability. */
const CONFIDENT_ONSET = 0.8;
const CONFIDENT_PITCH = 0.6;

export class PolicyNet {
  constructor(spec, head) {
    this.spec = spec;
    this.head = head;
    this.mlp = new MLP(spec.inDim, spec.hidden, spec.outDim);
    this.size = this.mlp.size;
    this.params = new Float32Array(this.size);
    this.base = new Float32Array(this.size); // untrained baseline θ0
    this.m = new Float32Array(this.size);
    this.v = new Float32Array(this.size);
    this.t = 0; // Adam step counter
    this.steps = 0; // optimizer steps reflected in the current weights
    this.grad = new Float64Array(this.size);
    this.h = new Float64Array(spec.hidden);
    this.dh = new Float64Array(spec.hidden);
    this.y = new Float64Array(spec.outDim);
    this.dy = new Float64Array(spec.outDim);
  }

  /** Seeded Xavier init; zero output layer; output biases = the starter prior. */
  initBaseline(seed, priorBias) {
    const rng = createRng(hashSeed(seed));
    const { inDim, hidden, outDim, oB1, oW2, oB2 } = this.mlp;
    const p = this.base;
    p.fill(0);
    const lim = Math.sqrt(6 / (inDim + hidden));
    for (let i = 0; i < oB1; i++) p[i] = (rng.next() * 2 - 1) * lim;
    for (let i = oW2; i < oB2; i++) p[i] = 0;
    priorBias(p.subarray(oB2, oB2 + outDim));
    this.params.set(p);
    this.resetOptimizer();
    this.steps = 0;
  }

  resetOptimizer() {
    this.m.fill(0);
    this.v.fill(0);
    this.t = 0;
  }

  forward(x, y = this.y) {
    this.mlp.forward(this.params, x, this.h, y);
    return y;
  }

  /** Weighted mean loss of a batch; accumulates its gradient into this.grad. */
  lossAndGrad(batch) {
    const { mlp, params: p, grad: g, h, y, dy, dh, head } = this;
    let W = 0;
    for (const e of batch) W += e.w;
    if (!(W > 0)) return 0;
    let total = 0;
    for (const e of batch) {
      mlp.forward(p, e.x, h, y);
      const l = head.loss(y, e, dy);
      const s = e.w / W;
      total += s * l;
      for (let k = 0; k < dy.length; k++) dy[k] *= s;
      mlp.backward(p, e.x, h, dy, g, dh);
    }
    return total;
  }

  /** Weighted mean loss without gradients (validation). */
  evalLoss(examples) {
    if (!examples.length) return null;
    const { mlp, params: p, h, y, dy, head } = this;
    let W = 0;
    let total = 0;
    for (const e of examples) {
      mlp.forward(p, e.x, h, y);
      total += e.w * head.loss(y, e, dy);
      W += e.w;
    }
    return W > 0 ? total / W : null;
  }

  /** One optimizer update from this.grad (prior anchor, norm clip, Adam or momentum SGD). Returns the gradient norm. */
  update(settings) {
    const { grad: g, params: p, base: p0, m, v } = this;
    const n = this.size;
    const anchor = settings.anchor;
    if (anchor > 0) for (let i = 0; i < n; i++) g[i] += anchor * (p[i] - p0[i]);
    let norm = 0;
    for (let i = 0; i < n; i++) norm += g[i] * g[i];
    norm = Math.sqrt(norm);
    const scale = norm > settings.clip ? settings.clip / norm : 1;
    const lr = settings.learningRate;
    if (settings.optimizer === 'sgd') {
      const mu = settings.momentum;
      for (let i = 0; i < n; i++) {
        m[i] = mu * m[i] + g[i] * scale;
        p[i] -= lr * m[i];
      }
    } else {
      this.t += 1;
      const b1 = 0.9;
      const b2 = 0.999;
      const c1 = 1 - b1 ** this.t;
      const c2 = 1 - b2 ** this.t;
      for (let i = 0; i < n; i++) {
        const gi = g[i] * scale;
        m[i] = b1 * m[i] + (1 - b1) * gi;
        v[i] = b2 * v[i] + (1 - b2) * gi * gi;
        p[i] -= (lr * (m[i] / c1)) / (Math.sqrt(v[i] / c2) + 1e-8);
      }
    }
    return norm;
  }

  isFinite() {
    const p = this.params;
    for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) return false;
    return true;
  }

  norm() {
    let s = 0;
    for (let i = 0; i < this.size; i++) s += this.params[i] * this.params[i];
    return Math.sqrt(s);
  }

  deltaNorm(ref = this.base) {
    let s = 0;
    for (let i = 0; i < this.size; i++) {
      const d = this.params[i] - ref[i];
      s += d * d;
    }
    return Math.sqrt(s);
  }
}

/**
 * Label smoothing keeps the networks from becoming confidently wrong on notes
 * they never saw: onset targets are 0.05 / 0.95 and pitch targets put 20% of
 * their mass on the lesson's own note distribution (the pet heard the whole
 * tune; only the note at each position is held out). Losses are reported as
 * KL divergences, so a perfect fit scores 0.
 */
export const SMOOTHING = Object.freeze({ onset: 0.08, pitch: 0.3, color: 0.1 });

/** Softmax cross-entropy against (1 - eps) * onehot(target) + eps * q, minus the target entropy (KL). */
function smoothCE(y, from, n, target, q, eps, dy, scale) {
  let max = -Infinity;
  for (let k = 0; k < n; k++) max = Math.max(max, y[from + k]);
  let sum = 0;
  for (let k = 0; k < n; k++) sum += Math.exp(y[from + k] - max);
  const lse = max + Math.log(sum);
  let L = 0;
  for (let k = 0; k < n; k++) {
    const tk = (1 - eps) * (k === target ? 1 : 0) + eps * (q ? q[k] : 1 / n);
    const logp = y[from + k] - lse;
    dy[from + k] = scale * (Math.exp(logp) - tk);
    if (tk > 0) L += tk * (Math.log(tk) - logp);
  }
  return scale * L;
}

export const MUSIC_HEAD = Object.freeze({
  /** Onset BCE; pitch CE, duration MSE and velocity BCE when a note starts; tempo MSE (smoothed, as KL). */
  loss(y, e, dy) {
    dy.fill(0);
    const po = sigmoid(y[MO.onset]);
    const to = e.onset ? 1 - SMOOTHING.onset : SMOOTHING.onset;
    let L = bceTerms(po, to);
    dy[MO.onset] = po - to;
    if (e.onset) {
      L += smoothCE(y, MO.pitch, KEYS, e.pitch, e.q, SMOOTHING.pitch, dy, 1);
      const dd = y[MO.dur] - e.dur;
      L += 0.25 * dd * dd;
      dy[MO.dur] = 0.5 * dd;
      const pv = sigmoid(y[MO.vel]);
      L += 0.5 * bceTerms(pv, e.vel);
      dy[MO.vel] = 0.5 * (pv - e.vel);
    }
    const dt = y[MO.tempo] - e.tempo;
    L += 2 * dt * dt;
    dy[MO.tempo] = 4 * dt;
    return L;
  },
});

export const DRAW_HEAD = Object.freeze({
  /** Offset MSE, pressure BCE, width MSE, steadiness BCE and colour CE. */
  loss(y, e, dy) {
    dy.fill(0);
    const a = y[DO.dn] - e.dn;
    const b = y[DO.dt] - e.dt;
    let L = 0.5 * (a * a + b * b);
    dy[DO.dn] = a;
    dy[DO.dt] = b;
    const pp = sigmoid(y[DO.pressure]);
    L += 0.5 * bceTerms(pp, e.p);
    dy[DO.pressure] = 0.5 * (pp - e.p);
    const dw = y[DO.width] - e.wid;
    L += 0.5 * dw * dw;
    dy[DO.width] = dw;
    const ps = sigmoid(y[DO.steady]);
    L += 0.3 * bceTerms(ps, e.steady);
    dy[DO.steady] = 0.3 * (ps - e.steady);
    L += smoothCE(y, DO.color, DRAW_COLORS.length, e.color, null, SMOOTHING.color, dy, 0.25);
    return L;
  },
});

// ---------------------------------------------------------------------------
// Shared fixed features: music
// ---------------------------------------------------------------------------
export function traitVector(traits) {
  const v = new Float32Array(TRAIT_KEYS.length);
  TRAIT_KEYS.forEach((k, i) => {
    v[i] = clamp(num(traits?.[k], 0.4), 0, 1);
  });
  return v;
}

const pcOf = (midi) => ((midi % 12) + 12) % 12;

/** Melody on the eighth-note grid: the highest note starting in each slot. */
export function phraseSlots(phrase) {
  const T = phrase.beats * 2;
  const slots = new Array(T).fill(null);
  for (const n of phrase.notes) {
    const s = Math.round(n.beat * 2);
    if (s < 0 || s >= T) continue;
    if (!slots[s] || n.midi > slots[s].midi) slots[s] = n;
  }
  return { T, slots };
}

/** Fixed 20-number description of a lesson phrase (what the pet is attempting). */
export function lessonEmbedding(phrase) {
  const v = new Float32Array(20);
  const notes = phrase.notes;
  let total = 0;
  for (const n of notes) {
    v[pcOf(n.midi)] += n.dur;
    total += n.dur;
  }
  if (total > 0) for (let i = 0; i < 12; i++) v[i] /= total;
  const N = notes.length;
  if (N) {
    let mean = 0;
    let lo = Infinity;
    let hi = -Infinity;
    let dur = 0;
    let vel = 0;
    for (const n of notes) {
      mean += n.midi;
      lo = Math.min(lo, n.midi);
      hi = Math.max(hi, n.midi);
      dur += n.dur;
      vel += n.vel;
    }
    v[12] = (mean / N - 70) / 10;
    v[13] = (hi - lo) / 21;
    v[15] = dur / N / 2;
    v[16] = vel / N;
  }
  v[14] = N / phrase.beats / 2;
  v[17] = (phrase.tempo - 110) / 50;
  v[18] = phrase.beats === 16 ? 1 : 0;
  v[19] = (phrase.hits?.length ?? 0) / phrase.beats / 2;
  return v;
}

function writeMusicInput(x, { t, T, prev, prev2, last, traits, style, lesson }) {
  x.fill(0);
  x[MI.prev + (prev == null ? KEYS : prev - KEY_RANGE.lo)] = 1;
  if (prev != null && prev2 != null) {
    x[MI.interval] = clamp((prev - prev2) / 12, -1, 1);
    x[MI.hasInterval] = 1;
  }
  const gap = last == null ? -1 : t - last;
  x[MI.gap + (gap < 0 ? 5 : gap >= 5 ? 4 : gap - 1)] = 1;
  x[MI.slot + (t % 8)] = 1;
  x[MI.bar + Math.min(3, Math.floor(t / 8))] = 1;
  x[MI.pos] = t / T;
  x[MI.sin] = Math.sin((TAU * t) / T);
  x[MI.cos] = Math.cos((TAU * t) / T);
  x.set(traits, MI.traits);
  x[MI.style] = style.energy;
  x[MI.style + 1] = style.order;
  x.set(lesson, MI.lesson);
}

/** Duration target: log2 of the length in eighth notes (0.5 .. 8). */
const logDur = (beats) => Math.log2(clamp(beats * 2, 0.5, 8));

let musicPriorCache = null;
/** Output biases of the untrained MusicPolicyNet, measured on the bundled starter repertoire. */
export function musicPrior() {
  if (musicPriorCache) return musicPriorCache;
  const phrases = [
    ...MUSIC_TEMPLATES.map((t) => sanitizePhrase(t)),
    ...Array.from({ length: 16 }, (_, i) => sanitizePhrase(generateStarterPhrase({ seed: i + 1 }))),
  ];
  let slots = 0;
  let onsets = 0;
  let dur = 0;
  let vel = 0;
  const counts = new Float64Array(KEYS).fill(1); // add-one smoothing
  for (const ph of phrases) {
    const { T, slots: s } = phraseSlots(ph);
    slots += T;
    for (const n of s) {
      if (!n) continue;
      onsets++;
      counts[n.midi - KEY_RANGE.lo] += 1;
      dur += logDur(n.dur);
      vel += n.vel;
    }
  }
  const total = counts.reduce((a, b) => a + b, 0);
  const logs = [...counts].map((c) => Math.log(c / total));
  const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
  musicPriorCache = Object.freeze({
    onset: onsets / slots,
    pitchLogits: Object.freeze(logs.map((l) => l - mean)),
    logDur: dur / Math.max(1, onsets),
    vel: vel / Math.max(1, onsets),
    phrases: phrases.length,
  });
  return musicPriorCache;
}

function musicPriorBias(b) {
  const pr = musicPrior();
  b[MO.onset] = logit(clamp(pr.onset, 0.05, 0.95));
  pr.pitchLogits.forEach((l, k) => {
    b[MO.pitch + k] = l;
  });
  b[MO.dur] = pr.logDur;
  b[MO.vel] = logit(clamp(pr.vel, 0.05, 0.95));
  b[MO.tempo] = 0;
}

// ---------------------------------------------------------------------------
// Shared fixed features: strokes
// ---------------------------------------------------------------------------
function nearestPaint(hex) {
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return 0;
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const c = rgb(hex);
  let best = 0;
  let bestD = Infinity;
  DRAW_COLORS.forEach((p, i) => {
    const q = rgb(p);
    const d = (c[0] - q[0]) ** 2 + (c[1] - q[1]) ** 2 + (c[2] - q[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/**
 * Fixed geometry of one stroke: arc length, a smoothed reference path
 * (48 evenly spaced points, four [1 2 1]/4 passes with pinned ends), its
 * tangents and curvature, and stroke-level features.
 */
export function strokeGeometry(stroke, index = 0, count = 1) {
  const pts = stroke.points;
  const m = pts.length;
  const cum = new Float64Array(m);
  for (let i = 1; i < m; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const L = m ? cum[m - 1] : 0;
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
    cx += p[0];
    cy += p[1];
  }
  cx /= Math.max(1, m);
  cy /= Math.max(1, m);
  const dot = m < 2 || L < 1e-4;
  const geo = {
    dot, L, cum, pts, m, index, count,
    width: stroke.width,
    color: nearestPaint(stroke.color),
    features: {
      index: count > 1 ? index / (count - 1) : 0,
      length: clamp(L / 1.5, 0, 2),
      closed: dot ? 0 : 1 - clamp(Math.hypot(pts[m - 1][0] - pts[0][0], pts[m - 1][1] - pts[0][1]) / Math.max(1e-6, 0.2 * L), 0, 1),
      bw: maxX - minX,
      bh: maxY - minY,
      cx: cx - 0.5,
      cy: cy - 0.5,
      width: Math.log(clamp(stroke.width, 0.004, 0.08) / BASE_WIDTH),
    },
  };
  if (dot) return geo;
  // Resample evenly by arc length, then smooth into the reference path.
  const R = REF_POINTS;
  const ref = new Float64Array(R * 2);
  for (let k = 0; k < R; k++) {
    const q = polyAt(geo, k / (R - 1));
    ref[2 * k] = q.x;
    ref[2 * k + 1] = q.y;
  }
  const tmp = new Float64Array(R * 2);
  for (let pass = 0; pass < REF_PASSES; pass++) {
    tmp.set(ref);
    for (let k = 1; k < R - 1; k++) {
      ref[2 * k] = (tmp[2 * k - 2] + 2 * tmp[2 * k] + tmp[2 * k + 2]) / 4;
      ref[2 * k + 1] = (tmp[2 * k - 1] + 2 * tmp[2 * k + 1] + tmp[2 * k + 3]) / 4;
    }
  }
  const curv = new Float64Array(R);
  for (let k = 1; k < R - 1; k++) {
    const ax = ref[2 * k] - ref[2 * k - 2];
    const ay = ref[2 * k + 1] - ref[2 * k - 1];
    const bx = ref[2 * k + 2] - ref[2 * k];
    const by = ref[2 * k + 3] - ref[2 * k + 1];
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la < 1e-9 || lb < 1e-9) continue;
    const turn = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
    curv[k] = turn / ((la + lb) / 2);
  }
  curv[0] = curv[1];
  curv[R - 1] = curv[R - 2];
  geo.ref = ref;
  geo.curv = curv;
  return geo;
}

/** Point on the original polyline at arc-length fraction t (with pressure). */
function polyAt(geo, t) {
  const { pts, cum, L, m } = geo;
  if (m === 1 || L <= 0) return { x: pts[0][0], y: pts[0][1], p: pts[0].length > 2 ? pts[0][2] : 0.55 };
  const d = clamp(t, 0, 1) * L;
  let lo = 0;
  let hi = m - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi] - cum[lo];
  const u = seg > 0 ? (d - cum[lo]) / seg : 0;
  const a = pts[lo];
  const b = pts[hi];
  const pa = a.length > 2 ? a[2] : 0.55;
  const pb = b.length > 2 ? b[2] : 0.55;
  return { x: a[0] + (b[0] - a[0]) * u, y: a[1] + (b[1] - a[1]) * u, p: pa + (pb - pa) * u };
}

/** Reference point, unit tangent, normal and curvature at fraction t. */
function frameAt(geo, t) {
  const R = REF_POINTS;
  const u = clamp(t, 0, 1) * (R - 1);
  const k = Math.min(R - 2, Math.floor(u));
  const f = u - k;
  const r = geo.ref;
  const x = r[2 * k] + (r[2 * k + 2] - r[2 * k]) * f;
  const y = r[2 * k + 1] + (r[2 * k + 3] - r[2 * k + 1]) * f;
  let tx = r[2 * k + 2] - r[2 * k];
  let ty = r[2 * k + 3] - r[2 * k + 1];
  const tl = Math.hypot(tx, ty) || 1;
  tx /= tl;
  ty /= tl;
  const curv = geo.curv[k] + (geo.curv[k + 1] - geo.curv[k]) * f;
  return { x, y, tx, ty, nx: -ty, ny: tx, curv };
}

function writeDrawInput(x, geo, t, fr, traits, style) {
  x.fill(0);
  x[DI.t] = t;
  for (let k = 1; k <= 4; k++) {
    x[DI.fourier + 2 * (k - 1)] = Math.sin(TAU * k * t);
    x[DI.fourier + 2 * (k - 1) + 1] = Math.cos(TAU * k * t);
  }
  if (fr) {
    x[DI.ref] = fr.x - 0.5;
    x[DI.ref + 1] = fr.y - 0.5;
    x[DI.tangent] = fr.tx;
    x[DI.tangent + 1] = fr.ty;
    x[DI.curv] = clamp(fr.curv * 0.05, -3, 3);
    x[DI.curv + 1] = clamp(frameAt(geo, t - CURV_SPAN).curv * 0.05, -3, 3);
    x[DI.curv + 2] = clamp(frameAt(geo, t + CURV_SPAN).curv * 0.05, -3, 3);
  } else {
    x[DI.ref] = geo.pts[0][0] - 0.5;
    x[DI.ref + 1] = geo.pts[0][1] - 0.5;
  }
  const f = geo.features;
  x[DI.index] = f.index;
  x[DI.length] = f.length;
  x[DI.closed] = f.closed;
  x[DI.bbox] = f.bw;
  x[DI.bbox + 1] = f.bh;
  x[DI.centroid] = f.cx;
  x[DI.centroid + 1] = f.cy;
  x[DI.width] = f.width;
  x[DI.dot] = geo.dot ? 1 : 0;
  x[DI.color + geo.color] = 1;
  x.set(traits, DI.traits);
  x[DI.style] = style.energy;
  x[DI.style + 1] = style.order;
}

function drawPriorBias(b) {
  b[DO.dn] = 0;
  b[DO.dt] = 0;
  b[DO.pressure] = logit(0.55);
  b[DO.width] = 0;
  b[DO.steady] = -4; // an untrained paw is not steady: the authored placement jitter stays
  for (let k = 0; k < DRAW_COLORS.length; k++) b[DO.color + k] = 0;
}

// ---------------------------------------------------------------------------
// Style augmentation (documented semantics; applied to copies of lessons)
// ---------------------------------------------------------------------------
const SCALE = PENTATONIC_SCALE;
function degreeOf(midi) {
  let best = 0;
  let bestD = Infinity;
  SCALE.forEach((m, i) => {
    const d = Math.abs(m - midi);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/**
 * The phrase played in a given style. calmer: slower (-14% per unit),
 * quick pairs merged, longer and softer notes; livelier: faster, long notes
 * split into eighths, louder; neater: melodic leaps compressed to at most two
 * scale steps; wilder: leaps widened by up to 60%. neater and wilder land on
 * the pentatonic scale. Deterministic.
 */
export function stylePhrase(phrase, prefs) {
  const p = sanitizePhrase(phrase);
  const st = sanitizeStyle(prefs);
  const calm = Math.max(0, -st.energy);
  const lively = Math.max(0, st.energy);
  const neat = Math.max(0, -st.order);
  const wild = Math.max(0, st.order);
  let notes = p.notes.map((n) => ({ ...n }));
  if (calm >= 0.3 && notes.length > 3) {
    const merged = [];
    for (let i = 0; i < notes.length; i++) {
      const a = notes[i];
      const b = notes[i + 1];
      if (b && b.beat - a.beat <= 0.5 + 1e-6 && merged.length + (notes.length - i - 1) >= 3) {
        merged.push({ ...a, dur: b.beat + b.dur - a.beat });
        i++;
      } else {
        merged.push(a);
      }
    }
    notes = merged;
  }
  notes = notes.map((n) => ({ ...n, dur: n.dur * (1 + 0.5 * calm), vel: Math.max(0.22, n.vel * (1 - 0.3 * calm)) }));
  if (lively >= 0.3) {
    const busy = [];
    notes.forEach((n, i) => {
      const next = notes[i + 1];
      const gap = (next ? next.beat : p.beats) - n.beat;
      if (n.dur >= 1 && gap >= 1) {
        busy.push({ ...n, dur: 0.5 });
        busy.push({ beat: n.beat + 0.5, midi: SCALE[clamp(degreeOf(n.midi) + 1, 0, SCALE.length - 1)], dur: 0.5, vel: n.vel * 0.9 });
      } else {
        busy.push(n);
      }
    });
    notes = busy;
  }
  notes = notes.map((n) => ({ ...n, vel: Math.min(1, n.vel * (1 + 0.15 * lively)) }));
  if (neat > 0 || wild > 0) {
    let prevOrig = null;
    let prevNew = null;
    notes = notes.map((n) => {
      const d = degreeOf(n.midi);
      if (prevOrig == null) {
        prevOrig = d;
        prevNew = d;
        return { ...n, midi: SCALE[d] };
      }
      let step = d - prevOrig;
      if (neat > 0 && Math.abs(step) > 2) step = Math.sign(step) * 2;
      if (wild > 0) step = Math.round(step * (1 + 0.6 * wild));
      const nd = clamp(prevNew + step, 0, SCALE.length - 1);
      prevOrig = d;
      prevNew = nd;
      return { ...n, midi: SCALE[nd] };
    });
  }
  const tempo = Math.round(clamp(p.tempo * (1 + 0.14 * st.energy), 60, 160));
  return sanitizePhrase({ tempo, beats: p.beats, notes, hits: p.hits });
}

/** How a drawing target changes in a given style (stroke detail, wobble, pressure, width, steadiness). */
export function strokeStyle(prefs) {
  const st = sanitizeStyle(prefs);
  const calm = Math.max(0, -st.energy);
  const lively = Math.max(0, st.energy);
  const neat = Math.max(0, -st.order);
  const wild = Math.max(0, st.order);
  return {
    detail: (1 - 0.6 * neat) * (1 + 0.6 * wild),
    wobble: wild * 0.012,
    pressure: 1 + 0.15 * lively - 0.2 * calm,
    width: 1 + 0.3 * lively - 0.25 * calm,
    steady: clamp(0.97 - 0.6 * wild, 0.05, 0.97),
  };
}

// ---------------------------------------------------------------------------
// Training data (replay buffer views over teaching memory)
// ---------------------------------------------------------------------------
const isHeldOut = (key, holdout) => hashSeed(key) % holdout === 0;

/** The lesson's own note distribution over the 22 keys (duration-weighted, with a small floor). */
export function keyDistribution(phrase) {
  const q = new Float32Array(KEYS).fill(0.02);
  for (const n of phrase.notes) q[n.midi - KEY_RANGE.lo] += n.dur;
  let s = 0;
  for (let k = 0; k < KEYS; k++) s += q[k];
  for (let k = 0; k < KEYS; k++) q[k] /= s;
  return q;
}

/**
 * Held-out slots of a phrase, stratified: 1 in `holdout` of the slots where
 * a note starts and 1 in `holdout` of the silent ones (rounded down), picked
 * by hash. Decided on the source phrase, so its style copies share it.
 */
export function heldOutSlots(phrase, src, holdout) {
  const { T, slots } = phraseSlots(phrase);
  const pick = (list) => list
    .map((t) => ({ t, h: hashSeed(`${src}|${t}`) }))
    .sort((a, b) => a.h - b.h || a.t - b.t)
    .slice(0, Math.floor(list.length / holdout))
    .map((x) => x.t);
  const notes = [];
  const rests = [];
  for (let t = 0; t < T; t++) (slots[t] ? notes : rests).push(t);
  return new Set([...pick(notes), ...pick(rests)]);
}

function musicExamples(target, ctx, { src, lesson, role, w, style, traits, holdout, out, heldOut }) {
  const tgt = sanitizePhrase(target);
  const { T, slots } = phraseSlots(tgt);
  const lessonVec = lessonEmbedding(ctx);
  const q = keyDistribution(ctx);
  const held = heldOut ?? heldOutSlots(tgt, src, holdout);
  const tempo = clamp(Math.log(tgt.tempo / ctx.tempo), -0.5, 0.5);
  let prev = null;
  let prev2 = null;
  let last = null;
  for (let t = 0; t < T; t++) {
    const x = new Float32Array(MUSIC_SPEC.inDim);
    writeMusicInput(x, { t, T, prev, prev2, last, traits, style, lesson: lessonVec });
    const n = slots[t];
    const ex = {
      x, w, src, lesson, role, q, onset: n ? 1 : 0, pitch: n ? n.midi - KEY_RANGE.lo : 0,
      dur: n ? logDur(n.dur) : 0, vel: n ? clamp(n.vel, 0.02, 0.98) : 0.5, tempo,
    };
    (held.has(t) ? out.val : out.train).push(ex);
    if (n) {
      prev2 = prev;
      prev = n.midi;
      last = t;
    }
  }
}

function drawExamples(drawing, { src, lesson, role, w, style, traits, holdout, out, shape, steady }) {
  const d = sanitizeDrawing(drawing);
  const n = d.strokes.length;
  d.strokes.forEach((s, si) => {
    const geo = strokeGeometry(s, si, n);
    const wid = Math.log(clamp(s.width * shape.width, 0.004, 0.08) / BASE_WIDTH);
    const push = (t, j, dn, dt, p, fr) => {
      const x = new Float32Array(DRAW_SPEC.inDim);
      writeDrawInput(x, geo, t, fr, traits, style);
      const ex = { x, w, src, lesson, role, dn, dt, p: clamp(p * shape.pressure, 0.02, 0.98), wid, color: geo.color, steady };
      (isHeldOut(`${src}|${si}|${j}`, holdout) ? out.val : out.train).push(ex);
    };
    if (geo.dot) {
      const p0 = s.points[0];
      push(0.5, 0, 0, 0, p0.length > 2 ? p0[2] : 0.55, null);
      return;
    }
    const M = clamp(Math.round(geo.L / 0.012), 8, 96);
    const phase = ((hashSeed(`${src}|wobble|${si}`) % 1000) / 1000) * TAU;
    const freq = 2.5 + (si % 3);
    for (let j = 0; j < M; j++) {
      const t = (j + 0.5) / M;
      const fr = frameAt(geo, t);
      const q = polyAt(geo, t);
      const rx = q.x - fr.x;
      const ry = q.y - fr.y;
      let dt = (rx * fr.tx + ry * fr.ty) * shape.detail;
      let dn = (rx * fr.nx + ry * fr.ny) * shape.detail;
      if (shape.wobble > 0) dn += shape.wobble * Math.sin(phase + TAU * freq * t);
      dt /= OFFSET_SCALE;
      dn /= OFFSET_SCALE;
      push(t, j, clamp(dn, -6, 6), clamp(dt, -6, 6), q.p, fr);
    }
  });
}

const NEUTRAL_SHAPE = Object.freeze({ detail: 1, wobble: 0, pressure: 1, width: 1, steady: 0.97 });

/** Content fingerprint of a lesson, so a re-taught identical tune or drawing is recognised. */
export function contentKey(kind, data) {
  const d = kind === 'music' ? sanitizePhrase(data) : sanitizeDrawing(data);
  return `${kind}:${hashSeed(JSON.stringify(kind === 'music' ? [d.tempo, d.beats, d.notes, d.hits] : d.strokes.map((s) => [s.color, s.width, s.points])))}`;
}

/**
 * Builds training and validation examples for both networks from plain data:
 * { lessons: [{ id, kind, createdAt, demo }], loved: [{ id, kind, data, lessonId, reward }],
 *   prefs: { energy, order }, nudgeCounts: { calmer, ... }, traits }.
 * Examples carry their role ('demo' | 'style' | 'pref'), weight and source.
 * A lesson's weight (1 for yours, 0.5 for a visitor's social demonstration)
 * scales its demonstration and style-copy examples. The newest lesson (half
 * of every batch) is your newest one; social lessons are replayed with the
 * older ones. The held-out split is decided per source position before
 * augmentation, so a style copy of a held-out note is held out too.
 */
export function buildDatasets(raw, settings = DEFAULT_SETTINGS) {
  const holdout = settings.holdout ?? DEFAULT_SETTINGS.holdout;
  const traits = traitVector(raw?.traits);
  const prefs = sanitizeStyle(raw?.prefs);
  const neutral = { energy: 0, order: 0 };
  const styled = Math.abs(prefs.energy) >= 0.05 || Math.abs(prefs.order) >= 0.05;
  const nudges = raw?.nudgeCounts ?? {};
  const axisNudges = (prefs.energy !== 0 ? num(nudges.calmer, 0) + num(nudges.livelier, 0) : 0)
    + (prefs.order !== 0 ? num(nudges.neater, 0) + num(nudges.wilder, 0) : 0);
  const styleWeight = clamp(0.35 + 0.1 * axisNudges, 0.35, 0.8);
  const lessons = (raw?.lessons ?? []).filter((l) => l && ID_RE.test(l.id) && (l.kind === 'music' || l.kind === 'drawing'));
  const out = {};
  for (const kind of MODEL_KINDS) {
    const set = { train: [], val: [], lessons: [], newest: null, counts: { demo: 0, style: 0, pref: 0, social: 0 }, styled, styleWeight };
    const ofKind = lessons.filter((l) => l.kind === kind).sort((a, b) => num(a.createdAt, 0) - num(b.createdAt, 0));
    const byId = new Map();
    for (const l of ofKind) {
      const demo = kind === 'music' ? sanitizePhrase(l.demo) : sanitizeDrawing(l.demo);
      if (kind === 'music' ? phraseIsEmpty(demo) : drawingIsEmpty(demo)) continue;
      byId.set(l.id, demo);
      const social = l.source === 'social';
      const lw = clamp(num(l.weight, social ? 0.5 : 1), 0.05, 1);
      set.lessons.push({ id: l.id, title: l.title ?? null, createdAt: num(l.createdAt, 0), key: contentKey(kind, demo), source: social ? 'social' : 'player', weight: lw });
      const before = set.train.length + set.val.length;
      if (kind === 'music') {
        musicExamples(demo, demo, { src: l.id, lesson: l.id, role: 'demo', w: lw, style: neutral, traits, holdout, out: set });
      } else {
        drawExamples(demo, { src: l.id, lesson: l.id, role: 'demo', w: lw, style: neutral, traits, holdout, out: set, shape: NEUTRAL_SHAPE, steady: 0.97 });
      }
      const mid = set.train.length + set.val.length;
      set.counts.demo += mid - before;
      if (styled) {
        if (kind === 'music') {
          musicExamples(stylePhrase(demo, prefs), demo, { src: l.id, lesson: l.id, role: 'style', w: styleWeight * lw, style: prefs, traits, holdout, out: set, heldOut: heldOutSlots(demo, l.id, holdout) });
        } else {
          const shape = strokeStyle(prefs);
          drawExamples(demo, { src: l.id, lesson: l.id, role: 'style', w: styleWeight * lw, style: prefs, traits, holdout, out: set, shape, steady: shape.steady });
        }
        set.counts.style += set.train.length + set.val.length - mid;
      }
      if (social) set.counts.social += set.train.length + set.val.length - before;
    }
    // Your newest lesson keeps the newest-lesson share of every batch; a visitor's lesson leads only when it is all there is.
    const own = set.lessons.filter((x) => x.source !== 'social');
    const lead = own.length ? own : set.lessons;
    set.newest = lead.length ? lead[lead.length - 1].id : null;
    const loved = (raw?.loved ?? []).filter((it) => it && it.kind === kind && ID_RE.test(it.id)).slice(-MODEL_LIMITS.prefsPerKind);
    for (const it of loved) {
      const w = 0.5 * clamp(num(it.reward, 0.6), 0, 1);
      if (!(w > 0)) continue;
      const lesson = it.lessonId && byId.has(it.lessonId) ? it.lessonId : null;
      const before = set.train.length + set.val.length;
      if (kind === 'music') {
        const data = sanitizePhrase(it.data);
        if (phraseIsEmpty(data)) continue;
        musicExamples(data, lesson ? byId.get(lesson) : data, { src: it.id, lesson, role: 'pref', w, style: neutral, traits, holdout, out: set });
      } else {
        const data = sanitizeDrawing(it.data);
        if (drawingIsEmpty(data)) continue;
        drawExamples(data, { src: it.id, lesson, role: 'pref', w, style: neutral, traits, holdout, out: set, shape: NEUTRAL_SHAPE, steady: 0.6 });
      }
      set.counts.pref += set.train.length + set.val.length - before;
    }
    set.groups = {
      recent: set.train.filter((e) => e.role === 'demo' && e.lesson === set.newest),
      older: set.train.filter((e) => e.role === 'demo' && e.lesson !== set.newest),
      extra: set.train.filter((e) => e.role !== 'demo'),
    };
    out[kind] = set;
  }
  return out;
}

/** Mini-batch with replay: newest lesson, older lessons and extra examples by share (empty groups are skipped). */
export function sampleBatch(set, size, rng, settings = DEFAULT_SETTINGS) {
  const groups = [set.groups.recent, set.groups.older, set.groups.extra];
  const shares = [settings.replayRecent, settings.replayOlder, settings.replayExtra].map((s, i) => (groups[i].length ? s : 0));
  const total = shares.reduce((a, b) => a + b, 0);
  const batch = [];
  if (!(total > 0)) return batch;
  for (let b = 0; b < size; b++) {
    let r = rng.next() * total;
    let g = 0;
    while (g < 2 && !(shares[g] > 0 && r < shares[g])) {
      r -= shares[g];
      g++;
    }
    while (!groups[g].length) g = (g + 1) % 3;
    const list = groups[g];
    batch.push(list[Math.floor(rng.next() * list.length) % list.length]);
  }
  return batch;
}

// ---------------------------------------------------------------------------
// The engine: two nets, training, generation, checkpoints, persistence
// ---------------------------------------------------------------------------
function makeNets() {
  const music = new PolicyNet(MUSIC_SPEC, MUSIC_HEAD);
  music.initBaseline(`${BASELINE_ID}:music`, musicPriorBias);
  const drawing = new PolicyNet(DRAW_SPEC, DRAW_HEAD);
  drawing.initBaseline(`${BASELINE_ID}:drawing`, drawPriorBias);
  return { music, drawing };
}

/** Global part of the blend schedule (grows with optimizer steps). */
export const stepConfidence = (steps) => (steps > 0 ? 1 - Math.exp(-steps / ALPHA_TAU) : 0);

/**
 * Blend weight of the learned network: 0 with no training; grows with the
 * network's optimizer steps, scaled by how often this lesson was practised
 * (a lesson it never practised gets a quarter of the weight).
 */
export function alphaSchedule(steps, lessonSteps = null) {
  if (!(steps > 0)) return 0;
  const fam = lessonSteps == null ? 0 : 1 - Math.exp(-Math.max(0, lessonSteps) / FAMILIARITY_TAU);
  return stepConfidence(steps) * (0.25 + 0.75 * fam);
}

const emptyLessonSteps = () => ({ music: {}, drawing: {} });
const copyLessonSteps = (ls) => ({ music: { ...(ls?.music ?? {}) }, drawing: { ...(ls?.drawing ?? {}) } });
const phraseKey = (p) => hashSeed(JSON.stringify([p.tempo, p.beats, p.notes, p.hits])).toString(36);

export class NeuralEngine {
  /**
   * @param {{petId?: string, clock?: () => number, settings?: object}} [opts]
   */
  constructor({ petId = null, clock = () => Date.now(), settings = null } = {}) {
    this.petId = typeof petId === 'string' ? petId : null;
    this.clock = clock;
    this.nets = makeNets();
    this.settings = sanitizeSettings(settings);
    this.lessonSteps = emptyLessonSteps();
    this.totalSteps = 0; // optimizer steps executed on this device (a log; never decreases)
    this.samplesSeen = 0;
    this.sessions = 0;
    this.lastSession = null;
    this.history = [];
    this.createdAt = clock();
    this.checkpoints = [this._untrainedCheckpoint()];
    this.source = null;
    this.data = null;
    this.dataKey = null;
    this.listeners = new Set();
    this.fault = null; // diagnostics hook: { kind: 'nan', atStep } injects a NaN gradient
  }

  get music() {
    return this.nets.music;
  }

  get drawing() {
    return this.nets.drawing;
  }

  get parameterCount() {
    return this.nets.music.size + this.nets.drawing.size;
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(type, payload = {}) {
    for (const fn of this.listeners) {
      try {
        fn({ type, ...payload });
      } catch (err) {
        if (typeof console !== 'undefined') console.error('[neural-engine] listener error', err);
      }
    }
  }

  // ----- data ------------------------------------------------------------------
  /** fn() -> { lessons, loved, prefs, nudgeCounts, traits } (plain data from teaching memory and the gallery). */
  setDataSource(fn) {
    this.source = typeof fn === 'function' ? fn : null;
    this.dataKey = null;
  }

  refreshData(force = false) {
    if (this.frozenData && !force) return this.frozenData; // a practice session judges itself on fixed data
    const raw = this.source?.() ?? { lessons: [], loved: [] };
    const key = JSON.stringify([
      (raw.lessons ?? []).map((l) => l.id), (raw.loved ?? []).map((i) => `${i.id}:${i.reward}`),
      raw.prefs ?? null, raw.nudgeCounts ?? null, TRAIT_KEYS.map((k) => roundTo(num(raw.traits?.[k], 0.4), 3)),
      this.settings.holdout,
    ]);
    if (force || key !== this.dataKey || !this.data) {
      this.data = buildDatasets(raw, this.settings);
      this.dataKey = key;
      // Forget practice counts of lessons the teaching memory no longer keeps (bounded state).
      for (const kind of MODEL_KINDS) {
        const keep = new Set(this.data[kind].lessons.map((l) => l.id));
        for (const id of Object.keys(this.lessonSteps[kind])) if (!keep.has(id)) delete this.lessonSteps[kind][id];
      }
    }
    return this.data;
  }

  /** Pins the current training and validation data (a session's before/after comparison stays fair). */
  freezeData() {
    this.frozenData = null;
    this.frozenData = this.refreshData();
    return this.frozenData;
  }

  thawData() {
    this.frozenData = null;
  }

  hasData(kind = null) {
    const d = this.refreshData();
    return kind ? d[kind].train.length > 0 : MODEL_KINDS.some((k) => d[k].train.length > 0);
  }

  // ----- training --------------------------------------------------------------
  /** One optimizer step on every network (of `only`) that has training data. */
  trainStep({ only = MODEL_KINDS } = {}) {
    const data = this.refreshData();
    const kinds = {};
    let loss = 0;
    let samples = 0;
    const lessons = {};
    for (const kind of MODEL_KINDS) {
      const set = data[kind];
      if (!set.train.length || !only.includes(kind)) continue;
      const r = this._stepKind(kind, set);
      kinds[kind] = r;
      if (!r.ok) return { ok: false, reason: r.reason, kind, kinds };
      loss += r.loss;
      samples += r.batch;
      for (const [id, c] of Object.entries(r.lessons)) lessons[id] = (lessons[id] ?? 0) + c;
    }
    if (!Object.keys(kinds).length) return { ok: false, reason: 'no-data', kinds };
    this.totalSteps += 1;
    this.samplesSeen += samples;
    return { ok: true, step: this.totalSteps, loss, kinds, lessons, samples };
  }

  _stepKind(kind, set) {
    const net = this.nets[kind];
    const rng = createRng(hashSeed(`batch:${kind}:${net.steps}:${this.totalSteps}`));
    const batch = sampleBatch(set, this.settings.batchSize, rng, this.settings);
    net.grad.fill(0);
    const loss = net.lossAndGrad(batch);
    if (this.fault && this.fault.kind === 'nan' && this.totalSteps >= (this.fault.atStep ?? 0)) {
      net.grad[0] = Number.NaN; // injected fault (tests and diagnostics only)
      this.fault = null;
    }
    if (!Number.isFinite(loss)) return { ok: false, reason: 'non-finite-loss' };
    const gnorm = net.update(this.settings);
    if (!net.isFinite()) return { ok: false, reason: 'non-finite-weights' };
    net.steps += 1;
    const counts = {};
    for (const e of batch) if (e.lesson) counts[e.lesson] = (counts[e.lesson] ?? 0) + 1;
    const ls = this.lessonSteps[kind];
    for (const id of Object.keys(counts)) ls[id] = (ls[id] ?? 0) + 1;
    return { ok: true, loss, gnorm, batch: batch.length, lessons: counts };
  }

  /**
   * computeValidationLoss(): deterministic loss on the held-out notes and
   * stroke samples (no gradients). `perLesson` covers demonstrations only, so
   * older lessons double as a retention check.
   */
  computeValidationLoss() {
    const data = this.refreshData();
    const out = { music: null, drawing: null, total: null, perLesson: {}, counts: {} };
    let sum = 0;
    let any = false;
    for (const kind of MODEL_KINDS) {
      const val = data[kind].val;
      out.counts[kind] = val.length;
      if (!val.length) continue;
      const net = this.nets[kind];
      const l = net.evalLoss(val);
      out[kind] = l;
      sum += l;
      any = true;
      const groups = new Map();
      for (const e of val) {
        if (e.role !== 'demo' || !e.lesson) continue;
        if (!groups.has(e.lesson)) groups.set(e.lesson, []);
        groups.get(e.lesson).push(e);
      }
      for (const [id, list] of groups) out.perLesson[id] = net.evalLoss(list);
    }
    out.total = any ? sum : null;
    return out;
  }

  /** Mean loss over the whole training set (deterministic; diagnostics and tests). */
  computeTrainingLoss() {
    const data = this.refreshData();
    const out = { music: null, drawing: null, total: null };
    let sum = 0;
    let any = false;
    for (const kind of MODEL_KINDS) {
      const l = this.nets[kind].evalLoss(data[kind].train);
      if (l == null) continue;
      out[kind] = l;
      sum += l;
      any = true;
    }
    out.total = any ? sum : null;
    return out;
  }

  /** Loss on one lesson's demonstration examples (training and held-out together). */
  lessonLoss(kind, lessonId) {
    const set = this.refreshData()[kind];
    const list = [...set.train, ...set.val].filter((e) => e.lesson === lessonId && e.role === 'demo');
    return this.nets[kind].evalLoss(list);
  }

  // ----- blend confidence --------------------------------------------------------
  stepsFor(kind) {
    return this.nets[kind]?.steps ?? 0;
  }

  familiarity(kind, lessonId) {
    const s = lessonId ? this.lessonSteps[kind]?.[lessonId] ?? 0 : 0;
    return 1 - Math.exp(-s / FAMILIARITY_TAU);
  }

  /** How strongly the learned network steers an attempt (0 = authored only). */
  alphaFor(kind, lessonId = null) {
    return alphaSchedule(this.stepsFor(kind), lessonId ? this.lessonSteps[kind]?.[lessonId] ?? 0 : null);
  }

  /**
   * The practised lesson whose content is identical to `data` (a re-taught
   * tune or drawing is recognised), preferring the most practised one.
   */
  practisedLessonFor(kind, data) {
    const key = contentKey(kind, data);
    let best = null;
    for (const l of this.refreshData()[kind].lessons) {
      if (l.key !== key) continue;
      const s = this.lessonSteps[kind]?.[l.id] ?? 0;
      if (!best || s > best.steps) best = { id: l.id, steps: s };
    }
    return best?.id ?? null;
  }

  // ----- generation ----------------------------------------------------------------
  /**
   * Autoregressive phrase generation. With `prior` (the authored attempt)
   * every decision blends logits: (1 - alpha) * prior + alpha * network.
   * alpha = 1 without a prior is the pure network output. A note starts when
   * the blended onset logit beats a small seeded threshold (so only uncertain
   * slots differ between seeds); pitches are sampled at a temperament-
   * dependent temperature. Percussion comes from the prior (or the lesson):
   * the network models the melody.
   */
  composeMusic(lesson, { seed = 1, prefs, traits, alpha = 1, prior = null, temperature = null, unpractised = null } = {}) {
    const src = sanitizePhrase(lesson);
    const net = this.nets.music;
    const alphaAll = clamp(num(alpha, 1), 0, 1);
    const T = src.beats * 2;
    const style = sanitizeStyle(prefs);
    const tv = traitVector(traits);
    const lessonVec = lessonEmbedding(src);
    const pr = prior ? sanitizePhrase(prior) : null;
    const pslots = pr ? phraseSlots(pr).slots : null;
    const temp = temperature ?? clamp(0.55 + 0.35 * tv[6] - 0.2 * tv[5], 0.3, 0.95);
    const rng = createRng(hashSeed(`neural:music:${seed >>> 0}:${phraseKey(src)}`));
    const x = new Float32Array(MUSIC_SPEC.inDim);
    const y = new Float64Array(MUSIC_SPEC.outDim);
    const logits = new Float64Array(KEYS);
    let prev = null;
    let prev2 = null;
    let last = null;
    let logTempo = 0;
    const notes = [];
    for (let t = 0; t < T; t++) {
      writeMusicInput(x, { t, T, prev, prev2, last, traits: tv, style, lesson: lessonVec });
      net.forward(x, y);
      if (t === 0) logTempo = y[MO.tempo];
      // Positions held out for validation were never practised: like an unpractised lesson, a quarter of the weight.
      const a = pslots && unpractised?.has(t) ? alphaAll * 0.25 : alphaAll;
      const pn = pslots ? pslots[t] : null;
      const onPrior = pslots ? (pn ? PRIOR_ONSET : -PRIOR_ONSET) : 0;
      // Confidence-weighted blend: where the network is unsure (a note it never
      // practised, say) its weight shrinks and the authored prior decides.
      const aOn = pslots ? a * clamp(Math.abs(2 * sigmoid(y[MO.onset]) - 1) / CONFIDENT_ONSET, 0, 1) : a;
      const threshold = (rng.next() * 2 - 1) * 0.6;
      if ((1 - aOn) * onPrior + aOn * y[MO.onset] <= threshold) continue;
      let aPitch = a;
      if (pslots) {
        let mx = -Infinity;
        for (let k = 0; k < KEYS; k++) mx = Math.max(mx, y[MO.pitch + k]);
        let z = 0;
        for (let k = 0; k < KEYS; k++) z += Math.exp(y[MO.pitch + k] - mx);
        aPitch = a * clamp((1 / z - 1 / KEYS) / (CONFIDENT_PITCH - 1 / KEYS), 0, 1);
      }
      let max = -Infinity;
      for (let k = 0; k < KEYS; k++) {
        const midi = KEY_RANGE.lo + k;
        let p = 0;
        if (pslots) {
          if (pn) p = -1.2 * Math.abs(midi - pn.midi);
          else p = (prev != null ? -0.35 * Math.abs(midi - prev) : 0) + (isPentatonic(midi) ? 0.8 : 0);
        }
        logits[k] = ((1 - aPitch) * p + aPitch * y[MO.pitch + k]) / temp;
        if (logits[k] > max) max = logits[k];
      }
      let sum = 0;
      for (let k = 0; k < KEYS; k++) sum += Math.exp(logits[k] - max);
      let r = rng.next() * sum;
      let pick = KEYS - 1;
      for (let k = 0; k < KEYS; k++) {
        r -= Math.exp(logits[k] - max);
        if (r <= 0) {
          pick = k;
          break;
        }
      }
      const midi = KEY_RANGE.lo + pick;
      const beat = t / 2;
      const netDur = 2 ** clamp(y[MO.dur], -1, 3) / 2;
      const dur = pn ? (1 - aPitch) * pn.dur + aPitch * netDur : netDur;
      const netVel = sigmoid(y[MO.vel]);
      const vel = pn ? (1 - aPitch) * pn.vel + aPitch * netVel : netVel;
      notes.push({
        beat,
        midi,
        dur: roundTo(clamp(Math.round(dur * 4) / 4, 0.25, Math.min(4, src.beats - beat)), 3),
        vel: roundTo(clamp(vel, 0.12, 1), 3),
      });
      prev2 = prev;
      prev = midi;
      last = t;
    }
    const baseTempo = pr ? pr.tempo : src.tempo;
    const logRatio = (1 - alphaAll) * Math.log(baseTempo / src.tempo) + alphaAll * clamp(logTempo, -0.5, 0.5);
    const tempo = Math.round(clamp(src.tempo * Math.exp(logRatio), 60, 160));
    return sanitizePhrase({ tempo, beats: src.beats, notes, hits: pr ? pr.hits : src.hits });
  }

  /**
   * Learned stroke corrections for a drawing, in its own coordinates: per
   * point offsets from each lesson point to the network's reconstruction,
   * plus pressure, width, colour (with confidence) and the drawing's
   * steadiness. Long strokes are evaluated at 48 positions and interpolated.
   */
  drawingResiduals(drawing, { prefs, traits } = {}) {
    const src = sanitizeDrawing(drawing);
    const net = this.nets.drawing;
    const style = sanitizeStyle(prefs);
    const tv = traitVector(traits);
    const x = new Float32Array(DRAW_SPEC.inDim);
    const y = new Float64Array(DRAW_SPEC.outDim);
    const nColors = DRAW_COLORS.length;
    const n = src.strokes.length;
    let steadySum = 0;
    let steadyN = 0;
    const strokes = src.strokes.map((s, si) => {
      const geo = strokeGeometry(s, si, n);
      const m = s.points.length;
      const dx = new Float32Array(m);
      const dy = new Float32Array(m);
      const pressure = new Float32Array(m);
      const colorP = new Float64Array(nColors);
      let wSum = 0;
      let count = 0;
      const evalAt = (t) => {
        const fr = geo.dot ? null : frameAt(geo, t);
        writeDrawInput(x, geo, t, fr, tv, style);
        net.forward(x, y);
        let mx = -Infinity;
        for (let k = 0; k < nColors; k++) mx = Math.max(mx, y[DO.color + k]);
        let sum = 0;
        for (let k = 0; k < nColors; k++) sum += Math.exp(y[DO.color + k] - mx);
        for (let k = 0; k < nColors; k++) colorP[k] += Math.exp(y[DO.color + k] - mx) / sum;
        wSum += y[DO.width];
        steadySum += sigmoid(y[DO.steady]);
        steadyN++;
        count++;
        return {
          px: fr ? fr.x + OFFSET_SCALE * (y[DO.dt] * fr.tx + y[DO.dn] * fr.nx) : geo.pts[0][0],
          py: fr ? fr.y + OFFSET_SCALE * (y[DO.dt] * fr.ty + y[DO.dn] * fr.ny) : geo.pts[0][1],
          p: sigmoid(y[DO.pressure]),
        };
      };
      if (geo.dot) {
        const r = evalAt(0.5);
        for (let i = 0; i < m; i++) pressure[i] = r.p;
      } else {
        const K = Math.max(2, Math.min(m, REF_POINTS));
        const samples = [];
        for (let k = 0; k < K; k++) samples.push(evalAt(k / (K - 1)));
        for (let i = 0; i < m; i++) {
          const u = (geo.L > 0 ? geo.cum[i] / geo.L : 0) * (K - 1);
          const k = Math.min(K - 2, Math.max(0, Math.floor(u)));
          const f = u - k;
          const A = samples[k];
          const B = samples[k + 1];
          dx[i] = A.px + (B.px - A.px) * f - s.points[i][0];
          dy[i] = A.py + (B.py - A.py) * f - s.points[i][1];
          pressure[i] = A.p + (B.p - A.p) * f;
        }
      }
      let best = 0;
      let total = 0;
      for (let k = 0; k < nColors; k++) {
        total += colorP[k];
        if (colorP[k] > colorP[best]) best = k;
      }
      return {
        dx, dy, pressure,
        width: clamp(BASE_WIDTH * Math.exp(clamp(wSum / Math.max(1, count), -2, 2)), 0.005, 0.07),
        color: DRAW_COLORS[best],
        colorConf: total > 0 ? colorP[best] / total : 0,
      };
    });
    return { strokes, steadiness: steadyN ? steadySum / steadyN : 0 };
  }

  /** The network's own reconstruction of a drawing (alpha = 1, no authored hand): live previews. */
  reconstructDrawing(drawing, { prefs, traits } = {}) {
    const src = sanitizeDrawing(drawing);
    const res = this.drawingResiduals(src, { prefs, traits });
    let t = 0;
    const strokes = src.strokes.map((s, si) => {
      const r = res.strokes[si];
      const points = s.points.map((p, i) => [clamp(p[0] + r.dx[i], 0, 1), clamp(p[1] + r.dy[i], 0, 1), r.pressure[i], i ? 0.02 : 0]);
      const stroke = { color: r.colorConf > 0.3 ? r.color : s.color, width: r.width, points, t0: t, dur: 0.3 };
      t += 0.35;
      return stroke;
    });
    return sanitizeDrawing({ paper: src.paper ?? PAPER, strokes });
  }

  // ----- statistics -----------------------------------------------------------------
  stats() {
    const net = (kind) => {
      const n = this.nets[kind];
      return {
        name: n.spec.name, id: n.spec.id, dims: n.mlp.dims, parameters: n.size, norm: n.norm(), deltaNorm: n.deltaNorm(),
        steps: n.steps, confidence: stepConfidence(n.steps), mode: n.steps > 0 ? NEURAL_GENERATOR : 'authored',
      };
    };
    return {
      music: net('music'), drawing: net('drawing'), parameters: this.parameterCount,
      totalSteps: this.totalSteps, samplesSeen: this.samplesSeen, sessions: this.sessions,
      norm: Math.hypot(this.nets.music.norm(), this.nets.drawing.norm()),
      deltaNorm: this.distanceTo(null),
    };
  }

  /** ‖θ − θref‖ over both networks (θref from a checkpoint or snapshot; defaults to the baseline). */
  distanceTo(ref = null) {
    let s = 0;
    for (const kind of MODEL_KINDS) {
      const r = ref?.params?.[kind] ?? ref?.nets?.[kind]?.params ?? this.nets[kind].base;
      s += this.nets[kind].deltaNorm(r) ** 2;
    }
    return Math.sqrt(s);
  }

  architecture() {
    const net = (n) => ({ id: n.spec.id, name: n.spec.name, dims: n.mlp.dims, activation: 'tanh', parameters: n.size, inputs: n.spec.inputs, outputs: n.spec.outputs });
    return {
      featureSchema: FEATURE_SCHEMA, baseline: BASELINE_ID, generator: NEURAL_GENERATOR, dtype: 'float32',
      music: net(this.nets.music), drawing: net(this.nets.drawing), parameters: this.parameterCount, optimizer: this.settings.optimizer,
    };
  }

  // ----- snapshots and checkpoints ---------------------------------------------------
  /** In-memory copy of the live state (weights, step counters, optimizer). */
  snapshot() {
    const nets = {};
    for (const kind of MODEL_KINDS) {
      const n = this.nets[kind];
      nets[kind] = { params: n.params.slice(), m: n.m.slice(), v: n.v.slice(), t: n.t, steps: n.steps };
    }
    return { nets, lessonSteps: copyLessonSteps(this.lessonSteps) };
  }

  restoreSnapshot(snap) {
    for (const kind of MODEL_KINDS) this.restoreNet(kind, snap);
  }

  /** Restores one network (weights, optimizer, step counters) from a snapshot. */
  restoreNet(kind, snap) {
    const s = snap.nets[kind];
    const n = this.nets[kind];
    n.params.set(s.params);
    n.m.set(s.m);
    n.v.set(s.v);
    n.t = s.t;
    n.steps = s.steps;
    this.lessonSteps[kind] = { ...(snap.lessonSteps?.[kind] ?? {}) };
  }

  _untrainedCheckpoint() {
    return {
      id: 'untrained', name: 'Untrained baseline', kind: 'untrained', createdAt: this.createdAt ?? 0,
      steps: { music: 0, drawing: 0 }, lessonSteps: emptyLessonSteps(), valLoss: null, params: null, adam: null,
    };
  }

  /** Captures the live weights as a named checkpoint (pre-sleep and latest replace their predecessor). */
  createCheckpoint(kind, { name = null, valLoss = null, withOptimizer = kind === 'latest' } = {}) {
    if (!CHECKPOINT_KINDS.includes(kind) || kind === 'untrained') return null;
    const at = this.clock();
    this._cpSeq = (this._cpSeq ?? 0) + 1;
    const cp = {
      id: kind === 'user' ? `user-${Math.floor(at).toString(36)}-${this._cpSeq.toString(36)}` : kind,
      name: name ?? (kind === 'pre-sleep' ? 'Before practice' : kind === 'latest' ? 'Latest' : 'Saved snapshot'),
      kind,
      createdAt: at,
      steps: { music: this.nets.music.steps, drawing: this.nets.drawing.steps },
      lessonSteps: copyLessonSteps(this.lessonSteps),
      valLoss: Number.isFinite(valLoss) ? valLoss : null,
      params: { music: this.nets.music.params.slice(), drawing: this.nets.drawing.params.slice() },
      adam: withOptimizer
        ? Object.fromEntries(MODEL_KINDS.map((k) => [k, { m: this.nets[k].m.slice(), v: this.nets[k].v.slice(), t: this.nets[k].t }]))
        : null,
    };
    if (kind === 'user') {
      const users = this.checkpoints.filter((c) => c.kind === 'user');
      if (users.length >= MODEL_LIMITS.userCheckpoints) {
        const drop = users[0].id;
        this.checkpoints = this.checkpoints.filter((c) => c.id !== drop);
      }
    } else {
      this.checkpoints = this.checkpoints.filter((c) => c.kind !== kind);
    }
    this.checkpoints.push(cp);
    this._orderCheckpoints();
    this._emit('checkpoint', { checkpoint: this.describeCheckpoint(cp) });
    return cp;
  }

  _orderCheckpoints() {
    const rank = { untrained: 0, 'pre-sleep': 1, latest: 2, user: 3 };
    this.checkpoints.sort((a, b) => rank[a.kind] - rank[b.kind] || a.createdAt - b.createdAt);
    this.checkpoints = this.checkpoints.slice(0, MODEL_LIMITS.checkpoints);
  }

  getCheckpoint(id) {
    return this.checkpoints.find((c) => c.id === id) ?? null;
  }

  describeCheckpoint(cp) {
    return {
      id: cp.id, name: cp.name, kind: cp.kind, createdAt: cp.createdAt, steps: { ...cp.steps },
      valLoss: cp.valLoss, hasOptimizer: !!cp.adam, bytes: cp.params ? this.parameterCount * 4 * (cp.adam ? 3 : 1) : 0,
    };
  }

  listCheckpoints() {
    return this.checkpoints.map((c) => this.describeCheckpoint(c));
  }

  /** Loads a checkpoint into the live weights (counters follow; Adam resumes only when it was saved). */
  applyCheckpoint(cp) {
    for (const kind of MODEL_KINDS) {
      const n = this.nets[kind];
      if (cp.kind === 'untrained' || !cp.params) n.params.set(n.base);
      else n.params.set(cp.params[kind]);
      const adam = cp.adam?.[kind];
      if (adam) {
        n.m.set(adam.m);
        n.v.set(adam.v);
        n.t = adam.t;
      } else {
        n.resetOptimizer();
      }
      n.steps = cp.steps?.[kind] ?? 0;
    }
    this.lessonSteps = copyLessonSteps(cp.lessonSteps ?? emptyLessonSteps());
  }

  /** Rolls the live model back to a checkpoint, which becomes the latest. */
  rollbackTo(id) {
    const cp = this.getCheckpoint(id);
    if (!cp) return false;
    this.applyCheckpoint(cp);
    const val = this.computeValidationLoss().total;
    if (cp.kind === 'untrained') this.checkpoints = this.checkpoints.filter((c) => c.kind !== 'latest');
    else if (cp.kind !== 'latest') this.createCheckpoint('latest', { valLoss: val });
    this.mark('rollback', val);
    this._emit('rollback', { id, val });
    return true;
  }

  /** Back to the untrained baseline; user snapshots are kept. */
  resetUntrained() {
    this.applyCheckpoint(this._untrainedCheckpoint());
    this.checkpoints = this.checkpoints.filter((c) => c.kind === 'untrained' || c.kind === 'user');
    this.lastSession = null;
    this.mark('reset', this.computeValidationLoss().total);
    this._emit('reset', {});
    return true;
  }

  /** Commits the live weights as the latest checkpoint. */
  commit(valLoss = null) {
    const cp = this.createCheckpoint('latest', { valLoss });
    this._emit('commit', { checkpoint: this.describeCheckpoint(cp) });
    return cp;
  }

  mark(mark, val = null) {
    this.pushHistory({ step: this.totalSteps, train: null, val: Number.isFinite(val) ? val : null, mark });
  }

  pushHistory(entry) {
    this.history.push(entry);
    if (this.history.length > MODEL_LIMITS.history) this.history.splice(0, this.history.length - MODEL_LIMITS.history);
  }

  // ----- persistence ----------------------------------------------------------------
  toJSON(now = this.clock()) {
    const enc = (a) => (a ? encodeFloat32(a) : null);
    return {
      schema: MODEL_SCHEMA,
      version: MODEL_VERSION,
      petId: this.petId,
      createdAt: this.createdAt,
      savedAt: now,
      arch: {
        featureSchema: FEATURE_SCHEMA, baseline: BASELINE_ID, dtype: 'float32',
        music: { id: MUSIC_SPEC.id, dims: this.nets.music.mlp.dims, parameters: this.nets.music.size },
        drawing: { id: DRAW_SPEC.id, dims: this.nets.drawing.mlp.dims, parameters: this.nets.drawing.size },
      },
      settings: { ...this.settings },
      progress: { totalSteps: this.totalSteps, samplesSeen: this.samplesSeen, sessions: this.sessions, lastSession: this.lastSession },
      history: this.history.slice(-MODEL_LIMITS.history).map((h) => ({ ...h })),
      checkpoints: this.checkpoints.filter((c) => c.kind !== 'untrained').map((c) => ({
        id: c.id, name: c.name, kind: c.kind, createdAt: c.createdAt, steps: { ...c.steps },
        lessonSteps: copyLessonSteps(c.lessonSteps), valLoss: c.valLoss,
        params: { music: enc(c.params.music), drawing: enc(c.params.drawing) },
        adam: c.adam ? Object.fromEntries(MODEL_KINDS.map((k) => [k, { m: enc(c.adam[k].m), v: enc(c.adam[k].v), t: c.adam[k].t }])) : null,
      })),
    };
  }

  /** Applies a sanitised record (see sanitizeModelRecord): the latest checkpoint becomes the live weights. */
  restoreRecord(rec) {
    this.createdAt = rec.createdAt ?? this.createdAt;
    this.settings = sanitizeSettings(rec.settings);
    this.totalSteps = rec.progress.totalSteps;
    this.samplesSeen = rec.progress.samplesSeen;
    this.sessions = rec.progress.sessions;
    this.lastSession = rec.progress.lastSession;
    this.history = rec.history;
    this.checkpoints = [this._untrainedCheckpoint(), ...rec.checkpoints];
    this._orderCheckpoints();
    const latest = this.checkpoints.find((c) => c.kind === 'latest');
    this.applyCheckpoint(latest ?? this.checkpoints[0]);
    this.dataKey = null;
  }
}

// ---------------------------------------------------------------------------
// Practice sessions: validation-gated training with rollback
// ---------------------------------------------------------------------------
/** A network ending more than 10% above its best validation loss returns to that best snapshot. */
export const KEEP_BEST_TOLERANCE = 0.1;
/**
 * Below this many held-out samples (one short tune holds out two or three
 * notes) a single note decides the validation loss: it still guards against
 * divergence, but is too noisy to pick an earlier "best" moment.
 */
export const MIN_HELD_OUT_FOR_BEST = 8;
/**
 * Noise allowance (nats) for a held-out set of n examples: about two
 * standard errors of a per-example loss with a spread of one nat. Tiny sets
 * (one short tune holds out two or three notes) cannot judge a 10% change,
 * but divergence and forgetting move the loss far more than this.
 */
export const noiseAllowance = (n) => 2 / Math.sqrt(Math.max(1, n));

/**
 * One practice session over a NeuralEngine. begin() stores the pre-sleep
 * checkpoint and the validation loss of each network; step() runs one
 * optimizer step and validates every `evalEvery` steps (a network whose
 * held-out loss keeps worsening for `patience` checks stops practising, and
 * the session ends when none is left); finish() judges
 * each network on its own held-out set: one that ended clearly above its
 * best returns to its best weights, and one that ended above its starting
 * loss by more than `rollbackMargin` (plus the noise allowance) is rolled
 * back to its pre-sleep weights. NaN or Infinity anywhere rolls the whole
 * session back immediately. The surviving weights become `latest`.
 */
export class PracticeSession {
  constructor(engine, opts = {}) {
    const s = engine.settings;
    this.engine = engine;
    this.maxSteps = Math.max(1, Math.round(num(opts.maxSteps, s.sessionSteps)));
    this.evalEvery = Math.max(1, Math.round(num(opts.evalEvery, s.evalEvery)));
    this.patience = Math.max(1, Math.round(num(opts.patience, s.patience)));
    this.margin = clamp(num(opts.margin, s.rollbackMargin), 0, 1);
    this.status = 'new';
    this.steps = 0;
    this.reason = null;
    this.trainEma = null;
    this.lastBatch = {};
    this.decision = null;
    this.preVal = null;
    this.preKinds = { music: null, drawing: null };
    this.val = null;
  }

  get running() {
    return this.status === 'running';
  }

  begin() {
    const e = this.engine;
    if (!e.hasData()) {
      this.status = 'no-data';
      return { ok: false, reason: 'no-data' };
    }
    e.freezeData();
    const v = e.computeValidationLoss();
    this.preVal = v.total;
    this.preKinds = { music: v.music, drawing: v.drawing };
    this.counts = { ...v.counts };
    this.val = v;
    this.preCheckpoint = e.createCheckpoint('pre-sleep', { valLoss: v.total });
    this.preSnapshot = e.snapshot();
    this.best = {};
    for (const kind of MODEL_KINDS) this.best[kind] = { val: v[kind], snapshot: this.preSnapshot, steps: 0 };
    this.worse = { music: 0, drawing: 0 };
    this.frozen = new Set();
    this.startStep = e.totalSteps;
    this.startedAt = e.clock();
    this.status = 'running';
    e.mark('start', v.total);
    return { ok: true, val: v.total };
  }

  step() {
    if (this.status !== 'running') return { ok: false, done: true, reason: this.status };
    const only = MODEL_KINDS.filter((k) => !this.frozen.has(k));
    const r = this.engine.trainStep({ only });
    if (!r.ok) {
      if (r.reason === 'no-data') {
        this.engine.thawData();
        this.status = 'no-data';
        return { ok: false, done: true, reason: 'no-data' };
      }
      this._rollback('diverged');
      return { ok: false, done: true, reason: 'diverged' };
    }
    this.steps += 1;
    this.trainEma = this.trainEma == null ? r.loss : 0.85 * this.trainEma + 0.15 * r.loss;
    this.lastBatch = r.lessons;
    this.lastLoss = r.loss;
    let evaluated = null;
    if (this.steps % this.evalEvery === 0 || this.steps >= this.maxSteps) {
      evaluated = this.evaluate();
      if (!evaluated.ok) return { ok: false, done: true, reason: 'diverged' };
    }
    if (this.status === 'running' && this.steps >= this.maxSteps) {
      this.status = 'complete';
      this.reason = 'max-steps';
    }
    return { ok: true, done: this.status !== 'running', result: r, evaluated };
  }

  evaluate() {
    const e = this.engine;
    const v = e.computeValidationLoss();
    if (v.total != null && !Number.isFinite(v.total)) {
      this._rollback('diverged');
      return { ok: false };
    }
    this.val = v;
    e.pushHistory({ step: e.totalSteps, train: Number.isFinite(this.trainEma) ? this.trainEma : null, val: v.total, mark: null });
    let snap = null;
    for (const kind of MODEL_KINDS) {
      const b = this.best[kind];
      if (v[kind] == null || this.frozen.has(kind)) continue;
      if (b.val == null || v[kind] < b.val * 0.995 - 1e-9) {
        snap ??= e.snapshot();
        this.best[kind] = { val: v[kind], snapshot: snap, steps: this.steps };
        this.worse[kind] = 0;
      } else if (this.preKinds[kind] != null && v[kind] > this.preKinds[kind] * (1 + this.margin) + noiseAllowance(this.counts?.[kind] ?? 0)) {
        // Worse than before practice: after `patience` such checks in a row this network stops practising.
        this.worse[kind] += 1;
        if (this.worse[kind] >= this.patience) this.frozen.add(kind);
      } else {
        this.worse[kind] = 0;
      }
    }
    const active = MODEL_KINDS.filter((k) => e.refreshData()[k].train.length && !this.frozen.has(k));
    if (!active.length && this.status === 'running') {
      this.status = 'complete';
      this.reason = 'stopped-worsening';
    }
    return { ok: true, val: v };
  }

  _rollback(reason) {
    this.engine.restoreSnapshot(this.preSnapshot);
    this.engine.thawData();
    this.status = 'rolled-back';
    this.reason = reason;
    const kinds = {};
    for (const kind of MODEL_KINDS) kinds[kind] = { decision: 'rolled-back', preVal: this.preKinds[kind], finalVal: this.preKinds[kind] };
    this.decision = { decision: 'rolled-back', reason, preVal: this.preVal, finalVal: this.preVal, steps: this.steps, kinds };
    this.engine.mark('rollback', this.preVal);
    this.engine.lastSession = this._summary();
    this.engine._emit('session', { decision: this.decision });
    return this.decision;
  }

  /** Judges each network, commits the survivors as `latest` (or rolls back). Returns the decision. */
  finish() {
    if (this.decision) return this.decision;
    if (this.status === 'no-data' || this.status === 'new') {
      this.decision = { decision: 'nothing', reason: this.status, steps: 0 };
      return this.decision;
    }
    const e = this.engine;
    if (!this.steps) {
      e.thawData();
      e.mark('end', this.preVal); // closed before any step: nothing was trained
      this.status = 'complete';
      this.decision = { decision: 'nothing', reason: 'no-steps', preVal: this.preVal, finalVal: this.preVal, steps: 0 };
      return this.decision;
    }
    let v = e.computeValidationLoss();
    if (v.total != null && !Number.isFinite(v.total)) return this._rollback('diverged');
    const kinds = {};
    let changed = false;
    for (const kind of MODEL_KINDS) {
      const pre = this.preKinds[kind];
      const best = this.best[kind];
      const slack = noiseAllowance(this.counts?.[kind] ?? 0);
      let final = v[kind];
      let decision = 'committed';
      const enough = (this.counts?.[kind] ?? 0) >= MIN_HELD_OUT_FOR_BEST;
      if (enough && final != null && best.val != null && best.steps > 0 && final > best.val * (1 + KEEP_BEST_TOLERANCE) + slack) {
        e.restoreNet(kind, best.snapshot); // clearly overfitted: keep the best weights seen
        decision = 'kept-best';
        changed = true;
        final = best.val;
      }
      if (final != null && pre != null && final > pre * (1 + this.margin) + slack) {
        e.restoreNet(kind, this.preSnapshot); // worse than before practice: back to the pre-sleep weights
        decision = 'rolled-back';
        changed = true;
        final = pre;
      }
      kinds[kind] = { decision, preVal: pre, finalVal: final, allowance: pre != null ? slack : null };
    }
    if (changed) v = e.computeValidationLoss();
    e.thawData();
    const judged = MODEL_KINDS.filter((k) => this.preKinds[k] != null);
    if (judged.length && judged.every((k) => kinds[k].decision === 'rolled-back')) {
      this.status = 'rolled-back';
      this.reason = 'validation-worse';
      this.decision = { decision: 'rolled-back', reason: 'validation-worse', preVal: this.preVal, finalVal: this.preVal, steps: this.steps, kinds };
      e.mark('rollback', this.preVal);
      e.lastSession = this._summary();
      e._emit('session', { decision: this.decision });
      return this.decision;
    }
    this.status = 'complete';
    e.sessions += 1;
    e.commit(v.total);
    e.mark('commit', v.total);
    this.finalVal = v.total;
    this.decision = { decision: 'committed', reason: this.reason ?? 'finished', preVal: this.preVal, finalVal: v.total, steps: this.steps, kinds };
    e.lastSession = this._summary();
    e._emit('session', { decision: this.decision });
    return this.decision;
  }

  /** Restores the pre-sleep weights and discards the session. */
  cancel() {
    if (this.decision) return this.decision;
    if (this.status === 'new' || this.status === 'no-data') return { decision: 'nothing' };
    this.engine.restoreSnapshot(this.preSnapshot);
    this.engine.thawData();
    this.status = 'cancelled';
    this.decision = { decision: 'cancelled', reason: 'player', preVal: this.preVal, finalVal: this.preVal, steps: this.steps };
    this.engine.mark('cancel', this.preVal);
    this.engine.lastSession = this._summary();
    this.engine._emit('session', { decision: this.decision });
    return this.decision;
  }

  _summary() {
    const d = this.decision ?? {};
    return {
      at: this.engine.clock(), steps: this.steps, decision: d.decision ?? null, reason: d.reason ?? null,
      preVal: Number.isFinite(this.preVal) ? this.preVal : null, finalVal: Number.isFinite(d.finalVal) ? d.finalVal : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Record sanitisation and storage
// ---------------------------------------------------------------------------
function sanitizeLessonSteps(ls) {
  const out = emptyLessonSteps();
  for (const kind of MODEL_KINDS) {
    const src = ls?.[kind] && typeof ls[kind] === 'object' ? ls[kind] : {};
    for (const [id, v] of Object.entries(src).slice(0, MODEL_LIMITS.lessonKeys)) {
      if (ID_RE.test(id) && Number.isInteger(v) && v >= 0) out[kind][id] = Math.min(v, 1e7);
    }
  }
  return out;
}

const validWeights = (a) => {
  if (!a) return false;
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i]) || Math.abs(a[i]) > MODEL_LIMITS.maxWeight) return false;
  return true;
};

function sanitizeCheckpoint(c, sizes) {
  if (!c || typeof c !== 'object' || !CHECKPOINT_KINDS.includes(c.kind) || c.kind === 'untrained') return null;
  if (typeof c.id !== 'string' || !/^[a-z0-9-]{3,48}$/i.test(c.id)) return null;
  const params = {};
  for (const kind of MODEL_KINDS) {
    const arr = decodeFloat32(c.params?.[kind], sizes[kind]);
    if (!validWeights(arr)) return null;
    params[kind] = arr;
  }
  let adam = null;
  if (c.adam && typeof c.adam === 'object') {
    adam = {};
    for (const kind of MODEL_KINDS) {
      const a = c.adam[kind];
      const m = decodeFloat32(a?.m, sizes[kind]);
      const v = decodeFloat32(a?.v, sizes[kind]);
      if (!validWeights(m) || !validWeights(v) || !v.every((x) => x >= 0) || !Number.isInteger(a?.t) || a.t < 0) {
        adam = null;
        break;
      }
      adam[kind] = { m, v, t: Math.min(a.t, 1e7) };
    }
  }
  const steps = {};
  for (const kind of MODEL_KINDS) steps[kind] = Number.isInteger(c.steps?.[kind]) && c.steps[kind] >= 0 ? Math.min(c.steps[kind], 1e7) : 0;
  const name = typeof c.name === 'string' ? c.name.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 32) : '';
  return {
    id: c.id,
    name: name || (c.kind === 'latest' ? 'Latest' : c.kind === 'pre-sleep' ? 'Before practice' : 'Saved snapshot'),
    kind: c.kind,
    createdAt: Number.isFinite(c.createdAt) ? c.createdAt : 0,
    steps,
    lessonSteps: sanitizeLessonSteps(c.lessonSteps),
    valLoss: Number.isFinite(c.valLoss) ? c.valLoss : null,
    params,
    adam,
  };
}

export const MODEL_SIZES = Object.freeze({
  music: new MLP(MUSIC_SPEC.inDim, MUSIC_SPEC.hidden, MUSIC_SPEC.outDim).size,
  drawing: new MLP(DRAW_SPEC.inDim, DRAW_SPEC.hidden, DRAW_SPEC.outDim).size,
});

/**
 * Validates a parsed model record. Throws when the architecture does not
 * match or the `latest` checkpoint is damaged (the loader then falls back to
 * the backup copy); other damaged checkpoints are dropped and counted.
 */
export function sanitizeModelRecord(r) {
  const src = r && typeof r === 'object' ? r : {};
  const arch = src.arch ?? {};
  const same = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
  if (arch.featureSchema !== FEATURE_SCHEMA || arch.music?.id !== MUSIC_SPEC.id || arch.drawing?.id !== DRAW_SPEC.id
    || !same(arch.music?.dims, [MUSIC_SPEC.inDim, MUSIC_SPEC.hidden, MUSIC_SPEC.outDim])
    || !same(arch.drawing?.dims, [DRAW_SPEC.inDim, DRAW_SPEC.hidden, DRAW_SPEC.outDim])) {
    const err = new Error('model architecture mismatch');
    err.reason = 'incompatible';
    throw err;
  }
  const raw = Array.isArray(src.checkpoints) ? src.checkpoints.slice(0, 8) : [];
  const checkpoints = [];
  let dropped = 0;
  for (const c of raw) {
    const clean = sanitizeCheckpoint(c, MODEL_SIZES);
    if (!clean) {
      if (c?.kind === 'latest') throw new Error('latest checkpoint damaged');
      dropped++;
      continue;
    }
    if (clean.kind !== 'user' && checkpoints.some((x) => x.kind === clean.kind)) continue;
    if (checkpoints.some((x) => x.id === clean.id)) continue;
    checkpoints.push(clean);
  }
  const users = checkpoints.filter((c) => c.kind === 'user');
  const keep = new Set(users.slice(-MODEL_LIMITS.userCheckpoints).map((c) => c.id));
  const p = src.progress ?? {};
  const int = (v, max = 1e9) => (Number.isInteger(v) && v >= 0 ? Math.min(v, max) : 0);
  const ls = p.lastSession && typeof p.lastSession === 'object' ? p.lastSession : null;
  return {
    petId: typeof src.petId === 'string' && /^[a-z0-9-]{4,48}$/i.test(src.petId) ? src.petId : null,
    createdAt: Number.isFinite(src.createdAt) ? src.createdAt : null,
    settings: sanitizeSettings(src.settings),
    progress: {
      totalSteps: int(p.totalSteps), samplesSeen: int(p.samplesSeen, 1e12), sessions: int(p.sessions),
      lastSession: ls ? {
        at: Number.isFinite(ls.at) ? ls.at : 0, steps: int(ls.steps, 1e7),
        decision: ['committed', 'rolled-back', 'cancelled', 'nothing'].includes(ls.decision) ? ls.decision : null,
        reason: typeof ls.reason === 'string' ? ls.reason.slice(0, 32) : null,
        preVal: Number.isFinite(ls.preVal) ? ls.preVal : null, finalVal: Number.isFinite(ls.finalVal) ? ls.finalVal : null,
      } : null,
    },
    history: (Array.isArray(src.history) ? src.history : []).slice(-MODEL_LIMITS.history)
      .filter((h) => h && Number.isInteger(h.step) && h.step >= 0)
      .map((h) => ({
        step: Math.min(h.step, 1e9), train: Number.isFinite(h.train) ? h.train : null, val: Number.isFinite(h.val) ? h.val : null,
        mark: ['start', 'partial', 'commit', 'rollback', 'cancel', 'reset', 'end'].includes(h.mark) ? h.mark : null,
      })),
    checkpoints: checkpoints.filter((c) => c.kind !== 'user' || keep.has(c.id)),
    dropped,
  };
}

/**
 * Loads the model of `petId`. Never throws. status: 'loaded' |
 * 'restored-backup' | 'new' | 'future-version' | 'unavailable' |
 * 'other-pet' | 'incompatible' (the old record is kept aside).
 */
export function loadModel(storage, { petId = null, clock } = {}) {
  let incompatible = false;
  const sanitize = (obj) => {
    try {
      return sanitizeModelRecord(obj);
    } catch (err) {
      if (err?.reason === 'incompatible') incompatible = true;
      throw err;
    }
  };
  const res = loadVersioned({
    storage, key: MODEL_KEY, backupKey: MODEL_BACKUP_KEY, futureKey: MODEL_FUTURE_KEY,
    schema: MODEL_SCHEMA, version: MODEL_VERSION, sanitize,
  });
  let { record, status } = res;
  const aside = () => {
    try {
      const raw = storage.getItem(MODEL_KEY);
      if (raw) storage.setItem(MODEL_ORPHAN_KEY, raw);
    } catch {
      /* best effort */
    }
  };
  if (!record && status === 'new' && incompatible) {
    aside();
    status = 'incompatible';
  }
  if (record && petId && record.petId && record.petId !== petId) {
    aside();
    record = null;
    status = 'other-pet';
  }
  const engine = new NeuralEngine({ petId, clock, settings: record?.settings });
  if (record) engine.restoreRecord(record);
  return { engine, status, dropped: record?.dropped ?? 0 };
}

export function saveModel(engine, storage = globalThis.localStorage, now = Date.now()) {
  let json;
  try {
    json = JSON.stringify(engine.toJSON(now));
  } catch (err) {
    return { ok: false, reason: `serialize-failed: ${err?.message ?? err}` };
  }
  let res = saveVersioned({ storage, key: MODEL_KEY, backupKey: MODEL_BACKUP_KEY, json, schema: MODEL_SCHEMA, version: MODEL_VERSION });
  if (!res.ok && res.quota) {
    // Make room by dropping the backup copy, then retry once.
    try {
      storage.removeItem(MODEL_BACKUP_KEY);
    } catch {
      /* ignore */
    }
    res = saveVersioned({ storage, key: MODEL_KEY, backupKey: null, json, schema: MODEL_SCHEMA, version: MODEL_VERSION });
    if (res.ok) res.droppedBackup = true;
  }
  return res;
}

export function clearModel(storage = globalThis.localStorage) {
  return removeKeys(storage, [MODEL_KEY, MODEL_BACKUP_KEY]);
}

// ---------------------------------------------------------------------------
// Compact weights for portable pet snapshots (Iteration 4)
// ---------------------------------------------------------------------------
/**
 * The live weights of both networks in a compact, portable form: base64
 * float32 (lossless), step counts and the architecture identity. No optimizer
 * state, history or lesson data: a snapshot shares the pet, not its lessons.
 * Untrained networks travel as `weights: null` (the baseline is rebuilt).
 */
export function compactWeights(engine) {
  const steps = { music: engine.stepsFor('music'), drawing: engine.stepsFor('drawing') };
  return {
    featureSchema: FEATURE_SCHEMA,
    baseline: BASELINE_ID,
    generator: NEURAL_GENERATOR,
    dims: { music: [...engine.nets.music.mlp.dims], drawing: [...engine.nets.drawing.mlp.dims] },
    parameters: engine.parameterCount,
    steps,
    weights: steps.music + steps.drawing > 0
      ? { music: encodeFloat32(engine.nets.music.params), drawing: encodeFloat32(engine.nets.drawing.params) }
      : null,
  };
}

/**
 * Validates compact weights from an untrusted snapshot: the same feature
 * schema, baseline and layer sizes, exact base64 lengths, and finite values
 * within MODEL_LIMITS.maxWeight. Returns { music, drawing } Float32Arrays, or
 * null when anything is off (the snapshot then travels without weights).
 */
export function decodeCompactWeights(c) {
  if (!c || typeof c !== 'object' || !c.weights || typeof c.weights !== 'object') return null;
  if (c.featureSchema !== FEATURE_SCHEMA || c.baseline !== BASELINE_ID) return null;
  const same = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
  if (!same(c.dims?.music, [MUSIC_SPEC.inDim, MUSIC_SPEC.hidden, MUSIC_SPEC.outDim])
    || !same(c.dims?.drawing, [DRAW_SPEC.inDim, DRAW_SPEC.hidden, DRAW_SPEC.outDim])) return null;
  const out = {};
  for (const kind of MODEL_KINDS) {
    const arr = decodeFloat32(c.weights[kind], MODEL_SIZES[kind]);
    if (!validWeights(arr)) return null;
    out[kind] = arr;
  }
  return out;
}

/**
 * A separate, never-persisted engine holding a visitor's weights (or the
 * untrained baseline when it has none). It only composes the visitor's own
 * pieces and never trains here, so the visitor stays the snapshot it arrived
 * as, and the host's networks are untouched by it.
 */
export function engineFromCompactWeights(c, { clock } = {}) {
  const engine = new NeuralEngine({ clock });
  const w = decodeCompactWeights(c);
  if (w) {
    for (const kind of MODEL_KINDS) {
      const n = engine.nets[kind];
      n.params.set(w[kind]);
      n.steps = Number.isInteger(c.steps?.[kind]) && c.steps[kind] >= 0 ? Math.min(c.steps[kind], 1e7) : 0;
    }
  }
  return engine;
}

/**
 * Plain training data from the teaching memory and the gallery (the replay
 * buffer the trainer reads). Loved and starred creations of the pet are
 * preference examples, never corrected labels.
 */
export function trainingDataFrom(memory, gallery, traits) {
  const lessons = (memory?.lessons ?? []).map((l) => ({
    id: l.id, kind: l.kind, createdAt: l.createdAt, title: l.title, demo: l.demo,
    source: l.source === 'social' ? 'social' : 'player', weight: Number.isFinite(l.weight) ? l.weight : 1,
  }));
  const items = Array.isArray(gallery?.items) ? gallery.items : [];
  const loved = items
    .filter((it) => (it.origin === 'attempt' || it.origin === 'starter') && (it.feedback?.reward > 0 || it.favorite))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((it) => ({ id: it.id, kind: it.kind, data: it.data, lessonId: it.lessonId, reward: it.feedback?.reward > 0 ? it.feedback.reward : 0.6 }));
  return { lessons, loved, prefs: memory?.prefs ?? null, nudgeCounts: memory?.nudgeCounts ?? null, traits };
}
