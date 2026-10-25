# Pet Studio: Iterations 1 and 2

A cozy 3D creative pet that lives in a miniature studio: it gets hungry, sleepy and bored,
walks between five stations, plays little tunes, paints on a live easel, splashes in the
bath and naps in its nook. You can feed, wash, rest, pet and praise it, send it to make
music or art, and customize its look and temperament.

**Iteration 2** (Milestones 3 and 4 of the plan) adds teaching. In the **Teaching
Workshop** you play a tune or draw a picture. Your pet listens, walks to the Music Corner
or the Easel, and performs its own take. A **Creation Feedback Bar** lets you love it, ask
for a variation, or guide it calmer, livelier, neater or wilder. The **Creation Gallery**
keeps your lessons and the pet's work, compares a lesson with the pet's attempt side by
side, and hangs a drawing in the frame on the studio wall.

Iteration 1 covered **Milestones 1 and 2**: the foundational architecture, the 3D studio,
the stylized customizable pet, the care-and-personality loop, the build and the tests.
Genuine on-device learning (Sleep Practice) and developer diagnostics (Inspector) are
Iteration 3; their hooks stay wired as placeholders.

> **Scope note.** `ASTRA_SPEC.md` targets a *native iPhone* app (SwiftUI + RealityKit).
> By explicit direction this iteration is a responsive **Three.js web app** instead.
> That is fine for the studio, care loop and in-browser training planned next, but some
> spec items cannot be met by a browser and will need a decision later: native background
> training (BackgroundTasks) and nearby exchange (Multipeer Connectivity). Nothing here
> claims otherwise.

## Quick start

```bash
npm install
npm run build   # bundles src/main.js -> dist/app.js (esbuild, ESM, es2022) + copies index.html, styles.css
npm test        # node:test suites in tests/ (114 cases)
npm run dev     # serves dist/ at http://localhost:4188 (python -m http.server)
npm run verify  # builds, then drives headless Edge through every Iteration 2 flow at three viewports
```

`npm run verify` (scripts/verify-ui.mjs) needs Microsoft Edge or Chrome
(`PETSTUDIO_BROWSER=/path/to/browser` overrides the lookup). A full run takes about
15 minutes with software rendering; `node scripts/verify-ui.mjs --only=phone`
(or `tablet`, `desktop`) runs one device. Screenshots and JSON reports go to `artifacts/verify/`.

`node build.mjs --dev` builds unminified with inline source maps; `node build.mjs --watch`
rebuilds on change. Everything runs offline: no fonts, models, textures or sounds are
downloaded. All geometry, textures and audio are generated procedurally on the device.

### Playing

* **Dock:** Feed, Wash, Rest/Wake, Pet, Praise, Go Play Music, Go Draw, Customize, and the
  Workshop group: **Teach** and **Gallery**, plus the Iteration 3 placeholders. On phones
  and tablets the Workshop group lives in the **More** sheet, where Teach and Gallery open
  with one tap.
* **Tap the pet** to pet it; **tap a station** to send it there (Snack Bar = feed, Bubble
  Bath = wash, Sleep Nook = rest/wake, Music Corner, Easel, Rug = sit and listen).
  **Tap the picture frame** on the left wall to open the Gallery.
* **Camera:** drag to orbit, pinch or scroll to zoom, or pick Overview, Pet Close-Up,
  Music Station, Easel or Sleep Nook in the top bar.
* **Keys (desktop):** F feed, W wash, R rest/wake, P pet, G praise, J music, D draw,
  L listen, C customize, T teach, Y gallery, M mute, 1-5 or V camera views. In the
  Teaching Workshop's Music tab the keyboard plays notes (A W S E D F T G Y H U J K…, from
  C4) and Z X C V play the pads. Keys and pads also respond to Tab plus Enter or Space.
* First launch opens the pet creator ("Meet your new pet!"). Progress is saved in
  `localStorage` and restored on return.

URL options (handy for demos and automation): `?skipIntro=1` skips the creator, `?seed=abc`
gives a deterministic new pet, `?reset=1` deletes the saved pet, its lessons and its
gallery, `?mute=1`, `?speed=4` (simulation time scale), `?view=pet|music|easel|sleep|overview`.

## Iteration 2: teaching, feedback and the gallery

