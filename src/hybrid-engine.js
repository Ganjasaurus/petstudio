/**
 * hybrid-engine.js: the pet's creative engine from Iteration 3 on.
 *
 * Implements the same replaceable compose(kind, source, opts) interface as
 * AuthoredCreativeEngine. While a network has no training steps its kind is
 * composed by the authored engine alone (generator 'imitate-phrase-v1' or
 * 'imitate-draw-v1'). Once it has trained, the learned network (from
 * neural-engine.js) is blended in with weight alpha, which grows with
 * training steps and with how often that lesson was practised:
 *
 *  - music: an autoregressive pass of MusicPolicyNet whose onset and pitch
 *    logits are (1 - alpha) * authored prior + alpha * network; duration,
 *    velocity and tempo blend the same way. Percussion stays authored.
 *  - drawing: the authored attempt with each stroke point moved alpha of the
 *    way toward StrokePolicyNet's reconstruction; pressure, width and colour
 *    blend likewise and the learned steadiness damps the placement jitter.
 *
 * Blended outputs are tagged generator 'neural-v1' and carry alpha and the
 * model's step count, so learned behaviour is never mistaken for authored.
 */
import { AuthoredCreativeEngine, composePhraseAttempt, composeDrawingAttempt, sanitizeStyle, MUSIC_GENERATOR, DRAWING_GENERATOR } from './creative-engine.js';
import { NEURAL_GENERATOR, heldOutSlots } from './neural-engine.js';
import { phraseIsEmpty, roundTo } from './teaching-core.js';

export const HYBRID_ENGINE_ID = 'hybrid-neural-v1';

export class HybridCreativeEngine {
  /**
   * @param {{neural: import('./neural-engine.js').NeuralEngine, authored?: AuthoredCreativeEngine}} deps
   */
  constructor({ neural, authored = new AuthoredCreativeEngine() }) {
    this.neural = neural;
    this.authored = authored;
  }

  get info() {
    const n = this.neural;
    return {
      id: HYBRID_ENGINE_ID,
      kind: 'hybrid',
      learned: n.stepsFor('music') + n.stepsFor('drawing') > 0,
      trainableParameters: n.parameterCount,
      generators: {
        music: n.stepsFor('music') > 0 ? NEURAL_GENERATOR : MUSIC_GENERATOR,
        drawing: n.stepsFor('drawing') > 0 ? NEURAL_GENERATOR : DRAWING_GENERATOR,
      },
      steps: { music: n.stepsFor('music'), drawing: n.stepsFor('drawing') },
      description: 'Authored variation rules blended with two small on-device neural networks (MusicPolicyNet, StrokePolicyNet). The learned share alpha grows with practice; untrained kinds stay fully authored.',
    };
  }

  /** The blend weight this engine would use (0 = authored only). */
  alphaFor(kind, lessonId = null) {
    return this.neural.alphaFor(kind, lessonId);
  }

  /**
   * @param {'music'|'drawing'} kind
   * @param {object} source the lesson (phrase or drawing)
   * @param {{seed?: number, style?: object, traits?: object, colors?: object, lessonId?: string, alpha?: number}} opts
   *   `style` is the player's guidance (the network's style input); `alpha` overrides the schedule (diagnostics).
   */
  compose(kind, source, opts = {}) {
    const { seed = 1, style, traits, colors } = opts;
    // A lesson it has not practised under this id may still be content it practised (re-taught).
    let lessonId = opts.lessonId ?? null;
    if (!(lessonId && this.neural.lessonSteps[kind]?.[lessonId]) && this.neural.stepsFor(kind) > 0) lessonId = this.neural.practisedLessonFor(kind, source) ?? lessonId;
    const alpha = Number.isFinite(opts.alpha) ? Math.min(1, Math.max(0, opts.alpha)) : this.alphaFor(kind, lessonId);
    if (!(alpha > 0)) return this.authored.compose(kind, source, { seed, style, traits, colors });
    const prefs = sanitizeStyle(style);
    const model = { steps: this.neural.stepsFor(kind), alpha: roundTo(alpha, 3) };
    if (kind === 'music') {
      const authored = composePhraseAttempt(source, { seed, style, traits });
      // Notes of this lesson held out for validation were never trained: the network has no say there beyond its unpractised share.
      const lesson = lessonId ? this.neural.refreshData().music.lessons.find((l) => l.id === lessonId) : null;
      const unpractised = lesson ? heldOutSlots(source, lessonId, this.neural.settings.holdout) : null;
      const phrase = this.neural.composeMusic(source, { seed, prefs, traits, alpha, prior: authored, unpractised });
      if (phraseIsEmpty(phrase)) return authored;
      return { ...phrase, source: 'attempt', generator: NEURAL_GENERATOR, seed: seed >>> 0, mode: authored.mode, style: authored.style, alpha: model.alpha, model };
    }
    const learned = this.neural.drawingResiduals(source, { prefs, traits });
    const drawing = composeDrawingAttempt(source, { seed, style, traits, colors, neural: { alpha, steadiness: learned.steadiness, strokes: learned.strokes } });
    return { ...drawing, generator: NEURAL_GENERATOR, alpha: model.alpha, model };
  }
}
