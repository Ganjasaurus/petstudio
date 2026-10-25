/**
 * Tests for the teaching representations (src/teaching-core.js): stroke
 * normalisation and resampling, the stroke and phrase recorders, phrase
 * quantisation, sanitisation of untrusted data, templates and the
 * descriptive similarity metrics.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeSample, resampleStroke, finalizeStroke, StrokeRecorder, sanitizeStroke, sanitizeDrawing, drawingStats,
  drawingSimilarity, drawingPointCount, STROKE_LIMITS, DRAW_COLORS, PAPER,
  quantize, PhraseRecorder, RECORDER, sanitizePhrase, phraseIsEmpty, phraseSeconds, phraseStats, phraseSimilarity,
  PHRASE_LIMITS, KEY_RANGE, DRUMS, drumById, keyboardNotes, isPentatonic, noteName,
  MUSIC_TEMPLATES, musicTemplate, DRAWING_TEMPLATES, drawingTemplate, templateStrokes,
} from '../src/teaching-core.js';
import { generateStarterDrawing, generateStarterPhrase } from '../src/starter-repertoire.js';

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

describe('stroke normalisation', () => {
  test('client pixels map into [0, 1] relative to the canvas rect, clamping strays', () => {
    const rect = { left: 100, top: 50, width: 200, height: 200 };
    assert.deepEqual(normalizeSample({ x: 100, y: 50 }, rect), [0, 0]);
    assert.deepEqual(normalizeSample({ x: 300, y: 250 }, rect), [1, 1]);
    assert.deepEqual(normalizeSample({ x: 200, y: 100 }, rect), [0.5, 0.25]);
    assert.deepEqual(normalizeSample({ x: -40, y: 900 }, rect), [0, 1], 'samples dragged off the canvas are clamped');
    assert.deepEqual(normalizeSample({ x: Number.NaN, y: 'x' }, rect), [0, 0], 'garbage never escapes the unit square');
  });
});

describe('stroke resampling', () => {
  test('resamples to even arc-length spacing and keeps both endpoints', () => {
    const raw = [
      { x: 0.1, y: 0.1, p: 0.5, t: 0 }, { x: 0.12, y: 0.1, t: 0.01 }, { x: 0.13, y: 0.1, t: 0.02 },
      { x: 0.5, y: 0.1, t: 0.2 }, { x: 0.5, y: 0.5, t: 0.6 },
    ];
    const pts = resampleStroke(raw, 0.02);
    assert.deepEqual(pts[0].slice(0, 2), [0.1, 0.1]);
    assert.deepEqual(pts.at(-1).slice(0, 2), [0.5, 0.5]);
    assert.equal(pts.length, 41, 'total length 0.8 at spacing 0.02 gives 40 even segments');
    const gaps = pts.slice(1).map((p, i) => dist(p, pts[i]));
    for (const g of gaps) assert.ok(near(g, 0.02, 2e-4), `segment ${g} is evenly spaced`);
    for (const p of pts) assert.ok(p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1);
  });

  test('pressure and time are interpolated; dt values are non-negative and sum to the duration', () => {
    const raw = [{ x: 0.2, y: 0.5, p: 0.2, t: 0 }, { x: 0.8, y: 0.5, p: 0.8, t: 0.6 }];
    const pts = resampleStroke(raw, 0.1);
    assert.equal(pts.length, 7);
    assert.ok(near(pts[3][2], 0.5, 0.011), 'pressure halfway is interpolated');
    assert.equal(pts[0][3], 0, 'the first point has dt 0');
    assert.ok(pts.every((p) => p[3] >= 0));
    assert.ok(near(pts.reduce((a, p) => a + p[3], 0), 0.6, 0.01));
    for (let i = 1; i < pts.length; i++) assert.ok(pts[i][2] >= pts[i - 1][2], 'pressure ramps with the capture');
  });

  test('a tap becomes a single dot and tiny jitter is not a line', () => {
    const dot = resampleStroke([{ x: 0.4, y: 0.4, p: 0.6, t: 0 }, { x: 0.401, y: 0.4005, p: 0.7, t: 0.05 }]);
    assert.equal(dot.length, 1);
    assert.deepEqual(dot[0].slice(0, 2), [0.4, 0.4]);
    assert.ok(near(dot[0][2], 0.65, 0.011));
  });

  test('long strokes are capped at the per-stroke point budget', () => {
    const raw = [];
    for (let i = 0; i <= 2000; i++) raw.push({ x: 0.05 + 0.9 * Math.abs(Math.sin(i / 30)), y: i / 2000, t: i * 0.004 });
    const pts = resampleStroke(raw);
    assert.ok(pts.length <= STROKE_LIMITS.maxPointsPerStroke, `${pts.length} points`);
    assert.ok(pts.length > 100, 'still detailed');
  });

  test('duplicate and non-finite samples are dropped', () => {
    const pts = resampleStroke([
      { x: 0.1, y: 0.1, t: 0 }, { x: 0.1, y: 0.1, t: 0.1 }, { x: Number.NaN, y: 0.2 }, { x: 0.3, y: Infinity },
      { x: 0.3, y: 0.1, t: 0.2 },
    ], 0.05);
    assert.equal(pts.length, 5);
    assert.ok(pts.every((p) => p.every(Number.isFinite)));
  });

  test('finalizeStroke validates colour and width and records duration', () => {
    const s = finalizeStroke(
      [{ x: 0.1, y: 0.2, pressure: 0.5, dt: 0, pen_state: 'down' }, { x: 0.6, y: 0.2, pressure: 0.5, dt: 0.25, pen_state: 'up' }],
      { color: 'red', width: 5, t0: 1.5 },
    );
    assert.equal(s.color, DRAW_COLORS[0], 'invalid colours fall back to ink');
    assert.equal(s.width, STROKE_LIMITS.width[1], 'width is clamped');
    assert.equal(s.t0, 1.5);
    assert.equal(s.dur, 0.25);
    assert.equal(finalizeStroke([], {}), null);
  });
});

describe('StrokeRecorder', () => {
  const rect = { left: 0, top: 0, width: 400, height: 400 };

  test('captures raw x, y, pressure, dt and pen_state, then stores a normalised stroke', () => {
    const rec = new StrokeRecorder();
    assert.equal(rec.begin({ x: 40, y: 40, pressure: 0.3, t: 10 }, rect, { color: '#FF7FA3', width: 0.03 }), true);
    for (let i = 1; i <= 20; i++) rec.move({ x: 40 + i * 10, y: 40 + i * 5, pressure: 0.3 + i * 0.02, t: 10 + i * 0.016 }, rect);
    const raw = rec.activeSamples;
    assert.equal(raw[0].pen_state, 'down');
    assert.equal(raw[1].pen_state, 'move');
    assert.ok(near(raw[1].dt, 0.016));
    assert.ok(raw.every((s) => s.x >= 0 && s.x <= 1 && s.y >= 0 && s.y <= 1), 'raw samples are already normalised');
    const stroke = rec.end({ x: 250, y: 145, pressure: 0.75, t: 10.35 }, rect);
    assert.equal(stroke.color, '#ff7fa3');
    assert.equal(stroke.width, 0.03);
    assert.equal(stroke.t0, 0);
    assert.ok(near(stroke.dur, 0.35));
    assert.deepEqual(stroke.points[0].slice(0, 2), [0.1, 0.1]);
    assert.deepEqual(stroke.points.at(-1).slice(0, 2), [0.625, 0.3625]);
    assert.ok(stroke.points.at(-1)[2] > stroke.points[0][2], 'pressure is preserved');
    assert.ok(stroke.points.every((p) => p.length === 4), '[x, y, pressure, dt] tuples');
    assert.equal(rec.activeSamples, null);

    rec.begin({ x: 100, y: 300, t: 11.0 }, rect, { color: '#55b8ec', width: 0.012 });
    rec.move({ x: 300, y: 300, t: 11.2 }, rect);
    const second = rec.end(null, rect);
    assert.ok(near(second.t0, 1.0), 'the pause between strokes is kept in t0');
    assert.equal(rec.drawing.strokes.length, 2);
  });

  test('undo removes the last stroke, clear is undoable, and limits hold', () => {
    const rec = new StrokeRecorder();
    const line = (y, t) => {
      rec.begin({ x: 20, y, t }, rect, { color: '#4a3f6b', width: 0.02 });
      rec.move({ x: 380, y, t: t + 0.2 }, rect);
      return rec.end(null, rect);
    };
    line(50, 0);
    line(100, 1);
    assert.equal(rec.strokes.length, 2);
    assert.equal(rec.undo(), true);
    assert.equal(rec.strokes.length, 1);
    assert.equal(rec.clear(), true);
    assert.equal(rec.strokes.length, 0);
    assert.equal(rec.undo(), true, 'clear can be undone');
    assert.equal(rec.strokes.length, 1);
    for (let i = 0; i < STROKE_LIMITS.maxStrokes + 5; i++) line(20 + (i % 18) * 20, 2 + i);
    assert.ok(rec.strokes.length <= STROKE_LIMITS.maxStrokes);
    assert.ok(rec.pointCount <= STROKE_LIMITS.maxTotalPoints);
  });

  test('template stamps add strokes in the chosen colour; one undo removes the stamp', () => {
    const rec = new StrokeRecorder();
    const added = rec.addStrokes(templateStrokes('flower', { color: '#9a7bff', width: 0.02 }));
    assert.ok(added >= 8);
    assert.ok(rec.strokes.some((s) => s.color === '#9a7bff'), 'petals use the chosen colour');
    assert.ok(rec.strokes.some((s) => s.color === '#6ccf7f'), 'the stem stays green');
    rec.undo();
    assert.equal(rec.strokes.length, 0);
  });
});

describe('drawing sanitisation', () => {
  test('hostile drawings are cleaned and bounded', () => {
    const d = sanitizeDrawing({
      paper: 'javascript:alert(1)',
      strokes: [
        { color: '#ABCDEF', width: 0.5, points: [[2, -1, 9, -3], [0.5, 0.5, 0.5, 0.1], ['a', 0.2], null] },
        { color: '<b>', width: 'wide', points: 'nope' },
        null,
        ...Array.from({ length: 200 }, () => ({ color: '#ff0000', width: 0.02, points: Array.from({ length: 300 }, (_, i) => [i / 300, 0.5]) })),
      ],
    });
    assert.equal(d.paper, PAPER);
    assert.deepEqual(d.strokes[0].points, [[1, 0, 1, 0], [0.5, 0.5, 0.5, 0.1]]);
    assert.equal(d.strokes[0].color, '#abcdef');
    assert.equal(d.strokes[0].width, STROKE_LIMITS.width[1]);
    assert.ok(d.strokes.length <= STROKE_LIMITS.maxStrokes);
    assert.ok(drawingPointCount(d) <= STROKE_LIMITS.maxTotalPoints);
    assert.equal(sanitizeStroke({ points: [] }), null);
    assert.deepEqual(sanitizeDrawing(null).strokes, []);
  });

  test('starter drawings (plain [x, y] points) are valid drawings', () => {
    const starter = generateStarterDrawing({ seed: 4, traits: {}, colors: {} });
    const d = sanitizeDrawing(starter);
    assert.equal(d.strokes.length, starter.strokes.length);
    assert.equal(d.strokes[0].points[0].length, 2);
    assert.equal(d.strokes[0].motif, starter.strokes[0].motif);
  });
});

describe('phrase quantisation and recording', () => {
  test('quantize snaps to the eighth-note grid (float-safe)', () => {
    assert.equal(quantize(0.26), 0.5);
    assert.equal(quantize(0.24), 0);
    assert.equal(quantize(1.74), 1.5);
    assert.equal(quantize(2.9999), 3);
    assert.equal(quantize(0.1 + 0.2, 0.1), 0.3);
    assert.equal(quantize(0.6, 0.25), 0.5);
  });

  test('free-time taps keep their spacing at the tempo, quantised (chords share a beat)', () => {
    const rec = new PhraseRecorder({ tempo: 120 }); // 0.5 s per beat
    assert.equal(rec.noteOn(60, 1.0).beat, 0, 'the first tap starts the phrase');
    assert.equal(rec.noteOn(62, 1.26).beat, 0.5, '0.52 beats later snaps to the next eighth');
    assert.equal(rec.noteOn(64, 1.65).beat, 1.5, '0.78 beats later snaps to one beat after');
    assert.equal(rec.noteOn(67, 1.68).beat, 1.5, 'a near-simultaneous tap joins the chord');
    assert.deepEqual(rec.snapshot().notes.map((x) => [x.beat, x.midi]), [[0, 60], [0.5, 62], [1.5, 64], [1.5, 67]]);
  });

  test('slow tapping becomes steady beats (gap cap) and a long pause starts a new take after a breath', () => {
    const rec = new PhraseRecorder({ tempo: 120 }); // 0.5 s per beat
    rec.noteOn(60, 0);
    assert.equal(rec.noteOn(62, 1.4).beat, RECORDER.maxFreeStep, 'a 2.8 beat wait is capped at one beat');
    assert.equal(rec.noteOn(64, 2.8).beat, 2 * RECORDER.maxFreeStep);
    assert.equal(rec.noteOn(65, 2.8 + RECORDER.freeResetSeconds + 1).beat, 3, 'a new take lands a beat after the last note');
  });

  test('holding a key sets the duration; quick taps are at least an eighth', () => {
    const rec = new PhraseRecorder({ tempo: 120 });
    const a = rec.noteOn(60, 0);
    assert.equal(rec.noteOff(a.handle, 0.05).dur, 0.5, 'a quick tap is an eighth note');
    const b = rec.noteOn(64, 0.5);
    assert.equal(rec.noteOff(b.handle, 1.5).dur, 2, 'a one second hold at 120 bpm is two beats');
    assert.equal(rec.noteOff(b.handle, 3), null, 'released notes are not changed twice');
  });

  test('a metronome pass places taps at the quantised playhead and overdubs the phrase', () => {
    const rec = new PhraseRecorder({ tempo: 120 });
    rec.load(musicTemplate('starlight-lullaby'));
    rec.setTempo(120);
    const before = rec.snapshot().notes.length;
    rec.startPass(10);
    assert.equal(rec.recording, true);
    assert.equal(rec.hit(drumById('clap').midi, 10.0 + 0.5 * 1.1).beat, 1, 'a slightly late clap still lands on beat 1');
    assert.equal(rec.noteOn(81, 10 + 0.5 * 3.4).beat, 3.5);
    assert.ok(near(rec.beatAt(11), 2), 'playhead position');
    rec.stopPass();
    const p = rec.snapshot();
    assert.equal(p.notes.length, before + 1, 'the lullaby notes are kept (overdub)');
    assert.ok(p.hits.some((x) => x.beat === 1 && x.midi === 39));
  });

  test('count-in taps are ignored and taps at the very end clamp to the last slot', () => {
    const rec = new PhraseRecorder({ tempo: 120, beats: 8 });
    rec.startPass(5);
    assert.equal(rec.noteOn(60, 4.5).reason, 'early');
    assert.equal(rec.noteOn(60, 4.9).beat, 0, 'just before beat 0 snaps onto it');
    assert.equal(rec.noteOn(62, 5 + 0.5 * 7.9).beat, 7.5);
  });

  test('a full phrase stops capturing and says why; limits are enforced', () => {
    const rec = new PhraseRecorder({ tempo: 120, beats: 8 });
    let t = 0;
    let res;
    for (let i = 0; i < 40; i++) {
      res = rec.noteOn(60 + (i % 5) * 2, t);
      t += 0.25;
      if (!res.captured) break;
    }
    assert.equal(res.captured, false);
    assert.equal(res.reason, 'full');
    assert.equal(rec.snapshot().notes.length, 16, '8 beats hold 16 eighths');
    assert.equal(rec.noteOn(40, t).reason, 'range', 'notes off the studio keyboard are refused');
    assert.equal(rec.hit(60, t).reason, 'unknown-drum');
  });

  test('drum pads record General MIDI hits in their own list', () => {
    const rec = new PhraseRecorder({ tempo: 100 });
    for (const [i, d] of DRUMS.entries()) assert.equal(rec.hit(d.midi, i * 0.3).captured, true);
    const p = rec.snapshot();
    assert.equal(p.notes.length, 0);
    assert.deepEqual(p.hits.map((x) => x.midi), DRUMS.map((d) => d.midi));
    assert.ok(!phraseIsEmpty(p), 'a drums-only phrase is not empty');
  });

  test('undo, clear, load and shortening the phrase', () => {
    const rec = new PhraseRecorder({ tempo: 120, beats: 16 });
    rec.load(musicTemplate('bouncy-walk'));
    assert.equal(rec.tempo, 104, 'loading a template brings its tempo');
    rec.setTempo(120);
    rec.setBeats(16);
    rec.startPass(0);
    rec.noteOn(72, 0.5 * 12);
    rec.stopPass();
    assert.ok(rec.snapshot().notes.some((x) => x.beat === 12));
    rec.setBeats(8);
    assert.ok(rec.snapshot().notes.every((x) => x.beat < 8), 'shortening drops notes past the end');
    rec.undo();
    assert.equal(rec.beats, 16);
    assert.ok(rec.snapshot().notes.some((x) => x.beat === 12), 'undo restores the longer phrase');
    rec.clear();
    assert.equal(rec.isEmpty, true);
    rec.undo();
    assert.equal(rec.isEmpty, false);
    assert.equal(rec.remove(12, 72), true, 'tap-to-delete on the timeline');
    assert.equal(rec.remove(12, 72), false);
  });

  test('captured notes use the { beat, midi, dur, vel } representation', () => {
    const rec = new PhraseRecorder({ tempo: 90 });
    const r = rec.noteOn(67, 0, 0.92);
    rec.noteOff(r.handle, 0.4);
    const [note] = rec.snapshot().notes;
    assert.deepEqual(Object.keys(note).sort(), ['beat', 'dur', 'midi', 'vel']);
    assert.equal(note.vel, 0.92);
  });

  test('sanitizePhrase rejects hostile data and keeps events sorted and unique', () => {
    const p = sanitizePhrase({
      tempo: 9999, beats: 12,
      notes: [
        { beat: 3, midi: 64, dur: 99, vel: 4 }, { beat: 1, midi: 60 }, { beat: 1, midi: 60 }, { beat: -1, midi: 62 },
        { beat: 20, midi: 62 }, { beat: '2', midi: 62 }, { beat: 2, midi: 61.5 }, { beat: 2, midi: 100 }, null, 'x',
      ],
      hits: [{ beat: 0, midi: 36 }, { beat: 0, midi: 60 }],
    });
    assert.equal(p.tempo, PHRASE_LIMITS.tempo[1]);
    assert.equal(p.beats, 16);
    assert.deepEqual(p.notes.map((x) => [x.beat, x.midi]), [[1, 60], [3, 64]]);
    assert.equal(p.notes[1].dur, PHRASE_LIMITS.maxDur);
    assert.equal(p.notes[1].vel, 1);
    assert.deepEqual(p.hits.map((x) => x.midi), [36]);
    assert.deepEqual(sanitizePhrase(undefined), { tempo: 100, beats: 8, notes: [], hits: [] });
    const many = sanitizePhrase({ notes: Array.from({ length: 500 }, (_, i) => ({ beat: (i % 16) / 2, midi: 60 + (i % 21) })) });
    assert.ok(many.notes.length <= PHRASE_LIMITS.maxNotes);
  });

  test('starter phrases are valid phrases; helpers describe notes', () => {
    const starter = sanitizePhrase(generateStarterPhrase({ seed: 9 }));
    assert.ok(starter.notes.length > 3);
    assert.ok(phraseSeconds(starter) > 2);
    assert.equal(noteName(60), 'C4');
    assert.equal(noteName(73), 'C#5');
    assert.equal(keyboardNotes().length, 10, 'pentatonic keyboard: C D E G A over the studio range');
    assert.equal(keyboardNotes({ chromatic: true }).length, KEY_RANGE.hi - KEY_RANGE.lo + 1);
    assert.ok(keyboardNotes().every(isPentatonic));
  });
});

describe('templates', () => {
  test('music templates are valid, distinct and fit the studio keyboard', () => {
    assert.deepEqual(MUSIC_TEMPLATES.map((t) => t.name), ['Sunny Arp', 'Bouncy Walk', 'Starlight Lullaby', 'Playful Hop']);
    const seen = new Set();
    for (const t of MUSIC_TEMPLATES) {
      const p = musicTemplate(t.id);
      assert.equal(p.notes.length, t.notes.length, `${t.id} survives sanitisation intact`);
      assert.equal(p.hits.length, t.hits.length);
      assert.ok(p.notes.every((x) => x.midi >= KEY_RANGE.lo && x.midi <= KEY_RANGE.hi && isPentatonic(x.midi)));
      assert.ok(p.notes.every((x) => x.beat % 0.5 === 0), 'on the eighth-note grid');
      seen.add(JSON.stringify(p.notes));
    }
    assert.equal(seen.size, MUSIC_TEMPLATES.length);
    assert.ok(phraseStats(musicTemplate('starlight-lullaby')).meanVel < phraseStats(musicTemplate('playful-hop')).meanVel);
    assert.equal(musicTemplate('nope'), null);
  });

  test('drawing templates produce in-bounds strokes with pen timing', () => {
    assert.deepEqual(DRAWING_TEMPLATES.map((t) => t.name), ['Star', 'Heart', 'Flower', 'Smiling Sun', 'Spiral']);
    for (const t of DRAWING_TEMPLATES) {
      const d = drawingTemplate(t.id, { color: '#55b8ec', width: 0.03 });
      assert.ok(d.strokes.length >= 1);
      for (const s of d.strokes) {
        assert.ok(s.points.every((p) => p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1));
        assert.ok(Number.isFinite(s.t0) && s.dur > 0);
      }
      assert.ok(d.strokes.some((s) => s.color === '#55b8ec'));
    }
    assert.deepEqual(templateStrokes('unknown'), []);
  });
});

describe('similarity metrics', () => {
  test('identical phrases are fully similar; unrelated phrases much less so', () => {
    const a = musicTemplate('sunny-arp');
    assert.deepEqual(phraseSimilarity(a, a), { rhythm: 1, melody: 1, overall: 1 });
    const b = musicTemplate('starlight-lullaby');
    assert.ok(phraseSimilarity(a, b).overall < 0.75);
  });

  test('drawing similarity is 1 for identical drawings and low for unrelated ones', () => {
    const star = drawingTemplate('star');
    const spiral = drawingTemplate('spiral');
    assert.equal(drawingSimilarity(star, star), 1);
    assert.ok(drawingSimilarity(star, spiral) < 0.6);
    assert.equal(drawingSimilarity({ strokes: [] }, star), 0);
    const st = drawingStats(star);
    assert.equal(st.strokes, 1);
    assert.ok(st.bbox.minX > 0.1 && st.bbox.maxX < 0.9);
  });
});