### Teaching Workshop (`src/teaching-workshop.js`)

Registered as the real `teach` feature with `features.register('teach', …)`. The sheet is
positioned like the Customizer: a bottom sheet on phones and tablets, a right-hand drawer on
desktop. The camera frames the pet in the space left over, so it stays visible, and it
glances over with interest while you play or draw. On phones the needs meters step aside
while the sheet is open to give the pet more room.

* **Music tab.** A touch and mouse keyboard covers the studio keyboard's range, C4 to A5.
  By default it shows pentatonic bars (C D E G A); **All notes** switches to a piano layout
  with all 22 keys, split into two stacked octaves on narrow screens. Tapping lower on a key
  plays it louder, and you can slide across keys. Four rhythm pads (Boom, Clap, Tick, Tock),
  a live beat timeline (8 or 16 beats; tap a note to remove it) and starter tunes (**Sunny
  Arp, Bouncy Walk, Starlight Lullaby, Playful Hop**) round it out.
  * **Taps are always captured.** Without Record they land in free time: spacing is kept at
    the current tempo, quantized to eighth notes, and gaps are capped at one beat so slow
    one-note-at-a-time playing becomes a steady line.
  * **Record** gives a one-bar count-in, then a metronome pass that overdubs onto the phrase.
  * The controls are **Preview**, Undo, **Clear**, tempo (60 to 160 BPM) and **Teach Pet**.
* **Drawing tab.** A pressure-aware stroke canvas works with touch, pen and mouse, with 8
  colours and 3 brush sizes. **Undo Stroke**, **Clear** and **Replay Strokes** are
  provided; replay uses the original pen timing, pauses included. Shapes (**Star, Heart,
  Flower, Smiling Sun, Spiral**) can be **stamped** in the current colour and brush, or
  shown as a dotted **trace** guide.
* **Teach Pet.** The pet stops, turns to you and listens attentively (a `lesson` activity
  with a curious face and a listening bubble) while the tune plays from the speakers or
  while it studies the drawing.
  * The demonstration is stored in the pet's teaching memory with its full representation.
  * The pet then walks to the Music Corner and plays its own take on the 3D keyboard
    (black keys included), or walks to the Easel and paints its take progressively.
  * The camera follows the pet and then shows the station. Unfinished drafts survive
    closing the sheet and reloading.

### Creation Feedback Bar (`src/hud.js`, `src/main.js`)

A compact bar floats above the dock while the pet listens, performs or has just finished
(it stays for 30 s). It shows a live thumbnail with a playhead or progressive drawing, a
title, an origin badge and progress. The studio is framed above it, so it never covers the
pet. It takes 3 rows on phones, 2 on tablets and 1 on desktop.

* **Love It.** Saves the creation to the Gallery as a favourite (immediately, even
  mid-performance), boosts Bond and Mood, and records a `+1.0` preference signal on that
  creation.
* **Try Variation.** The pet immediately tries again with a new seed and a slightly tweaked
  style. It riffs on the original lesson, not on its own riff.
* **Calmer / Livelier / Neater / Wilder.** Each one moves the pet's style guidance one step
  on that axis, stores a direction signal, and starts a guided retry tagged with that
  direction.

After a piece the pet lingers for a moment before wandering off, which gives you time to
react. Its own autonomous starter songs and drawings get the bar too.

### Creation Gallery and the wall frame (`src/gallery.js`)

Registered as the real `gallery` feature with `features.register('gallery', …)`.

* Songs and drawings are listed newest first. Each card shows its **origin badge**
  (Starter, Taught by You or Pet Attempt), timestamp, title, favourite star and direction
  tags. Filters: All, Songs, Drawings, Favourites.
* **Perform / Redraw** sends the pet to play the song at the Music Corner or redraw the
  picture on the easel. **Listen** plays a song inside the sheet.
* **Hang on Wall** (drawings) pins the picture in the left-wall frame of the 3D studio with
  a brass title plaque and rosette, then the camera visits it. The pin persists across
  reloads; **Take Down** reverts the frame to the newest drawing.
* **Compare** puts any two songs, or any two drawings, side by side (older on the left).
  You can play both one after the other or replay both drawings together. Attempts also
  have a one-tap **Compare with your lesson**. A descriptive readout shows shared rhythm and
  melody similarity for songs, and shape overlap for drawings. It is labelled as a
  description, not a score.
