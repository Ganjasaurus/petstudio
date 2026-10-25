Build a complete, runnable native iPhone prototype of a wholesome 3D creative pet app. The pet lives in a small studio, makes simple music and drawings, responds to care and play, and genuinely adapts through training on the user's own device. A player can teach it, let it practice while sleeping, return to see its latest creations, and exchange a copy of its learned pet with a nearby friend.

Deliver working code, an operable interface, real local model updates, persistence, and a demonstrable end-to-end learning loop. Make reasonable, reversible engineering decisions and document them. Implement the prototype rather than stopping at a plan or a visual mockup. The priority is a convincing experience backed by a small, honest learning system that can be replaced with a more capable approach later.

# Product direction

The experience combines a Tamagotchi-style pet, a small Sims-like room, and a creative workshop. The tone is wholesome, playful, calm, and suitable for families. Use original characters with simple rounded forms, expressive faces, restrained detail, soft lighting, and a cel-shaded or similarly stylized appearance. Nintendo Wii Miis are a reference for simplicity and approachability, not assets to reproduce.

Create a polished miniature studio with a music station, drawing easel, bed, food area, and bath. The pet should move between stations, animate convincingly, react to touch, and visibly use its tools. Keep the space compact enough for a strong prototype. Use procedural geometry and original assets so unavailable art does not block implementation.

The central experience is teaching a particular pet and recognizing its developing habits and abilities. Players should be able to recognize differences between two pets trained on different examples. Do not make numerical experience points the evidence of machine learning.

Ordinary care, navigation, animation, and room interactions may use deterministic game logic. Clearly distinguish that implementation from the parts that actually learn. Avoid claims that the character is conscious, has human feelings, or suffers when the app is not used.

# Platform and offline requirements

Target native iOS and physical iPhones. Use SwiftUI for the interface and a suitable native 3D renderer such as RealityKit. Choose the simplest maintained stack that produces a working build in the available environment. Use native audio synthesis or bundled original sounds.

The installed app must support play, generation, training, saving, and viewing creations without internet access. Nearby peer exchange may use a local wireless connection. Do not require hosted AI APIs, accounts, analytics, cloud databases, or an API key for the core experience.

Normal development dependency downloads are acceptable. Bundle everything needed for runtime, including a useful initial model or a small seed dataset and initialization path. Explain which parts are authored algorithms, shared fixed features, and learned parameters.

Inspect the repository and available build environment before choosing implementation details. Respect existing project conventions. If there is no project, create a complete native project with a reproducible setup. If Xcode or a physical iPhone is unavailable, still implement the native project, validate all available portions, and explicitly identify what requires later device verification. Do not silently replace the native prototype with a browser app or claim an iPhone build or background test was run when it was not.

# Complete prototype experience

Implement these connected experiences:

1. Create and name a pet. Offer a small set of original appearance options and initialize its own persistent learning state.

2. Enter the studio. Feed, bathe, play with, and put the pet to bed. Show simple care indicators without clutter.

3. Watch it make something. It can perform a short musical phrase and produce a simple abstract drawing, with visible character animation.

4. Teach it. Demonstrate notes or rhythm through an on-screen instrument, and strokes through a touch canvas. Save, edit, retry, or compare its response.

5. Practice. Start a real local training session through a natural sleep or practice interaction. Show honest progress and allow cancellation.

6. Return. Restore the pet and show a saved recent creation or generate a new one from its current learned state. Do not fabricate completed training or backdate work.

7. Meet a nearby friend. Discover a peer, exchange a pet snapshot with explicit user actions, and show both characters in the studio.

8. Explore a local gallery of saved drawings and musical phrases. Provide simple replay, deletion, and a way to compare early and later attempts.

Make the first session enjoyable before extensive teaching. Include a small authored or procedurally generated starter repertoire. Starter content must be distinguishable in implementation and diagnostics from behavior acquired through subsequent learning.

# Initial learning architecture

Start with a small trainable controller or neural-network head for each pet. The user accepts this simpler first approach and wants the architecture to support a later upgrade. Do not make a large language model or language-model LoRA training a prerequisite.

Use shared fixed feature extraction, shared tool definitions, and shared rendering and audio systems where appropriate. Features can be deterministic numerical descriptions of musical or drawing context, or outputs from a bundled frozen encoder. Give each pet its own small trainable parameters.

