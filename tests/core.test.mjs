/**
 * Core tests for the deterministic pet simulation (src/pet-state.js):
 * needs decay, care actions, temperament weighting, station selection,
 * serialisation and persistence. Run with `npm test` (node:test).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PetState, NEEDS, TRAITS, ACTIVITIES, STATION_ACTIVITIES, EAR_STYLES, TAIL_STYLES,
  SCHEMA, SCHEMA_VERSION, STORAGE_KEY, BACKUP_KEY, FUTURE_BACKUP_KEY, AWAY, BASE_DECAY,
  AUTO_CARE_EFFICIENCY, DEFAULT_APPEARANCE, DEFAULT_TRAITS,
  scoreStations, selectionTemperature, decayMultipliers, moodTarget,
  savePet, loadPet, clearSavedPet, validateRecord, sanitizeAppearance, sanitizeName,
  describeActivity, needWord,
} from '../src/pet-state.js';
import { STATIONS, ROOM, planPath, distance } from '../src/studio-layout.js';

// ----- helpers ---------------------------------------------------------------
const NOW = 1_760_000_000_000;
const fixedClock = () => NOW;

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
}

const FULL = { hunger: 100, energy: 100, hygiene: 100, mood: 100, curiosity: 100, bond: 100 };
const traitsWith = (overrides) => ({ ...Object.fromEntries(TRAITS.map((k) => [k, 0.3])), ...overrides });

function makePet(opts = {}) {
  return PetState.create({ seed: 1234, now: NOW, clock: fixedClock, ...opts });
}

/** Steps the simulation until `predicate(pet)` holds; returns the simulated seconds or -1. */
function runUntil(pet, predicate, maxSeconds = 120, step = 0.1) {
  let t = 0;
  while (t <= maxSeconds) {
    if (predicate(pet)) return t;
    pet.update(step);
    t += step;
  }
  return -1;
}

function events(pet) {
  const list = [];
  pet.on((e) => list.push(e));
  return list;
}

// ----- needs decay -------------------------------------------------------------
describe('needs decay', () => {
  test('every decaying need drops at its base rate times the temperament multiplier', () => {
    const traits = traitsWith({});
    const pet = makePet({ traits, autonomy: false, needs: { hunger: 80, energy: 80, hygiene: 80, curiosity: 80, bond: 80, mood: 80 } });
    pet.update(60);
    assert.equal(pet.activity.type, 'idle', 'autonomy off keeps the pet idle');
    const mult = decayMultipliers(pet.traits);
    for (const k of ['hunger', 'energy', 'hygiene', 'curiosity', 'bond']) {
      const expected = 80 - BASE_DECAY[k] * mult[k] * 60;
      assert.ok(Math.abs(pet.needs[k] - expected) < 1e-6, `${k}: ${pet.needs[k]} vs ${expected}`);
      assert.ok(pet.needs[k] < 80, `${k} decays`);
    }
  });

  test('mood drifts toward a target derived from the other needs', () => {
    const low = makePet({ autonomy: false, needs: { hunger: 10, energy: 10, hygiene: 10, curiosity: 10, bond: 10, mood: 90 } });
    low.update(30);
    assert.ok(low.needs.mood < 90, 'mood falls when other needs are low');
    const high = makePet({ autonomy: false, needs: { ...FULL, mood: 20 } });
    high.update(30);
    assert.ok(high.needs.mood > 20, 'mood rises when other needs are met');
    assert.ok(moodTarget(FULL, DEFAULT_TRAITS) > moodTarget({ ...FULL, hunger: 0, energy: 0 }, DEFAULT_TRAITS));
  });

  test('temperament changes decay: curious pets get bored sooner, neat pets stay clean longer', () => {
    const curious = makePet({ autonomy: false, traits: traitsWith({ curious: 1 }) });
    const incurious = makePet({ autonomy: false, traits: traitsWith({ curious: 0 }) });
    const neat = makePet({ autonomy: false, traits: traitsWith({ neat: 1, chaotic: 0 }) });
    const chaotic = makePet({ autonomy: false, traits: traitsWith({ neat: 0, chaotic: 1 }) });
    for (const p of [curious, incurious, neat, chaotic]) p.update(120);
    assert.ok(curious.needs.curiosity < incurious.needs.curiosity);
    assert.ok(neat.needs.hygiene > chaotic.needs.hygiene);
    assert.ok(decayMultipliers(traitsWith({ playful: 1 })).energy > decayMultipliers(traitsWith({ calm: 1 })).energy);
  });

  test('needs are always clamped to 0..100', () => {
    const pet = makePet({ autonomy: false });
    pet.update(4000);
    for (const k of NEEDS) assert.ok(pet.needs[k] >= 0 && pet.needs[k] <= 100, `${k}=${pet.needs[k]}`);
    pet.setNeeds({ hunger: 500, energy: -20, mood: Number.NaN });
    assert.equal(pet.needs.hunger, 100);
    assert.equal(pet.needs.energy, 0);
    assert.ok(Number.isFinite(pet.needs.mood));
  });

  test('sleeping slows hunger decay and restores energy', () => {
    const pet = makePet({ needs: { energy: 30, hunger: 80 } });
    assert.equal(pet.sleep().ok, true);
    assert.ok(runUntil(pet, (p) => p.activity.type === 'sleeping', 60) >= 0, 'reaches the bed');
    const before = { ...pet.needs };
    pet.update(5);
    assert.equal(pet.activity.type, 'sleeping');
    assert.ok(pet.needs.energy > before.energy + 10, 'energy restores while asleep');
    const awakeDrop = BASE_DECAY.hunger * decayMultipliers(pet.traits).hunger * 5;
    assert.ok(before.hunger - pet.needs.hunger < awakeDrop * 0.6, 'hunger decays slower while asleep');
  });
});

