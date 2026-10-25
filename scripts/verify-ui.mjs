/**
 * verify-ui.mjs: end-to-end UI verification of the Iteration 2, 3 and 4
 * features in headless Microsoft Edge at 390x844 (phone, touch), 768x1024
 * (tablet, touch) and 1440x900 (desktop, mouse).
 *
 * Uses real input (CDP touch / mouse events) to open the Teaching Workshop
 * (dock on desktop, More sheet on phone and tablet), play keys and pads,
 * load templates, record, draw and stamp, teach music and drawing, give
 * feedback in the Creation Feedback Bar, browse / compare / hang in the
 * Creation Gallery, run Sleep Practice (start, pause, step, cancel and
 * rollback, practise again, compare before and after, perform the learned
 * version), invite a visiting friend (Visit / Jam sheet, a second pet in the
 * 3D studio, Jam Together, Co-Draw Together, Learn From, snapshot export and
 * hostile / self imports, Send Home), use the Learning Inspector (run steps,
 * save, rollback, reset; tables never clipped on phones), check the PWA
 * manifest, icons and service worker, and reload to check persistence. At
 * every step it records
 * window.__PET_STUDIO__.layout() and fails on console errors, horizontal
 * overflow, clipped controls, notes sliced by a sheet footer, table cells
 * cut off (or scrolled sideways) in an open sheet, the dock under a side
 * drawer (or peeking out under a centred sheet), or either pet overlapping
 * the UI.
 *
 *   npm run build && node scripts/verify-ui.mjs [--only=phone|tablet|desktop]
 * Screenshots and a JSON summary are written to artifacts/verify/.
 */
