/**
 * rng.js — tiny deterministic random helpers shared by the simulation and the
 * authored starter generators. Seeded PRNGs make behaviour reproducible in
 * tests and diagnostics (same seed + same inputs = same output).
 */

/** mulberry32 step. Returns [value in [0,1), nextState]. */
export function mulberry32Step(state) {
  const next = (state + 0x6d2b79f5) >>> 0;
  let r = Math.imul(next ^ (next >>> 15), 1 | next);
  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
  return [((r ^ (r >>> 14)) >>> 0) / 4294967296, next];
}

/** Hashes any number/string into a uint32 seed (FNV-1a). */
export function hashSeed(input) {
  const s = String(input);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Convenience wrapper with range/int/pick/weighted helpers. */
export function createRng(seed) {
  let state = seed >>> 0;
  const next = () => {
    const [v, s] = mulberry32Step(state);
    state = s;
    return v;
  };
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (list) => list[Math.floor(next() * list.length) % list.length],
    /** Gaussian-ish noise in roughly [-1, 1] (sum of uniforms). */
    noise: () => (next() + next() + next() - 1.5) / 1.5,
    /** Picks a key of `weights` proportionally to its (non-negative) weight. */
    weighted(weights) {
      const entries = Object.entries(weights).filter(([, w]) => w > 0);
      const total = entries.reduce((a, [, w]) => a + w, 0);
      let r = next() * total;
      for (const [k, w] of entries) {
        r -= w;
        if (r <= 0) return k;
      }
      return entries.length ? entries[entries.length - 1][0] : null;
    },
    get state() {
      return state;
    },
  };
}