// ----- care actions ------------------------------------------------------------
describe('care actions', () => {
  test('feed() walks the pet to the Snack Bar and eating raises hunger', () => {
    const pet = makePet({ needs: { hunger: 30, bond: 40 } });
    const log = events(pet);
    const res = pet.feed();
    assert.equal(res.ok, true);
    assert.equal(res.kind, 'feed');
    assert.ok(res.message.includes(pet.name));
    assert.equal(pet.activity.type, 'walking');
    assert.equal(pet.activity.station, 'food');
    assert.equal(pet.activity.pending, 'eating');
    assert.equal(pet.activity.source, 'player');
    assert.ok(pet.needs.bond > 40, 'attention builds bond');
    assert.ok(runUntil(pet, (p) => p.activity.type === 'eating', 60) >= 0, 'arrives and eats');
    assert.ok(distance(pet.position, STATIONS.food.anchor) < 1e-9);
    const hungerAtStart = pet.needs.hunger;
    assert.ok(runUntil(pet, (p) => p.activity.type !== 'eating', 30) >= 0, 'finishes eating');
    assert.ok(pet.needs.hunger > hungerAtStart + 35, `hunger ${hungerAtStart} -> ${pet.needs.hunger}`);
    assert.equal(pet.counters.meals, 1);
    const ended = log.find((e) => e.type === 'activity:end' && e.activity === 'eating');
    assert.ok(ended && ended.completed, 'emits a completed activity:end event');
  });

  test('feed() politely declines when the pet is already full', () => {
    const pet = makePet({ needs: { hunger: 98 } });
    const before = pet.activity.type;
    const res = pet.feed();
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'full');
    assert.equal(pet.activity.type, before);
  });

  test('wash() leads to a bath that restores hygiene', () => {
    const pet = makePet({ needs: { hygiene: 20 } });
    assert.equal(pet.wash().ok, true);
    assert.ok(runUntil(pet, (p) => p.activity.type === 'bathing', 60) >= 0);
    assert.ok(pet.elevation > 0, 'the pet sits inside the tub');
    assert.ok(runUntil(pet, (p) => p.activity.type !== 'bathing', 30) >= 0);
    assert.ok(pet.needs.hygiene > 85, `hygiene ${pet.needs.hygiene}`);
    assert.ok(distance(pet.position, STATIONS.bath.approach) < 1e-9, 'hops back out of the tub');
    assert.equal(pet.wash().reason, 'clean');
  });

  test('sleep() / wake(): rest in the Sleep Nook, other requests wait while asleep', () => {
    const pet = makePet({ needs: { energy: 30 } });
    assert.equal(pet.sleep().ok, true);
    assert.ok(runUntil(pet, (p) => p.isAsleep, 60) >= 0);
    assert.equal(pet.getExpression(), 'asleep');
    assert.equal(pet.feed().reason, 'asleep');
    assert.equal(pet.goDraw().reason, 'asleep');
    pet.update(4);
    const res = pet.wake();
    assert.equal(res.ok, true);
    assert.equal(pet.isAsleep, false);
    assert.ok(pet.needs.energy > 40);
    assert.equal(pet.wake().reason, 'awake');
  });

  test('sleep() is declined when the pet is not tired', () => {
    const pet = makePet({ needs: { energy: 99 } });
    const res = pet.sleep();
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'not-sleepy');
  });

  test('pet() raises bond and mood immediately, with diminishing returns when spammed', () => {
    const pet = makePet({ autonomy: false, needs: { bond: 40, mood: 50 } });
    const r = pet.pet();
    assert.equal(r.ok, true);
    assert.equal(r.expression, 'happy');
    assert.equal(r.bubble, 'heart');
    const firstGain = pet.needs.bond - 40;
    assert.ok(firstGain >= 3.9, `first pet gives ${firstGain}`);
    assert.ok(pet.needs.mood > 50);
    const b = pet.needs.bond;
    pet.pet();
    assert.ok(pet.needs.bond - b < firstGain, 'rapid repeat pets count for less');
    assert.equal(pet.getExpression(), 'happy');
    assert.equal(pet.getBubble().icon, 'heart');
    assert.equal(pet.counters.pets, 2);
  });

  test('praise() right after a finished drawing makes the pet proud', () => {
    const pet = makePet({ needs: { energy: 90, curiosity: 40 } });
    assert.equal(pet.goDraw().ok, true);
    assert.ok(runUntil(pet, (p) => p.activity.type === 'drawing', 60) >= 0);
    const seed = pet.activity.seed;
    assert.equal(pet.currentDrawing.seed, seed);
    assert.equal(pet.currentDrawing.complete, false);
    assert.ok(runUntil(pet, (p) => p.activity.type !== 'drawing', 30) >= 0);
    assert.equal(pet.counters.drawings, 1);
    assert.equal(pet.currentDrawing.complete, true);
    assert.equal(pet.currentDrawing.progress, 1);
    const praise = pet.praise();
    assert.equal(praise.ok, true);
    assert.equal(praise.expression, 'proud');
    assert.match(praise.message, /drawing/);
    pet.update(5);
    assert.equal(pet.praise().expression, 'happy', 'the same creation is only celebrated once');
  });

  test('goPlayMusic() and goTo(rug) reach the right stations', () => {
    const pet = makePet({ needs: { energy: 90 } });
    assert.equal(pet.goPlayMusic().ok, true);
    assert.ok(runUntil(pet, (p) => p.activity.type === 'playing_music', 60) >= 0);
    assert.equal(pet.goPlayMusic().reason, 'already');
    assert.equal(pet.goTo('rug').ok, true);
    assert.ok(runUntil(pet, (p) => p.activity.type === 'listening', 60) >= 0);
    assert.equal(pet.goTo('nowhere').ok, false);
  });

  test('care the player asks for is more effective than autonomous self-care', () => {
    const run = (source) => {
      const pet = makePet({ needs: { hunger: 20 } });
      if (source === 'player') pet.feed();
      else pet._commandStation('food', 'auto');
      runUntil(pet, (p) => p.activity.type === 'eating', 60);
      const start = pet.needs.hunger;
      pet.update(3);
      return pet.needs.hunger - start;
    };
    const playerGain = run('player');
    const autoGain = run('auto');
    assert.ok(autoGain < playerGain);
    assert.ok(Math.abs(autoGain / playerGain - AUTO_CARE_EFFICIENCY) < 0.05);
  });

  test('stubborn pets may refuse optional requests but never a real need, nor twice in a row', () => {
    let refusals = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const urgent = makePet({ seed, traits: traitsWith({ stubborn: 1 }), needs: { hunger: 20 } });
      assert.equal(urgent.feed().ok, true, `seed ${seed}: hungry pets always accept food`);
      const pet = makePet({ seed, traits: traitsWith({ stubborn: 1 }), needs: { hunger: 70, energy: 90 } });
      let prevRefused = false;
      for (let i = 0; i < 6; i++) {
        const r = pet.goTo(i % 2 ? 'music' : 'rug');
        const refused = r.reason === 'refused';
        if (refused) {
          refusals++;
          assert.equal(r.expression, 'pouty');
          assert.equal(prevRefused, false, 'never refuses twice in a row');
        }
        prevRefused = refused;
      }
    }
    assert.ok(refusals > 0, 'a fully stubborn pet does sometimes refuse');
    const agreeable = makePet({ traits: traitsWith({ stubborn: 0 }) });
    for (let i = 0; i < 10; i++) assert.notEqual(agreeable.goTo(i % 2 ? 'music' : 'rug').reason, 'refused');
  });

  test('reactions expose expression, emote and bubble for the renderer', () => {
    const pet = makePet({ needs: { hunger: 40 } });
    const r = pet.feed();
    assert.equal(r.type, 'reaction');
    assert.equal(r.expression, 'excited');
    assert.equal(r.emote, 'hop');
    assert.equal(r.bubble, 'food');
    assert.equal(pet.getExpression(), 'excited');
    assert.ok(pet.events.at(-1).text.length > 0, 'care is logged');
  });
});