* **Favourite / Delete.** Delete asks for a second tap.

## Architecture

| Module | Responsibility |
| --- | --- |
| `src/pet-state.js` | Pet identity, appearance, temperament, needs, the autonomous activity state machine, care actions, reactions, time away, serialisation, sanitisation and `localStorage` persistence. Iteration 2 adds the `lesson` activity and *creation plans* (an opaque `ref`, a kind and a fixed duration) that flow from lesson to walking to performing. The simulation only schedules them; it never invents content. Pure JS, no DOM or Three.js, so it is fully testable in Node. |
| `src/studio-layout.js` | Shared floor plan: station positions, approach points, facing, path planning. Used by both the simulation and the renderer. |
| `src/starter-repertoire.js` | Authored, seeded generators for starter drawings (vector strokes) and pentatonic phrases. Outputs are tagged `source: 'starter'` plus a generator version. |
| `src/rng.js` | Seeded PRNG helpers (mulberry32, FNV-1a), so behaviour is reproducible. |
| `src/teaching-core.js` | *Teaching-example capture* (pure): phrase and stroke representations, sanitisation of untrusted data, `PhraseRecorder` (free time and metronome passes, quantization, undo), `StrokeRecorder` (raw `x, y, pressure, dt, pen_state` normalised and resampled to even arc length), templates, and descriptive similarity metrics. |
| `src/creative-engine.js` | `AuthoredCreativeEngine`: seeded, hand-written variation rules that turn a lesson into the pet's attempt. This is the replaceable `compose(kind, source, opts)` interface a learned controller will implement later. Style guidance (energy, order) and temperament steer it. |
| `src/teaching-memory.js` | The pet's teaching memory (replay buffer): lessons, labelled feedback signals, style guidance and the pending plan. Bounded and versioned. |
| `src/gallery-store.js` | The Creation & Teaching History: up to 40 songs and drawings with origins, favourites, tags, feedback and the wall pin. Bounded, versioned and quota-resilient. |
| `src/persist.js` | Shared versioned `localStorage` records: last-known-good backup, torn-write fallback, future-version preservation. |
| `src/creation-flow.js` | The teaching loop (pure): teach, then listen, walk, perform, save and link to the lesson; gallery replays; Love It, Try Variation and nudges; the feedback bar's state; resuming a planned piece after a reload. |
| `src/studio-scene.js` | Three.js diorama: room, five stations, the gallery wall frame with title plaque, lights and shadows, particles, picking, and the camera rig (presets, damping, responsive framing, `settled` state). |
| `src/pet-model.js` | Procedural cel-shaded pet: body, head, ears, tails, canvas-texture face with eased expressions and blinking, mood bubble, every procedural animation (including the attentive lesson pose), and outline points for layout checks. |
| `src/toon.js`, `src/canvas-icons.js`, `src/particles.js` | Shared toon materials and outlines, vector icon painter, pooled sprite particles. |
| `src/drawing-surface.js`, `src/creation-render.js` | Progressive stroke renderer behind the easel's live texture; stateless painters for drawings, trace guides and piano rolls, shared by the workshop, gallery, bar and wall frame. |
| `src/audio.js` | WebAudio: synthesised plucked voice for note events, synthesised percussion (kick, clap, hat, wood block), a metronome, soft care sounds, procedural room reverb, persisted mute. |
| `src/hud.js`, `src/customizer.js` | DOM UI: top bar, meters, dock, toasts, tips, the More sheet, the Creation Feedback Bar, and the pet creator/customizer. |
| `src/teaching-workshop.js`, `src/gallery.js` | The Teaching Workshop and Creation Gallery sheets. Each registers itself through `features.register`. |
| `src/main.js` | Composition root: wiring, frame loop, layout and framing, saving, camera automation for teaching flows, `window.__PET_STUDIO__`. |
| `scripts/` | Development tooling only (not shipped): a dependency-free CDP harness (`cdp-harness.mjs`), the multi-device verification (`verify-ui.mjs`) and quick screenshots (`look.mjs`). |

### What is authored and what learns

Iterations 1 and 2 contain **no machine learning**, and nothing in the UI suggests
otherwise. Iteration 2 adds *memory* and an *authored variation engine*; these are kept
deliberately distinct from learning:

