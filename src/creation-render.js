/**
 * creation-render.js: stateless 2D canvas painters for creations (stroke
 * rendering and phrase visualisation), shared by the Teaching Workshop, the
 * Gallery, the Creation Feedback Bar and the studio wall frame, so a drawing
 * or song looks the same everywhere. Deterministic: same input, same pixels.
 */
import { strokeLength, noteColor, drumByMidi, DRUMS, KEY_RANGE, PAPER } from './teaching-core.js';

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Width multiplier for a segment: real pen pressure when recorded, else a gentle taper. */
export function pressureWidth(a, b, u) {
  if (a.length > 2 && b.length > 2) return 0.55 + 0.9 * ((a[2] + b[2]) / 2);
  return 0.62 + 0.38 * Math.sin(Math.min(1, Math.max(0, u)) * Math.PI);
}

export function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

const paperCache = new Map();

/** Cream paper with faint speckles and a soft border (cached per size). */
export function paintPaper(ctx, size, paper = PAPER, { border = true } = {}) {
  const s = Math.max(8, Math.round(size));
  const key = `${s}|${paper}|${border}`;
  let cached = paperCache.get(key);
  if (!cached) {
    cached = document.createElement('canvas');
    cached.width = s;
    cached.height = s;
    const c = cached.getContext('2d');
    c.fillStyle = paper;
    c.fillRect(0, 0, s, s);
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    c.fillStyle = 'rgba(150, 120, 90, 0.05)';
    const dot = Math.max(1, (1.6 * s) / 512);
    const count = Math.round(900 * (s / 512) ** 2);
    for (let i = 0; i < count; i++) c.fillRect(rand() * s, rand() * s, dot, dot);
    if (border) {
      c.strokeStyle = 'rgba(170, 140, 110, 0.22)';
      c.lineWidth = s * 0.014;
      c.strokeRect(s * 0.012, s * 0.012, s * 0.976, s * 0.976);
    }
    if (paperCache.size > 16) paperCache.clear();
    paperCache.set(key, cached);
  }
  ctx.drawImage(cached, 0, 0, size, size);
}

function paintStroke(ctx, s, size, upTo, len, fast) {
  const pts = s.points;
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  if (pts.length === 1) {
    if (upTo >= len / 2) {
      const p = pts[0];
      const k = p.length > 2 ? 0.55 + 0.9 * p[2] : 1;
      ctx.beginPath();
      ctx.arc(p[0] * size, p[1] * size, Math.max(0.8, (s.width * size * k) / 2), 0, TAU);
      ctx.fill();
    }
    return;
  }
  if (fast) {
    // Small thumbnails: one path per stroke (pressure is invisible at this size).
    ctx.lineWidth = Math.max(1, s.width * size);
    ctx.beginPath();
    ctx.moveTo(pts[0][0] * size, pts[0][1] * size);
    let acc = 0;
    for (let j = 1; j < pts.length; j++) {
      const seg = Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]);
      if (acc + seg > upTo) {
        const t = seg > 0 ? (upTo - acc) / seg : 0;
        ctx.lineTo((pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * t) * size, (pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * t) * size);
        break;
      }
      acc += seg;
      ctx.lineTo(pts[j][0] * size, pts[j][1] * size);
    }
    ctx.stroke();
    return;
  }
  let acc = 0;
  for (let j = 1; j < pts.length && acc < upTo; j++) {
    const a = pts[j - 1];
    const b = pts[j];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (seg <= 0) continue;
    const t = Math.min(1, (upTo - acc) / seg);
    ctx.lineWidth = Math.max(1, s.width * size * pressureWidth(a, b, (acc + (seg * t) / 2) / len));
    ctx.beginPath();
    ctx.moveTo(a[0] * size, a[1] * size);
    ctx.lineTo((a[0] + (b[0] - a[0]) * t) * size, (a[1] + (b[1] - a[1]) * t) * size);
    ctx.stroke();
    acc += seg;
  }
}

/**
 * Paints a drawing into a `size` px square at (x, y), up to `progress`
 * (0..1 of the total stroke length, like the pet's easel).
 */
export function paintDrawing(ctx, drawing, size, { progress = 1, x = 0, y = 0, paper = true, border = true } = {}) {
  ctx.save();
  ctx.translate(x, y);
  if (paper) paintPaper(ctx, size, drawing?.paper ?? PAPER, { border });
  const strokes = drawing?.strokes ?? [];
  if (strokes.length) {
    const lengths = strokes.map(strokeLength);
    const total = lengths.reduce((a, b) => a + b, 0) || 1;
    let budget = clamp(progress, 0, 1) * total;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const fast = size < 140;
    for (let i = 0; i < strokes.length && budget > 1e-9; i++) {
      paintStroke(ctx, strokes[i], size, Math.min(lengths[i], budget), lengths[i], fast);
      budget -= lengths[i];
    }
  }
  ctx.restore();
}