// ----- temperament weighting -----------------------------------------------------
describe('personality trait weighting', () => {
  const needs = { hunger: 55, energy: 60, hygiene: 45, mood: 60, curiosity: 40, bond: 50 };

  test('neat pets value the bath more than chaotic pets', () => {
    const neat = scoreStations(needs, traitsWith({ neat: 1, chaotic: 0 }));
    const chaotic = scoreStations(needs, traitsWith({ neat: 0, chaotic: 1 }));
    assert.ok(neat.bath > chaotic.bath, `${neat.bath} > ${chaotic.bath}`);
  });

  test('playful and dramatic pets are drawn to the music corner more than calm pets', () => {
    const performer = scoreStations(needs, traitsWith({ playful: 1, dramatic: 1, calm: 0 }));
    const calm = scoreStations(needs, traitsWith({ playful: 0, dramatic: 0, calm: 1 }));
    assert.ok(performer.music > calm.music);
    assert.ok(calm.rug > performer.rug, 'calm pets prefer listening on the rug');
    assert.ok(calm.idle > performer.idle, 'calm pets idle longer');
  });

  test('curious pets favour the easel', () => {
    const curious = scoreStations(needs, traitsWith({ curious: 1 }));
    const incurious = scoreStations(needs, traitsWith({ curious: 0 }));
    assert.ok(curious.easel > incurious.easel);
  });

  test('chaotic pets choose more randomly (higher softmax temperature)', () => {
    assert.ok(selectionTemperature(traitsWith({ chaotic: 1 })) > selectionTemperature(traitsWith({ chaotic: 0, calm: 1 })));
  });

  test('the dominant trait flavours reaction text', () => {
    const dramatic = makePet({ traits: traitsWith({ dramatic: 1 }), needs: { hunger: 40 } });
    const calm = makePet({ traits: traitsWith({ calm: 1 }), needs: { hunger: 40 } });
    assert.notEqual(dramatic.feed().message, calm.feed().message);
    assert.deepEqual(makePet({ traits: traitsWith({ neat: 0.9, curious: 0.8, calm: 0.1 }) }).topTraits(), ['neat', 'curious']);
  });
});