* **Teaching memory is not learning.** A lesson is stored as an example with its full
  representation and originating session. Storing or retrieving it changes no parameter.
  There are no trainable parameters yet (`ENGINE_INFO.trainableParameters === 0`); they
  arrive with Sleep Practice in Iteration 3, which will read this replay buffer.
* **The pet's attempt is authored variation.** `AuthoredCreativeEngine` keeps recognisable
  parts of the lesson and varies the rest with seeded rules.
  * For music it echoes the motif a scale step away, answers the second half with a
    mirrored contour, moves the tune up or down the scale, or adds ornaments.
  * For drawing it adds its own hand (wobble), a composition shift, its own colours some of
    the time, and a tiny heart signature.
  * Same lesson, seed, style and temperament always give the same attempt. Every output
    carries a `generator` tag (`imitate-phrase-v1`, `imitate-draw-v1`).
* **Feedback is labelled by meaning.** `love` is a *preference* signal (`reward: +1.0` on a
  creation). It is not a correct next-note or next-stroke label. `nudge` is a *direction*
  signal; `variation` and `perform` are *requests*. The labels are stored with each signal
  so a future trainer cannot mistake one for another.
* **Style guidance** (energy for calmer/livelier, order for neater/wilder, each −1 to 1)
  moves one step (0.34) per nudge. It steers the authored engine together with
  temperament: playful versus calm leans energy, chaotic versus neat leans order. Tests
  check the direction of each effect, averaged over many seeds:
  * calmer music is slower, sparser and softer; livelier music is faster and busier;
  * wilder melodies leap further;
  * wilder drawings wobble about 2× more than neater ones;
  * livelier lines are bolder than calmer ones.

* **Needs** are satisfaction meters: 100 is fully satisfied, 0 needs attention. They decay
  at per-second base rates scaled by temperament and activity. Mood drifts toward a
  weighted average of the other needs.
* **Autonomy:** when idle the pet scores every station from need urgency plus temperament
  affinity. Critically low hunger, energy or hygiene win outright. Otherwise a softmax with
  a temperament-dependent temperature picks the station using the pet's seeded PRNG.
  Satisfied needs never send it to eat, bathe or nap. Self-chosen care is 55% as
  effective as care you ask for, so a neglected pet stays okay but you still matter.
* **Temperament** (Playful, Calm, Curious, Dramatic, Stubborn, Neat, Chaotic, each 0-1)
  only weights these hand-written rules and the flavour text. Stubborn pets may refuse an
  optional request, but never a real need and never twice in a row.
* **Starter songs and drawings** are deterministic functions of (seed, temperament,
  colours). The easel paints them progressively and the keyboard plays them note by note,
  with key presses, arm motion, floating notes and synthesised sound all driven by the
  same note events.

### Persistence

The pet is saved as a versioned record (`schema: "petstudio.pet"`, `version: 1`) under
`petstudio.pet.v1`, with the previous valid save kept as a last-known-good backup
(`.bak`). Loading falls back to the backup if the main record is damaged. A save written
by a newer schema is copied aside and never overwritten. Every field is sanitised on load:
numbers clamped, enums checked, colours validated, names stripped and truncated.

Time away is bounded and gentle: at most 8 hours are simulated, needs drift at 35% speed
and never drop below 25 because of absence, and a sleeping pet keeps resting. An
unfinished drawing or song resumes if you return within 30 minutes. Otherwise it stays
unfinished: the app never fabricates work done while closed.

Iteration 2 adds three more records, all sanitised on load:

| Key | Schema | Contents and retention |
| --- | --- | --- |
| `petstudio.teach.v1` (+ `.bak`) | `petstudio.teach` v1 | Teaching memory for one pet: at most 12 lessons per kind (oldest dropped first), 200 signals and about 600 KB. If the memory belongs to a different pet (for example after a reset) it is moved to `petstudio.teach.orphan` rather than reused. |
| `petstudio.gallery.v1` (+ `.bak`) | `petstudio.gallery` v1 | At most 40 items and about 1.2 MB. Non-favourite starter pieces are capped at 10. When room is needed the oldest non-favourite starter piece goes first, then attempts, then lessons, then favourites. The pinned drawing and the item just added are never evicted. On a quota error the backup copy is dropped, then the oldest items, and the save is retried. |
| `petstudio.workshop.v1` | `petstudio.workshop` v1 | The unfinished draft in the Teaching Workshop (phrase, drawing, brush). |

