'use strict';
/**
 * Hollowmere House — the floor plan.
 *
 * An original 24×24 plan in the spirit of the classic board: nine rooms round
 * the edge, corridors between them walked square by square, a locked stairwell
 * in the middle where the envelope waits, and six starting squares on the edge
 * of the house. Everything that moves a pawn goes through this file.
 *
 * Coordinates are [x, y], x across, y down, both 0–23.
 * Graph keys: a corridor square is "x,y"; a room is "r:<id>".
 */

const W = 24, H = 24;

/** Rooms as inclusive rectangles [x0, y0, x1, y1]. */
const ROOM_RECTS = {
  study:        [0, 0, 5, 4],
  hall:         [9, 0, 14, 6],
  lounge:       [18, 0, 23, 5],
  library:      [0, 7, 5, 11],
  dining:       [17, 9, 23, 15],
  billiard:     [0, 14, 5, 18],
  conservatory: [0, 20, 6, 23],
  ballroom:     [8, 17, 15, 23],
  kitchen:      [18, 18, 23, 23]
};

/** The stairwell. Nobody walks through it; the envelope lives here. */
const CENTRE = [9, 9, 14, 14];

/** Doors: the corridor square you stand on to step into the room. */
const DOORS = [
  ['study', 6, 3], ['study', 3, 5],
  ['hall', 8, 4], ['hall', 15, 4], ['hall', 11, 7], ['hall', 12, 7],
  ['lounge', 17, 4], ['lounge', 19, 6],
  ['library', 6, 8], ['library', 4, 12],
  ['dining', 16, 11], ['dining', 19, 8], ['dining', 18, 16],
  ['billiard', 2, 13], ['billiard', 6, 16],
  ['conservatory', 4, 19], ['conservatory', 7, 21],
  ['ballroom', 10, 16], ['ballroom', 13, 16], ['ballroom', 7, 19], ['ballroom', 16, 20],
  ['kitchen', 20, 17], ['kitchen', 17, 21]
];

/** Where each character waits when the evening begins — on the edge, outside every room. */
const STARTS = {
  vale: [7, 0], cross: [16, 0], thorne: [23, 7],
  snow: [23, 16], ward: [7, 23], ashe: [0, 12]
};

/** Opposite corners, joined by passages behind the panelling. */
const PASSAGES = { study: 'kitchen', kitchen: 'study', lounge: 'conservatory', conservatory: 'lounge' };

// ------------------------------------------------------------ the grid

const inRect = (x, y, r) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];

/** Every square: 'corridor' | 'void' | 'centre' | 'room:<id>'. */
const GRID = [];
for (let y = 0; y < H; y++) {
  const row = [];
  for (let x = 0; x < W; x++) {
    let t = 'corridor';
    for (const [id, r] of Object.entries(ROOM_RECTS)) if (inRect(x, y, r)) t = 'room:' + id;
    if (inRect(x, y, CENTRE)) t = 'centre';
    // The outer ring of corridor is the house wall — except the six doorsteps
    // where the guests begin.
    const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1;
    const isStart = Object.values(STARTS).some(([sx, sy]) => sx === x && sy === y);
    if (t === 'corridor' && edge && !isStart) t = 'void';
    row.push(t);
  }
  GRID.push(row);
}

const key = (x, y) => x + ',' + y;
const unkey = k => k.split(',').map(Number);
const isCorridor = (x, y) => x >= 0 && y >= 0 && x < W && y < H && GRID[y][x] === 'corridor';

/** Corridor square -> the room its door leads into. */
const DOOR_AT = {};
/** Room -> the corridor squares outside its doors. */
const DOORS_OF = {};
for (const [room, x, y] of DOORS) {
  DOOR_AT[key(x, y)] = room;
  (DOORS_OF[room] = DOORS_OF[room] || []).push(key(x, y));
}