/** Faint dashed guide for tracing a template underneath live strokes. */
export function paintGuide(ctx, drawing, size) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([size * 0.018, size * 0.022]);
  ctx.strokeStyle = 'rgba(143, 124, 240, 0.45)';
  ctx.fillStyle = 'rgba(143, 124, 240, 0.35)';
  ctx.lineWidth = Math.max(2, size * 0.008);
  for (const s of drawing?.strokes ?? []) {
    const p = s.points;
    if (p.length === 1) {
      ctx.beginPath();
      ctx.arc(p[0][0] * size, p[0][1] * size, Math.max(2, s.width * size * 0.5), 0, TAU);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(p[0][0] * size, p[0][1] * size);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0] * size, p[i][1] * size);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Geometry of the piano-roll view (shared by painting and tap hit-testing):
 * notes are pills placed by pitch (y) and time (x); percussion hits are dots
 * in a lane along the bottom, one row per drum.
 */
export function phraseRollLayout(phrase, { w, h, pad = 6, labels = false } = {}) {
  const beats = phrase?.beats ?? 8;
  const laneH = Math.max(10, Math.round(h * 0.24));
  const top = pad + (labels ? 13 : 0);
  const bottom = h - pad - laneH;
  const left = pad;
  const right = w - pad;
  const bw = (right - left) / beats;
  const span = KEY_RANGE.hi - KEY_RANGE.lo;
  const nh = clamp(((bottom - top) / (span + 1)) * 2.4, 3, 11);
  return {
    beats, top, bottom, left, right, bw, laneH, nh,
    noteRect(n) {
      const x = left + n.beat * bw;
      const y = bottom - ((n.midi - KEY_RANGE.lo) / span) * (bottom - top - nh) - nh;
      return { x, y, w: Math.max(nh, n.dur * bw - 1.5), h: nh };
    },
    hitCenter(e) {
      const lane = Math.max(0, DRUMS.findIndex((d) => d.midi === e.midi));
      return { x: left + e.beat * bw + Math.min(bw / 2, 4), y: bottom + 2 + (lane + 0.5) * ((laneH - 4) / DRUMS.length) };
    },
    beatAtX(x) {
      return (x - left) / bw;
    },
  };
}

/**
 * Paints a phrase as a little piano roll with a beat grid, optional beat
 * numbers and a playhead (in beats).
 */
export function paintPhraseRoll(ctx, phrase, { x = 0, y = 0, w, h, playhead = null, labels = false, pad = 6, background = '#ffffff', radius = 10, flash = null } = {}) {
  const L = phraseRollLayout(phrase, { w, h, pad, labels });
  ctx.save();
  ctx.translate(x, y);
  roundRectPath(ctx, 0, 0, w, h, radius);
  ctx.fillStyle = background;
  ctx.fill();
  ctx.save();
  roundRectPath(ctx, 0, 0, w, h, radius);
  ctx.clip();
  for (let b = 4; b < L.beats; b += 8) {
    ctx.fillStyle = 'rgba(143, 124, 240, 0.07)';
    ctx.fillRect(L.left + b * L.bw, 0, Math.min(4, L.beats - b) * L.bw, h);
  }
  ctx.fillStyle = 'rgba(110, 72, 92, 0.05)';
  ctx.fillRect(0, L.bottom + 1, w, h - L.bottom);
  for (let b = 0; b <= L.beats; b++) {
    const gx = Math.round(L.left + b * L.bw) + 0.5;
    ctx.strokeStyle = b % 4 === 0 ? 'rgba(110, 72, 92, 0.26)' : 'rgba(110, 72, 92, 0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(gx, L.top - (labels ? 2 : 0));
    ctx.lineTo(gx, h);
    ctx.stroke();
  }
  if (labels) {
    ctx.fillStyle = 'rgba(118, 97, 122, 0.85)';
    ctx.font = '700 9px ui-rounded, "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let b = 0; b < L.beats; b++) {
      if (L.bw < 14 && b % 2) continue;
      ctx.fillText(String(b + 1), L.left + (b + 0.5) * L.bw, pad - 1);
    }
  }
  for (const n of phrase?.notes ?? []) {
    const r = L.noteRect(n);
    roundRectPath(ctx, r.x, r.y, r.w, r.h, r.h / 2);
    ctx.fillStyle = noteColor(n.midi);
    ctx.globalAlpha = 0.55 + 0.45 * n.vel;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = flash && flash.midi === n.midi && Math.abs(flash.beat - n.beat) < 1e-6 ? '#f0645a' : 'rgba(61, 44, 62, 0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  for (const e of phrase?.hits ?? []) {
    const c = L.hitCenter(e);
    ctx.beginPath();
    ctx.arc(c.x, c.y, clamp(L.laneH / 9, 1.6, 3.6), 0, TAU);
    ctx.fillStyle = drumByMidi(e.midi)?.color ?? '#999';
    ctx.fill();
  }
  if (playhead != null && playhead >= 0 && playhead <= L.beats) {
    const px = L.left + playhead * L.bw;
    ctx.strokeStyle = '#f0645a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
  }
  ctx.restore();
  ctx.restore();
  return L;
}

/** Sizes a canvas backing store for crisp drawing at the device pixel ratio. Returns the ratio. */
export function fitCanvas(canvas, cssW, cssH, maxDpr = 2) {
  const dpr = Math.min(maxDpr, globalThis.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return dpr;
}