Implement genuine parameter updates using a suitable supported iOS training path. A small fully connected network with a suitable loss is a reasonable baseline. Core ML updatable neural networks are a candidate; MLX Swift is another when its iOS integration is justified and verified. Select one primary path and finish it. If a small custom numerical implementation is simpler, it must perform real optimization and have meaningful gradient and convergence checks.

For music, the learned component should influence outputs such as next-note choice, duration, timing, or a compact phrase transformation. For drawing, it should influence outputs such as the next stroke, stroke parameters, color choice, or a compact transformation. Small networks can learn narrow mappings and patterns; do not promise general artistic intelligence.

Keep the action vocabulary compact and valid. Have a synthesizer render note events and a drawing engine render vector strokes. Do not depend on full-resolution image generation, waveform generation, a large diffusion model, or physically realistic instrument simulation.

A procedural generator or existing skill vocabulary may provide starting candidates. Learning must measurably affect the output and must not be reduced to a scripted level-up, a changed personality string, or random selection presented as training.

Hide model details behind replaceable interfaces. Future implementations should be able to replace the controller with a compact autoregressive skill model, partial fine-tuning, or LoRA without rewriting the room, teaching tools, persistence, and exchange flow.

# Technical separation and data

Keep at least these responsibilities distinct: pet state and care, studio simulation, animation, audio rendering, stroke rendering, teaching-example capture, local learning, training scheduling, evaluation, storage, and nearby exchange.

Persist structured, versioned records for:

- Pet identity, display name, appearance, care state, and current activity.

- Model architecture or feature-schema version, shared-baseline version, and the pet's learned parameters.

- Demonstrations, corrected targets, optional preference feedback, and their originating sessions.

- Model checkpoints, optimizer state where needed for faithful resumption, and training progress.

- Saved creations with the model version that produced them.

- Exchange provenance identifying an imported snapshot and its relationship to the source pet.

Use an appropriate local store and atomic file writes. Keep a last-known-good model. Handle app restarts, interrupted saves, and schema mismatches. Keep the training data and number of stored checkpoints bounded through a clear retention policy.

Memory and model learning are separate mechanisms. Remembering a name or retrieving an example is useful, but it is not evidence that neural weights changed. Expose this distinction in developer diagnostics.

# Teaching music and drawing

Provide a small on-screen keyboard or rhythm pad with editable note events. The player can demonstrate a short phrase, request a response, change part of the response, and save that correction. Support a pleasant piano-like or plucked instrument sound using bundled or synthesized audio.

Provide a drawing canvas with a few colors, undo, clear, and simple stroke editing. Normalize touch coordinates and timing into the representation used by the learning system. The pet should draw progressively in the studio rather than simply swapping in a finished image.

Capture useful supervised pairs: the context that the pet received, its attempted action or sequence, and the player's desired target. Use demonstrations and direct corrections as the primary learning signal.

Optional favorite or comparison controls may train a preference model or adjust the relative importance of suitable examples. A thumbs-up is not automatically a correct next-note or next-stroke label; model that distinction explicitly.

For a first useful loop, teach short patterns and constrained variations. For example, the pet can learn a user's rhythmic motif or a repeated stroke style and attempt it in a different valid context. Do not claim broad transfer between music and drawing unless it is actually implemented and evaluated.

# Training and rehearsal

Implement a real local training cycle:

1. Capture and validate new examples.

2. Build a training batch that mixes recent examples with selected older examples.

3. Compute predictions and a loss appropriate to the target.

4. Update the pet's trainable parameters.

5. Periodically evaluate on held-out examples and retention examples.

6. Save an acceptable checkpoint and retain the previous usable checkpoint.

The replay of earlier lessons is intended to reduce forgetting. Split train and evaluation data by original demonstration or session before deriving augmented variants, so near-duplicates do not appear on both sides of the test.

Include useful bounded augmentations only where their semantics are valid, such as tempo changes for relative rhythmic representations or translation and scale changes for normalized strokes. Label and test assumptions about invariance.

Start from sensible initial weights or a bundled baseline rather than expecting a user to teach all basic competence from nothing. Describe how that baseline was produced.

Keep batch sizes, replay size, optimization steps, and learning rates configurable in developer settings. Avoid blocking the main thread or making the app unusable while learning. Save enough training state to resume after interruption. Do not imply that a longer training run guarantees better results; stop or retain an older checkpoint when evaluation worsens.

# Sleep and background execution

Build foreground sleep or practice mode first so the complete training loop works reliably while the app is open. The pet rests visibly while the learning engine works in interruptible segments. This mode must also work without background capabilities.

