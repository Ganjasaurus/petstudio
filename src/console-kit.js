// console-kit.js: support for Edge on the original Xbox One, shared by Marc's games.
// Master copy: H:\AI\AgentHub\console-kit\console-kit.js (README.md there). Each repo keeps its own copy; update them together.
//
// On the console it shows a card until the controller is in game controls, goes fullscreen and resumes sound on the first
// pad press, marks <html> with `console-kit` for TV-size CSS, and answers the console rules (no mouse grab, leave Edge's
// right-click menu alone). Everywhere else it does nothing unless a game asks for it: the console check only runs in Edge
// on Windows, and pad helpers only react to a connected pad.
//
// Spot the console by its GPU, not the user agent: Edge on the Xbox One sends a plain Windows user agent, and its renderer
// is "ANGLE (Microsoft, SraKmd (0x0000D000) Direct3D11 vs_4_1 ps_4_1, D3D11)". `?console=1` forces console mode for
// testing on a PC, `?console=0` turns it off (both remembered for the tab).

const KIT = '__consoleKit1';
const S = globalThis[KIT] || (globalThis[KIT] = {
  console: undefined, started: false, opts: {}, pads: 0, firstPress: false, audios: new Set(),
  prev: [], state: null, subs: new Set(), menus: [], loop: 0, card: null, cardTimer: 0, repeat: {},
});

// Budgets measured on the console (29 Oct 2026): about 300 draws a frame, and real-time shadows, point lights and bloom
// each cost about 10 ms. Games map these onto their own settings.
export const CONSOLE_TIER = Object.freeze({
  maxDraws: 300, pixelRatio: 1, msaa: false, shadows: false, pointLights: false, bloom: false, maxTexture: 2048,
});

const BUTTONS = ['a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'view', 'menu', 'ls', 'rs', 'up', 'down', 'left', 'right', 'home'];

function storage() { try { return sessionStorage; } catch { return null; } }

/** True on Edge on the original Xbox One (or with ?console=1). Cached for the tab. */
export function isConsole() {
  if (S.console !== undefined) return S.console;
  const ss = storage();
  const m = typeof location !== 'undefined' && /[?&]console=([01])\b/.exec(location.search);
  if (m) { try { ss && ss.setItem('consoleKit.force', m[1]); } catch { /* private mode */ } }
  const forced = m ? m[1] : ss && ss.getItem('consoleKit.force');
  if (forced === '1' || forced === '0') return (S.console = forced === '1');
  const cached = ss && ss.getItem('consoleKit.gpu');
  if (cached === '1' || cached === '0') return (S.console = cached === '1');
  S.console = false;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Windows NT/.test(ua) && /\bEdg\//.test(ua) && typeof document !== 'undefined') {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (gl) {
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
        S.console = /SraKmd/i.test(name);
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      }
    } catch { /* no WebGL: not a console we know */ }
  }
  try { ss && ss.setItem('consoleKit.gpu', S.console ? '1' : '0'); } catch { /* private mode */ }
  return S.console;
}

/** On the console a click must not grab the mouse: Edge's cursor disappears and Use game controls can't be reached. */
export function allowPointerLock() { return !isConsole(); }

/** On the console leave Edge's right-click menu alone: holding ☰ opens it, and it holds Use game controls. */
export function allowContextMenu() { return isConsole(); }

/** True once a pad has been seen (on the console: game controls are on). */
export function padConnected() { return S.pads > 0; }

/**
 * Start the console behaviour. Safe to call more than once and on any device: off the console only the pad helpers run.
 * @param {{card?: boolean, cardText?: string, fullscreen?: boolean, onFirstPress?: () => void, onPadChange?: (on: boolean) => void}} [opts]
 */
export function start(opts = {}) {
  Object.assign(S.opts, opts);
  if (S.started) return;
  S.started = true;
  addEventListener('gamepadconnected', () => { recount(); });
  addEventListener('gamepaddisconnected', () => { recount(); });
  recount();
  if (!isConsole()) return;
  document.documentElement.classList.add('console-kit');
  style();
  if (S.opts.card !== false && !S.pads) showCard();
}

function recount() {
  const before = S.pads;
  S.pads = list().length;
  if (S.pads && !S.loop) S.loop = requestAnimationFrame(tick);
  if (S.pads && S.card) cardReady();
  if (!S.pads && before && isConsole() && S.opts.card !== false) showCard();
  if ((before > 0) !== (S.pads > 0) && S.opts.onPadChange) S.opts.onPadChange(S.pads > 0);
}

function list() {
  const all = typeof navigator !== 'undefined' && navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
  return all.filter((p) => p && p.connected !== false);
}

