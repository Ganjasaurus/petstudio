/**
 * verify-ui.mjs: end-to-end UI verification of the Iteration 2 features in
 * headless Microsoft Edge at 390x844 (phone, touch), 768x1024 (tablet,
 * touch) and 1440x900 (desktop, mouse).
 *
 * Uses real input (CDP touch / mouse events) to open the Teaching Workshop
 * (dock on desktop, More sheet on phone and tablet), play keys and pads,
 * load templates, record, draw and stamp, teach music and drawing, give
 * feedback in the Creation Feedback Bar, browse / compare / hang in the
 * Creation Gallery and reload to check persistence. At every step it records
 * window.__PET_STUDIO__.layout() and fails on console errors, horizontal
 * overflow, clipped controls or the pet overlapping the UI.
 *
 *   npm run build && node scripts/verify-ui.mjs [--only=phone|tablet|desktop]
 * Screenshots and a JSON summary are written to artifacts/verify/.
 */
import path from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { serveDir, launchBrowser } from './cdp-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'artifacts', 'verify');
const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1] ?? null;
const DEVICES = [
  { name: 'phone', label: '390x844 phone (touch, 3x)', width: 390, height: 844, deviceScaleFactor: 3, mobile: true, touch: true },
  { name: 'tablet', label: '768x1024 tablet (touch, 2x)', width: 768, height: 1024, deviceScaleFactor: 2, mobile: true, touch: true },
  { name: 'desktop', label: '1440x900 desktop (mouse, 1x)', width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, touch: false },
].filter((d) => !only || d.name === only);

const READY = 'window.__PET_STUDIO__ && window.__PET_STUDIO__.ready === true';