Then add native background support according to the actual iOS version and device capabilities:

- Scheduled background processing may request an idle or charging opportunity. iOS determines when it runs and may interrupt it.

- On supported iOS versions, a user-started continued-processing task may continue after the app moves to the background. Check resource availability before requesting GPU use and configure any required capability correctly.

- Preserve progress and handle expiration, cancellation, low-memory conditions, thermal pressure, and app relaunch.

- Force-quitting the app must not be treated as a guarantee that training continues.

- Do not promise eight or nine uninterrupted hours of overnight processing. There is no general setting that reserves the phone for this app after it is closed.

Use truthful statuses such as waiting, practicing, paused, and complete. Resume interrupted work when the app next has an appropriate opportunity. Keep the interface pleasant without claiming that learning happened during a period when no training ran.

Track time-based care state on return using bounded elapsed-time calculations. Keep that separate from completed computation. A new creation may be produced on reopening using the latest saved model; do not represent it as evidence of training that did not occur.

A browser or installed web app is not an equivalent fallback for native background training. Foreground web experimentation can be a later separate demo, but it must not replace the required native implementation or promise reliable computation after a tab is suspended or the browser is closed.

# Nearby pet exchange

Implement an explicit nearby discovery and transfer flow using supported iOS peer-to-peer capabilities. Multipeer Connectivity or an appropriate supported alternative may be used. Request necessary permissions with clear explanations. Describe the transport honestly; do not claim a Bluetooth-only transfer if the selected framework also uses local Wi-Fi.

The player selects a peer, previews the pet being shared, and the receiving player accepts. Transfer a bounded, versioned pet package containing appearance, selected game state, learned parameters, and required compatibility information. Share only selected pet data rather than automatically exporting an entire personal demonstration history.

Validate schema, size limits, parameter dimensions, numeric values, and model compatibility. Treat transferred content as data, not executable code. Keep the original pet intact and give the imported copy a distinct local identity.

The imported character should preserve its learned behavior on the receiving device. If two copies continue training independently, they diverge. Treat them as snapshots in the prototype; automatic reconciliation or merging of independently trained models is out of scope.

Reuse shared fixed assets and model components where supported. Each pet still has its own learned state and incurs processing and working-memory costs. Schedule inference so two visible pets remain responsive without assuming that the second pet is computationally free.

Provide a local file export and import path as a useful development and recovery mechanism. It supplements nearby exchange rather than falsely passing for a tested wireless implementation.

# Visual design and interaction

Use a coherent small room, a friendly original pet silhouette, clear facial expressions, tactile controls, and gentle transitions. Make the music and drawing stations recognizable at a glance. Keep menus shallow and favor direct interactions.

Implement believable idle, walk, sit, eat, wash, sleep, draw, and perform animations at a prototype level. Procedural animation is acceptable if it is visually coherent. Synchronize simple drawing gestures and instrument movements to the generated events.

Keep the normal experience focused on care, making, teaching, sleeping, and meeting friends. Place losses, parameter counts, training steps, checkpoint details, and benchmark readouts in a separate developer panel.

Make touch controls usable on a standard iPhone screen. Include readable labels, accessible touch targets, reduced-motion behavior where practical, sensible audio defaults, and a mute control. Do not rely only on color to communicate progress or errors.

Avoid adding accounts, social feeds, monetization, advertisements, or a large customization economy. Concentrate effort on one polished studio and a working creative-learning loop.

# Evidence of real learning

Build a reproducible developer demonstration with two pets starting from the same baseline. Give them different small teaching datasets. Train them separately, then compare their responses to held-out inputs.

Verify that actual trainable parameters change, that saved parameters reload correctly, and that the pets remain independently trainable. A file timestamp or an arbitrary progress bar is insufficient evidence by itself.

Evaluate both learned task performance and retention of older examples. Report observed improvements and failures honestly. Do not turn a decreasing training loss into a claim that every generated drawing or melody is objectively better.

For generation comparisons, use controlled random seeds or another fair comparison method. Separate the effect of random sampling from the effect of learning.

Confirm that exporting and importing a pet preserves a controlled response within an appropriate numerical tolerance, and that training the imported copy does not change the original.

Use automated checks for the learning core, serialization, interruption recovery, and malformed packages where useful. Verify real interaction on the available simulator or device. Do not replace device-dependent wireless or background checks with fabricated success.

# Performance and device validation

