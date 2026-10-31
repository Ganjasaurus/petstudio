/**
 * console-pad.js: the controller in Pet Studio (Edge on the Xbox One with "Use game controls", or any pad elsewhere).
 *
 * The D-pad or left stick moves between the buttons and A presses (the console kit's menu()); in a panel B goes back.
 * While no panel is open: X pets, Y feeds, LB/RB switch the camera view, the right stick looks around, View mutes and
 * ☰ opens More (with Exit on the console). A small legend shows this while a pad is connected.
 * Without a pad nothing here changes the page; the console-only rules sit behind isConsole().
 */
import { isConsole, start, menu, exit, audio, onPad } from './console-kit.js';
import { CAMERA_VIEWS } from './studio-scene.js';

const LEGEND_PLAY = '<span><b>A</b>Select</span><span><b>X</b>Pet</span><span><b>Y</b>Feed</span>'
  + '<span><b>LB</b><b>RB</b>View</span><span><b>☰</b>More</span>';
const LEGEND_PANEL = '<span><b>A</b>Select</span><span><b>B</b>Back</span>';

/** The open modal sheet (Customize, Teach, Gallery, Inspector, More), if any. */
function topModal() {
  try {
    return document.querySelector('dialog:modal');
  } catch {
    return [...document.querySelectorAll('dialog[open]')].find((d) => d.id !== 'practice' && d.id !== 'visit') ?? null;
  }
}

/** What Escape does to a modal sheet: its own cancel handler, else a plain close. */
function cancelSheet(d) {
  const ev = new Event('cancel', { cancelable: true });
  d.dispatchEvent(ev);
  if (!ev.defaultPrevented && d.open) d.close();
}

export function installConsolePad(app) {
  const html = document.documentElement;
  const legend = document.createElement('div');
  legend.className = 'pad-legend glass';
  legend.setAttribute('aria-hidden', 'true');
  legend.hidden = true;
  legend.innerHTML = LEGEND_PLAY;
  document.querySelector('.top-overlay')?.append(legend);
  let legendMode = 'play';

  start({
    card: false, // every control in the studio also works with Edge's cursor
    onFirstPress: () => {
      if (app.audio.unlock() && app.audio.ctx) audio(app.audio.ctx);
    },
    onPadChange: (on) => {
      html.classList.toggle('pad-on', on);
      legend.hidden = !on;
      const dock = app.hud?.el.dock;
      if (on && dock && !topModal() && !dock.contains(document.activeElement)) {
        const first = [...dock.querySelectorAll('button.act')].find((b) => b.offsetParent);
        first?.focus({ preventScroll: true });
      }
    },
  });

  // B: back out of the open sheet (its Cancel), else close an open drawer (Sleep Practice, Visit) the way Escape does.
  menu({
    root: () => topModal() || document.getElementById('app'),
    back: () => {
      const d = topModal();
      if (d) cancelSheet(d);
      else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    },
  });

  const stepView = (step) => {
    const ids = CAMERA_VIEWS.map((v) => v.id);
    const i = Math.max(0, ids.indexOf(app.studio?.view ?? 'overview'));
    app.setView(ids[(i + step + ids.length) % ids.length]);
  };

  let last = 0;
  let looking = false;
  onPad((p) => {
    const now = performance.now();
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    const modal = topModal();
    const mode = modal ? 'panel' : 'play';
    if (mode !== legendMode) {
      legendMode = mode;
      legend.innerHTML = modal ? LEGEND_PANEL : LEGEND_PLAY;
    }
    if (p.pressed.menu) {
      const more = app.hud?.el.nextSheet;
      if (more?.open) more.close();
      else if (!modal) app.hud?.openNext();
      return;
    }
    if (modal) return;
    if (p.pressed.x) app.action('pet');
    if (p.pressed.y) app.action('feed');
    if (p.pressed.lb) stepView(-1);
    if (p.pressed.rb) stepView(1);
    if (p.pressed.view) app.toggleMute();
    // Right stick: look around, like dragging the studio.
    const rig = app.studio?.rig;
    if (!rig) return;
    if (p.rx || p.ry) {
      rig.user.yaw -= p.rx * dt * 1.8;
      rig.user.pitch += p.ry * dt * 1.2;
      rig.dragging = true;
      looking = true;
    } else if (looking) {
      rig.dragging = false;
      looking = false;
    }
  });

  if (!isConsole()) return;
  // Edge's cursor mode sends B as Escape and then goes Back unless the page takes the key: take it only while a
  // sheet is open (and close that sheet), so B leaves the studio only when nothing is open.
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const d = topModal();
    if (!d) return;
    e.preventDefault();
    cancelSheet(d);
  }, true);
  // Exit for game controls (B stays in the page there): at the foot of the More sheet that ☰ opens.
  const more = document.getElementById('next-sheet');
  if (more) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ck-exit';
    b.textContent = 'Exit Pet Studio';
    b.addEventListener('click', () => {
      app.save();
      exit();
    });
    more.append(b);
  }
}