// ----- station selection ---------------------------------------------------------
describe('station selection', () => {
  test('critically low needs win outright, the lowest first', () => {
    for (let seed = 1; seed <= 25; seed++) {
      assert.equal(makePet({ seed, needs: { ...FULL, hunger: 10 } }).chooseNextActivity().station, 'food');
      assert.equal(makePet({ seed, needs: { ...FULL, energy: 8 } }).chooseNextActivity().station, 'bed');
      assert.equal(makePet({ seed, needs: { ...FULL, hygiene: 5 } }).chooseNextActivity().station, 'bath');
      const both = makePet({ seed, needs: { ...FULL, hunger: 12, energy: 5 } }).chooseNextActivity();
      assert.equal(both.station, 'bed');
      assert.equal(both.reason, 'urgent');
    }
  });

  test('a satisfied pet never wanders off to eat, bathe or nap', () => {
    const pet = makePet({ needs: FULL });
    for (let i = 0; i < 400; i++) {
      const c = pet.chooseNextActivity();
      assert.ok(!['food', 'bath', 'bed'].includes(c.station), `picked ${c.station}`);
    }
  });

  test('temperament shifts how often each station is chosen', () => {
    const tally = (traits) => {
      const pet = makePet({ seed: 99, traits, needs: { ...FULL, curiosity: 45, mood: 70 } });
      const counts = {};
      for (let i = 0; i < 600; i++) {
        const c = pet.chooseNextActivity().station ?? 'idle';
        counts[c] = (counts[c] ?? 0) + 1;
      }
      return counts;
    };
    const diva = tally(traitsWith({ dramatic: 1, playful: 0.9, calm: 0 }));
    const dreamy = tally(traitsWith({ calm: 1, playful: 0, dramatic: 0 }));
    const scholar = tally(traitsWith({ curious: 1, playful: 0, dramatic: 0 }));
    assert.ok((diva.music ?? 0) > (dreamy.music ?? 0), `diva ${diva.music} vs dreamy ${dreamy.music}`);
    assert.ok((dreamy.rug ?? 0) > (diva.rug ?? 0), 'dreamy pets listen more');
    assert.ok((scholar.easel ?? 0) > (diva.easel ?? 0), 'scholars draw more');
  });

  test('choices are deterministic for a given seed', () => {
    const seq = (seed) => {
      const pet = makePet({ seed, needs: { ...FULL, curiosity: 50, hunger: 50, hygiene: 50 } });
      return Array.from({ length: 30 }, () => pet.chooseNextActivity().activity).join(',');
    };
    assert.equal(seq(7), seq(7));
    assert.notEqual(seq(7), seq(8));
  });

  test('the autonomous loop visits many stations and stays inside the room', () => {
    const pet = makePet({ seed: 5 });
    const visited = new Set();
    let walkingFor = 0;
    for (let i = 0; i < 6000; i++) {
      pet.update(0.1);
      assert.ok(ACTIVITIES.includes(pet.activity.type));
      if (STATION_ACTIVITIES.includes(pet.activity.type)) visited.add(pet.activity.station);
      walkingFor = pet.activity.type === 'walking' ? walkingFor + 0.1 : 0;
      assert.ok(walkingFor < 41, 'never stuck walking');
      assert.ok(Math.abs(pet.position.x) <= ROOM.half && Math.abs(pet.position.z) <= ROOM.half, 'inside the room');
    }
    assert.ok(visited.size >= 4, `visited ${[...visited].join(', ')}`);
  });

  test('paths bow around furniture and use station entry waypoints', () => {
    const path = planPath(STATIONS.bed.approach, STATIONS.music.approach, STATIONS.music.entry);
    assert.ok(path.length >= 2);
    assert.deepEqual(path.at(-1), STATIONS.music.approach);
    assert.ok(path.some((p) => distance(p, STATIONS.music.entry[0]) < 1e-9), 'walks around the keyboard');
  });

  test('status text describes what the pet is doing', () => {
    assert.equal(describeActivity({ type: 'walking', station: 'easel', pending: 'drawing' }).text, 'Off to the Drawing Easel');
    assert.equal(describeActivity({ type: 'walking', station: 'easel', pending: 'drawing' }).short, 'To the Easel');
    assert.equal(describeActivity({ type: 'drawing', station: 'easel' }).icon, 'draw');
    assert.equal(needWord('hunger', 10), 'Hungry');
    assert.equal(needWord('hunger', 95), 'Full');
  });
});

