/**
 * studio-layout.js — shared floor plan of the miniature studio diorama.
 *
 * Pure data + tiny geometry helpers (no DOM, no Three.js) so that the
 * deterministic simulation (pet-state.js), the renderer (studio-scene.js)
 * and the Node test-suite all agree on where every station lives.
 *
 * Coordinate system ("studio units", roughly metres for a toy-sized room):
 *   x → right, y → up, z → toward the open front of the diorama.
 *   The back wall sits at z = -ROOM.half and the left wall at x = -ROOM.half;
 *   the front and right sides are open so the camera can look in.
 *   Yaw / heading 0 faces +z (toward the viewer); yaw = atan2(dx, dz).
 */

export const ROOM = Object.freeze({
  half: 3.2, // floor spans [-3.2, 3.2] on x and z
  wallHeight: 2.7,
  wallThickness: 0.2,
  floorThickness: 0.42,
  /** The pet's centre stays inside these bounds while walking. */
  walk: Object.freeze({ minX: -2.75, maxX: 2.8, minZ: -2.75, maxZ: 2.75 }),
});

/** Paths bow toward this point so the pet walks around furniture on the walls. */
export const ROOM_CENTER = Object.freeze({ x: 0.15, z: 0.35 });

const deg = (d) => (d * Math.PI) / 180;

/**
 * Stations the pet can walk to and use.
 *  - `center`    visual centre of the furniture (camera focus, hover ring)
 *  - `entry`     optional waypoints walked just before the approach point
 *  - `approach`  where walking ends
 *  - `anchor`    where the pet sits/stands while using the station (a short hop
 *                is animated when it differs from `approach`, e.g. into the tub)
 *  - `elevation` how high the pet's feet are while using it (cushion, tub floor)
 *  - `facing`    yaw used during the activity
 */
export const STATIONS = Object.freeze({
  rug: Object.freeze({
    id: 'rug', label: 'Cozy Rug', short: 'Rug', activity: 'listening', icon: 'listen',
    center: { x: 0.2, z: 0.45 }, approach: { x: 0.2, z: 0.5 }, anchor: { x: 0.2, z: 0.5 },
    elevation: 0, facing: deg(40),
  }),
  food: Object.freeze({
    id: 'food', label: 'Snack Bar', short: 'Snacks', activity: 'eating', icon: 'food',
    center: { x: 2.2, z: 0.55 }, approach: { x: 1.42, z: 0.72 }, anchor: { x: 1.42, z: 0.72 },
    elevation: 0, facing: deg(102),
  }),
  bath: Object.freeze({
    id: 'bath', label: 'Bubble Bath', short: 'Bath', activity: 'bathing', icon: 'bath',
    center: { x: -1.95, z: 2.1 }, approach: { x: -0.72, z: 1.95 }, anchor: { x: -1.85, z: 2.12 },
    elevation: 0.2, facing: deg(38),
  }),
  bed: Object.freeze({
    id: 'bed', label: 'Sleep Nook', short: 'Bed', activity: 'sleeping', icon: 'sleep',
    center: { x: -2.2, z: -2.2 }, approach: { x: -1.25, z: -1.3 }, anchor: { x: -2.15, z: -2.12 },
    elevation: 0.27, facing: deg(42),
  }),
  music: Object.freeze({
    id: 'music', label: 'Music Corner', short: 'Music', activity: 'playing_music', icon: 'music',
    center: { x: 1.3, z: -2.05 }, entry: Object.freeze([{ x: 0.42, z: -1.95 }]),
    approach: { x: 1.12, z: -2.62 }, anchor: { x: 1.12, z: -2.62 },
    elevation: 0, facing: deg(18),
  }),
  easel: Object.freeze({
    id: 'easel', label: 'Drawing Easel', short: 'Easel', activity: 'drawing', icon: 'draw',
    center: { x: -2.35, z: 0.05 }, approach: { x: -1.56, z: -0.36 }, anchor: { x: -1.56, z: -0.36 },
    elevation: 0, facing: deg(5), // body opens toward the room; the brush arm reaches sideways
    /** yaw of the canvas surface normal (the easel turns toward the camera) */
    canvasYaw: deg(64),
  }),
});

export const STATION_IDS = Object.freeze(Object.keys(STATIONS));

/** Which station hosts each station-bound activity. */
export const ACTIVITY_STATION = Object.freeze({
  eating: 'food',
  bathing: 'bath',
  sleeping: 'bed',
  playing_music: 'music',
  drawing: 'easel',
  listening: 'rug',
});