A future-version record is copied to `*.future` and never overwritten. A torn or corrupt
main record falls back to the last good backup, and a corrupt main record never overwrites
a good backup. An attempt is saved to the gallery only when the pet finishes it, or when
you press Love It. A pending plan in teaching memory lets a performance interrupted by a
reload resume the same attempt.

### Responsive framing

The canvas fills the screen and the UI floats over it. Each layout pass measures the area
the UI leaves free; the camera then applies a matching projection offset and
binary-searches the distance that fits the whole diorama, or the focused station, inside
that area. Portrait screens get a steeper camera and a wider field of view. The overview
always frames the entire room, from a 390x844 phone up to desktop. The customizer and the
Teaching Workshop reframe the pet beside their drawer (desktop) or above their sheet (phone
and tablet). Sheets are measured by their layout box, so their slide-in animation never
skews the framing. The Creation Feedback Bar is treated as UI too: while it shows, the
studio is framed above it.

### Representations (shared by teaching, the engine, storage and rendering)

* **Phrase:** `{ tempo, beats, notes: [{ beat, midi, dur, vel }], hits: [{ beat, midi, dur, vel }] }`.
  * `notes` are pitched events on the studio keyboard (MIDI 60 to 81).
  * `hits` are percussion events with General MIDI drum numbers (36 kick, 39 clap,
    42 hi-hat, 76 wood block), kept separate so a drum number is never mistaken for a pitch.
  * Beats are relative to the phrase start; durations are in beats; velocity is 0 to 1.
* **Drawing:** `{ paper, strokes: [{ color, width, points: [[x, y, p, dt]], t0, dur }] }`.
  * `x, y` lie in [0, 1] (y down) on a square canvas; `p` is pen pressure; `dt` is seconds
    since the previous point.
  * Each stroke is one pen-down to pen-up span, which encodes the raw `pen_state`.
  * `t0` keeps the pauses between strokes.
  * Starter strokes with plain `[x, y]` points remain valid.

## Hooks for later iterations

* `window.__PET_STUDIO__.features.register(id, { open(app) {...} })` plugs a real
  implementation into a hook. Teach and Gallery now use it; `practice` and `inspector`
  (Iteration 3) are still placeholders. The dock and the More sheet update automatically.
* The creative engine is a replaceable interface: `engine.compose(kind, source, { seed, style, traits, colors })`.
  A learned controller can replace `AuthoredCreativeEngine` without touching the workshop,
  gallery, flow or storage. Outputs carry `generator` tags so learned behaviour stays
  distinguishable from authored behaviour.
* Teaching memory is the training data source. It holds lessons (supervised examples with
  their sessions and linked attempts) and labelled preference or direction signals.

## Inspection API

`window.__PET_STUDIO__` exposes `state` (snapshot), `record` (persisted JSON), `actions.*`,
`camera.setView(id)` and `camera.settled`, `customize.open/close/apply/setTraits`,
`setNeeds`, `setTimeScale`, `layout()`, `renderInfo()`, `audio.setMuted`, `features`,
`save()`, `reset()` and `ready`. Iteration 2 adds three groups:

* `teach`: open the workshop, `setTab`, `loadTemplate`, `stampShape`, `playNote`, `hit`,
  `record`, `preview`, `undo`, `clear`, `setPhrase`, `setDrawing`, `phrase`, `drawing`,
  `teach()` and `teachData(kind, data)`. Teaching-memory views: `memory`, `lessons`,
  `prefs`, `signals`. `engine` gives the engine info and `learning` states that it is none.
* `gallery`: `items`, `get`, `counts`, `wall`, `wallArt`, `favorite`, `remove`, `perform`,
  `hang`, `unhang`, `compare`, `filter`, `limits`, `bytes`.
* `creation`: the feedback `bar` state, the current `subject`, `love()`, `variation()`,
  `nudge(id)`, `dismiss()`.