// ----- serialisation & persistence ------------------------------------------------
describe('serialization', () => {
  test('toJSON / fromJSON round-trips identity, appearance, temperament, needs and activity', () => {
    const pet = makePet({
      appearance: { name: 'Pico', bodyColor: '#a8d8ff', earStyle: 'cat', tailStyle: 'star', headScale: 1.2 },
      traits: traitsWith({ curious: 0.9 }),
    });
    pet.goDraw();
    runUntil(pet, (p) => p.activity.type === 'drawing', 60);
    pet.currentDrawing.style = { generator: 'starter-draw-v1', traits: { ...pet.traits }, colors: { bodyColor: '#a8d8ff', accentColor: '#fff1dc', cheekColor: '#ff7d9c' } };
    pet.update(3);
    const json = JSON.parse(JSON.stringify(pet.toJSON(NOW)));
    assert.equal(json.currentDrawing.style.colors.bodyColor, '#a8d8ff', 'drawing style is persisted');
    assert.equal(json.schema, SCHEMA);
    assert.equal(json.version, SCHEMA_VERSION);
    const copy = PetState.fromJSON(json, { now: NOW, clock: fixedClock });
    assert.equal(copy.id, pet.id);
    assert.deepEqual(copy.appearance, pet.appearance);
    assert.deepEqual(copy.traits, pet.traits);
    for (const k of NEEDS) assert.ok(Math.abs(copy.needs[k] - pet.needs[k]) < 0.01, k);
    assert.equal(copy.activity.type, 'drawing');
    assert.equal(copy.activity.seed, pet.activity.seed);
    assert.ok(Math.abs(copy.activity.elapsed - pet.activity.elapsed) < 0.01);
    assert.deepEqual(copy.currentDrawing, pet.currentDrawing);
    assert.deepEqual(copy.counters, pet.counters);
    assert.equal(copy.rngState, pet.rngState);
  });

  test('a restored pet continues exactly like the original (same seeded choices)', () => {
    const pet = makePet({ seed: 77, needs: { curiosity: 50, hunger: 50 } });
    pet.update(20);
    const copy = PetState.fromJSON(JSON.parse(JSON.stringify(pet.toJSON(NOW))), { now: NOW, clock: fixedClock });
    copy.activity = { ...pet.activity };
    copy.path = pet.path.map((p) => ({ ...p }));
    copy.needs = { ...pet.needs };
    copy.position = { ...pet.position };
    const a = Array.from({ length: 12 }, () => pet.chooseNextActivity().activity);
    const b = Array.from({ length: 12 }, () => copy.chooseNextActivity().activity);
    assert.deepEqual(b, a);
  });

  test('hostile or damaged fields are sanitised', () => {
    const pet = new PetState({
      appearance: {
        name: '  <b>Super\u0000Long\nName</b> That Never Ends  ', bodyColor: 'red', accentColor: '#12345', cheekColor: '#ABCDEF',
        earStyle: 'laser', tailStyle: 'propeller', headScale: 9, bodyScale: -3,
      },
      traits: { playful: 7, calm: -1, curious: 'very', dramatic: Number.NaN },
      needs: { hunger: 999, energy: -5, hygiene: 'clean', mood: Infinity },
      position: { x: 1e9, z: -1e9 },
      activity: { type: 'teleporting', station: 'moon', elapsed: -4 },
      counters: { meals: -3, songs: 2.5, drawings: 4 },
      events: 'not a list',
    }, { now: NOW, clock: fixedClock });
    const a = pet.appearance;
    assert.ok(a.name.length > 0 && Array.from(a.name).length <= 16);
    assert.ok(!/[<>\u0000\n]/.test(a.name));
    assert.equal(a.bodyColor, DEFAULT_APPEARANCE.bodyColor);
    assert.equal(a.accentColor, DEFAULT_APPEARANCE.accentColor);
    assert.equal(a.cheekColor, '#abcdef');
    assert.ok(EAR_STYLES.includes(a.earStyle) && TAIL_STYLES.includes(a.tailStyle));
    assert.equal(a.headScale, 1.3);
    assert.equal(a.bodyScale, 0.8);
    assert.equal(pet.traits.playful, 1);
    assert.equal(pet.traits.calm, 0);
    assert.equal(pet.traits.curious, DEFAULT_TRAITS.curious);
    assert.equal(pet.needs.hunger, 100);
    assert.equal(pet.needs.energy, 0);
    for (const k of NEEDS) assert.ok(Number.isFinite(pet.needs[k]));
    assert.ok(Math.abs(pet.position.x) <= ROOM.half && Math.abs(pet.position.z) <= ROOM.half);
    assert.ok(ACTIVITIES.includes(pet.activity.type));
    assert.deepEqual([pet.counters.meals, pet.counters.songs, pet.counters.drawings], [0, 0, 4]);
    assert.deepEqual(pet.events, []);
    assert.equal(sanitizeName('🐰🐰🐰🐰🐰🐰🐰🐰🐰🐰🐰🐰🐰🐰🐰🐰🐰🐰'), '🐰'.repeat(16), 'never splits emoji');
    assert.equal(sanitizeAppearance({ name: '   ' }).name, DEFAULT_APPEARANCE.name);
  });

  test('validateRecord rejects foreign data and recognises future versions', () => {
    assert.equal(validateRecord(null).ok, false);
    assert.equal(validateRecord([]).ok, false);
    assert.equal(validateRecord({ schema: 'something.else', version: 1 }).reason, 'wrong-schema');
    assert.equal(validateRecord({ schema: SCHEMA, version: 0 }).reason, 'bad-version');
    assert.equal(validateRecord({ schema: SCHEMA, version: SCHEMA_VERSION + 1 }).reason, 'future-version');
    assert.equal(validateRecord(makePet().toJSON(NOW)).ok, true);
    assert.throws(() => PetState.fromJSON({ schema: 'nope', version: 1 }), /wrong-schema/);
  });
});

