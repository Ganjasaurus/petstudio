/**
 * Tests for the authored starter repertoire (src/starter-repertoire.js):
 * determinism, valid ranges and temperament influence. These generators are
 * deterministic authored content, not learned behaviour.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateStarterDrawing, generateStarterPhrase, drawingLength, degreeToMidi, phraseDurationSeconds,
  STARTER_DRAWING_GENERATOR, STARTER_PHRASE_GENERATOR, DRAWING_MOTIFS,
} from '../src/starter-repertoire.js';

const COLORS = { bodyColor: '#ffb8c9', accentColor: '#fff1dc', cheekColor: '#ff7d9c' };
const traitsWith = (o) => ({ playful: 0.3, calm: 0.3, curious: 0.3, dramatic: 0.3, stubborn: 0.3, neat: 0.3, chaotic: 0.3, ...o });
const PENTATONIC_PCS = new Set([0, 2, 4, 7, 9]);

describe('starter drawings', () => {
  test('are deterministic per seed and tagged as starter content', () => {
    const a = generateStarterDrawing({ seed: 11, traits: traitsWith({}), colors: COLORS });
    const b = generateStarterDrawing({ seed: 11, traits: traitsWith({}), colors: COLORS });
    const c = generateStarterDrawing({ seed: 12, traits: traitsWith({}), colors: COLORS });
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, c);
    assert.equal(a.source, 'starter');
    assert.equal(a.generator, STARTER_DRAWING_GENERATOR);
  });

  test('stay inside the canvas with valid colours and widths', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const d = generateStarterDrawing({ seed, traits: traitsWith({ chaotic: (seed % 10) / 10 }), colors: COLORS });
      assert.ok(d.strokes.length >= 3 && d.strokes.length <= 14);
      for (const s of d.strokes) {
        assert.match(s.color, /^#[0-9a-f]{6}$/i);
        assert.ok(s.width > 0 && s.width <= 0.06);
        assert.ok(DRAWING_MOTIFS.includes(s.motif));
        for (const [x, y] of s.points) assert.ok(x >= 0 && x <= 1 && y >= 0 && y <= 1);
      }
      assert.ok(drawingLength(d) > 0);
    }
  });

  test('temperament shapes the art: chaotic pets scribble more than neat, calm pets', () => {
    const avg = (traits) => {
      let strokes = 0;
      let scribbles = 0;
      for (let seed = 1; seed <= 80; seed++) {
        const d = generateStarterDrawing({ seed, traits, colors: COLORS });
        strokes += d.strokes.length;
        scribbles += d.motifs.filter((m) => m === 'scribble' || m === 'zigzag').length;
      }
      return { strokes: strokes / 80, scribbles: scribbles / 80 };
    };
    const chaotic = avg(traitsWith({ chaotic: 1, playful: 0.9, neat: 0, calm: 0 }));
    const tidy = avg(traitsWith({ chaotic: 0, playful: 0, neat: 1, calm: 1 }));
    assert.ok(chaotic.strokes > tidy.strokes, `${chaotic.strokes} > ${tidy.strokes}`);
    assert.ok(chaotic.scribbles > tidy.scribbles * 2);
  });
});

describe('starter phrases', () => {
  test('fill two bars on the pentatonic scale and resolve home', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const p = generateStarterPhrase({ seed, traits: traitsWith({ playful: (seed % 7) / 7 }) });
      assert.equal(p.source, 'starter');
      assert.equal(p.generator, STARTER_PHRASE_GENERATOR);
      assert.equal(p.beats, 8);
      let prev = -1;
      for (const n of p.notes) {
        assert.ok(n.beat > prev && n.beat < 8);
        prev = n.beat;
        assert.ok(PENTATONIC_PCS.has(n.midi % 12));
        assert.ok(n.midi >= 60 && n.midi <= 81, 'within the C4..A5 studio keyboard');
        assert.ok(n.dur > 0 && n.vel > 0 && n.vel <= 1);
      }
      assert.equal(p.notes.at(-1).midi % 12, 0, 'ends on C');
      assert.ok(phraseDurationSeconds(p) > 2);
    }
  });

  test('are deterministic and temperament changes the tempo', () => {
    assert.deepEqual(generateStarterPhrase({ seed: 5 }), generateStarterPhrase({ seed: 5 }));
    let playful = 0;
    let calm = 0;
    for (let seed = 1; seed <= 40; seed++) {
      playful += generateStarterPhrase({ seed, traits: traitsWith({ playful: 1, calm: 0 }) }).tempo;
      calm += generateStarterPhrase({ seed, traits: traitsWith({ playful: 0, calm: 1 }) }).tempo;
    }
    assert.ok(playful > calm + 40 * 20, 'playful pets play noticeably faster');
  });

  test('lullabies from the speakers are soft and stepwise', () => {
    const l = generateStarterPhrase({ seed: 3, mode: 'lullaby' });
    assert.equal(l.mode, 'lullaby');
    assert.ok(l.notes.every((n) => n.vel <= 0.4));
    assert.equal(degreeToMidi(0), 60);
    assert.equal(degreeToMidi(5), 72);
  });
});