/** Resume this AudioContext on the first pad press (the press counts as a user gesture). Returns the context. */
export function audio(ctx) {
  if (ctx) { S.audios.add(ctx); if (S.firstPress && ctx.state === 'suspended') ctx.resume().catch(() => {}); }
  return ctx;
}

/**
 * The pad, by standard mapping: buttons by name (`a`, `b`, `menu`, `up`...), `pressed.a` only on the frame it went down,
 * sticks as lx/ly/rx/ry with a dead zone. Null with no pad.
 */
export function pad() { return S.state; }

/** Call cb(state) every frame while a pad is connected. Returns a function that stops it. */
export function onPad(cb) { S.subs.add(cb); return () => S.subs.delete(cb); }

function read() {
  const pads = list();
  const p = pads.find((g) => g.mapping === 'standard') || pads[0];
  if (!p) return null;
  const st = { id: p.id, mapping: p.mapping, held: {}, pressed: {}, released: {} };
  BUTTONS.forEach((name, i) => {
    const b = p.buttons[i];
    const v = b ? (typeof b === 'object' ? b.pressed || b.value > 0.5 : b > 0.5) : false;
    const was = !!S.prev[i];
    st.held[name] = v; st.pressed[name] = v && !was; st.released[name] = !v && was;
    S.prev[i] = v;
  });
  const dz = (v) => (Math.abs(v || 0) < 0.2 ? 0 : v);
  st.lx = dz(p.axes[0]); st.ly = dz(p.axes[1]); st.rx = dz(p.axes[2]); st.ry = dz(p.axes[3]);
  st.any = Object.values(st.pressed).some(Boolean);
  return st;
}

function tick() {
  S.loop = 0;
  if (!S.pads) { S.state = null; return; }
  const st = (S.state = read());
  if (st && st.any && !S.firstPress) firstPress();
  if (st) {
    for (const cb of S.subs) { try { cb(st); } catch (e) { console.error(e); } }
    runMenus(st);
  }
  S.loop = requestAnimationFrame(tick);
}

function firstPress() {
  S.firstPress = true;
  for (const ctx of S.audios) if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  if (isConsole() && S.opts.fullscreen !== false && !document.fullscreenElement && document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  }
  if (S.opts.onFirstPress) { try { S.opts.onFirstPress(); } catch (e) { console.error(e); } }
}

/**
 * Leave the game: out of fullscreen, then back to where the player came from (the Xbox receiver page, the portal) or to
 * `home` (default https://retrofleshed.com/). Edge gives the cursor back on the new page by itself.
 */
export function exit(home = 'https://retrofleshed.com/') {
  const go = () => {
    const ref = document.referrer;
    if (history.length > 1 && ref) {
      history.back();
      // Still here after the back step: it stayed inside the game (its own history entries), so go to the page it came from.
      const t = setTimeout(() => location.assign(ref), 700);
      addEventListener('pagehide', () => clearTimeout(t), { once: true });
    } else location.assign(home);
  };
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {}).finally(go);
  else go();
}

/**
 * Keep a lost WebGL context restorable instead of leaving a black screen: lets the browser restore it and tells the game.
 * Never ask a WebGL canvas for a 2D context after a loss (it returns null), and never reload in a loop.
 * @param {HTMLCanvasElement} canvas
 * @param {{onLost?: (losses: number) => void, onRestored?: (losses: number) => void}} [hooks]
 */
export function watchContext(canvas, hooks = {}) {
  const w = { losses: 0 };
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); w.losses += 1; if (hooks.onLost) hooks.onLost(w.losses); }, false);
  canvas.addEventListener('webglcontextrestored', () => { if (hooks.onRestored) hooks.onRestored(w.losses); }, false);
  return w;
}

// ------------------------------------------------------------------------------------------------ menus on the pad

const FOCUSABLE = 'button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"]), [data-pad-focus]';

/**
 * Drive HTML menus with the pad: D-pad or left stick moves focus to the nearest button that way, A presses it, B calls
 * `back` (default: an Escape key press). Only while `enabled()` is true, so gameplay keeps the pad.
 * @param {{root?: Element | (() => Element | null), enabled?: () => boolean, back?: () => void}} [opts]
 * @returns {() => void} stop
 */
export function menu(opts = {}) {
  start();
  const m = { root: opts.root, enabled: opts.enabled || (() => true), back: opts.back };
  S.menus.push(m);
  return () => { S.menus = S.menus.filter((x) => x !== m); };
}

function rootOf(m) { const r = typeof m.root === 'function' ? m.root() : m.root; return r || document.body; }

function visible(el) {
  if (el.disabled || el.closest('[inert], [aria-hidden="true"]')) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
}