`layout()` reports the viewport, horizontal and vertical overflow, the free "safe" rect,
overlay rects (including the feedback bar and the sheets), clipped controls, labels that
spill out of their buttons, small touch targets, and whether the camera has settled.
Clipped means cut off by any ancestor that cannot scroll the control into view, not only
off-screen. It also reports whether the pet's silhouette sits inside the safe rect without
touching the UI or the feedback bar. The silhouette is computed from outline points
because 3D box corners are inflated by perspective in close-ups; the box is still reported
for reference.

## Testing and verification

* `npm test` runs 114 `node:test` cases (45 from Iteration 1, 69 new).
  * `tests/core.test.mjs`, `tests/repertoire.test.mjs`: the Iteration 1 simulation,
    persistence and starter generators. All still pass unchanged.
  * `tests/teaching-core.test.mjs`: stroke normalisation (pixels to [0, 1], clamping),
    resampling (even arc-length spacing, endpoints kept, pressure and time interpolated,
    dots, point budgets), the stroke recorder (raw `pen_state` stream, undo and clear,
    stamps), phrase quantization, free-time and metronome-pass recording (chords, gap cap,
    count-in, overdub, full phrases, held durations), sanitisation of hostile phrases and
    drawings, templates and similarity metrics.
  * `tests/creative-engine.test.mjs`: attempts are deterministic, valid, recognisably
    inspired by their lesson, and move in the guided style direction (averaged over seeds).
  * `tests/stores.test.mjs`: teaching memory and gallery round trips, backup fallback,
    future-version preservation, hostile-record sanitisation, retention (40 items, starter
    cap, protected favourites and pin, byte budget), quota recovery, and the move-aside
    for another pet's memory.
  * `tests/teaching-flow.test.mjs`: the teach-to-attempt flow end to end on the real
    simulation.
    * Covered: listen, walk, perform, save and link for music and drawing; Love It
      (favourite, `+1.0` signal, bond and mood); Try Variation; nudges.
    * Also: napping pets declining with nothing stored; interruptions discarding
      unfinished work; replays without duplicates; starter items; resuming after a
      reload; feedback-bar timing; two temperaments answering one lesson differently.
* `npm run verify` drives the production build in headless Microsoft Edge 156 (SwiftShader
  WebGL, so frame rates are low) with real CDP touch and mouse input. Devices: 390x844@3x
  touch, 768x1024@2x touch, 1440x900@1x mouse. The flow per device:
  * opens the workshop (dock on desktop, More sheet on phone and tablet);
  * taps keys and pads, deletes a timeline note and undoes it, plays a key with Enter;
  * previews, loads a starter tune, toggles all notes, starts and stops recording;
  * draws a stroke, stamps, undoes, replays and traces;
  * teaches music, then checks the lesson, the performance and the bar, presses Love It
    and Calmer;
  * teaches a drawing and watches the easel;
  * in the gallery: Listen, both compare views with playback and replay, favourite and
    filter, Hang on Wall;
  * reloads to check persistence;
  * lets the pet nap, confirms a lesson is declined with an explanation, and closes the
    workshop with Escape.

  It also covers the customizer as a regression check on the shared framing code. At
  every step it records `layout()`.

  **Latest results:** 97 of 97 checks passed on each of the three devices. That means zero
  console errors, zero horizontal overflow, zero clipped controls and zero spilling labels,
  with the pet inside the free area and clear of the UI, the sheets and the feedback bar
  in every studio state checked.
* Not yet verified on physical devices, in Safari/WebKit, or with audio output: the
  automated runs are muted. Software-rendered frame rates say nothing about real GPU
  performance.

## Known limitations

* No machine learning yet: the pet's attempts come from the authored variation engine, so
  they do not improve with more lessons. Teaching memory, labelled signals and the engine
  interface are in place for the Iteration 3 trainer.
* Drawing similarity and phrase similarity are coarse descriptive measures, shown only in
  the comparison view and never as a score or as evidence of learning.
* Free-time capture caps gaps at one beat. Longer rests need a Record pass.
* No PWA manifest or service worker yet. Offline use works only once the page is cached
  by the browser.
* Station walking uses simple waypoints rather than navmesh pathfinding. Paths are tuned
  for this layout.
* Audio starts after the first tap or keypress (browser autoplay rules) and is synthesised
  rather than sampled. Note timing in the workshop is scheduled ahead with WebAudio; the 3D
  performance plays notes on frame boundaries.
