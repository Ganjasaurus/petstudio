# Pet Studio: Iterations 1 to 3

A cozy 3D creative pet that lives in a miniature studio. It gets hungry, sleepy and bored,
walks between five stations, plays little tunes, paints on a live easel, splashes in the
bath and naps in its nook. You can care for it, teach it tunes and drawings, and watch its
own takes in the Creation Gallery.

**Iteration 3** (Milestones 5, 6 and 7 of the plan) adds genuine on-device learning. Each pet
owns two small neural networks that train in the page, with Float32 tensors, analytic
backpropagation and Adam, on the lessons you taught it:

* **Sleep Practice:** the pet naps in its Sleep Nook while the networks train in time
  slices. You see live losses, a loss chart and what it is dreaming about, and you can
  pause, step, cancel and roll back. Afterwards a before-and-after card compares its attempts.
* **Learning Inspector:** sizes, weights, checkpoints with rollback, the training data, a
  fair evidence check, and a table of what is learned versus authored.

Once a network has trained, the pet's attempts blend in what it learned and are labelled
**Learned** (generator `neural-v1`).

Iteration 3 also fixes four layout issues found in the Iteration 2 screenshots (see
[Layout fixes](#iteration-3-layout-fixes)). Iteration 2 added the Teaching Workshop, the
Creation Feedback Bar and the Gallery; Iteration 1 built the studio, the pet and the care loop.

> **Scope note.** `ASTRA_SPEC.md` targets a *native iPhone* app (SwiftUI + RealityKit).
> By explicit direction this project is a responsive **Three.js web app** instead. The
> learning loop runs in the foreground only: training happens while the page is open and
> the pet naps, and nothing trains while the app is closed or the tab is hidden. Native
> background processing (BackgroundTasks) and nearby exchange (Multipeer Connectivity) are
> not implemented and nothing here claims otherwise.

## Quick start

```bash
npm install
npm run build   # bundles src/main.js -> dist/app.js (esbuild, ESM, es2022) + copies index.html, styles.css
npm test        # node:test suites in tests/ (143 cases)
npm run dev     # serves dist/ at http://localhost:4188 (python -m http.server)
npm run verify  # builds, then drives headless Edge through every flow at three viewports
```

`npm run verify` (scripts/verify-ui.mjs) needs Microsoft Edge or Chrome
(`PETSTUDIO_BROWSER=/path/to/browser` overrides the lookup). With software rendering a
full run takes 30 to 40 minutes; `node scripts/verify-ui.mjs --only=phone` (or `tablet`,
`desktop`) runs one device. Screenshots and JSON reports go to `artifacts/verify/`.

`node build.mjs --dev` builds unminified with inline source maps; `node build.mjs --watch`
rebuilds on change. Everything runs offline: no fonts, models, textures or sounds are
downloaded. Geometry, textures and audio are generated on the device, and the networks
start from a deterministic baseline computed at load time (see below).

### Playing

* **Dock:** Feed, Wash, Rest/Wake, Pet, Praise, Go Play Music, Go Draw, Customize, and the
  Workshop group: **Teach**, **Gallery**, **Practice** and **Inspector**. On phones and
  tablets the Workshop group lives in the **More** sheet.
* **Tap the pet** to pet it (it snuggles even while practising in its sleep). **Tap a
  station** to send it there. **Tap the picture frame** to open the Gallery.
* **Camera:** drag to orbit, pinch or scroll to zoom, or pick a view in the top bar.
* **Keys (desktop):**
  * Care and studio: F feed, W wash, R rest/wake, P pet, G praise, J music, D draw, L listen,
    C customize.
  * Features: T teach, Y gallery, **Z Sleep Practice**, **I Inspector**.
  * General: M mute, 1-5 or V camera views.
  * In the workshop's Music tab, the keyboard plays notes and Z X C V play the pads.
* First launch opens the pet creator. Progress, lessons, creations and learned weights
  are saved in `localStorage`.

URL options: `?skipIntro=1`, `?seed=abc` (deterministic new pet), `?reset=1` (deletes the
pet, its lessons, gallery and learned model), `?mute=1`, `?speed=4` (simulation time scale),
`?view=pet|music|easel|sleep|overview`.

## Iteration 3: on-device learning

### The two networks (`src/neural-engine.js`)

| Network | Layers | Trainable float32 parameters | What it predicts | Loss |
| --- | --- | --- | --- | --- |
| **MusicPolicyNet** | 75 → 32 tanh → 26 | 3,290 | For each eighth-note slot: whether a note starts, its pitch over the 22 keys (C4 to A5), its duration, its velocity, and a tempo modulation | Binary cross-entropy (onset), categorical cross-entropy (pitch), squared error (duration, tempo), BCE (velocity) |
| **StrokePolicyNet** | 42 → 40 tanh → 13 | 2,253 | Along each stroke: tangent and normal offsets from a smoothed reference path, pen pressure, width, steadiness, and a colour over the 8 paints | Squared error (offsets, width), BCE (pressure, steadiness), cross-entropy (colour) |

That is **5,543 trainable parameters** in total, 21.7 KiB per checkpoint. Both networks
are plain two-layer perceptrons on one flat `Float32Array` each. The forward pass, the
backward pass and the optimizers are written out by hand; there is no ML library.

**Inputs (shared fixed features, never trained).**

* **MusicPolicyNet** is autoregressive. It sees:
  * the previous pitch (one-hot) and the last interval;
  * the gap since the last onset, the beat phase, the bar and the phrase position;
  * the pet's temperament (7 traits) and the player's style guidance (energy, order);
  * a 20-number embedding of the lesson it is attempting: its pitch-class profile,
    register, range, density, mean duration and velocity, tempo and length.
* **StrokePolicyNet** sees:
  * the position `t` along the stroke, with Fourier features;
  * the smoothed reference point, tangent and curvature (here and 0.04 either side);
  * stroke features: index, length, closedness, bounding box, centroid, width, dot flag
    and colour;
  * temperament and style.
* The smoothed reference resamples each stroke to 96 points and applies four `[1 2 1]/4`
  passes. The network learns to restore the detail that smoothing removes.

**Baseline.** A seeded Xavier initialisation, identical for every pet. The output layer
starts at zero, and its biases are set from statistics of the bundled starter repertoire:

* the onset rate, pitch histogram, mean duration and velocity measured over the four tune
  templates and 16 starter phrases;
* a neutral stroke prior with a low "steadiness".

An untrained network therefore predicts exactly that prior. The baseline is recomputed at
load time and is never stored.

**Training data (the replay buffer).** `trainingDataFrom()` reads the teaching memory and the gallery.

* **Demonstrations** are the supervised targets, weight 1.0.
* **Style copies:** once you have nudged, each lesson also appears in your current style,
  with that style as the network's style input. Weight 0.35, plus 0.1 per nudge on that
  axis, up to 0.8. The transforms are documented and deterministic:
  * calmer: slower, fewer and longer notes, softer;
  * livelier: faster, eighths, louder;
  * neater: leaps compressed to two scale steps, less stroke detail;
  * wilder: leaps widened, extra wobble, lower steadiness.
* **Preferences:** loved or starred creations of the pet are reward-weighted examples,
  weight 0.5 × reward. They are never treated as corrected labels.
* **Label smoothing** keeps the networks from being confidently wrong about notes they
  never saw:
  * onset targets are 0.08 and 0.92;
  * pitch targets put 30% of their mass on the lesson's own note distribution;
  * colour uses 10% uniform smoothing.
  Losses are reported as KL divergences, so a perfect fit scores 0.
* **Held-out split, made before any augmentation:**
  * music: exactly 1 in 5 of each lesson's note slots and 1 in 5 of its silent slots,
    picked by hash;
  * drawing: about 1 in 5 stroke samples, by hash.
  A style copy of a held-out position is held out too.

**Optimisation.**

* Adam (learning rate 0.008, β 0.9 / 0.999); momentum SGD is selectable in the Inspector.
* Mini-batches of 24 are sampled with replay: 50% the newest lesson, 35% older lessons,
  15% preference and style examples.
* The global gradient norm is clipped at 4.
* An L2 *prior anchor* (2e-4) pulls the weights toward the untrained baseline.
* One practice step updates each network that has data.
* All of these are developer settings in the Inspector.

**Sessions, validation and rollback** (`PracticeSession`). `computeValidationLoss()`
evaluates the held-out set deterministically every 20 steps.

* Each network is judged on its **own** held-out set.
* **Noise allowance.** One short tune holds out only two or three notes, so the
  comparisons carry a noise allowance of 2/√n nats: about two standard errors.
* **Practice stops on worsening.** A network whose held-out loss stays above its pre-sleep
  level (plus the margin and allowance) for 3 checks stops practising.
* **At the end of a session:**
  * a network that clearly overfitted returns to its best weights; this only applies with
    at least 8 held-out samples;
  * a network that ends more than 10% above its pre-sleep loss (plus the allowance) is
    rolled back to its pre-sleep weights;
  * NaN or Infinity anywhere rolls the whole session back at once.
* The data is frozen for the duration of a session, so "before" and "after" stay comparable.

**Checkpoints and storage.** Record `petstudio.model.v1` (+ `.bak`), schema
`petstudio.model` version 1, about 118 KiB. It holds at most five checkpoints:

* `untrained`: regenerated, never stored;
* `pre-sleep`;
* `latest`: with Adam moments, for faithful resumption;
* up to two user snapshots.

Plus progress counters, a 240-point loss history and the settings.

* **Partial checkpoints.** Validated progress is checkpointed every 60 steps, so a reload
  keeps it. The next launch says that practice stopped when the app closed; nothing is
  claimed to have trained while it was closed.
* **Load-time checks.** Loading validates the architecture, dimensions, base64 lengths and
  finite values (|w| ≤ 1000). It falls back to the backup when the `latest` checkpoint is
  damaged, keeps future versions aside (`.future`), and moves another pet's model or an
  incompatible architecture aside (`.orphan`). On a quota error the backup copy is
  dropped first.

**How attempts use the networks** (`src/hybrid-engine.js`).
`HybridCreativeEngine.compose()` keeps the same interface as the authored engine.

* **While a network has no training steps,** its kind is composed by the authored rules
  (generators `imitate-phrase-v1` / `imitate-draw-v1`).
* **After training,** the network is blended in with weight
  α = (1 − e^(−steps/100)) × (0.25 + 0.75 × familiarity), and the output is tagged
  `neural-v1` with its steps and α. Familiarity, 1 − e^(−n/40), counts the steps that
  practised this lesson. A lesson the pet never practised gets at most a quarter of the
  learned weight. A tune or drawing re-taught with identical content is recognised by a
  content fingerprint. The Practice drawer shows α as "Learned confidence": it is a schedule,
  not a quality score.
* **Music:** each slot blends logits, (1 − α) × the authored attempt + α × the network.
  * The weight shrinks where the network is unsure.
  * Positions held out for validation, which were never trained, get the unpractised
    quarter weight.
  * Percussion stays authored.
* **Drawing:** every point moves α of the way from the authored wobble toward the
  network's reconstruction; pressure, width and colour blend the same way. The learned
  steadiness damps the authored placement jitter (tilt, scale, shift). With α = 0 the
  output is identical to Iteration 2.
* **Model version.** Gallery items and pending plans store the model tag
  (`{ steps, alpha }`) of the network that made them.

### Sleep Practice (`src/practice-runner.js`, `src/sleep-practice.js`)

Registered with `features.register('practice', ...)`.

**Opening it.**

* The pet walks to the Sleep Nook and falls asleep. It does so even when it is not sleepy
  and is never stubborn about it; the nap is *held* while it practises.
* The camera frames the nook beside the drawer. The drawer is non-modal, so the studio
  stays live and touchable.
* Dream notes or sparkles drift up from the pet. A thought bubble shows a note or a brush.
* The status pill reads "Practising in its dreams".

**Running.**

* `PracticeRunner.tick()` runs inside the frame loop and is pure, so it is testable in Node.
* It paces training at 16 steps a second, a developer setting, and never starts a step
  after 4 ms of the frame have been used.
* Statuses are truthful: waiting, practicing, paused, complete, rolled back, cancelled.

**The drawer shows:**

* **Dreaming about:** the lesson most present in recent batches, with a live preview of
  the network's own version of it drawn over a faint copy of the lesson. The preview is
  redrawn as the weights change.
* **Counters:** Training Steps, Epoch · Batch, Training Loss (moving average of batch losses), Validation
  Loss (was …), Weight Change ‖Δθ‖ since practice began, and Learned Confidence.
* **Loss chart:** an SVG with a log scale. The training loss is a solid line and the
  validation loss a dashed line, and session marks are drawn as dotted lines.
* **Controls:** Start / Resume (Practise Again), Pause, Step +1, Cancel & Rollback (restores
  the pre-sleep weights) and Wake & Finish.

**After a session, Before practice vs after practice** compares the pet's attempts with the
pre-sleep weights and with the new ones. Both use the same six seeds, style and temperament.

* The card shows closeness to the lesson averaged over the six tries, and which generator
  made each side.
* **Have Pet Perform New Learned Version** wakes the pet and performs the "after" attempt.
  It is saved to the Gallery tagged Learned.

### Learning Inspector (`src/learning-inspector.js`)

Registered with `features.register('inspector', ...)`. It is a centred sheet on desktop and
a bottom sheet on phones, and it shows:

* **Networks:** layers, parameter counts, ‖θ‖, ‖θ − θ₀‖, steps in the weights, step
  confidence, held-out loss and sample counts, and the mode: authored or `neural-v1`.
* **Replay buffer:** lessons, training and held-out examples by role, love signals, nudge
  counts, style guidance and the replay mix.
* **Checkpoints:** a table with Rollback per row, plus Run 10 Training Steps (a short
  validation-gated session that needs no nap), Save Checkpoint and Reset Model to Untrained
  (asks for a second tap; lessons are kept).
* **Evidence:** closeness to each lesson with the same four seeds. The columns are
  authored (α 0), *untrained weights at today's α*, and learned now. The middle column
  separates what training learned from the blend schedule.
* **What is learned and what is authored:** an explicit table (see below).
* **Settings:** learning rate, batch size, steps per session, practice pace, replay share,
  prior anchor and optimizer.

### Measured results (Node 24, Windows 10, AMD FX-6300)

These are measurements, not guarantees. They come from scripted runs of the real modules
(`tests/neural-engine.test.mjs` asserts the same effects).

* **Music** (`artifacts/scratch/eval-music.mjs`, not shipped): 11 tunes × 7 pet
  temperaments = 77 cases. The tunes are the 4 templates, the verification tune and 6
  random user-like tunes. Each case is one 240-step session, and closeness is averaged over
  6 fixed seeds.
  * Mean closeness to the lesson rose by **+0.080**: 70 cases improved and **none got
    worse**.
  * In 7 cases (all one irregular tune) memorising it made its held-out notes 2.5× worse,
    so the gate **rolled the session back** and the pet kept its authored behaviour. That
    is the safety net working as intended.
* **Drawing:** 11 drawings × 7 temperaments = 77 cases. The drawings are the 5 stamps and 6
  hand-drawn-style lessons with wobble and varying pressure.
  * Mean closeness rose by **+0.025**: 70 improved, none worse, none rolled back.
  * Gains are largest for loose (chaotic) pets: +0.09 on hand-drawn lessons.
* **Fair control:** untrained weights at the same α do not reproduce the gains. The tests
  assert "trained > untrained at the same α" for music and drawing.
* **Replay:**
  * after training lesson A and then lesson B, A keeps **74%** of its loss improvement
    with replay;
  * with replay switched off it keeps **−4%**: completely forgotten.
* **Nudges are learned:**
  * after practice with "calmer ×2", the network's own tunes average 94 BPM against 104
    for a neutral pet. They are softer (velocity 0.59 against 0.74) and sparser, and its
    lines thinner (width 0.021 against 0.026);
  * "livelier ×2" averages 114 BPM, louder (0.81) and bolder (0.031);
  * "wilder ×2" widens the pitch range (11.5 against 8.75 semitones) and lowers the
    learned steadiness (0.97 to 0.57).
* **Cost,** on an idle 2012-era desktop CPU:
  * 1.6 to 1.9 ms per practice step for both networks (batch 24 each): 1.0 ms for music
    and 0.6 ms for drawing;
  * a validation pass takes 0.1 to 1.6 ms for one tune and one 9-stroke drawing;
  * composing an attempt takes about 1 ms for music and about 7 ms for that drawing;
  * the model record is 120,727 bytes with two checkpoints.

Software-rendered browser runs say nothing about phone GPU or thermal behaviour. None of
this was measured on a physical device.

### Iteration 3 layout fixes

1. **Dock vs. side drawers.**
   * `#dock` is centred in the safe lane:
     `left: calc(var(--safe-left) + var(--safe-width) / 2)`,
     `max-width: calc(var(--safe-width) - 24px)`.
   * `layout()` computes the lane as the screen minus any side drawer. The desktop needs
     panel ends far above the dock, so it does not count.
   * The dock then picks the roomiest layout that fits: full labels, short labels,
     compact (More), or two rows. So it sits beside the Workshop, Customizer or Practice
     drawer and never under it.
   * Toasts follow the lane.
   * `layout()` reports `dock.overlapsPanel`, `dock.insideLane` and `dock.hidden`, and
     verification asserts them at every step.
2. **Dock under centred sheets.** While the Gallery, the More sheet or the Inspector is
   open, the dock fades out (`opacity: 0; visibility: hidden; pointer-events: none`), so
   no half-covered buttons peek out.
3. **Phone Drawing tab.**
   * All five shapes fit on one row with short names ("Sun"), and the starter tunes do
     too; there is no scroll fade or cut chip.
   * The canvas sits beside a two-column colour grid and a vertical brush picker, so it
     is larger than before (≈270 px).
   * Stamp | Trace moved down beside Undo, Clear and Replay.
   * On phones the honesty note became one short line in the footer, so the sticky
     footer can never slice it. The workshop body fades at its bottom edge while more is
     below.
   * `layout()` reports `slicedNotes`. Buttons use `touch-action: manipulation`.
4. **Camera after a performance.** When a taught (or gallery) performance ends and the pet
   walks away from the station the camera had aimed at, it returns to the overview, which
   keeps the pet in the safe area. A view you picked yourself is never overridden.

Also fixed:

* The Sleep Nook view is centred higher, so a pet curled up in the cushion stays in frame.
* `StudioScene.resize()` no longer re-assigns an unchanged canvas size, which used to clear
  the WebGL canvas for a frame.

## Iteration 2: teaching, feedback and the gallery

* **Teaching Workshop** (`src/teaching-workshop.js`).
  * **Music tab:** a keyboard (pentatonic bars, or all 22 keys), four rhythm pads, a beat
    timeline, starter tunes, Record with a count-in, Preview, Undo, Clear and tempo.
  * **Drawing tab:** a pressure-aware canvas with colours, brushes, Undo, Clear and Replay,
    and shapes to stamp or trace.
  * **Teach Pet:** the pet listens or studies, walks to its station and performs its own take.
* **Creation Feedback Bar** (`src/hud.js`): Love It, which saves the piece and records a
  `+1.0` preference; Try Variation; and Calmer, Livelier, Neater or Wilder, which records a
  direction and starts a guided retry. A **Learned** chip marks `neural-v1` pieces.
* **Creation Gallery** (`src/gallery.js`):
  * origin badges, plus a Learned badge with the model's steps and α in its tooltip;
  * Perform or Redraw, Listen, Hang on Wall, and Compare with a descriptive similarity
    readout;
  * Favourite and Delete.

## Architecture

| Module | Responsibility |
| --- | --- |
| `src/pet-state.js` | Pet identity, needs, autonomy state machine, care actions, creation plans, the held practice nap (`startPracticeNap`), persistence. Pure. |
| `src/studio-layout.js`, `src/rng.js`, `src/starter-repertoire.js` | Floor plan and paths; seeded PRNG; authored starter songs and doodles. |
| `src/teaching-core.js` | Phrase and stroke representations, capture (recorders), sanitisation, templates, descriptive similarity and `lessonCloseness`. Pure. |
| `src/creative-engine.js` | `AuthoredCreativeEngine`: seeded variation rules. Its drawing path accepts the optional learned hand. |
| `src/neural-engine.js` | **Local learning:** features, `MLP`, `PolicyNet`s, datasets and replay, Adam/SGD, validation, `PracticeSession`, checkpoints, persistence. Pure, deterministic. |
| `src/hybrid-engine.js` | `HybridCreativeEngine`: authored rules blended with the trained networks (α). |
| `src/practice-runner.js` | **Training scheduling:** Sleep Practice sessions over the pet's nap, frame-budgeted pacing, partial checkpoints, before/after comparison. Pure. |
| `src/teaching-memory.js`, `src/gallery-store.js`, `src/persist.js` | Teaching memory (replay buffer), creation history, versioned storage with backups. |
| `src/creation-flow.js` | The teaching loop: lessons, performances, feedback, `performComposed` for learned versions. Pure. |
| `src/studio-scene.js`, `src/pet-model.js`, `src/particles.js`, `src/toon.js`, `src/canvas-icons.js` | 3D studio, camera rig, the pet, particles (including dream notes). |
| `src/drawing-surface.js`, `src/creation-render.js`, `src/audio.js` | Progressive easel, 2D painters, WebAudio synthesis. |
| `src/hud.js`, `src/customizer.js`, `src/teaching-workshop.js`, `src/gallery.js`, `src/sleep-practice.js`, `src/learning-inspector.js` | DOM UI. Each feature registers itself with `features.register`. |
| `src/main.js` | Composition root: wiring, frame loop (simulation, practice tick, rendering), layout and the dock lane, camera automation, saving, `window.__PET_STUDIO__`. |
| `scripts/` | Development tooling (not shipped): CDP harness, multi-device verification, quick screenshots. |

### What is authored, what is remembered, and what learns

| Part | How it works | Kind |
| --- | --- | --- |
| Needs, moods, care, choosing what to do | Hand-written rules, utility scores, seeded softmax | Authored |
| Walking, 3D animation, expressions | Waypoint paths and procedural animation | Authored |
| Starter songs and doodles | Seeded generators | Authored |
| Teaching memory | Stored lessons and labelled feedback; storing or retrieving changes no weight | Memory |
| Variation rules (echo, sequence, wobble, tilt) | `AuthoredCreativeEngine` | Authored |
| Features, smoothing, renderers, synthesiser | Fixed and shared by every pet | Shared fixed |
| Next note, duration, velocity, tempo | MusicPolicyNet weights, gradient descent | **Learned** |
| Stroke detail, pressure, width, colour, steadiness | StrokePolicyNet weights, gradient descent | **Learned** |
| Style-conditioned generation | Style inputs of both networks, trained on nudge-weighted style copies | **Learned** |
| How much the networks steer (α) | Schedule over steps and lesson practice | Authored |

Feedback stays labelled by meaning. `love` is a preference: a reward-weighted example,
never a corrected label. `nudge` is a direction: it moves the style input and weights the
style copies. Temperament only weights the authored rules, and enters the networks as a
constant input per pet.

### Persistence

| Key | Schema | Contents and retention |
| --- | --- | --- |
| `petstudio.pet.v1` (+ `.bak`) | `petstudio.pet` v1 | The pet: identity, appearance, needs, activity, counters. |
| `petstudio.teach.v1` (+ `.bak`) | `petstudio.teach` v1 | Teaching memory: at most 12 lessons per kind, 200 signals, ~600 KB. |
| `petstudio.gallery.v1` (+ `.bak`) | `petstudio.gallery` v1 | At most 40 items, ~1.2 MB. Items now carry an optional `model` tag. |
| `petstudio.workshop.v1` | `petstudio.workshop` v1 | The unfinished workshop draft. |
| `petstudio.model.v1` (+ `.bak`) | `petstudio.model` v1 | The learned networks: at most 5 checkpoints (~118 KiB with two), progress, history, settings. |

Every record is sanitised on load. A torn main record falls back to its backup, a future
version is copied to `*.future` and never overwritten, and data of another pet is moved to
`*.orphan`. Time away is bounded and gentle (care only). No training happens while the app
is closed, and the app never claims otherwise.

## Inspection API

`window.__PET_STUDIO__` exposes:

* `state`, `record`, `actions.*`, `camera`, `customize`, `setNeeds`, `setTimeScale`;
* `layout()`, `renderInfo()`, `features`, `save()` and `reset()`;
* `teach`, `gallery` and `creation`, as in Iteration 2. `teach.engine` now reports the
  hybrid engine.

Iteration 3 (`iteration: 3`) adds three groups:

* `practice`: `open`, `close`, `state` (status, steps, epoch and batch, losses, ‖Δθ‖,
  confidence, dream, result), `start`, `pause`, `step(n)`, `cancel`, `finish`,
  `performLearned`, `comparison`, `setSpeed`, `setSessionSteps`.
* `inspector`: `open`, `close`, `summary`, `checkpoints`, `run(n)`, `save`, `rollback(id)`,
  `reset`, `measure`.
* `modelNet`: `architecture`, `stats`, `parameters`, `settings`, `history`, `lastSession`,
  `steps(kind)`, `alpha(kind, lessonId)`, `validation()`, `data()`. Also:
  * `generate(lessonId)`: the network's own version of a lesson;
  * `attempt(lessonId)`: the pet's real blended attempt;
  * `save()`.

`layout()` additionally reports:

* `dock`: rect, hidden, fit mode, lane, side panels, `overlapsPanel`, `insideLane`;
* `slicedNotes`;
* overlays for the practice and inspector sheets.

## Testing and verification

* **`npm test` runs 143 `node:test` cases:** the 114 from Iterations 1 and 2, unchanged
  and passing, plus 29 in `tests/neural-engine.test.mjs`.
* **Architecture:** parameter counts. The untrained baseline is identical for every pet
  and predicts the starter prior. Forward passes are deterministic.
* **Gradients:** central finite differences match the analytic gradients of both networks.
  Gradients stay finite, training loss falls by more than 80%, and momentum SGD works too.
* **Validation split:** hold-out positions are chosen before augmentation.
* **Replay:** lesson A survives learning lesson B with replay and is forgotten without it.
* **Rollback:**
  * an injected NaN rolls back to the exact pre-sleep weights;
  * a corrupted update is rejected by validation;
  * corruption after a good check returns to the best weights;
  * a divergent learning rate never commits worse weights.
* **Checkpoints:** five at most; rollback and reset work; save and load is bit-exact with
  the Adam state, and responses are identical after reload; a torn record falls back to
  the backup; NaN, malformed and absurd checkpoints are dropped; damaged `latest`
  checkpoints are rejected; future, other-pet and incompatible records are kept aside;
  base64 is exact.
* **Learning changes the output:** music and drawing attempts get closer to the taught
  lesson after practice, with the same seeds and the untrained-at-same-α control. Calmer,
  livelier and wilder are learned. Two pets from one baseline diverge on a new lesson and
  train independently. The blend schedule is checked too.
* **Sleep Practice scheduling:** no data, then nap, pacing, held nap, pause, Step +1,
  completion with before/after, and Wake & Finish. A re-taught identical tune is
  recognised, and a session closed before any step leaves no "interrupted" mark. Also covered: the 4 ms frame budget,
  pausing when the pet wakes, Cancel & Rollback, and the creation flow tagging retries
  `neural-v1` after practice.
* **`npm run verify`** drives the production build in headless Microsoft Edge (SwiftShader
  WebGL) with real CDP touch and mouse input on three devices: 390x844 @3x touch, 768x1024
  @2x touch and 1440x900 @1x mouse.
  * It covers every Iteration 2 flow, plus the new Iteration 3 checks:
    * the dock is never under a side drawer and hides under the Gallery, More and
      Inspector sheets;
    * no note is sliced and no shape chip is cut;
    * the camera returns to the overview when the pet leaves a station.
  * Sleep Practice is driven by real taps: open, nap, live counters and chart, Pause,
    Step +1, Cancel & Rollback, Practise Again, commit, before/after, and Perform New
    Learned Version (`neural-v1` in the bar and the gallery).
  * Learned weights reload exactly.
  * In the Inspector it checks the content, then Run 10 steps, Save, Measure, Rollback,
    confirmed Reset and Escape.
  * `layout()` is checked at every step.
  * **Latest results:** all checks passed on every device: phone 198 of 198, tablet 198
    of 198, desktop 192 of 192. That means:
    * zero console errors, zero horizontal overflow and zero clipped controls;
    * zero spilling labels and zero sliced notes;
    * the dock never under a drawer and hidden under every centred sheet;
    * the pet inside the free area in every studio state checked.
* **Not yet verified:** physical devices, Safari/WebKit, audio output (the automated runs
  are muted), and real GPU or thermal behaviour.

## Known limitations

* **What the networks can learn.** They are deliberately small and learn narrow mappings:
  your tunes' notes and rhythms, your strokes' detail, pressure, width and colour, and
  your style nudges. They do not compose freely. Percussion and the drawing's composition
  (placement, flourishes, signature) stay authored.
* **Held-out sets are tiny for short tunes.** One tune holds out two or three notes, and
  memorising a one-off melody makes those notes harder to guess. The gate therefore
  carries a noise allowance and can still roll a tune back (seen for one irregular tune).
  Gains in held-out loss are modest for music. The reproduction gains come from the
  practised notes.
* **Blend weight.** α is a schedule over steps and practice, not a learned confidence. On
  lessons it never practised, the pet uses at most a quarter of the learned weight.
* **Foreground only.** Practice runs while the page is open and the pet naps. A hidden tab
  pauses it (requestAnimationFrame stops), and a reload keeps the last 60-step checkpoint.
* **Frame budget.** A validation pass every 20 steps can take a few milliseconds more than
  a normal step on large lesson sets.
* **Still missing:** nearby exchange, file export and import of pets, and native
  background training. No PWA manifest or service worker yet.
* **Descriptive measures.** Similarity and closeness are descriptive measures, never
  scores shown to the player.