import path from 'node:path';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { serveDir, launchBrowser, imageDetail } from './cdp-harness.mjs';

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
  /**
   * Screenshot. Studio views also get a pixel check: the free studio area must
   * show the rendered room (outlines and texture), never a blank WebGL canvas
   * (geometric checks alone cannot see a frame that failed to draw).
   */
  // Calibrated on blank references (canvas hidden: std about 3, step about 0.3) and the least
  // detailed rendered view, a bare wall close-up (std 15 and up, step 1.08 and up).
  const BLANK = { std: 8, step: 0.7 };
  const shot = async (name, { studio = false } = {}) => {
    await page.sleep(350);
    const file = await page.screenshot(path.join(outDir, `${device.name}-${name}.png`));
    shots.push(path.relative(root, file));
    if (!studio) return;
    const safe = await page.eval('window.__PET_STUDIO__.layout().safeRect');
    const k = device.deviceScaleFactor;
    const detail = imageDetail(await readFile(file), { x: safe.x * k, y: safe.y * k, width: safe.width * k, height: safe.height * k }, k);
    check(`[${name}] the 3D studio is drawn in the screenshot (not a blank canvas)`, detail.std >= BLANK.std || detail.step >= BLANK.step, { detail, safe });
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
  const layout = async (step, { petVisible = true, dockHidden = false, visitorVisible = false } = {}) => {
    if (petVisible) {
      // Let the damped camera finish reframing first (software rendering is slow).
      await page.waitFor('window.__PET_STUDIO__.camera.settled', { timeout: 25000 }).catch(() => {});
    }
    const r = await page.eval('window.__PET_STUDIO__.layout()');
    layouts[step] = r;
    check(`[${step}] no horizontal overflow`, !r.horizontalOverflow, r.horizontalOverflow);
    check(`[${step}] no clipped controls`, r.clippedControls.length === 0, r.clippedControls);
    check(`[${step}] no labels spilling out of their buttons`, r.overflowingLabels.length === 0, r.overflowingLabels);
    check(`[${step}] no note sliced by a sheet footer`, r.slicedNotes.length === 0, r.slicedNotes);
    check(`[${step}] no table column clipped or scrolled sideways in an open sheet`, r.clippedTableCells.length === 0 && r.scrollingTables.length === 0, { cells: r.clippedTableCells, scrolling: r.scrollingTables });
    check(`[${step}] dock clear of every open side drawer`, !r.dock.overlapsPanel && (r.dock.hidden || r.dock.insideLane), r.dock);
    if (dockHidden) check(`[${step}] dock steps aside under the centred sheet`, r.dock.hidden, r.dock);
    if (petVisible && r.pet) check(`[${step}] pet inside the free area, clear of the UI`, r.pet.insideSafeRect && !r.pet.overlapsUI, { pet: r.pet, safe: r.safeRect, settled: r.cameraSettled });
    if (petVisible && visitorVisible) check(`[${step}] visiting friend inside the free area, clear of the UI`, !!r.visitor && r.visitor.insideSafeRect && !r.visitor.overlapsUI, { visitor: r.visitor, safe: r.safeRect });
    return r;
  };
  /** Waits until no CSS animation is running (sheets slide in; taps mid-slide would miss). */
  const settleAnimations = () => page.waitFor('document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity)', { timeout: 4000 }).catch(() => {});
  const DIALOG = { teach: 'workshop', gallery: 'gallery', practice: 'practice', inspector: 'inspector', visit: 'visit' };
  let moreChecked = false;
  const openFeature = async (id, attempt = 0) => {
    await settleAnimations(); // the dock glides beside drawers: never tap it mid-slide
    const inline = await page.center(`#next-buttons [data-feature="${id}"]`);
    if (inline) {
      await page.tap(`#next-buttons [data-feature="${id}"]`);
      const opened = await page.waitFor(`document.getElementById("${DIALOG[id]}").open`, { timeout: 3000 }).catch(() => false);
      if (!opened && attempt === 0) {
        console.log(`  (retrying the ${id} tap: ${JSON.stringify(await page.eval('window.__PET_STUDIO__.layout().dock'))})`);
        return openFeature(id, 1);
      }
    } else {
      await page.tap('#dock .more-btn');
      await page.waitFor('document.getElementById("next-sheet").open');
      await settleAnimations();
      if (!moreChecked) {
        moreChecked = true;
        await layout('more-sheet', { petVisible: false, dockHidden: true });
      }
      await page.tap(`#next-list button[data-feature="${id}"]`);
    }
    await page.waitFor(`document.getElementById("${DIALOG[id]}").open`);
    await settleAnimations();
  };

  console.log(`\n== ${device.label}`);
  await page.goto(`${server.url}?skipIntro=1&seed=verify-${device.name}&mute=1`, { readyExpr: READY, timeout: 60000 });
  await page.sleep(1500);
  await layout('studio');
  check('teach, gallery, practice, inspector and visit hooks are registered as real features', await S("api.features.list().filter(f => f.available).map(f => f.id).join(',') === 'teach,gallery,practice,inspector,visit'"));
  check('inspection API exposes teach, gallery, practice, inspector, visit and modelNet', await S("typeof api.teach.open === 'function' && typeof api.gallery.open === 'function' && typeof api.practice.open === 'function' && typeof api.inspector.open === 'function' && typeof api.visit.invite === 'function' && api.modelNet.parameters === 5543 && api.iteration === 4"));
  check('a new pet starts with untrained networks (authored attempts)', await S("api.modelNet.steps('music') === 0 && api.modelNet.steps('drawing') === 0 && api.teach.engine.generators.music === 'imitate-phrase-v1'"));

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
  await shot('workshop-music', { studio: true });
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
  await shot('workshop-music-template', { studio: true });
  await page.tap('[data-ws="chromatic"]');
  await page.sleep(300);
  check('chromatic keyboard shows all 22 keys', (await page.eval('document.querySelectorAll(".ws-key").length')) === 22);
  await layout('workshop-chromatic');
  await shot('workshop-music-chromatic', { studio: true });
  await page.tap('[data-ws="chromatic"]');
  await page.tap('[data-ws="record"]');
  check('record arms a count-in', await S('api.teach.state.recording'));
  await page.tap('[data-ws="record"]');
  check('record can be stopped', !(await S('api.teach.state.recording')));
  await page.tap('[data-ws="record"]');
  await shot('workshop-music-recording', { studio: true });
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
  // Every shape chip is whole: not cut by its row, the sheet edge or the Stamp | Trace toggle.
  const chipIssues = await page.eval(`(() => {
    const sheet = document.getElementById('workshop').getBoundingClientRect();
    const mode = document.querySelector('[data-panel="drawing"] .ws-mode').getBoundingClientRect();
    const hit = (a, b) => a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
    return [...document.querySelectorAll('[data-panel="drawing"] .ws-chip')].filter((c) => {
      const r = c.getBoundingClientRect();
      const row = c.parentElement.getBoundingClientRect();
      return r.left < row.left - 0.5 || r.right > row.right + 0.5 || r.left < sheet.left || r.right > sheet.right || hit(r, mode) || c.scrollWidth > c.clientWidth + 1;
    }).map((c) => c.textContent.trim());
  })()`);
  check('every shape chip is fully visible, clear of the Stamp | Trace toggle', chipIssues.length === 0, chipIssues);
  await shot('workshop-drawing', { studio: true });
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
  await shot('lesson', { studio: true });
  await S('api.setTimeScale(4)');
  await waitState('window.__PET_STUDIO__.state.activity.type === "playing_music"', 30000);
  await S('api.setTimeScale(1)');
  await page.sleep(1500);
  check('the pet performs its attempt at the Music Corner', (await S('api.state.activity.plan && api.state.activity.plan.mode')) === 'attempt');
  const bar = await layout('performing-music');
  check('feedback bar visible while performing', !!bar.overlays.creationBar);
  check('feedback bar never overlaps the pet', bar.pet && !bar.pet.overlapsCreationBar, bar.pet);
  await shot('performing-music', { studio: true });
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
  await shot('feedback-done', { studio: true });
  await page.tap('#creation-bar [data-fb="calmer"]');
  await page.sleep(400);
  check('Calmer stores a direction signal and lowers energy', (await S('api.teach.prefs.energy')) < 0 && (await S("api.teach.signals.some(s => s.kind === 'nudge' && s.nudge === 'calmer')")));
  check('a guided retry starts, tagged Calmer', (await S("api.creation.subject.mode === 'variation' && api.creation.subject.tags[0] === 'calmer'")));
  await S('api.setTimeScale(6)');
  await waitState('window.__PET_STUDIO__.creation.bar.phase === "done"', 40000);
  await S('api.setTimeScale(1)');
  // Once the piece is over and the pet walks away, the camera stops aiming at the Music Corner.
  check('the camera shows the Music Corner while the pet performs there', (await S('api.camera.view')) === 'music');
  for (let i = 0; i < 3 && (await S('api.state.activity.type')) !== 'walking'; i++) {
    await S('api.actions.listen()'); // a stubborn pet may refuse once, never twice in a row
    await page.sleep(200);
  }
  await waitState('window.__PET_STUDIO__.state.activity.type === "walking"', 10000);
  await page.sleep(300);
  check('when the pet walks away from the station the camera returns to the overview', (await S('api.camera.view')) === 'overview');
  await S('api.setTimeScale(6)');
  await waitState('window.__PET_STUDIO__.state.activity.type !== "walking"', 30000);
  await S('api.setTimeScale(1)');
  await layout('after-performance');
  await shot('after-performance', { studio: true });

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
  await shot('performing-drawing', { studio: true });
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
  await layout('gallery', { petVisible: false, dockHidden: true });
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
  await layout('gallery-compare-music', { petVisible: false, dockHidden: true });
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
  await shot('wall', { studio: true });

  // ----- Persistence across reload --------------------------------------------------
  const before = { items: await S('api.gallery.items.length'), wall: await S('api.gallery.wall'), lessons: await S('api.teach.lessons.length'), signals: await S('api.teach.signals.length') };
  await S('api.save()');
  await page.goto(`${server.url}?skipIntro=1&mute=1`, { readyExpr: READY, timeout: 60000 });
  await page.sleep(1200);
  const after = { items: await S('api.gallery.items.length'), wall: await S('api.gallery.wall'), lessons: await S('api.teach.lessons.length'), signals: await S('api.teach.signals.length') };
  check('gallery, wall pin and teaching memory persist across reload', JSON.stringify(before) === JSON.stringify(after), { before, after });
  check('the wall frame shows the pinned drawing after reload', await S('api.gallery.wallArt.pinned === true'));
  await layout('after-reload');

  // ----- Sleep Practice: genuine on-device training while the pet naps -------------------
  await S('api.practice.setSpeed(40)');
  await openFeature('practice');
  check('Sleep Practice opens as a non-modal drawer (the studio stays live)', await S('api.practice.isOpen && document.querySelectorAll("dialog:modal").length === 0'));
  await S('api.setTimeScale(6)');
  await waitState('window.__PET_STUDIO__.practice.status === "practicing"', 60000);
  await S('api.setTimeScale(1)');
  check('opening Practice sends the pet to the Sleep Nook and it practises asleep', await S('api.state.asleep && api.camera.view === "sleep"'));
  await page.waitFor('window.__PET_STUDIO__.practice.state.sessionSteps >= 45', { timeout: 60000 });
  const p1 = await S('api.practice.state');
  check('training runs in time slices while the studio keeps animating', p1.sessionSteps >= 45 && p1.status === 'practicing', p1);
  check('live counters: steps, epoch and batch, training and validation loss, weight change, confidence',
    p1.epoch >= 1 && p1.batchesPerEpoch >= 1 && Number.isFinite(p1.trainLoss) && Number.isFinite(p1.valLoss) && p1.deltaNorm > 0 && p1.confidence > 0, p1);
  check('the dream preview names the lesson it is practising', !!p1.dream && (await page.eval('document.querySelector("#practice [data-sp-dream]").textContent.trim().length > 3')));
  check('the loss chart draws the training and validation curves', await page.eval('["train", "val"].every((k) => document.querySelector(`#practice [data-line="${k}"]`).getAttribute("points").split(" ").length >= 2)'));
  check('the status pill says it is practising in its dreams', /Practising|Dreaming/.test(await page.eval('document.getElementById("status-text").textContent')));
  check('dream notes drift up from the sleeping pet', (await S('api.renderInfo().particles')) > 0);
  await layout('practice');
  await shot('practice', { studio: true });
  await page.tap('#practice [data-sp="pause"]');
  check('Pause stops training', await S('api.practice.status === "paused"'));
  const steps0 = await S('api.practice.state.sessionSteps');
  await page.tap('#practice [data-sp="step"]');
  check('Step +1 runs exactly one mini-batch', (await S('api.practice.state.sessionSteps')) === steps0 + 1);
  await page.tap('#practice [data-sp="cancel"]');
  check('Cancel & Rollback restores the weights from before practice', await S('api.practice.status === "cancelled" && api.modelNet.steps("music") === 0 && api.modelNet.steps("drawing") === 0'));
  await page.tap('#practice [data-sp="start"]');
  await waitState('window.__PET_STUDIO__.practice.status === "practicing"', 20000);
  await S('api.practice.setSpeed(500)');
  await waitState('["complete", "rolled-back"].includes(window.__PET_STUDIO__.practice.status)', 120000);
  const done = await S('api.practice.state');
  check('a full session passes held-out validation and commits', done.result?.decision === 'committed' && done.status === 'complete', done.result);
  check('genuine weight updates: both networks moved away from the untrained baseline', await S('api.modelNet.stats.music.deltaNorm > 0.5 && api.modelNet.stats.drawing.deltaNorm > 0.5'));
  const cmp = await S('api.practice.comparison');
  check('before vs after uses the same seeds: authored before, learned after', !!cmp && /^imitate-/.test(cmp.before.generator) && cmp.after.generator === 'neural-v1', cmp);
  // A nudged style (this pet was told "calmer") can legitimately move the attempt away from the
  // lesson, so closeness is reported here; tests/neural-engine.test.mjs asserts it across many cases.
  check(`before vs after closeness reported (${cmp?.before.closeness} -> ${cmp?.after.closeness})`, !!cmp && cmp.before.closeness > 0 && cmp.after.closeness > 0, cmp);
  await page.eval('document.querySelector("#practice .sp-body").scrollTop = 1e6');
  await page.sleep(500);
  await layout('practice-complete');
  await shot('practice-complete', { studio: true });
  await page.tap('#practice [data-sp="perform"]');
  await page.waitFor('!window.__PET_STUDIO__.practice.isOpen', { timeout: 5000 });
  check('the pet wakes to perform what it practised', await S('!api.state.asleep'));
  await S('api.setTimeScale(6)');
  await waitState('["playing_music", "drawing"].includes(window.__PET_STUDIO__.state.activity.type)', 60000);
  await S('api.setTimeScale(1)');
  await page.sleep(1200);
  check('the feedback bar marks the learned version', await S('api.creation.bar.visible && api.creation.bar.learned === true'));
  await layout('performing-learned');
  await shot('performing-learned', { studio: true });
  await S('api.setTimeScale(8)');
  await waitState('window.__PET_STUDIO__.creation.bar.phase === "done"', 60000);
  await S('api.setTimeScale(1)');
  check('the learned version is saved to the gallery tagged neural-v1', await S("api.gallery.items.some((i) => i.origin === 'attempt' && i.generator === 'neural-v1')"));

  // ----- The learned state survives a reload ----------------------------------------
  const model = await S('({ music: api.modelNet.steps("music"), drawing: api.modelNet.steps("drawing"), val: api.modelNet.validation().total, attempt: JSON.stringify(api.modelNet.generate(api.teach.lessons[0].id)) })');
  await S('api.save()');
  await page.goto(`${server.url}?skipIntro=1&mute=1`, { readyExpr: READY, timeout: 60000 });
  await page.sleep(1200);
  const model2 = await S('({ music: api.modelNet.steps("music"), drawing: api.modelNet.steps("drawing"), val: api.modelNet.validation().total, attempt: JSON.stringify(api.modelNet.generate(api.teach.lessons[0].id)) })');
  check('learned weights reload exactly (same steps, validation loss and output)', model.music === model2.music && model.drawing === model2.drawing && Math.abs(model.val - model2.val) < 1e-9 && model.attempt === model2.attempt, { model, model2 });

  // ----- Visit / Jam: a visiting friend in the 3D studio (Iteration 4) -------------------
  await openFeature('visit');
  check('Visit / Jam opens as a non-modal sheet (the studio stays live)', await S('api.visit.isOpen && document.querySelectorAll("dialog:modal").length === 0'));
  const friendNames = await page.eval('[...document.querySelectorAll("#visit .vs-friend h4")].map((h) => h.textContent)');
  check('the three built-in friends are ready to invite: Mochi, Bongo and Lyra', ['Mochi', 'Bongo', 'Lyra'].every((n) => friendNames.includes(n)), friendNames);
  check('each built-in friend shows its temperament', (await page.eval('[...document.querySelectorAll("#visit .vs-ftraits")].slice(0, 3).map((p) => p.textContent).join("|")')) === 'Calm · Neat|Playful · Chaotic|Curious · Dramatic');
  await layout('visit-sheet');
  await shot('visit-sheet', { studio: true });
  await page.tap('#visit .vs-friend[data-friend="builtin-mochi"] [data-vs="invite"]');
  check('inviting Mochi adds a second pet model to the 3D studio', await S('api.visit.model?.inScene === true && api.renderInfo().pets === 2'));
  await S('api.setTimeScale(3)');
  await waitState('window.__PET_STUDIO__.visit.visitor?.arrived === true', 30000);
  await S('api.setTimeScale(1)');
  await page.sleep(900);
  check('Mochi walks in from the door to a hangout spot', await S('api.visit.visitor.walked > 1 && api.visit.model.scale > 0.98'));
  check('its toy xylophone appears beside the studio keyboard', await S('api.renderInfo().xylophone === true'));
  check('the visitor card offers Jam, Co-Draw, Learn From (after a session) and Send Home', await page.eval(`(() => {
    const q = (s) => document.querySelector('#visit [data-vs="' + s + '"]');
    return !q('jam').disabled && !q('codraw').disabled && q('learn').disabled && q('home').textContent.includes('Send Mochi Home');
  })()`));
  await layout('visit-arrived', { visitorVisible: true });
  await shot('visit-arrived', { studio: true });

  // Jam Together: the visitor's call on its xylophone, then the host's answer on the keyboard.
  await page.tap('#visit [data-vs="jam"]');
  await page.waitFor('!document.getElementById("visit").open', { timeout: 5000 });
  check('Jam Together closes the sheet so both pets are in full view', !(await S('api.visit.isOpen')));
  await S('api.setTimeScale(3)');
  await waitState('window.__PET_STUDIO__.visit.session?.phase === "performing"', 40000);
  await S('api.setTimeScale(1)');
  check('both pets go to the Music Corner: the host at the keyboard, Mochi at its xylophone', await S(`api.state.activity.type === 'playing_music' && api.state.activity.plan.mode === 'social'
    && Math.hypot(api.visit.visitor.position.x - api.visit.spots.jam.x, api.visit.visitor.position.z - api.visit.spots.jam.z) < 0.1`));
  check('the camera frames both pets for the jam', (await S('api.camera.view')) === 'jam');
  await page.waitFor('window.__PET_STUDIO__.visit.duet?.turn === "visitor" && window.__PET_STUDIO__.visit.duet.beat > 0.5', { timeout: 20000 });
  check('Mochi plays its signature phrase first while the host listens', await S("api.visit.visitor.activity === 'playing_music' && api.visit.session.turn === 'visitor'"));
  check('the feedback bar tags the piece "Duet with Mochi" and offers Learn From Mochi', await page.eval(`(() => {
    const bar = document.getElementById('creation-bar');
    const learn = bar.querySelector('[data-fb="learn"]');
    return bar.querySelector('.cb-social').textContent === 'Duet with Mochi' && !learn.hidden && learn.textContent.includes('Learn From Mochi');
  })()`));
  await layout('jam-call', { visitorVisible: true });
  await shot('jam-call', { studio: true });
  await S('api.setTimeScale(3)');
  await waitState('window.__PET_STUDIO__.visit.session?.turn === "host"', 30000);
  await S('api.setTimeScale(1)');
  await page.sleep(900);
  check('then the host answers on the keyboard while Mochi listens', await S("api.visit.visitor.activity === 'lesson' && api.state.activity.type === 'playing_music'"));
  await layout('jam-answer', { visitorVisible: true });
  await shot('jam-answer', { studio: true });
  await S('api.setTimeScale(4)');
  await waitState('window.__PET_STUDIO__.visit.session?.phase === "done"', 40000);
  await S('api.setTimeScale(1)');
  const duet = await S("api.gallery.items.find((i) => i.origin === 'social' && i.kind === 'music')");
  check('the duet is saved to the Gallery tagged "Duet with Mochi"', !!duet && duet.social?.label === 'Duet with Mochi' && duet.social.split === 8, duet);
  check('the host answered with its own trained networks (neural-v1)', duet?.generator === 'neural-v1', duet?.generator);
  await page.tap('#creation-bar [data-fb="learn"]');
  await page.sleep(300);
  const socialLessons = await S("api.teach.lessons.filter((l) => l.source === 'social')");
  check('Learn From Mochi keeps its demonstration as a social lesson at half weight (0.5x)', socialLessons.length === 1 && socialLessons[0].weight === 0.5 && socialLessons[0].from?.name === 'Mochi' && socialLessons[0].kind === 'music', socialLessons);
  check('the feedback bar marks it learned', (await page.eval('document.querySelector("#creation-bar [data-fb=learn]").getAttribute("aria-pressed")')) === 'true');
  check('Sleep Practice will replay it with your lessons', await S('api.modelNet.data().music.counts.social > 0'));
  await layout('jam-learned', { visitorVisible: true });

  // Co-Draw Together: turns at the shared easel.
  await S('api.setTimeScale(4)');
  await waitState('!window.__PET_STUDIO__.visit.session', 30000);
  await S('api.setTimeScale(1)');
  await openFeature('visit');
  await page.tap('#visit [data-vs="codraw"]');
  await page.waitFor('!document.getElementById("visit").open', { timeout: 5000 });
  await S('api.setTimeScale(3)');
  await waitState('window.__PET_STUDIO__.visit.session?.phase === "performing"', 40000);
  await S('api.setTimeScale(1)');
  check('both pets go to the easel and the camera frames them', (await S('api.camera.view')) === 'codraw' && (await S("api.visit.visitor.activity === 'drawing' && api.state.activity.type === 'drawing' && api.state.activity.plan.mode === 'social'")));
  const owners = new Set();
  for (let i = 0; i < 160 && owners.size < 2; i++) {
    const pen = await S('api.visit.pen');
    if (pen?.owner) owners.add(pen.owner);
    await page.sleep(100);
  }
  check('they take turns: Mochi\'s strokes and the host\'s strokes on one canvas', owners.has('v') && owners.has('h'), [...owners]);
  await page.sleep(1500);
  await layout('codraw', { visitorVisible: true });
  await shot('codraw', { studio: true });
  await S('api.setTimeScale(5)');
  await waitState('window.__PET_STUDIO__.visit.session?.phase === "done"', 60000);
  await S('api.setTimeScale(1)');
  const pic = await S("api.gallery.items.find((i) => i.origin === 'social' && i.kind === 'drawing')");
  check('the co-drawn picture is saved tagged "Co-Drawn with Mochi"', !!pic && pic.social?.label === 'Co-Drawn with Mochi' && /^[vh]+$/.test(pic.social.owners ?? ''), pic);
  await page.sleep(600);
  await shot('codraw-done', { studio: true });
  check('the co-drawn picture hangs in the 3D wall frame', await S(`api.gallery.hang('${pic?.id}') && api.gallery.wallArt.pinned === true`));
  await page.sleep(2400);
  await layout('codraw-wall', { petVisible: false });
  await shot('codraw-wall', { studio: true });

  // Snapshots: export, a malformed paste, a hostile paste, and a copy of the pet itself.
  await openFeature('visit');
  await page.tap('#visit [data-vs="export"]');
  await page.sleep(300);
  check('Download Snapshot names the file after the pet', /-snapshot\.json/.test(await page.eval('document.querySelector("#visit [data-vs-msg]").textContent')));
  const exported = await S('api.visit.parse(api.visit.exportJSON())');
  check('the snapshot carries look, temperament, style, learned weights and two songs and drawings (bounded)', exported.ok && exported.summary.learned.trained && exported.summary.phrases.length === 2 && exported.summary.drawings.length === 2 && exported.summary.bytes < 262144, exported.summary ?? exported);
  await page.tap('#visit [data-vs="paste-toggle"]');
  const paste = async (text) => {
    await page.eval((t) => { document.querySelector('#visit [data-vs-paste]').value = t; }, text);
    await page.tap('#visit [data-vs="paste-import"]');
    await page.sleep(300);
    return page.eval('({ text: document.querySelector("#visit [data-vs-msg]").textContent, tone: document.querySelector("#visit [data-vs-msg]").dataset.tone })');
  };
  const bad = await paste('definitely not a snapshot');
  check('a malformed paste is rejected with a clear message (and nothing breaks)', bad.tone === 'warn' && /not valid snapshot JSON/.test(bad.text), bad);
  const friendsBefore = await S('api.visit.friends.length');
  const hostile = await paste(JSON.stringify({ format: 'petstudio.snapshot.v1', pet: { name: '<img src=x onerror=window.__pwned=1>' }, neural: { weights: { music: '!!' } } }));
  check('a hostile snapshot is sanitised: no markup reaches the page and damaged weights are dropped', hostile.tone === 'good' && /damaged/.test(hostile.text)
    && (await page.eval('!document.querySelector("#visit [onerror], #visit img") && window.__pwned === undefined')), hostile);
  const hostileId = await S("api.visit.friends.find((f) => f.origin === 'import' && !f.trained)?.id");
  if (hostileId) await page.tap(`#visit .vs-friend[data-friend="${hostileId}"] [data-vs="remove"]`);
  check('an imported friend can be removed again', (await S('api.visit.friends.length')) === friendsBefore);
  const self = await paste(await S('api.visit.exportJSON()'));
  check('importing your own snapshot adds a copy with its own identity', /copy of your own pet/.test(self.text), self);
  const copyId = await S("api.visit.friends.find((f) => f.origin === 'import' && f.trained)?.id");
  await page.tap(`#visit .vs-friend[data-friend="${copyId}"] [data-vs="invite"]`);
  await S('api.setTimeScale(3)');
  await waitState('window.__PET_STUDIO__.visit.visitor?.arrived === true', 30000);
  await S('api.setTimeScale(1)');
  await page.sleep(900);
  check('the copy visits beside the original, with its learned weights (never trained here)', await S("api.visit.visitor.displayName.endsWith('(copy)') && api.visit.visitor.engine.trained === true && api.visit.visitor.id !== api.state.id && api.renderInfo().pets === 2"));
  await layout('visit-copy', { visitorVisible: true });
  await shot('visit-copy', { studio: true });

  // The visit survives a reload; Send Home ends it.
  await S('api.save()');
  await page.goto(`${server.url}?skipIntro=1&mute=1`, { readyExpr: READY, timeout: 60000 });
  await page.sleep(1500);
  check('the visit survives a reload: the friend is still in the studio', await S("!!api.visit.visitor && api.visit.visitor.displayName.endsWith('(copy)') && api.visit.model?.inScene === true"));
  await openFeature('visit');
  await page.tap('#visit [data-vs="home"]');
  await S('api.setTimeScale(3)');
  await waitState('!window.__PET_STUDIO__.visit.visitor', 30000);
  await S('api.setTimeScale(1)');
  await page.waitFor('window.__PET_STUDIO__.visit.model === null && window.__PET_STUDIO__.renderInfo().xylophone === false', { timeout: 10000 }).catch(() => {});
  check('Send Home ends the visit and removes the second pet model and its xylophone', await S('api.visit.model === null && api.renderInfo().pets === 1 && api.renderInfo().xylophone === false'));
  await layout('after-visit');
  await page.key('Escape');
  await page.sleep(300);
  check('Escape closes the Visit sheet', !(await S('api.visit.isOpen')));

  // ----- Learning Inspector -----------------------------------------------------------
  await openFeature('inspector');
  await page.sleep(500);
  await layout('inspector', { petVisible: false, dockHidden: true });
  const text = await page.eval('document.getElementById("inspector").textContent');
  check('inspector: both networks with layer sizes and parameter counts', ['MusicPolicyNet', 'StrokePolicyNet', '3,290', '2,253', '5,543', '75 → 32 tanh → 26'].every((s) => text.includes(s)));
  check('inspector: replay buffer, signals and the learned-vs-authored table', ['Love signals', 'Direction signals', 'Needs, moods and care', 'Learned', 'Authored'].every((s) => text.includes(s)));
  const total0 = await S('api.modelNet.stats.totalSteps');
  await page.tap('#inspector [data-in="run"]');
  check('Run 10 Training Steps really trains (or safely rolls back)', (await S('api.modelNet.stats.totalSteps')) === total0 + 10);
  await page.tap('#inspector [data-in="save"]');
  check('Save Checkpoint adds a named checkpoint', await S("api.inspector.checkpoints.some((c) => c.kind === 'user')"));
  await page.tap('#inspector [data-in="measure"]');
  check('the evidence table compares authored, untrained-at-same-alpha and learned', (await page.eval('document.querySelectorAll("#inspector [data-in-evidence] tbody tr").length')) >= 2);
  check('the replay buffer lists the visitor\'s social lesson at half weight', /Mochi's .*×0\.5/.test(await page.eval('document.querySelector("#inspector [data-in-data]").textContent')));
  await layout('inspector-evidence', { petVisible: false, dockHidden: true });
  // Every Rollback button and all three closeness numbers of every lesson are fully visible (no clipped column).
  const tableIssues = await page.eval(`(() => {
    const body = document.querySelector('#inspector .in-body').getBoundingClientRect();
    const out = (r) => r.left < body.left - 0.5 || r.right > body.right + 0.5;
    const bad = [];
    for (const b of document.querySelectorAll('#inspector [data-in="rollback"]')) {
      if (out(b.getBoundingClientRect()) || b.scrollWidth > b.clientWidth + 1) bad.push('rollback ' + b.dataset.id);
    }
    for (const row of document.querySelectorAll('#inspector [data-in-evidence] tbody tr')) {
      const nums = [...row.querySelectorAll('.ev-num')];
      if (nums.length !== 3) bad.push('row without three numbers: ' + row.textContent.slice(0, 30));
      for (const n of nums) if (out(n.getBoundingClientRect()) || n.getBoundingClientRect().width < 8 || !/\\d%|–/.test(n.textContent)) bad.push('number ' + n.textContent);
    }
    return bad;
  })()`);
  check('every checkpoint\'s Rollback button and all three closeness percentages are fully visible', tableIssues.length === 0, tableIssues);
  await page.eval('document.querySelector("#inspector [data-in-ckpts]").scrollIntoView({ block: "start" })');
  await page.sleep(200);
  await shot('inspector');
  await page.eval('document.querySelector("#inspector [data-in-evidence]").scrollIntoView({ block: "start" })');
  await page.sleep(200);
  await shot('inspector-evidence');
  await layout('inspector-scrolled', { petVisible: false, dockHidden: true });
  const preSteps = await S("api.inspector.checkpoints.find((c) => c.id === 'pre-sleep').steps");
  await page.tap('#inspector [data-ckpt="pre-sleep"] [data-in="rollback"]');
  check('Rollback to Checkpoint restores that checkpoint', (await S('api.modelNet.steps("music")')) === preSteps.music && (await S('api.modelNet.steps("drawing")')) === preSteps.drawing);
  await page.tap('#inspector [data-in="reset"]');
  check('Reset asks for a second tap first', /again/i.test(await page.eval('document.querySelector("#inspector [data-in=\\"reset\\"]").textContent')));
  await page.sleep(600);
  await page.tap('#inspector [data-in="reset"]');
  const reset = await S('({ music: api.modelNet.steps("music"), drawing: api.modelNet.steps("drawing"), delta: api.modelNet.stats.deltaNorm, msg: api.inspector.summary.message })');
  check('Reset Model to Untrained (confirmed) returns to the baseline', reset.music === 0 && reset.drawing === 0 && reset.delta === 0, reset);
  await page.key('Escape');
  await page.sleep(300);
  check('Escape closes the Inspector', !(await S('api.inspector.isOpen')));

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

  // ----- Installable web app: manifest, icons, offline service worker ------------------
  const pwa = await page.eval(`(async () => {
    const href = document.querySelector('link[rel="manifest"]')?.getAttribute('href');
    const res = href ? await fetch(href) : null;
    const m = res?.ok ? await res.json() : null;
    const icons = [];
    for (const i of m?.icons ?? []) {
      const r = await fetch(i.src);
      const b = new Uint8Array(await r.arrayBuffer());
      icons.push({ src: i.src, sizes: i.sizes, purpose: i.purpose, ok: r.ok, png: b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e, svg: new TextDecoder().decode(b.slice(0, 5)) === '<svg ' });
    }
    const apple = document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href');
    const ar = apple ? await fetch(apple) : null;
    return { href, type: res?.headers.get('content-type'), name: m?.name, short: m?.short_name, display: m?.display, start: m?.start_url, icons, apple: !!ar?.ok };
  })()`);
  check('the web app manifest is linked and complete (name, standalone display, start URL)', pwa.name === 'Pet Studio' && pwa.short === 'Pet Studio' && pwa.display === 'standalone' && pwa.start === './', pwa);
  check('manifest icons load: 192 and 512 PNG, a maskable 512 and an SVG', ['192x192', '512x512'].every((sz) => pwa.icons.some((i) => i.sizes === sz && i.ok && i.png))
    && pwa.icons.some((i) => i.purpose === 'maskable' && i.ok && i.png) && pwa.icons.some((i) => i.ok && i.svg), pwa.icons);
  check('an apple-touch-icon is linked for iOS home screens', pwa.apple, pwa);
  await page.waitFor('window.__PET_STUDIO__.pwa.serviceWorker.registered === true', { timeout: 15000 }).catch(() => {});
  check('the offline service worker is registered', await S('api.pwa.serviceWorker.registered === true'), await S('api.pwa.serviceWorker'));

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