Choose a conservative initial model size and record its trainable parameter count and checkpoint size. Measure inference latency, training-step time, peak memory where tooling allows, UI responsiveness, and the cost of running two pets. Report the device, OS, build configuration, dataset size, and training settings alongside measurements.

Distinguish simulator observations from physical-device measurements. An iPhone performance target is a hypothesis until measured. Successful inference does not demonstrate that the same model can be trained comfortably.

Give training sensible work budgets. Checkpoint frequently enough to preserve useful progress without excessive file writes. Adapt or pause based on runtime conditions. Keep audio and UI behavior stable while a training segment runs.

Document the behavior when background execution is denied, unavailable, delayed, or interrupted. The app must remain a complete usable prototype in those cases through foreground practice.

# Implementation sequence

Work through these milestones while keeping the project runnable:

1. Establish the native project, persistent pet state, studio, character, and basic care interactions.

2. Implement structured music and stroke representations, rendering, teaching tools, and saved creations.

3. Add the smallest genuine local trainable model and a reproducible learning check.

4. Connect the learned outputs to the pet's creative behavior and teaching feedback.

5. Add foreground sleep training, replay, evaluation, checkpointing, and restart recovery.

6. Add supported background execution with graceful fallback.

7. Implement nearby pet exchange, portable packages, and two-pet scheduling.

8. Polish the presentation and perform the end-to-end validation.

Keep the learning engine modular so later experiments can replace the small controller without changing the user experience. Do not spend the prototype budget implementing several competing training engines before one complete path works.

# Definition of done

The prototype is complete when:

- A player can create a pet, care for it, and interact with a coherent 3D studio.

- The pet visibly produces and saves simple music and drawings without a hosted AI service.

- The player can demonstrate or correct behavior and trigger real on-device parameter updates.

- A reproducible check distinguishes learned improvement from random variation, memorized retrieval, and scripted progression.

- The pet retains its learned state after restarting the app.

- Training can pause and resume without losing or corrupting the last usable pet.

- Background behavior follows actual platform capabilities and is not represented as guaranteed overnight execution.

- A compatible pet snapshot can be exported, imported, and displayed alongside the original with preserved learned behavior.

- The nearby transfer flow is implemented, with its real-device verification status accurately reported.

- Shared components and per-pet costs are documented.

- Core gameplay works offline, and all measured results identify their test environment.

If a platform or environment limitation prevents one acceptance check, complete the remaining implementation and provide the exact unresolved validation step. Do not describe an untested requirement as complete.

# Final deliverables

Provide the complete source project and any scripts or bundled resources required to reproduce it. Include a concise README covering setup, build and run steps, supported OS and device assumptions, the first-session walkthrough, offline behavior, training, sleep mode, pet exchange, and developer diagnostics.

Include a short architecture document explaining the feature representation, model structure, trainable parameters, loss, optimization, replay, evaluation, versioning, and exchange package. Make the boundary between learned behavior and authored game logic explicit.

Provide a validation report that separates tests actually run from tests requiring a physical iPhone or another nearby device. Include screenshots or a short capture if the environment can produce them from the real application. List material limitations and the next experiment needed to evaluate a broader learning method.

The final result should be a playable prototype with demonstrable learning, not a pitch deck, a static interface, or an implementation plan.

# Official technical references

Verify platform availability and current documentation while implementing:

- [Apple on-device model personalization](https://developer.apple.com/documentation/coreml/model-personalization)

- [Core ML updatable neural networks](https://apple.github.io/coremltools/docs-guides/source/updatable-neural-network-classifier-on-mnist-dataset.html)

- [Core ML model representations and update limitations](https://github.com/apple/coremltools/blob/main/docs-guides/source/comparing-ml-programs-and-neural-networks.md)

- [MLX Swift examples including iOS small-model training](https://github.com/ml-explore/mlx-swift-examples)

- [Apple background strategy selection](https://developer.apple.com/documentation/BackgroundTasks/choosing-background-strategies-for-your-app)

- [Apple user-started continued background processing](https://developer.apple.com/documentation/BackgroundTasks/performing-long-running-tasks-on-ios-and-ipados)

- [Apple nearby peer connectivity](https://developer.apple.com/documentation/multipeerconnectivity)

Core ML updatable models have specific supported representations and operations. Do not infer trainability from successful inference. The official MLX Swift small-network training example supports iOS; the official language-model LoRA app is described as macOS. Treat language-model adaptation on iPhone as a future capability to prototype and measure rather than an assumed dependency of this build.