/** Neighbours of a graph node, ignoring who is standing where. */
function neighbours(node) {
  if (node.startsWith('r:')) return (DOORS_OF[node.slice(2)] || []).slice();
  const [x, y] = unkey(node);
  const out = [];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (isCorridor(x + dx, y + dy)) out.push(key(x + dx, y + dy));
  }
  if (DOOR_AT[node]) out.push('r:' + DOOR_AT[node]);
  return out;
}

/** A player's position as a graph node. */
function nodeOf(p) { return p.room ? 'r:' + p.room : key(p.cell[0], p.cell[1]); }

/**
 * Everywhere a pawn can finish this turn, having rolled `steps`.
 *
 *   - Up to `steps` squares, one at a time, no diagonals.
 *   - Occupied corridor squares cannot be entered or passed through.
 *   - Stepping into a room ends the move, whatever is left on the dice.
 *   - You cannot walk out of a room and straight back into it.
 *
 * Returns { dist, parent } keyed by node, excluding the starting node.
 */
function reach(from, steps, blocked) {
  const dist = { [from]: 0 };
  const parent = {};
  let edge = [from];
  for (let d = 1; d <= steps && edge.length; d++) {
    const next = [];
    for (const n of edge) {
      if (n !== from && n.startsWith('r:')) continue;        // rooms end the walk
      for (const m of neighbours(n)) {
        if (dist[m] !== undefined) continue;
        if (m === from) continue;
        if (!m.startsWith('r:') && blocked.has(m)) continue;
        dist[m] = d; parent[m] = n; next.push(m);
      }
    }
    edge = next;
  }
  delete dist[from];
  return { dist, parent };
}

/** The route from the start of a reach() to `target`, start included. */
function pathTo(parent, from, target) {
  const out = [target];
  let n = target;
  while (n !== from && parent[n]) { n = parent[n]; out.push(n); }
  return out.reverse();
}

/**
 * How many steps from every square to being inside `room`, ignoring pawns.
 * Used to steer: "head towards the Library".
 */
const DIST_CACHE = {};
function distanceTo(room) {
  if (DIST_CACHE[room]) return DIST_CACHE[room];
  const target = 'r:' + room;
  const dist = { [target]: 0 };
  let edge = [target];
  while (edge.length) {
    const next = [];
    for (const n of edge) {
      if (n !== target && n.startsWith('r:')) continue;      // do not route through other rooms
      for (const m of neighbours(n)) {
        if (dist[m] !== undefined) continue;
        dist[m] = dist[n] + 1; next.push(m);
      }
    }
    edge = next;
  }
  return (DIST_CACHE[room] = dist);
}

/** Steps from a node to inside `room`; a room-to-room trip leaves by its best door. */
function stepsBetween(node, room) {
  const d = distanceTo(room);
  if (node.startsWith('r:')) {
    if (node === 'r:' + room) return 0;
    const doors = DOORS_OF[node.slice(2)] || [];
    let best = Infinity;
    for (const dk of doors) if (d[dk] !== undefined) best = Math.min(best, d[dk] + 1);
    return best;
  }
  return d[node] === undefined ? Infinity : d[node];
}

/** Everything a screen needs to draw the house. */
function layout() {
  return {
    w: W, h: H, rooms: ROOM_RECTS, centre: CENTRE, starts: STARTS,
    passages: PASSAGES,
    doors: DOORS.map(([room, x, y]) => {
      // which side of the room the door is on, for drawing the threshold
      const r = ROOM_RECTS[room];
      const side = x < r[0] ? 'w' : x > r[2] ? 'e' : y < r[1] ? 'n' : 's';
      return { room, x, y, side };
    }),
    grid: GRID.map(row => row.map(t => t === 'corridor' ? 1 : t === 'void' ? 0 : t === 'centre' ? 2 : 3))
  };
}

module.exports = {
  W, H, ROOM_RECTS, CENTRE, DOORS, DOORS_OF, DOOR_AT, STARTS, PASSAGES, GRID,
  key, unkey, isCorridor, neighbours, nodeOf, reach, pathTo, distanceTo, stepsBetween, layout
};
