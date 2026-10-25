# Pet Studio: Iteration 1

A cozy 3D creative pet that lives in a miniature studio: it gets hungry, sleepy and bored,
walks between five stations, plays little tunes, paints on a live easel, splashes in the
bath and naps in its nook. You can feed, wash, rest, pet and praise it, send it to make
music or art, and customize its look and temperament.

Iteration 1 covers **Milestones 1 and 2** of the plan: the foundational architecture, the
3D studio, the stylized customizable pet, the care-and-personality loop, the build and the tests.
Teaching, saved-creation gallery, real on-device learning and diagnostics are later
iterations; their UI hooks are already wired (see *Hooks for later iterations*).

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
npm test        # node:test suites in tests/
npm run dev     # serves dist/ at http://localhost:4188 (python -m http.server)
```

`node build.mjs --dev` builds unminified with inline source maps; `node build.mjs --watch`
rebuilds on change. Everything runs offline: no fonts, models, textures or sounds are
downloaded. All geometry, textures and audio are generated procedurally on the device.

### Playing

* **Dock:** Feed, Wash, Rest/Wake, Pet, Praise, Go Play Music, Go Draw, Customize, and
  "Coming next" hooks (shown as **More** on phones and tablets).
* **Tap the pet** to pet it; **tap a station** to send it there (Snack Bar = feed, Bubble
  Bath = wash, Sleep Nook = rest/wake, Music Corner, Easel, Rug = sit and listen).
* **Camera:** drag to orbit, pinch or scroll to zoom, or pick Overview, Pet Close-Up,
  Music Station, Easel or Sleep Nook in the top bar.
* **Keys (desktop):** F feed, W wash, R rest/wake, P pet, G praise, J music, D draw,
  L listen, C customize, M mute, 1-5 or V camera views.
* First launch opens the pet creator ("Meet your new pet!"). Progress is saved in
  `localStorage` and restored on return.

URL options (handy for demos and automation): `?skipIntro=1` skips the creator, `?seed=abc`
gives a deterministic new pet, `?reset=1` deletes the saved pet, `?mute=1`, `?speed=4`
(simulation time scale), `?view=pet|music|easel|sleep|overview`.

## Architecture

| Module | Responsibility |
| --- | --- |
| `src/pet-state.js` | Pet identity, appearance, temperament, needs, the autonomous activity state machine, care actions, reactions, time away, serialisation, sanitisation and `localStorage` persistence. Pure JS, no DOM or Three.js, so it is fully testable in Node. |
| `src/studio-layout.js` | Shared floor plan: station positions, approach points, facing, path planning. Used by both the simulation and the renderer. |
| `src/starter-repertoire.js` | Authored, seeded generators for starter drawings (vector strokes) and pentatonic phrases. Outputs are tagged `source: 'starter'` plus a generator version. |
| `src/rng.js` | Seeded PRNG helpers (mulberry32, FNV-1a), so behaviour is reproducible. |
| `src/studio-scene.js` | Three.js diorama: room, five stations, lights and shadows, particles, picking, and the camera rig (presets, damping, responsive framing). |
| `src/pet-model.js` | Procedural cel-shaded pet: body, head, ears, tails, canvas-texture face with eased expressions and blinking, mood bubble, and every procedural animation. |
| `src/toon.js`, `src/canvas-icons.js`, `src/particles.js` | Shared toon materials and outlines, vector icon painter, pooled sprite particles. |
| `src/drawing-surface.js` | Progressive stroke renderer behind the easel's live CanvasTexture (reusable by the future teaching canvas). |
| `src/audio.js` | WebAudio: synthesised plucked voice for note events, soft care sounds, procedural room reverb, persisted mute. |
| `src/hud.js`, `src/customizer.js` | DOM UI: top bar, meters, dock, toasts, tips, the "coming next" sheet, and the pet creator/customizer. |
| `src/main.js` | Composition root: wiring, frame loop, layout, saving, feature hooks, `window.__PET_STUDIO__`. |

### What is authored and what learns

Iteration 1 contains **no machine learning**, and nothing in the UI suggests otherwise.

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

### Responsive framing

The canvas fills the screen and the UI floats over it. Each layout pass measures the area
the UI leaves free; the camera then applies a matching projection offset and
binary-searches the distance that fits the whole diorama, or the focused station, inside
that area. Portrait screens get a steeper camera and a wider field of view. The overview
always frames the entire room, from a 390x844 phone up to desktop, and the customizer
reframes the pet beside its drawer (desktop) or above its sheet (phone and tablet).

## Hooks for later iterations

* `window.__PET_STUDIO__.features.register(id, { open(app) {...} })` replaces the
  placeholders `teach`, `gallery` (Iteration 2) and `practice`, `inspector` (Iteration 3).
  The dock and the "Coming next" sheet update automatically.
* Strokes (`{ color, width, points: [[x, y]] }`, normalised) and phrases
  (`{ tempo, notes: [{ beat, midi, dur, vel }] }`) are the representations the teaching
  tools and learned models will share. The starter generators become fallback candidates
  behind a replaceable creative-engine interface.

## Inspection API

`window.__PET_STUDIO__` exposes `state` (snapshot), `record` (persisted JSON), `actions.*`,
`camera.setView(id)`, `customize.open/close/apply/setTraits`, `setNeeds`, `setTimeScale`,
`layout()`, `renderInfo()`, `audio.setMuted`, `features`, `save()`, `reset()`, and
`ready`. `layout()` reports viewport, horizontal or vertical overflow, the free "safe"
rect, overlay rects, clipped controls, small touch targets, and whether the pet's screen
box sits inside the safe rect without touching the UI.

## Testing and verification

* `npm test` runs 45 `node:test` cases.
  * `tests/core.test.mjs`: needs decay, care actions, temperament weighting, station
    selection, serialisation and persistence (backup fallback, future versions, storage
    failures, bounded time away, resume rules).
  * `tests/repertoire.test.mjs`: determinism, value ranges and temperament influence of
    the starter generators.
* The production build was also exercised in headless Microsoft Edge (SwiftShader WebGL)
  at 390x844@3x with touch, 768x1024@2x with touch, and 1440x900@1x. Checks covered
  screenshots of every camera view and activity, `layout()` reports (no overflow, no
  clipped controls, pet inside the free area), real tap and click picking, the creator
  flow, reload persistence and console errors (none).
* Not yet verified on physical devices or in Safari/WebKit. Software-rendered frame rates
  say nothing about real GPU performance.

## Known limitations

* No PWA manifest or service worker yet. Offline use works only once the page is cached
  by the browser.
* Station walking uses simple waypoints rather than navmesh pathfinding. Paths are tuned
  for this layout.
* Audio starts after the first tap or keypress (browser autoplay rules) and is synthesised
  rather than sampled.