function repeatDir(st) {
  const dirs = { up: st.held.up || st.ly < -0.5, down: st.held.down || st.ly > 0.5, left: st.held.left || st.lx < -0.5, right: st.held.right || st.lx > 0.5 };
  const now = performance.now();
  for (const d of Object.keys(dirs)) {
    if (!dirs[d]) { delete S.repeat[d]; continue; }
    const t = S.repeat[d];
    if (t === undefined) { S.repeat[d] = now + 380; return d; }
    if (now >= t) { S.repeat[d] = now + 140; return d; }
  }
  return null;
}

function runMenus(st) {
  const m = [...S.menus].reverse().find((x) => { try { return x.enabled(); } catch { return false; } });
  if (!m) return;
  const root = rootOf(m);
  const items = Array.from(root.querySelectorAll(FOCUSABLE)).filter(visible);
  if (!items.length) return;
  const cur = items.includes(document.activeElement) ? document.activeElement : null;
  const dir = repeatDir(st);
  if (dir) {
    if (!cur) return focus(items[0]);
    if (adjust(cur, dir)) return;
    const next = nearest(cur, items, dir);
    if (next) focus(next);
    return;
  }
  if (st.pressed.a) {
    if (!cur) return focus(items[0]);
    document.documentElement.classList.add('ck-pad');
    if (cur.matches('input[type=checkbox], input[type=radio]')) cur.click();
    else if (cur.matches('input:not([type=range]), textarea, select')) cur.focus();
    else cur.click();
  } else if (st.pressed.b) {
    if (m.back) m.back();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  }
}

function focus(el) {
  document.documentElement.classList.add('ck-pad');
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// Left and right change a slider or a drop-down instead of moving away from it.
function adjust(el, dir) {
  if (dir !== 'left' && dir !== 'right') return false;
  const step = dir === 'right' ? 1 : -1;
  if (el.matches('input[type=range]')) {
    if (step > 0) el.stepUp(); else el.stepDown();
  } else if (el.matches('select')) {
    const i = Math.max(0, Math.min(el.options.length - 1, el.selectedIndex + step));
    if (i === el.selectedIndex) return true;
    el.selectedIndex = i;
  } else return false;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function nearest(from, items, dir) {
  const a = from.getBoundingClientRect();
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best = null, bestScore = Infinity;
  for (const el of items) {
    if (el === from) continue;
    const b = el.getBoundingClientRect();
    const bx = b.left + b.width / 2, by = b.top + b.height / 2;
    const dx = bx - ax, dy = by - ay;
    const along = dir === 'up' ? -dy : dir === 'down' ? dy : dir === 'left' ? -dx : dx;
    const across = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
    if (along <= 1) continue;
    const score = along + across * 2.5;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  return best;
}

// ------------------------------------------------------------------------------------------------ the card and styles

function style() {
  if (document.getElementById('console-kit-style')) return;
  const s = document.createElement('style');
  s.id = 'console-kit-style';
  s.textContent = `
.ck-card{position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483000;pointer-events:none;
  max-width:min(92vw,760px);padding:14px 24px;border-radius:16px;background:rgba(10,10,14,.86);color:#fff;
  border:2px solid rgba(255,255,255,.28);box-shadow:0 8px 30px rgba(0,0,0,.45);text-align:center;
  font:600 22px/1.35 system-ui,'Segoe UI',sans-serif;transition:opacity .4s,transform .4s}
.ck-card small{display:block;margin-top:4px;font-weight:500;font-size:17px;opacity:.82}
.ck-card.ck-small{left:auto;right:14px;transform:none;padding:8px 14px;font-size:16px}
.ck-card.ck-small small{display:none}
.ck-card.ck-ready{background:rgba(20,110,60,.92)}
.ck-card.ck-gone{opacity:0}
html.ck-pad :focus{outline:4px solid #ffd54a !important;outline-offset:3px !important}`;
  (document.head || document.documentElement).appendChild(s);
}

function showCard() {
  if (S.card) return;
  if (!document.body) { addEventListener('DOMContentLoaded', () => { if (!S.pads) showCard(); }, { once: true }); return; }
  style();
  const c = document.createElement('div');
  c.className = 'ck-card';
  c.setAttribute('role', 'status');
  c.innerHTML = S.opts.cardText || '🎮 To play with the controller, hold ☰ and choose <b>Use game controls</b>'
    + '<small>or select the controller icon right of the address bar</small>';
  document.body.appendChild(c);
  S.card = c;
  clearTimeout(S.cardTimer);
  S.cardTimer = setTimeout(() => { if (S.card === c) c.classList.add('ck-small'); }, 12000);
}

function cardReady() {
  const c = S.card;
  if (!c) return;
  S.card = null;
  clearTimeout(S.cardTimer);
  c.classList.remove('ck-small');
  c.classList.add('ck-ready');
  c.textContent = '🎮 Controller ready';
  setTimeout(() => c.classList.add('ck-gone'), 1400);
  setTimeout(() => c.remove(), 2000);
}