describe('persistence (localStorage-compatible)', () => {
  test('save and load round-trip, keeping the previous save as a backup', () => {
    const storage = new MemoryStorage();
    const pet = makePet({ appearance: { name: 'Nori' } });
    assert.equal(savePet(pet, storage, NOW).ok, true);
    assert.equal(storage.getItem(BACKUP_KEY), null, 'no backup before a second save');
    pet.setAppearance({ name: 'Nori II' });
    assert.equal(savePet(pet, storage, NOW + 1000).ok, true);
    assert.match(storage.getItem(BACKUP_KEY), /"Nori"/);
    const { pet: loaded, status, away } = loadPet(storage, { now: NOW + 2000, clock: fixedClock });
    assert.equal(status, 'loaded');
    assert.equal(loaded.name, 'Nori II');
    assert.equal(loaded.id, pet.id);
    assert.equal(away, null, 'a two second gap is not time away');
  });

  test('a corrupted save falls back to the last-known-good backup', () => {
    const storage = new MemoryStorage();
    const pet = makePet({ appearance: { name: 'Kiwi' } });
    savePet(pet, storage, NOW);
    savePet(pet, storage, NOW + 10);
    storage.setItem(STORAGE_KEY, '{"schema":"petstudio.pet","version":1,"needs":{'); // torn write
    const res = loadPet(storage, { now: NOW + 20 });
    assert.equal(res.status, 'restored-backup');
    assert.equal(res.pet.name, 'Kiwi');
    // Saving again must not copy the corrupted record over the good backup.
    const good = storage.getItem(BACKUP_KEY);
    storage.setItem(STORAGE_KEY, 'garbage');
    savePet(res.pet, storage, NOW + 30);
    assert.equal(storage.getItem(BACKUP_KEY), good);
  });

  test('missing or unusable data starts fresh without throwing', () => {
    assert.equal(loadPet(new MemoryStorage()).status, 'new');
    const broken = new MemoryStorage();
    broken.setItem(STORAGE_KEY, 'nope');
    broken.setItem(BACKUP_KEY, '{}');
    assert.equal(loadPet(broken).status, 'new');
    assert.equal(loadPet(null).status, 'unavailable');
    const throwing = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } };
    assert.equal(loadPet(throwing).status, 'unavailable');
    assert.equal(savePet(makePet(), throwing).ok, false, 'save failures are reported, not thrown');
    const storage = new MemoryStorage();
    savePet(makePet(), storage, NOW);
    assert.equal(clearSavedPet(storage), true);
    assert.equal(loadPet(storage).status, 'new');
  });

  test('a save from a newer app version is preserved, never overwritten', () => {
    const storage = new MemoryStorage();
    const future = JSON.stringify({ schema: SCHEMA, version: SCHEMA_VERSION + 3, appearance: { name: 'FromTheFuture' } });
    storage.setItem(STORAGE_KEY, future);
    const res = loadPet(storage, { now: NOW });
    assert.equal(res.status, 'future-version');
    assert.equal(res.pet, null);
    assert.equal(storage.getItem(FUTURE_BACKUP_KEY), future);
  });

  test('time away is bounded and gentle, and never fabricates creative work', () => {
    const storage = new MemoryStorage();
    const pet = makePet({ needs: { hunger: 90, hygiene: 90, curiosity: 90, bond: 60, energy: 60 } });
    pet.goDraw();
    runUntil(pet, (p) => p.activity.type === 'drawing', 60);
    pet.update(4);
    const progress = pet.currentDrawing.progress;
    savePet(pet, storage, NOW);
    const threeDays = 3 * 24 * 3600 * 1000;
    const { pet: back, away } = loadPet(storage, { now: NOW + threeDays, clock: fixedClock });
    assert.equal(away.appliedSeconds, AWAY.capSeconds, 'at most 8 h are simulated');
    assert.equal(away.capped, true);
    for (const k of ['hunger', 'hygiene', 'curiosity', 'bond']) assert.ok(back.needs[k] >= AWAY.floor, `${k} floor`);
    assert.match(away.text, /Welcome back/);
    assert.notEqual(back.activity.type, 'drawing', 'a stale drawing session is not resumed');
    assert.equal(back.currentDrawing.complete, false, 'the unfinished drawing was not completed while away');
    assert.ok(Math.abs(back.currentDrawing.progress - progress) < 0.01);
    assert.equal(back.counters.drawings, 0);
  });

  test('a short absence resumes the unfinished activity where it left off', () => {
    const storage = new MemoryStorage();
    const pet = makePet();
    pet.goPlayMusic();
    runUntil(pet, (p) => p.activity.type === 'playing_music', 60);
    pet.update(2);
    const elapsed = pet.activity.elapsed;
    savePet(pet, storage, NOW);
    const { pet: back } = loadPet(storage, { now: NOW + 5 * 60 * 1000, clock: fixedClock });
    assert.equal(back.activity.type, 'playing_music');
    assert.ok(Math.abs(back.activity.elapsed - elapsed) < 0.01);
  });

  test('a pet that was asleep keeps resting while away', () => {
    const storage = new MemoryStorage();
    const pet = makePet({ needs: { energy: 20 } });
    pet.sleep();
    runUntil(pet, (p) => p.isAsleep, 60);
    savePet(pet, storage, NOW);
    const { pet: back, away } = loadPet(storage, { now: NOW + 10 * 60 * 1000, clock: fixedClock });
    assert.ok(back.needs.energy > 90, `energy ${back.needs.energy}`);
    assert.ok(away.deltas.energy > 0);
  });
});