async function runDevice(browser, server, device) {
  const page = await browser.newPage(device);
  const checks = [];
  const shots = [];
  const layouts = {};
  const check = (name, ok, detail = null) => {
    checks.push({ name, ok: !!ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail != null && !ok ? ` :: ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
  };
  const shot = async (name) => {
    await page.sleep(350);
    const file = await page.screenshot(path.join(outDir, `${device.name}-${name}.png`));
    shots.push(path.relative(root, file));
  };
  const S = (expr) => page.eval(`(() => { const api = window.__PET_STUDIO__; return ${expr}; })()`);
  const diag = () => S(`JSON.stringify({ activity: api.state.activity, subject: api.creation.subject, workshop: api.teach.isOpen,
    gallery: api.gallery.isOpen, toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent), hint: document.querySelector('.ws-hint')?.textContent })`);
  const waitState = async (expr, timeout = 30000) => {
    try {
      await page.waitFor(expr, { timeout });
    } catch (err) {
      throw new Error(`${err.message}\n   state: ${await diag()}`);
    }
  };
  const layout = async (step, { petVisible = true } = {}) => {
    if (petVisible) {
      // Let the damped camera finish reframing first (software rendering is slow).
      await page.waitFor('window.__PET_STUDIO__.camera.settled', { timeout: 25000 }).catch(() => {});
    }
    const r = await page.eval('window.__PET_STUDIO__.layout()');
    layouts[step] = r;
    check(`[${step}] no horizontal overflow`, !r.horizontalOverflow, r.horizontalOverflow);
    check(`[${step}] no clipped controls`, r.clippedControls.length === 0, r.clippedControls);
    check(`[${step}] no labels spilling out of their buttons`, r.overflowingLabels.length === 0, r.overflowingLabels);
    if (petVisible && r.pet) check(`[${step}] pet inside the free area, clear of the UI`, r.pet.insideSafeRect && !r.pet.overlapsUI, { pet: r.pet, safe: r.safeRect, settled: r.cameraSettled });
    return r;
  };
  /** Waits until no CSS animation is running (sheets slide in; taps mid-slide would miss). */
  const settleAnimations = () => page.waitFor('document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity)', { timeout: 4000 }).catch(() => {});
  const openFeature = async (id) => {
    const inline = await page.center(`#next-buttons [data-feature="${id}"]`);
    if (inline) {
      await page.tap(`#next-buttons [data-feature="${id}"]`);
    } else {
      await page.tap('#dock .more-btn');
      await page.waitFor('document.getElementById("next-sheet").open');
      await settleAnimations();
      await page.tap(`#next-list button[data-feature="${id}"]`);
    }
    await page.waitFor(`document.getElementById("${id === 'teach' ? 'workshop' : 'gallery'}").open`);
    await settleAnimations();
  };

  console.log(`\n== ${device.label}`);
  await page.goto(`${server.url}?skipIntro=1&seed=verify-${device.name}&mute=1`, { readyExpr: READY, timeout: 60000 });
  await page.sleep(1500);
  await layout('studio');
  check('teach and gallery hooks are registered as real features', await S("api.features.list().filter(f => f.available).map(f => f.id).join(',') === 'teach,gallery'"));
  check('inspection API exposes teach and gallery', await S("typeof api.teach.open === 'function' && typeof api.gallery.open === 'function' && api.iteration === 2"));

  // Regression guard for the shared framing code: the Iteration 1 customizer still frames the pet.
  await page.tap('#btn-customize');
  await page.waitFor('document.getElementById("customizer").open');
  await settleAnimations();
  await layout('customizer');
  await page.tap('.cz-foot [data-cz="cancel"]');
  await page.waitFor('!document.getElementById("customizer").open');

  // ----- Teaching Workshop: music -------------------------------------------------
  await openFeature('teach');
  await page.waitFor('document.getElementById("workshop").open');
  await page.sleep(700);
  check('workshop opens from the dock / More sheet', await S('api.teach.isOpen'));
  await layout('workshop-music');
  await shot('workshop-music');
  for (const midi of [60, 64, 67, 72, 69]) {
    await page.tap(`.ws-key[data-midi="${midi}"]`);
    await page.sleep(120);
  }
  await page.tap('.ws-pad[data-drum="clap"]');
  const tapped = await S('api.teach.phrase');
  check('tapping keys and pads captures note events', tapped.notes.length === 5 && tapped.hits.length === 1, tapped);
  check('captured notes use { beat, midi, dur, vel }', tapped.notes.every((n) => ['beat', 'midi', 'dur', 'vel'].every((k) => typeof n[k] === 'number')));
  const first = tapped.notes[0];
  await page.tap(await S(`api.teach.timelinePoint(${first.beat}, ${first.midi})`));
  check('tapping a note on the timeline removes it', (await S('api.teach.phrase.notes.length')) === 4);
  await page.tap('[data-ws="undo-music"]');
  check('undo brings the removed note back', (await S('api.teach.phrase.notes.length')) === 5);
  await page.eval('document.querySelector(\'.ws-key[data-midi="62"]\').focus()');
  await page.key('Enter');
  check('keyboard users can play a focused key (Enter)', (await S('api.teach.phrase.notes.length')) === 6);
  await page.tap('[data-ws="preview"]');
  check('Preview plays the phrase', await S('api.teach.state.previewing'));
  await page.tap('[data-ws="preview"]');
  check('Preview can be stopped', !(await S('api.teach.state.previewing')));
  await page.tap('.ws-chip[data-template="sunny-arp"]');
  await page.sleep(300);
  const tpl = await S('api.teach.phrase');
  check('one-tap starter tune loads (Sunny Arp)', tpl.notes.length === 15 && tpl.hits.length === 4, { notes: tpl.notes.length, hits: tpl.hits.length });
  await page.sleep(600);
  await shot('workshop-music-template');
  await page.tap('[data-ws="chromatic"]');
  await page.sleep(300);
  check('chromatic keyboard shows all 22 keys', (await page.eval('document.querySelectorAll(".ws-key").length')) === 22);
  await layout('workshop-chromatic');
  await shot('workshop-music-chromatic');
  await page.tap('[data-ws="chromatic"]');
  await page.tap('[data-ws="record"]');
  check('record arms a count-in', await S('api.teach.state.recording'));
  await page.tap('[data-ws="record"]');
  check('record can be stopped', !(await S('api.teach.state.recording')));
  await page.tap('[data-ws="record"]');
  await shot('workshop-music-recording');
  if (await S('api.teach.state.recording')) await page.tap('[data-ws="record"]');

  // ----- Teaching Workshop: drawing ------------------------------------------------
  await page.tap('[data-tab="drawing"]');
  await page.sleep(400);
  const c = await page.center('.ws-canvas');
  const pts = [];
  for (let i = 0; i <= 24; i++) pts.push({ x: c.x - c.w * 0.32 + (c.w * 0.64 * i) / 24, y: c.y + c.h * 0.2 + Math.sin(i / 3) * c.h * 0.12 });
  await page.drag(pts);
  await page.sleep(200);
  const drawn = await S('api.teach.drawing');
  const s0 = drawn.strokes[0];
  check('a finger/mouse drag becomes one normalised, resampled stroke', drawn.strokes.length === 1 && s0.points.length > 10 && s0.points.every((p) => p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1 && p.length === 4), { strokes: drawn.strokes.length, points: s0?.points.length });
  await page.tap('.ws-chip[data-shape="star"]');
  await page.sleep(1100);
  check('shape stamp adds strokes', (await S('api.teach.drawing.strokes.length')) >= 2);
  await layout('workshop-drawing');
  await shot('workshop-drawing');
  await page.tap('[data-ws="replay"]');
  check('Replay Strokes animates the drawing', await S('api.teach.state.replaying'));
  await page.tap('[data-ws="undo-draw"]');
  check('undo stroke removes the stamp', (await S('api.teach.drawing.strokes.length')) === 1);
  await page.tap('[data-mode="trace"]');
  await page.tap('.ws-chip[data-shape="heart"]');
  await page.sleep(200);
  check('trace mode shows a guide without adding strokes', (await S('api.teach.state.traceId')) === 'heart' && (await S('api.teach.drawing.strokes.length')) === 1);
  await page.tap('[data-mode="stamp"]');
  await page.tap('.ws-chip[data-shape="flower"]');
  await page.sleep(1000);

  // ----- Teach music -> lesson -> perform -> feedback ------------------------------
  await page.tap('[data-tab="music"]');
  await page.sleep(300);
  await page.tap('[data-ws="teach"]');
  await page.waitFor('!document.getElementById("workshop").open', { timeout: 5000 });
  check('Teach Pet closes the sheet and starts a lesson', (await S('api.state.activity.type')) === 'lesson');
  check('the pet listens attentively (curious)', (await S('api.state.expression')) === 'curious');
  const mem = await S('api.teach.memory');
  check('the demonstration is stored in teaching memory', mem.lessons.music === 1);
  await page.sleep(900);
  await layout('lesson');
  check('feedback bar shows the lesson phase', (await S('api.creation.bar.phase')) === 'lesson');
  await shot('lesson');
  await S('api.setTimeScale(4)');
  await waitState('window.__PET_STUDIO__.state.activity.type === "playing_music"', 30000);
  await S('api.setTimeScale(1)');
  await page.sleep(1500);
  check('the pet performs its attempt at the Music Corner', (await S('api.state.activity.plan && api.state.activity.plan.mode')) === 'attempt');
  const bar = await layout('performing-music');
  check('feedback bar visible while performing', !!bar.overlays.creationBar);
  check('feedback bar never overlaps the pet', bar.pet && !bar.pet.overlapsCreationBar, bar.pet);
  await shot('performing-music');
  await page.tap('#creation-bar [data-fb="love"]');
  await page.sleep(300);
  const loved = await S('api.gallery.items.filter(i => i.favorite)');
  check('Love It saves the attempt as a favourite', loved.length === 1 && loved[0].origin === 'attempt', loved);
  check('Love It records a +1.0 preference signal', await S("api.teach.signals.some(s => s.kind === 'love' && s.reward === 1 && s.label === 'preference')"));
  await S('api.setTimeScale(6)');
  await waitState('window.__PET_STUDIO__.creation.bar.phase === "done"', 30000);
  await S('api.setTimeScale(1)');
  await page.sleep(500);
  await layout('feedback-done');
  await shot('feedback-done');
  await page.tap('#creation-bar [data-fb="calmer"]');
  await page.sleep(400);
  check('Calmer stores a direction signal and lowers energy', (await S('api.teach.prefs.energy')) < 0 && (await S("api.teach.signals.some(s => s.kind === 'nudge' && s.nudge === 'calmer')")));
  check('a guided retry starts, tagged Calmer', (await S("api.creation.subject.mode === 'variation' && api.creation.subject.tags[0] === 'calmer'")));
  await S('api.setTimeScale(6)');
  await waitState('window.__PET_STUDIO__.creation.bar.phase === "done"', 40000);
  await S('api.setTimeScale(1)');

  // ----- Teach a drawing (via the sheet again) -------------------------------------
  await openFeature('teach');
  await page.waitFor('document.getElementById("workshop").open');
  await page.tap('[data-tab="drawing"]');
  await page.sleep(300);
  await page.tap('[data-ws="teach"]');
  await page.waitFor('!document.getElementById("workshop").open', { timeout: 5000 });
  await S('api.setTimeScale(4)');
  await waitState('window.__PET_STUDIO__.state.activity.type === "drawing"', 30000);
  await S('api.setTimeScale(1)');
  await page.sleep(2500);
  check('the pet draws its attempt progressively on the easel', await S('api.state.currentDrawing.progress > 0 && api.state.currentDrawing.progress < 1 && !!api.state.currentDrawing.ref'));
  await layout('performing-drawing');
  await shot('performing-drawing');
  await S('api.setTimeScale(6)');
  await waitState('window.__PET_STUDIO__.creation.bar.phase === "done"', 40000);
  await S('api.setTimeScale(1)');
  await page.tap('#creation-bar [data-fb="dismiss"]');
  await page.sleep(300);
  check('the feedback bar can be dismissed', !(await S('api.creation.bar.visible')));

  // ----- Gallery -------------------------------------------------------------------
  await openFeature('gallery');
  await page.waitFor('document.getElementById("gallery").open');
  await page.sleep(700);
  const items = await S('api.gallery.items');
  check('gallery lists lessons and attempts with origin badges', items.some((i) => i.origin === 'taught') && items.some((i) => i.origin === 'attempt'), items.map((i) => `${i.origin}:${i.kind}`));
  check('gallery cards show badge, time, star and tags', (await page.eval('[...document.querySelectorAll(".gl-card")].every(c => c.querySelector(".gl-origin") && c.querySelector("time") && c.querySelector(".gl-star"))')) && (await page.eval('!!document.querySelector(".gl-tag")')));
  await layout('gallery', { petVisible: false });
  await shot('gallery');
  await page.tap('.gl-card[data-kind="music"] [data-gl="listen"]');
  check('Listen plays a song inside the gallery (no pet needed)', await S('api.gallery.state.playing'));
  await page.tap('.gl-card[data-kind="drawing"][data-origin="attempt"] [data-gl="vs-lesson"]');
  await page.sleep(800);
  check('compare: lesson vs pet attempt side by side', (await S('api.gallery.state.comparing && api.gallery.state.comparing.length')) === 2);
  await layout('gallery-compare', { petVisible: false });
  await shot('gallery-compare-drawing');
  await page.tap('[data-gl="replay-both"]');
  check('compare can replay both drawings together', await S('api.gallery.state.replaying'));
  await page.tap('[data-gl="back"]');
  await page.sleep(300);
  await page.tap('.gl-card[data-kind="music"][data-origin="attempt"] [data-gl="vs-lesson"]');
  await page.sleep(800);
  await page.tap('[data-gl="play-both"]');
  check('compare can play both songs one after the other', await S('api.gallery.state.playing'));
  await shot('gallery-compare-music');
  await page.tap('[data-gl="back"]');
  await page.sleep(300);
  // Favourite toggles from the card star, and the Favourites filter shows it.
  const favBefore = await S('api.gallery.counts.favorites');
  await page.tap('.gl-card[data-origin="taught"] [data-gl="favorite"]');
  check('the card star toggles a favourite', (await S('api.gallery.counts.favorites')) === favBefore + 1);
  await page.tap('[data-filter="favorites"]');
  check('the Favourites filter lists only favourites', (await page.eval('document.querySelectorAll(".gl-card").length')) === favBefore + 1);
  await page.tap('[data-filter="all"]');
  await page.sleep(300);
  await page.tap('.gl-card[data-kind="drawing"][data-origin="attempt"] [data-gl="wall"]');
  await page.waitFor('!document.getElementById("gallery").open', { timeout: 5000 });
  await page.sleep(2600);
  check('Hang on Wall pins the drawing in the 3D frame', await S('!!api.gallery.wall && api.gallery.wallArt.pinned === true'));
  check('the camera visits the wall frame', (await S('api.camera.view')) === 'wall');
  await layout('wall', { petVisible: false });
  await shot('wall');

  // ----- Persistence across reload --------------------------------------------------
  const before = { items: await S('api.gallery.items.length'), wall: await S('api.gallery.wall'), lessons: await S('api.teach.lessons.length'), signals: await S('api.teach.signals.length') };
  await S('api.save()');
  await page.goto(`${server.url}?skipIntro=1&mute=1`, { readyExpr: READY, timeout: 60000 });
  await page.sleep(1200);
  const after = { items: await S('api.gallery.items.length'), wall: await S('api.gallery.wall'), lessons: await S('api.teach.lessons.length'), signals: await S('api.teach.signals.length') };
  check('gallery, wall pin and teaching memory persist across reload', JSON.stringify(before) === JSON.stringify(after), { before, after });
  check('the wall frame shows the pinned drawing after reload', await S('api.gallery.wallArt.pinned === true'));
  await layout('after-reload');

  // ----- A napping pet cannot take a lesson; the sheet says why; Escape closes it -----
  await S('api.setNeeds({ energy: 16 })');
  await S('api.actions.rest()');
  await S('api.setTimeScale(6)');
  await waitState('window.__PET_STUDIO__.state.asleep === true', 40000);
  await S('api.setTimeScale(1)');
  await openFeature('teach');
  check('the unfinished lesson draft survived the reload', (await S('api.teach.phrase.notes.length + api.teach.drawing.strokes.length')) > 0);
  await page.tap('[data-tab="music"]');
  await page.tap('[data-ws="teach"]');
  await page.sleep(300);
  check('a napping pet declines the lesson and the sheet explains why', (await S('api.teach.isOpen')) && /napping/i.test(await page.eval('document.querySelector(".ws-hint").textContent')));
  await page.key('Escape');
  await page.sleep(300);
  check('Escape closes the Teaching Workshop', !(await S('api.teach.isOpen')));
  await S('api.actions.wake()');

  check('zero console errors', page.errors.length === 0, page.errors);
  await page.close();
  return { device: device.label, checks, screenshots: shots, layouts, errors: page.errors };
}

await mkdir(outDir, { recursive: true });
const server = await serveDir(path.join(root, 'dist'));
const browser = await launchBrowser();
const results = [];
try {
  for (const d of DEVICES) results.push(await runDevice(browser, server, d));
} catch (err) {
  console.error('verification aborted:', err);
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
const summary = results.map((r) => ({ device: r.device, passed: r.checks.filter((c) => c.ok).length, failed: r.checks.filter((c) => !c.ok).map((c) => c.name) }));
await writeFile(path.join(outDir, `summary${only ? `-${only}` : ''}.json`), JSON.stringify({ when: new Date().toISOString(), summary, results }, null, 2));
console.log('\nSummary:', JSON.stringify(summary, null, 2));
if (summary.some((s) => s.failed.length) || results.length < DEVICES.length) process.exitCode = 1;
