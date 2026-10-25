/**
 * canvas-icons.js: tiny vector icon painter used for the pet's mood bubble and
 * the studio particles (notes, hearts, bubbles, sparkles, Zzz). Drawn with
 * paths instead of emoji fonts so it looks identical on every device.
 */
const TAU = Math.PI * 2;
export const ICON_INK = '#3a2a3e';

function outline(ctx, width) {
  ctx.lineWidth = width;
  ctx.strokeStyle = ICON_INK;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
}

function heartPath(ctx, x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.42);
  ctx.bezierCurveTo(x - s * 0.62, y + s * 0.02, x - s * 0.5, y - s * 0.5, x, y - s * 0.2);
  ctx.bezierCurveTo(x + s * 0.5, y - s * 0.5, x + s * 0.62, y + s * 0.02, x, y + s * 0.42);
  ctx.closePath();
}

function starPath(ctx, x, y, r, inner = 0.45, points = 5, rot = -Math.PI / 2) {
  ctx.beginPath();
  for (let i = 0; i <= points * 2; i++) {
    const a = rot + (i / (points * 2)) * TAU;
    const rr = i % 2 ? r * inner : r;
    if (i === 0) ctx.moveTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
    else ctx.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
  }
  ctx.closePath();
}

function notePath(ctx, x, y, s, color, lw) {
  // Two beamed eighth notes.
  ctx.fillStyle = color;
  const heads = [[x - s * 0.24, y + s * 0.26], [x + s * 0.24, y + s * 0.18]];
  for (const [hx, hy] of heads) {
    ctx.beginPath();
    ctx.ellipse(hx, hy, s * 0.15, s * 0.11, -0.4, 0, TAU);
    ctx.fill();
    outline(ctx, lw);
  }
  ctx.beginPath();
  ctx.moveTo(heads[0][0] + s * 0.13, heads[0][1] - s * 0.02);
  ctx.lineTo(heads[0][0] + s * 0.13, y - s * 0.32);
  ctx.lineTo(heads[1][0] + s * 0.13, y - s * 0.4);
  ctx.lineTo(heads[1][0] + s * 0.13, heads[1][1] - s * 0.02);
  outline(ctx, lw * 1.1);
}

function bubbleIcon(ctx, x, y, s, list, strong) {
  for (const [bx, by, br] of list) {
    const cx = x + bx * s;
    const cy = y + by * s;
    const r = br * s;
    const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.6, 'rgba(178,228,255,0.75)');
    g.addColorStop(1, 'rgba(140,200,255,0.9)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, s * 0.05);
    ctx.strokeStyle = strong ? ICON_INK : 'rgba(90,150,210,0.85)';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(cx - r * 0.38, cy - r * 0.38, r * 0.2, r * 0.13, -0.7, 0, TAU);
    ctx.fill();
  }
}

