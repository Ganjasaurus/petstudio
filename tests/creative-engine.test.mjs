/**
 * Tests for the authored creative engine (src/creative-engine.js): the pet's
 * attempts are deterministic, valid, recognisably inspired by the lesson, and
 * respond to style guidance in the requested direction. Effects are checked
 * as averages over many seeds so they test tendencies, not lucky draws.
 * This engine is authored variation, not machine learning.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AuthoredCreativeEngine, composePhraseAttempt, composeDrawingAttempt, ENGINE_INFO, MUSIC_GENERATOR, DRAWING_GENERATOR,
  NUDGES, NUDGE_STEP, applyNudge, sanitizeStyle, styleTags, effectiveStyle,
} from '../src/creative-engine.js';
import {
  MUSIC_TEMPLATES, musicTemplate, DRAWING_TEMPLATES, drawingTemplate, phraseSimilarity, drawingSimilarity,
  phraseStats, drawingStats, sanitizePhrase, sanitizeDrawing, KEY_RANGE, PHRASE_LIMITS, STROKE_LIMITS, DRUMS,
} from '../src/teaching-core.js';

const SEEDS = Array.from({ length: 10 }, (_, i) => i + 1);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const musicIds = MUSIC_TEMPLATES.map((t) => t.id);
const drawingIds = DRAWING_TEMPLATES.map((t) => t.id);

function musicAverages(style) {
  const out = { tempo: [], notes: [], vel: [], step: [], self: [] };
  for (const id of musicIds) {
    const lesson = musicTemplate(id);
    for (const seed of SEEDS) {
      const a = composePhraseAttempt(lesson, { seed, style });
      const st = phraseStats(a);
      out.tempo.push(st.tempo / lesson.tempo);
      out.notes.push(st.notes);
      out.vel.push(st.meanVel);
      out.step.push(st.meanStep);
      out.self.push(phraseSimilarity(lesson, a).overall);
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, mean(v)]));
}

describe('authored creative engine: music', () => {
  test('attempts are deterministic per seed and differ across seeds', () => {
    const lesson = musicTemplate('bouncy-walk');
    assert.deepEqual(composePhraseAttempt(lesson, { seed: 7 }), composePhraseAttempt(lesson, { seed: 7 }));
    const distinct = new Set(SEEDS.map((seed) => JSON.stringify(composePhraseAttempt(lesson, { seed }).notes)));
    assert.ok(distinct.size >= 6, `${distinct.size} distinct attempts from 10 seeds`);
  });

  test('attempts are valid phrases tagged as authored attempts', () => {
    for (const id of musicIds) {
      for (const seed of SEEDS) {
        for (const style of [{}, { energy: 1, order: 1 }, { energy: -1, order: -1 }]) {
          const a = composePhraseAttempt(musicTemplate(id), { seed, style });
          assert.equal(a.source, 'attempt');
          assert.equal(a.generator, MUSIC_GENERATOR);
          assert.deepEqual(sanitizePhrase(a).notes, a.notes, 'already canonical');
          assert.ok(a.notes.length >= 3);
          assert.ok(a.notes.every((n) => n.midi >= KEY_RANGE.lo && n.midi <= KEY_RANGE.hi && n.beat < a.beats));
          assert.ok(a.tempo >= PHRASE_LIMITS.tempo[0] && a.tempo <= PHRASE_LIMITS.tempo[1]);
        }
      }
    }
  });

  test('attempts are recognisably inspired by their lesson', () => {
    for (const id of musicIds) {
      const lesson = musicTemplate(id);
      const self = [];
      const other = [];
      for (const seed of SEEDS) {
        const a = composePhraseAttempt(lesson, { seed });
        self.push(phraseSimilarity(lesson, a).overall);
        for (const o of musicIds) if (o !== id) other.push(phraseSimilarity(musicTemplate(o), a).overall);
      }
      assert.ok(mean(self) > mean(other) + 0.15, `${id}: self ${mean(self).toFixed(2)} vs others ${mean(other).toFixed(2)}`);
      assert.ok(mean(self) > 0.6, `${id} keeps most of the lesson`);
    }
  });

  test('calmer vs livelier: tempo, note count and loudness move the guided way', () => {
    const calm = musicAverages({ energy: -1 });
    const lively = musicAverages({ energy: 1 });
    assert.ok(lively.tempo > 1.08 && calm.tempo < 0.92, `tempo x${lively.tempo.toFixed(2)} vs x${calm.tempo.toFixed(2)}`);
    assert.ok(lively.notes > calm.notes + 2, `notes ${lively.notes} vs ${calm.notes}`);
    assert.ok(lively.vel > calm.vel + 0.15, `velocity ${lively.vel} vs ${calm.vel}`);
  });

  test('neater vs wilder: wilder melodies leap further and stray more from the lesson', () => {
    const neat = musicAverages({ order: -1 });
    const wild = musicAverages({ order: 1 });
    assert.ok(wild.step > neat.step + 1, `mean interval ${wild.step.toFixed(2)} vs ${neat.step.toFixed(2)}`);
    assert.ok(neat.self > wild.self, 'neater attempts stay closer to the lesson');
  });

  test('a drums-only lesson gets a matching groove and a hummed line', () => {
    const lesson = { tempo: 100, beats: 8, notes: [], hits: [0, 1, 2, 3, 4, 5, 6, 7].map((b) => ({ beat: b, midi: DRUMS[b % 2].midi, dur: 0.25, vel: 0.8 })) };
    const a = composePhraseAttempt(lesson, { seed: 3 });
    assert.ok(a.hits.length >= 4);
    assert.ok(a.notes.length >= 3);
  });
});

describe('authored creative engine: drawing', () => {
  test('attempts are deterministic, valid, on the paper and signed', () => {
    const lesson = drawingTemplate('heart', { color: '#ff7fa3' });
    assert.deepEqual(composeDrawingAttempt(lesson, { seed: 5 }), composeDrawingAttempt(lesson, { seed: 5 }));
    for (const id of drawingIds) {
      for (const seed of SEEDS) {
        for (const style of [{}, { energy: 1, order: 1 }, { energy: -1, order: -1 }]) {
          const a = composeDrawingAttempt(drawingTemplate(id), { seed, style, colors: { bodyColor: '#a8d8ff', cheekColor: '#ff7d9c', accentColor: '#fff1dc' } });
          assert.equal(a.source, 'attempt');
          assert.equal(a.generator, DRAWING_GENERATOR);
          assert.deepEqual(sanitizeDrawing(a).strokes, a.strokes, 'already canonical');
          for (const s of a.strokes) {
            assert.ok(s.points.every((p) => p[0] >= 0.02 && p[0] <= 0.98 && p[1] >= 0.02 && p[1] <= 0.98), 'stays on the paper');
            assert.ok(s.width >= STROKE_LIMITS.width[0] && s.width <= STROKE_LIMITS.width[1]);
          }
          const sig = a.strokes.at(-1);
          assert.ok(sig.points.every((p) => p[0] > 0.85 && p[1] > 0.85), 'ends with the little heart signature');
        }
      }
    }
  });

  test('attempts are recognisably inspired by their lesson', () => {
    for (const id of drawingIds.filter((x) => x !== 'spiral')) {
      const lesson = drawingTemplate(id);
      const self = [];
      const other = [];
      for (const seed of SEEDS) {
        const a = composeDrawingAttempt(lesson, { seed });
        self.push(drawingSimilarity(lesson, a));
        for (const o of drawingIds) if (o !== id && o !== 'spiral') other.push(drawingSimilarity(drawingTemplate(o), a));
      }
      assert.ok(mean(self) > mean(other) + 0.15, `${id}: self ${mean(self).toFixed(2)} vs others ${mean(other).toFixed(2)}`);
    }
  });

  test('wilder drawings wobble more than neater ones; livelier lines are bolder than calmer ones', () => {
    const avg = (style, f) => mean(drawingIds.flatMap((id) => SEEDS.map((seed) => f(drawingStats(composeDrawingAttempt(drawingTemplate(id), { seed, style }))))));
    const rough = { neat: avg({ order: -1 }, (s) => s.roughness), wild: avg({ order: 1 }, (s) => s.roughness) };
    assert.ok(rough.wild > rough.neat * 1.5, `roughness ${rough.wild.toFixed(1)} vs ${rough.neat.toFixed(1)}`);
    const width = { calm: avg({ energy: -1 }, (s) => s.meanWidth), lively: avg({ energy: 1 }, (s) => s.meanWidth) };
    assert.ok(width.lively > width.calm * 1.3, `width ${width.lively.toFixed(4)} vs ${width.calm.toFixed(4)}`);
    const strokes = { calm: avg({ energy: -1 }, (s) => s.strokes), lively: avg({ energy: 1 }, (s) => s.strokes) };
    assert.ok(strokes.lively > strokes.calm, 'livelier attempts add flourishes');
  });

  test('the pet paints with its own colours some of the time', () => {
    const lesson = { strokes: Array.from({ length: 8 }, (_, i) => ({ color: '#4a3f6b', width: 0.02, points: [[0.1, 0.1 + i * 0.1], [0.9, 0.1 + i * 0.1]] })) };
    const colours = new Set();
    for (const seed of SEEDS) {
      for (const s of composeDrawingAttempt(lesson, { seed, style: { order: 0.6 }, colors: { cheekColor: '#c58cff' } }).strokes) colours.add(s.color);
    }
    assert.ok(colours.has('#4a3f6b'), 'keeps the lesson colour');
    assert.ok(colours.size > 2, 'and adds some of its own');
  });
});

describe('style guidance', () => {
  test('nudges move one axis a step at a time and saturate at the ends', () => {
    let s = sanitizeStyle({});
    assert.deepEqual(s, { energy: 0, order: 0 });
    s = applyNudge(s, 'calmer');
    assert.equal(s.energy, -NUDGE_STEP);
    assert.equal(s.order, 0);
    for (let i = 0; i < 10; i++) s = applyNudge(s, 'wilder');
    assert.equal(s.order, 1);
    s = applyNudge(s, 'livelier');
    assert.equal(s.energy, 0, 'opposite nudges cancel');
    assert.deepEqual(applyNudge(s, 'sideways'), s, 'unknown nudges are ignored');
    assert.deepEqual(Object.keys(NUDGES), ['calmer', 'livelier', 'neater', 'wilder']);
    assert.deepEqual(styleTags({ energy: -0.5, order: 0.5 }), ['calmer', 'wilder']);
    assert.deepEqual(sanitizeStyle({ energy: 9, order: 'x' }), { energy: 1, order: 0 });
  });

  test('temperament leans the style the engine uses', () => {
    const chaotic = effectiveStyle({}, { chaotic: 1, neat: 0, playful: 1, calm: 0 });
    const tidy = effectiveStyle({}, { chaotic: 0, neat: 1, playful: 0, calm: 1 });
    assert.ok(chaotic.order > 0.2 && tidy.order < -0.2);
    assert.ok(chaotic.energy > tidy.energy);
    assert.deepEqual(effectiveStyle({ energy: 0.5 }), { energy: 0.5, order: 0 });
  });

  test('the engine declares itself authored, with no trainable parameters', () => {
    const engine = new AuthoredCreativeEngine();
    assert.equal(engine.info, ENGINE_INFO);
    assert.equal(ENGINE_INFO.learned, false);
    assert.equal(ENGINE_INFO.trainableParameters, 0);
    assert.equal(engine.compose('music', musicTemplate('sunny-arp'), { seed: 1 }).generator, MUSIC_GENERATOR);
    assert.equal(engine.compose('drawing', drawingTemplate('star'), { seed: 1 }).generator, DRAWING_GENERATOR);
  });
});
