/**
 * drawing-surface.js: progressive vector-stroke renderer (stroke rendering).
 *
 * Paints the normalised stroke representation (see starter-repertoire.js)
 * onto a canvas a little at a time, so the pet visibly draws on the easel
 * instead of swapping in a finished picture. Deterministic: the same drawing
 * at the same progress always produces the same pixels. Taught strokes carry
 * real pen pressure; the stroke styling is shared with creation-render.js so
 * the easel, the workshop canvas, the gallery and the wall frame match.
 */
import { strokeLength } from './starter-repertoire.js';
import { pressureWidth } from './creation-render.js';

export class DrawingSurface {
  constructor(size = 512) {
    this.size = size;
    this.canvas = document.createElement('canvas');
    this.canvas.width = size;
    this.canvas.height = size;
    this.ctx = this.canvas.getContext('2d');
    this.drawing = null;
    this.lengths = [];
    this.total = 1;
    this.drawnLength = 0;
    this.progress = 0;
    this.pen = null;
    this.changed = true;
    this.clear();
  }

  clear(paper = '#fffaf1') {
    const { ctx, size: s } = this;
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, s, s);
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    ctx.fillStyle = 'rgba(150, 120, 90, 0.05)';
    for (let i = 0; i < 900; i++) ctx.fillRect(rand() * s, rand() * s, 1.6, 1.6);
    ctx.strokeStyle = 'rgba(170, 140, 110, 0.22)';
    ctx.lineWidth = s * 0.014;
    ctx.strokeRect(s * 0.012, s * 0.012, s * 0.976, s * 0.976);
    this.pen = null;
    this.changed = true;
  }

  /** Starts a new drawing on blank paper. */
  start(drawing) {
    this.drawing = drawing;
    this.lengths = drawing.strokes.map(strokeLength);
    this.total = this.lengths.reduce((a, b) => a + b, 0) || 1;
    this.drawnLength = 0;
    this.progress = 0;
    this.clear(drawing.paper);
  }

  /** Paints everything up to `progress` (0..1) of the total stroke length. */
  setProgress(progress) {
    if (!this.drawing) return;
    const target = Math.max(0, Math.min(1, progress)) * this.total;
    if (target < this.drawnLength - 1e-9) this.start(this.drawing);
    if (target <= this.drawnLength) return;
    this._paint(this.drawnLength, target);
    this.drawnLength = target;
    this.progress = target / this.total;
    if (this.progress >= 1) this.pen = null;
    this.changed = true;
  }

  /** Shows a drawing at a given progress immediately (e.g. after a reload). */
  show(drawing, progress = 1) {
    this.start(drawing);
    this.setProgress(progress);
  }

  _paint(from, to) {
    const { ctx, size: S } = this;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    let acc = 0;
    const strokes = this.drawing.strokes;
    for (let i = 0; i < strokes.length; i++) {
      const stroke = strokes[i];
      const len = this.lengths[i];
      const s0 = acc;
      acc += len;
      if (acc <= from) continue;
      if (s0 >= to) break;
      ctx.strokeStyle = stroke.color;
      ctx.fillStyle = stroke.color;
      const pts = stroke.points;
      if (pts.length === 1) {
        const mid = s0 + len / 2;
        if (mid > from && mid <= to) {
          ctx.beginPath();
          ctx.arc(pts[0][0] * S, pts[0][1] * S, (stroke.width * S) / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        this.pen = { u: pts[0][0], v: pts[0][1], color: stroke.color };
        continue;
      }
      const a = Math.max(0, from - s0);
      const b = Math.min(len, to - s0);
      let segStart = 0;
      for (let j = 1; j < pts.length && segStart < b; j++) {
        const [x0, y0] = pts[j - 1];
        const [x1, y1] = pts[j];
        const segLen = Math.hypot(x1 - x0, y1 - y0);
        const segEnd = segStart + segLen;
        if (segLen > 0 && segEnd > a) {
          const t0 = Math.max(0, (a - segStart) / segLen);
          const t1 = Math.min(1, (b - segStart) / segLen);
          const u = (segStart + segLen * ((t0 + t1) / 2)) / len;
          // Taught strokes carry real pen pressure; starter strokes taper gently.
          ctx.lineWidth = Math.max(1.5, stroke.width * S * pressureWidth(pts[j - 1], pts[j], u));
          ctx.beginPath();
          ctx.moveTo((x0 + (x1 - x0) * t0) * S, (y0 + (y1 - y0) * t0) * S);
          ctx.lineTo((x0 + (x1 - x0) * t1) * S, (y0 + (y1 - y0) * t1) * S);
          ctx.stroke();
          this.pen = { u: x0 + (x1 - x0) * t1, v: y0 + (y1 - y0) * t1, color: stroke.color };
        }
        segStart = segEnd;
      }
    }
  }
}