const PAINTERS = {
  food(ctx, x, y, s, lw) {
    ctx.fillStyle = '#ff6b6b';
    ctx.beginPath();
    ctx.ellipse(x, y + s * 0.07, s * 0.42, s * 0.32, 0, 0, TAU);
    ctx.fill();
    outline(ctx, lw);
    ctx.fillStyle = '#ffd0d0';
    ctx.beginPath();
    ctx.ellipse(x - s * 0.2, y - s * 0.04, s * 0.07, s * 0.1, -0.5, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x, y - s * 0.2);
    ctx.quadraticCurveTo(x + s * 0.02, y - s * 0.36, x + s * 0.08, y - s * 0.42);
    outline(ctx, lw);
    ctx.fillStyle = '#6ccf7f';
    ctx.beginPath();
    ctx.ellipse(x + s * 0.2, y - s * 0.34, s * 0.14, s * 0.07, -0.5, 0, TAU);
    ctx.fill();
    outline(ctx, lw * 0.8);
  },
  bath(ctx, x, y, s) {
    bubbleIcon(ctx, x, y, s, [[-0.15, 0.1, 0.27], [0.2, -0.12, 0.2], [0.18, 0.28, 0.13]], true);
  },
  bubble(ctx, x, y, s) {
    bubbleIcon(ctx, x, y, s, [[0, 0, 0.42]], false);
  },
  sleep(ctx, x, y, s, lw) {
    ctx.fillStyle = '#ffd35c';
    ctx.beginPath();
    ctx.arc(x - s * 0.04, y + s * 0.02, s * 0.36, 0.55 * Math.PI, 1.95 * Math.PI, false);
    ctx.arc(x + s * 0.12, y - s * 0.1, s * 0.27, 1.8 * Math.PI, 0.6 * Math.PI, true);
    ctx.closePath();
    ctx.fill();
    outline(ctx, lw);
    ctx.fillStyle = '#fff1a8';
    starPath(ctx, x + s * 0.28, y + s * 0.24, s * 0.1, 0.45, 4, 0);
    ctx.fill();
  },
  music(ctx, x, y, s, lw) {
    notePath(ctx, x, y, s, '#9a7bff', lw);
  },
  note(ctx, x, y, s, lw) {
    notePath(ctx, x, y, s, '#9a7bff', lw);
  },
  draw(ctx, x, y, s, lw) {
    ctx.fillStyle = '#ff7fa3';
    ctx.beginPath();
    ctx.ellipse(x - s * 0.12, y + s * 0.2, s * 0.26, s * 0.17, -0.3, 0, TAU);
    ctx.fill();
    ctx.translate(x + s * 0.04, y - s * 0.02);
    ctx.rotate(0.7);
    ctx.fillStyle = '#e8b06a';
    ctx.beginPath();
    ctx.roundRect(-s * 0.06, -s * 0.46, s * 0.12, s * 0.5, s * 0.05);
    ctx.fill();
    outline(ctx, lw * 0.9);
    ctx.fillStyle = '#c9ccd6';
    ctx.fillRect(-s * 0.07, s * 0.02, s * 0.14, s * 0.1);
    ctx.fillStyle = '#ff7fa3';
    ctx.beginPath();
    ctx.moveTo(-s * 0.07, s * 0.12);
    ctx.quadraticCurveTo(0, s * 0.36, s * 0.07, s * 0.12);
    ctx.closePath();
    ctx.fill();
    outline(ctx, lw * 0.9);
  },
  listen(ctx, x, y, s, lw) {
    ctx.lineWidth = s * 0.1;
    ctx.strokeStyle = '#7a8cff';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(x, y + s * 0.06, s * 0.32, Math.PI * 1.08, Math.PI * 1.92);
    ctx.stroke();
    for (const side of [-1, 1]) {
      ctx.fillStyle = '#9aa8ff';
      ctx.beginPath();
      ctx.roundRect(x + side * s * 0.36 - s * 0.1, y - s * 0.02, s * 0.2, s * 0.32, s * 0.08);
      ctx.fill();
      outline(ctx, lw * 0.9);
    }
  },
  heart(ctx, x, y, s, lw) {
    ctx.fillStyle = '#ff6f91';
    heartPath(ctx, x, y + s * 0.04, s);
    ctx.fill();
    outline(ctx, lw);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath();
    ctx.ellipse(x - s * 0.2, y - s * 0.1, s * 0.07, s * 0.05, -0.6, 0, TAU);
    ctx.fill();
  },
  star(ctx, x, y, s, lw) {
    ctx.fillStyle = '#ffcf4a';
    starPath(ctx, x, y + s * 0.03, s * 0.45, 0.48);
    ctx.fill();
    outline(ctx, lw);
  },
  sparkle(ctx, x, y, s, lw) {
    ctx.fillStyle = '#fff3a6';
    starPath(ctx, x, y, s * 0.48, 0.3, 4, 0);
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, lw * 0.6);
    ctx.strokeStyle = '#ffb63f';
    ctx.stroke();
  },
  idea(ctx, x, y, s, lw) {
    ctx.fillStyle = '#ffe066';
    ctx.beginPath();
    ctx.arc(x, y - s * 0.08, s * 0.28, 0, TAU);
    ctx.fill();
    outline(ctx, lw);
    ctx.fillStyle = '#c9ccd6';
    ctx.beginPath();
    ctx.roundRect(x - s * 0.13, y + s * 0.2, s * 0.26, s * 0.16, s * 0.04);
    ctx.fill();
    outline(ctx, lw * 0.8);
    ctx.strokeStyle = '#ffb63f';
    ctx.lineWidth = lw * 0.8;
    for (const a of [-2.4, -1.57, -0.74]) {
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * s * 0.36, y - s * 0.08 + Math.sin(a) * s * 0.36);
      ctx.lineTo(x + Math.cos(a) * s * 0.46, y - s * 0.08 + Math.sin(a) * s * 0.46);
      ctx.stroke();
    }
  },
  exclaim(ctx, x, y, s) {
    ctx.fillStyle = '#ff7b5c';
    ctx.beginPath();
    ctx.roundRect(x - s * 0.09, y - s * 0.42, s * 0.18, s * 0.56, s * 0.09);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y + s * 0.34, s * 0.1, 0, TAU);
    ctx.fill();
  },
  mood(ctx, x, y, s, lw) {
    ctx.fillStyle = '#ffd35c';
    ctx.beginPath();
    ctx.arc(x, y, s * 0.4, 0, TAU);
    ctx.fill();
    outline(ctx, lw);
    ctx.beginPath();
    ctx.arc(x, y + s * 0.02, s * 0.2, 0.15 * Math.PI, 0.85 * Math.PI);
    outline(ctx, lw);
  },
  zzz(ctx, x, y, s) {
    ctx.strokeStyle = '#8f7cf0';
    ctx.lineWidth = s * 0.13;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - s * 0.3, y - s * 0.3);
    ctx.lineTo(x + s * 0.3, y - s * 0.3);
    ctx.lineTo(x - s * 0.3, y + s * 0.3);
    ctx.lineTo(x + s * 0.3, y + s * 0.3);
    ctx.stroke();
  },
  walk(ctx, x, y, s) {
    ctx.fillStyle = '#c9a4ff';
    for (const [px, py, pr] of [[0, 0.16, 0.24], [-0.26, -0.14, 0.1], [-0.08, -0.3, 0.1], [0.12, -0.3, 0.1], [0.28, -0.12, 0.1]]) {
      ctx.beginPath();
      ctx.arc(x + px * s, y + py * s, pr * s, 0, TAU);
      ctx.fill();
    }
  },
  dot(ctx, x, y, s) {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, s * 0.45, 0, TAU);
    ctx.fill();
  },
};

export const ICON_NAMES = Object.freeze(Object.keys(PAINTERS));

/** Draws icon `name` centred at (x, y) with overall size `s` px. Returns false if unknown. */
export function drawIcon(ctx, name, x, y, s) {
  const painter = PAINTERS[name];
  if (!painter) return false;
  ctx.save();
  painter(ctx, x, y, s, Math.max(2, s * 0.07));
  ctx.restore();
  return true;
}