/** Open floor spots the pet idly wanders between. */
export const WANDER_SPOTS = Object.freeze([
  { x: -0.55, z: -0.35 }, { x: 0.85, z: -0.7 }, { x: 0.75, z: 1.45 }, { x: -0.7, z: 1.05 },
  { x: 0.05, z: -1.25 }, { x: 1.35, z: 1.85 }, { x: -0.3, z: 0.55 }, { x: 0.6, z: 0.3 },
]);

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function yawTowards(from, to) {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

export function clampToWalkable(p) {
  const w = ROOM.walk;
  return {
    x: Math.min(w.maxX, Math.max(w.minX, p.x)),
    z: Math.min(w.maxZ, Math.max(w.minZ, p.z)),
  };
}

/**
 * Plans a short list of waypoints from `from` to `to`. Long walks bow toward
 * the middle of the room so the pet passes around furniture placed along the
 * walls; optional `entry` waypoints guide it around a station (e.g. behind the
 * keyboard). Deterministic and allocation-light.
 */
export function planPath(from, to, entry = []) {
  const waypoints = [];
  const first = entry.length ? entry[0] : to;
  if (distance(from, first) > 1.7) {
    const mid = { x: (from.x + first.x) / 2, z: (from.z + first.z) / 2 };
    waypoints.push(clampToWalkable({
      x: mid.x + (ROOM_CENTER.x - mid.x) * 0.55,
      z: mid.z + (ROOM_CENTER.z - mid.z) * 0.55,
    }));
  }
  for (const e of entry) {
    if (distance(from, e) > 0.2) waypoints.push({ x: e.x, z: e.z });
  }
  waypoints.push({ x: to.x, z: to.z });
  return waypoints;
}

// ---------------------------------------------------------------------------
// Visiting friends (Iteration 4)
// ---------------------------------------------------------------------------
/** The easel spot mirrors the host's painting spot across the canvas normal (the visitor paints left-handed). */
function mirrorAcrossEasel() {
  const E = STATIONS.easel;
  const yaw = E.canvasYaw;
  const lx = { x: Math.cos(yaw), z: -Math.sin(yaw) };
  const lz = { x: Math.sin(yaw), z: Math.cos(yaw) };
  const board = { x: E.center.x + 0.14 * lz.x, z: E.center.z + 0.14 * lz.z };
  const rx = E.anchor.x - board.x;
  const rz = E.anchor.z - board.z;
  const u = -(rx * lx.x + rz * lx.z) - 0.04;
  const v = rx * lz.x + rz * lz.z + 0.03;
  const r3 = (n) => Math.round(n * 1000) / 1000;
  // Mirrored, then opened a little toward the room so its face shows while it paints.
  const facing = Math.atan2(Math.sin(2 * yaw - E.facing - deg(15)), Math.cos(2 * yaw - E.facing - deg(15)));
  return { x: r3(board.x + u * lx.x + v * lz.x), z: r3(board.z + u * lx.z + v * lz.z), facing: Math.round(facing * 1e4) / 1e4 };
}

/** Where a visiting friend stands: arrival, hanging out, and its spots for a jam and a co-draw. */
export const VISIT_SPOTS = Object.freeze({
  /** Visitors arrive at and leave from the open front-right corner of the diorama. */
  door: Object.freeze({ x: 2.5, z: 2.45 }),
  /** Open floor where a visitor hangs out between sessions (picked away from the host and out of the shot). */
  hangout: Object.freeze([
    Object.freeze({ x: 1.0, z: 2.3 }), Object.freeze({ x: 1.95, z: 1.9 }), Object.freeze({ x: -0.05, z: 2.4 }), Object.freeze({ x: 1.95, z: -0.55 }),
  ]),
  /** Behind its toy xylophone, to the right of the studio keyboard. */
  jam: Object.freeze({ x: 2.35, z: -2.05, facing: deg(-30) }),
  /** The other side of the easel from the host. */
  codraw: Object.freeze(mirrorAcrossEasel()),
});

/** The visitor's toy xylophone stands just in front of its jam spot (only while a friend visits). */
export const XYLOPHONE = Object.freeze({
  x: Math.round((VISIT_SPOTS.jam.x + 0.42 * Math.sin(VISIT_SPOTS.jam.facing)) * 1000) / 1000,
  z: Math.round((VISIT_SPOTS.jam.z + 0.42 * Math.cos(VISIT_SPOTS.jam.facing)) * 1000) / 1000,
  yaw: VISIT_SPOTS.jam.facing,
  /** Bars, low to high (the player's left to right). */
  bars: Object.freeze([60, 62, 64, 67, 69, 72, 74, 76, 79, 81]),
});

/** The xylophone bar that plays a MIDI note (nearest pitch). */
export function xylophoneBar(midi) {
  let best = 0;
  XYLOPHONE.bars.forEach((m, i) => {
    if (Math.abs(m - midi) < Math.abs(XYLOPHONE.bars[best] - midi)) best = i;
  });
  return best;
}

/** Station whose anchor/approach is closest to `p` (used for idle bookkeeping). */
export function nearestStation(p, maxDist = 0.6) {
  let best = null;
  let bestD = maxDist;
  for (const id of STATION_IDS) {
    const st = STATIONS[id];
    const d = Math.min(distance(p, st.anchor), distance(p, st.approach));
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}
