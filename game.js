'use strict';
const BOARD = require('./board');
const { PASSAGES } = BOARD;
/**
 * A Game of Consequence — rules engine.
 *
 * This file is the only place the solution exists. Nothing here writes to a
 * socket; the server asks for publicState() or privateState(pid) and sends
 * exactly what it is given. Keeping the split in one file means there is a
 * single place to audit for leaks.
 */

// --------------------------------------------------------------- the cast

const SUSPECTS = [
  { id: 'thorne', name: 'Major Aldous Thorne', initials: 'AT', colour: '#c8a22a',
    epithet: 'Retired, and far too calm', portrait: 'mustard' },
  { id: 'cross',  name: 'Miss Vivienne Cross', initials: 'VC', colour: '#b3243c',
    epithet: 'Arrived late. Left earlier.', portrait: 'scarlett' },
  { id: 'vale',   name: 'Professor Edmund Vale', initials: 'EV', colour: '#6d4a9e',
    epithet: 'Knows the house better than its owner', portrait: 'plum' },
  { id: 'ashe',   name: 'Lady Rosalind Ashe', initials: 'RA', colour: '#2f7f8f',
    epithet: 'Never once without an alibi', portrait: 'peacock' },
  { id: 'ward',   name: 'Mr Cassius Ward', initials: 'CW', colour: '#3f7d44',
    epithet: 'Owed the deceased a great deal', portrait: 'green' },
  { id: 'snow',   name: 'Mrs Harriet Snow', initials: 'HS', colour: '#b9b3a6',
    epithet: 'Has kept this house for thirty years', portrait: 'white' }
];

const WEAPONS = [
  { id: 'candlestick', name: 'The Candlestick' },
  { id: 'opener',      name: 'The Letter Opener' },
  { id: 'pipe',        name: 'The Lead Pipe' },
  { id: 'revolver',    name: 'The Service Revolver' },
  { id: 'cord',        name: 'The Silk Cord' },
  { id: 'spanner',     name: 'The Spanner' }
];

/**
 * Nine rooms round the edge of Hollowmere House. Their walls, doors and the
 * corridors between them live in board.js; this is just their names.
 */
const ROOMS = [
  { id: 'study',        name: 'The Study' },
  { id: 'hall',         name: 'The Hall' },
  { id: 'lounge',       name: 'The Lounge' },
  { id: 'library',      name: 'The Library' },
  { id: 'dining',       name: 'The Dining Room' },
  { id: 'billiard',     name: 'The Billiard Room' },
  { id: 'conservatory', name: 'The Conservatory' },
  { id: 'ballroom',     name: 'The Ballroom' },
  { id: 'kitchen',      name: 'The Kitchen' }
];

const ROOM_BY_ID = Object.fromEntries(ROOMS.map(r => [r.id, r]));

const CARD = {};
SUSPECTS.forEach(s => CARD[s.id] = { id: s.id, kind: 'suspect', name: s.name });
WEAPONS.forEach(w => CARD[w.id] = { id: w.id, kind: 'weapon', name: w.name });
ROOMS.forEach(r => CARD[r.id] = { id: r.id, kind: 'room', name: r.name });

// ------------------------------------------------------------------ helpers

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// -------------------------------------------------------------------- game

class Game {
  /** @param {() => number} rng injected so tests can be deterministic. */
  constructor(rng = Math.random) {
    this.rng = rng;
    this.code = '';
    for (let i = 0; i < 4; i++) this.code += 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(rng() * 24)];
    this.reset();
  }

  reset() {
    this.phase = 'lobby';          // lobby | play | over
    this.players = [];             // seating order
    this.solution = null;          // never leaves this object until 'over'
    this.turn = 0;                 // index into players
    this.round = 1;
    this.turnPhase = 'roll';       // roll | move | action | disprove | reveal
    this.die = null;
    this.dice = null;              // [a, b]
    this.reachable = null;         // { dist, parent, from } while choosing where to walk
    this.enteredRoom = false;      // walked, passaged or stayed into a room this turn
    this.lastMove = null;          // { pid, path, kind, seq } for the projector to animate
    this.moveSeq = 0;
    this.hasSuggested = false;
    this.suggestion = null;
    this.disproveQueue = [];
    this.pendingShow = null;       // { to, by, card }
    this.reveal = null;            // { kind, by, solution? }
    this.awaitingAck = null;       // pid who must tap Continue
    this.winner = null;
    this.log = [];                 // public narration for the big screen
  }

  // ------------------------------------------------------------ the lobby

  addPlayer(name) {
    if (this.phase !== 'lobby') return { error: 'The game has already started.' };
    // A real person outranks a stand-in: if the table is full of bots, one
    // steps aside rather than turning someone away at the door.
    if (this.players.length >= 6) {
      const lastBot = [...this.players].reverse().find(p => p.isBot);
      if (lastBot) this.players.splice(this.players.indexOf(lastBot), 1);
    }
    if (this.players.length >= 6) return { error: 'All six seats are taken.' };
    const clean = String(name || '').trim().slice(0, 18);
    if (!clean) return { error: 'Give us a name to call you.' };
    const player = {
      id: 'p' + (this.players.length + 1) + Math.floor(this.rng() * 1e6).toString(36),
      name: clean, charId: null, room: null, cell: null, dragged: false, hand: [], notes: {}, grid: {},
      eliminated: false, connected: true
    };
    this.players.push(player);
    return { player };
  }

  /**
   * A stand-in detective, so a short-handed table can still play. Takes the
   * first free character and is otherwise an ordinary player — dealt a real
   * hand, obliged to disprove, able to win.
   */
  addBot() {
    if (this.phase !== 'lobby') return { error: 'The game has already started.' };
    if (this.players.length >= 6) return { error: 'All six seats are taken.' };
    const taken = new Set(this.players.map(p => p.charId));
    const free = SUSPECTS.find(s => !taken.has(s.id));
    if (!free) return { error: 'Every character is spoken for.' };

    const player = {
      id: 'b' + (this.players.length + 1) + Math.floor(this.rng() * 1e6).toString(36),
      name: free.name.split(' ').slice(-1)[0],
      charId: free.id, room: null, cell: null, dragged: false, hand: [], notes: {}, grid: {},
      eliminated: false, connected: true,
      isBot: true,
      botShown: {}   // asker pid -> card already shown them, to leak as little as possible
    };
    this.players.push(player);
    return { player };
  }

  player(pid) { return this.players.find(p => p.id === pid) || null; }

  claim(pid, charId) {
    if (this.phase !== 'lobby') return { error: 'Too late to change your mind.' };
    const me = this.player(pid);
    if (!me) return { error: 'We have lost track of you.' };
    if (!SUSPECTS.some(s => s.id === charId)) return { error: 'No such person.' };
    const taken = this.players.find(p => p.charId === charId && p.id !== pid);
    if (taken) return { error: `${taken.name} is already playing them.` };
    me.charId = charId;
    return {};
  }

  canStart() {
    const ready = this.players.filter(p => p.charId);
    return ready.length >= 3 && ready.length === this.players.length;
  }

  /** Host-only. Deals the cards and puts everyone on the board. */
  start() {
    if (this.phase !== 'lobby') return { error: 'Already under way.' };
    if (!this.canStart()) return { error: 'Three or more players, and everyone must pick a character.' };

    const suspect = SUSPECTS[Math.floor(this.rng() * SUSPECTS.length)].id;
    const weapon  = WEAPONS[Math.floor(this.rng() * WEAPONS.length)].id;
    const room    = ROOMS[Math.floor(this.rng() * ROOMS.length)].id;
    this.solution = { suspect, weapon, room };

    const deck = shuffle([
      ...SUSPECTS.map(s => s.id).filter(id => id !== suspect),
      ...WEAPONS.map(w => w.id).filter(id => id !== weapon),
      ...ROOMS.map(r => r.id).filter(id => id !== room)
    ], this.rng);

    // Seat in character order so the table reads consistently on the screen.
    this.players.sort((a, b) =>
      SUSPECTS.findIndex(s => s.id === a.charId) - SUSPECTS.findIndex(s => s.id === b.charId));

    this.players.forEach((p, i) => {
      p.hand = deck.filter((_, k) => k % this.players.length === i);
      // Everyone begins on their doorstep at the edge of the house.
      p.room = null;
      p.cell = BOARD.STARTS[p.charId].slice();
      p.dragged = false;
      p.notes = {};
      p.grid = {};
      p.hand.forEach(c => { p.notes[c] = 'have'; });
    });

    // Where the weapons are lying. Cosmetic, but the screen feels dead without it.
    this.weaponAt = {};
    const spots = shuffle(ROOMS.map(r => r.id), this.rng);
    WEAPONS.forEach((w, i) => { this.weaponAt[w.id] = spots[i % spots.length]; });

    this.phase = 'play';
    this.turn = 0;
    this.round = 1;
    this.turnPhase = 'roll';
    this.say(`The doors are locked. ${this.nameOf(this.current().id)} moves first.`);
    return {};
  }

  // ------------------------------------------------------------- the turn

  current() { return this.players[this.turn]; }

  nameOf(pid) {
    const p = this.player(pid);
    if (!p) return 'Someone';
    return p.charId ? SUSPECTS.find(s => s.id === p.charId).name : p.name;
  }

  say(line) {
    this.log.push({ at: Date.now(), line });
    if (this.log.length > 40) this.log.shift();
  }

  /** Guard shared by every in-turn action. */
  mustBeCurrent(pid, phase) {
    if (this.phase !== 'play') return 'The game is not running.';
    if (this.awaitingAck) return 'Wait — something is on the big screen.';
    const me = this.player(pid);
    if (!me) return 'We have lost track of you.';
    if (this.current().id !== pid) return 'It is not your turn.';
    if (phase && this.turnPhase !== phase) return 'Not just now.';
    return null;
  }

  /** Corridor squares other pawns are standing on. */
  blockedFor(pid) {
    const set = new Set();
    for (const p of this.players) if (p.id !== pid && p.cell) set.add(BOARD.key(p.cell[0], p.cell[1]));
    return set;
  }

  where(p) { return p.room ? ROOM_BY_ID[p.room].name : 'the corridor'; }

  roll(pid) {
    const bad = this.mustBeCurrent(pid, 'roll');
    if (bad) return { error: bad };
    const me = this.current();
    this.dice = [1 + Math.floor(this.rng() * 6), 1 + Math.floor(this.rng() * 6)];
    this.die = this.dice[0] + this.dice[1];
    const from = BOARD.nodeOf(me);
    const { dist, parent } = BOARD.reach(from, this.die, this.blockedFor(pid));
    this.reachable = { dist, parent, from };
    this.say(`${this.nameOf(pid)} rolls ${this.dice[0]} and ${this.dice[1]} — ${this.die}.`);
    if (!Object.keys(dist).length) {
      // Every door is blocked. It happens; the turn carries on where they stand.
      this.reachable = null;
      this.turnPhase = 'action';
      this.enteredRoom = false;
      this.say(`${this.nameOf(pid)} is boxed in and cannot move.`);
      return {};
    }
    this.turnPhase = 'move';
    return {};
  }

  /** Corner rooms: slip through the passage instead of rolling. */
  passage(pid) {
    const bad = this.mustBeCurrent(pid, 'roll');
    if (bad) return { error: bad };
    const me = this.current();
    const to = me.room && PASSAGES[me.room];
    if (!to) return { error: 'There is no passage from here.' };
    const from = me.room;
    me.room = to; me.cell = null;
    this.enteredRoom = true;
    this.turnPhase = 'action';
    this.hasSuggested = false;
    this.lastMove = { pid, path: ['r:' + from, 'r:' + to], kind: 'passage', seq: ++this.moveSeq };
    this.say(`${this.nameOf(pid)} slips through the secret passage into ${ROOM_BY_ID[to].name}.`);
    return {};
  }

  /** Dragged into a room by someone else's suggestion: you may stay and suggest. */
  stay(pid) {
    const bad = this.mustBeCurrent(pid, 'roll');
    if (bad) return { error: bad };
    const me = this.current();
    if (!me.room || !me.dragged) return { error: 'You can only stay if you were brought here by a suggestion.' };
    this.enteredRoom = true;
    this.turnPhase = 'action';
    this.hasSuggested = false;
    this.say(`${this.nameOf(pid)} stays in ${ROOM_BY_ID[me.room].name}.`);
    return {};
  }

  /** Walk to a square ("x,y") or into a room ("r:id" or a bare room id). */
  move(pid, target) {
    const bad = this.mustBeCurrent(pid, 'move');
    if (bad) return { error: bad };
    if (ROOM_BY_ID[target]) target = 'r:' + target;
    const r = this.reachable;
    if (!r || r.dist[target] === undefined) return { error: 'You cannot get there with that roll.' };
    const me = this.current();
    const path = BOARD.pathTo(r.parent, r.from, target);
    if (target.startsWith('r:')) { me.room = target.slice(2); me.cell = null; }
    else { me.room = null; me.cell = BOARD.unkey(target); }
    this.enteredRoom = !!me.room;
    this.reachable = null;
    this.turnPhase = 'action';
    this.hasSuggested = false;
    this.lastMove = { pid, path, kind: 'walk', seq: ++this.moveSeq };
    if (me.room) this.say(`${this.nameOf(pid)} enters ${ROOM_BY_ID[me.room].name}.`);
    else this.say(`${this.nameOf(pid)} walks ${path.length - 1} squares down the corridor.`);
    return {};
  }

  /** The square or room, within this roll, that gets closest to `roomId`. */
  bestToward(roomId) {
    const r = this.reachable;
    if (!r || !ROOM_BY_ID[roomId]) return null;
    if (r.dist['r:' + roomId] !== undefined) return 'r:' + roomId;
    let best = null, bestD = Infinity;
    for (const n of Object.keys(r.dist)) {
      if (n.startsWith('r:')) continue;                 // stepping into another room ends the trip
      const d = BOARD.stepsBetween(n, roomId);
      if (d < bestD || (d === bestD && r.dist[n] > r.dist[best])) { best = n; bestD = d; }
    }
    return best;
  }

  toward(pid, roomId) {
    const bad = this.mustBeCurrent(pid, 'move');
    if (bad) return { error: bad };
    const t = this.bestToward(roomId);
    if (!t) return { error: 'Nowhere to go.' };
    return this.move(pid, t);
  }

  /** Test helper: put a pawn straight into a room as though they had walked in. */
  placeForTest(pid, roomId) {
    const me = this.player(pid);
    me.room = roomId; me.cell = null;
    this.enteredRoom = true; this.reachable = null;
    this.turnPhase = 'action'; this.hasSuggested = false;
  }

  suggest(pid, suspectId, weaponId) {
    const bad = this.mustBeCurrent(pid, 'action');
    if (bad) return { error: bad };
    if (this.hasSuggested) return { error: 'You have already put a suggestion to the table.' };
    if (!this.current().room) return { error: 'You can only make a suggestion inside a room.' };
    if (!this.enteredRoom) return { error: 'You have to enter a room this turn to make a suggestion there.' };
    if (!CARD[suspectId] || CARD[suspectId].kind !== 'suspect') return { error: 'No such person.' };
    if (!CARD[weaponId] || CARD[weaponId].kind !== 'weapon') return { error: 'No such weapon.' };

    const me = this.current();
    const room = me.room;
    this.hasSuggested = true;

    // The named person and weapon are drawn into the room, as at the table.
    const dragged = this.players.find(p => p.charId === suspectId && p.id !== pid);
    if (dragged && dragged.room !== room) {
      dragged.room = room; dragged.cell = null; dragged.dragged = true;
      this.lastMove = { pid: dragged.id, path: [], kind: 'summoned', seq: ++this.moveSeq };
    }
    this.weaponAt[weaponId] = room;

    this.suggestion = { suggesterId: pid, suspect: suspectId, weapon: weaponId, room };
    this.say(`${this.nameOf(pid)} suggests ${CARD[suspectId].name}, with ${CARD[weaponId].name}, in ${ROOM_BY_ID[room].name}.`);

    // Everyone else, clockwise. Eliminated players still hold cards and still answer.
    this.disproveQueue = [];
    for (let k = 1; k < this.players.length; k++) {
      this.disproveQueue.push(this.players[(this.turn + k) % this.players.length].id);
    }
    this.turnPhase = 'disprove';
    this.advanceDisprove();
    return {};
  }

  /** Walks the queue until someone can answer, or nobody can. */
  advanceDisprove() {
    const s = this.suggestion;
    while (this.disproveQueue.length) {
      const pid = this.disproveQueue[0];
      const p = this.player(pid);
      const options = [s.suspect, s.weapon, s.room].filter(c => p.hand.includes(c));
      if (options.length) { this.askingPid = pid; return; }
      this.say(`${this.nameOf(pid)} cannot answer.`);
      // Everyone at the table just saw that; mark it on every notepad, as a
      // careful player would with a pencil.
      for (const other of this.players) {
        if (other.id === pid) continue;
        for (const c of [s.suspect, s.weapon, s.room]) this.pencil(other, c, pid, 'no', false);
      }
      this.disproveQueue.shift();
    }
    // Nobody could disprove it. That is the loudest moment in the game.
    this.askingPid = null;
    this.reveal = { kind: 'unchallenged', by: s.suggesterId };
    this.awaitingAck = s.suggesterId;
    this.turnPhase = 'reveal';
    this.say('Nobody can disprove it.');
  }

  disprove(pid, cardId) {
    if (this.turnPhase !== 'disprove') return { error: 'Nothing to answer.' };
    if (this.askingPid !== pid) return { error: 'Not your card to show.' };
    const p = this.player(pid);
    const s = this.suggestion;
    const legal = [s.suspect, s.weapon, s.room].filter(c => p.hand.includes(c));
    if (!legal.includes(cardId)) return { error: 'You cannot show that one.' };

    this.pendingShow = { to: s.suggesterId, by: pid, card: cardId };
    const shown = this.player(s.suggesterId);
    if (shown.notes[cardId] !== 'have') shown.notes[cardId] = 'shown';
    this.pencil(shown, cardId, pid, 'yes', true);
    this.askingPid = null;
    this.disproveQueue = [];
    this.turnPhase = 'reveal';
    this.awaitingAck = s.suggesterId;
    this.reveal = { kind: 'disproved', by: pid, to: s.suggesterId };
    this.say(`${this.nameOf(pid)} shows ${this.nameOf(s.suggesterId)} a card. Privately.`);
    return {};
  }

  accuse(pid, suspectId, weaponId, roomId) {
    if (this.phase !== 'play') return { error: 'The game is not running.' };
    const bad = this.mustBeCurrent(pid);
    if (bad) return { error: bad };
    if (!['roll', 'action'].includes(this.turnPhase)) return { error: 'Finish your move first.' };
    if (!CARD[suspectId] || !CARD[weaponId] || !ROOM_BY_ID[roomId]) return { error: 'Name a person, a weapon and a room.' };
    const me = this.player(pid);
    const right = this.solution.suspect === suspectId
      && this.solution.weapon === weaponId
      && this.solution.room === roomId;

    this.say(`${this.nameOf(pid)} makes a formal accusation: ${CARD[suspectId].name}, with ${CARD[weaponId].name}, in ${ROOM_BY_ID[roomId].name}.`);

    if (right) {
      this.phase = 'over';
      this.winner = pid;
      this.turnPhase = 'reveal';
      this.reveal = { kind: 'solved', by: pid, solution: this.solution };
      this.say(`${this.nameOf(pid)} is right. The case is closed.`);
      return {};
    }

    me.eliminated = true;
    me.hasAccused = true;
    this.reveal = { kind: 'wrong', by: pid, accusation: { suspect: suspectId, weapon: weaponId, room: roomId } };
    this.awaitingAck = pid;
    this.turnPhase = 'reveal';
    this.say(`${this.nameOf(pid)} is wrong, and is out of the running.`);

    if (this.players.every(p => p.eliminated)) {
      this.phase = 'over';
      this.winner = null;
      this.reveal = { kind: 'nobody', solution: this.solution };
      this.awaitingAck = null;
      this.say('Everyone has guessed, and everyone was wrong. The murderer walks free.');
    }
    return {};
  }

  /** The Continue / Understood tap on a phone. */
  acknowledge(pid) {
    if (this.pendingShow && this.pendingShow.to === pid) {
      this.pendingShow = null;
      this.awaitingAck = null;
      this.reveal = null;
      this.turnPhase = 'action';   // they may still accuse, but not suggest again
      return {};
    }
    if (this.awaitingAck !== pid) return { error: 'Nothing waiting on you.' };
    const kind = this.reveal && this.reveal.kind;
    this.awaitingAck = null;
    this.reveal = null;
    if (kind === 'unchallenged') { this.turnPhase = 'action'; return {}; }
    // A wrong accusation ends that player's turn.
    this.nextTurn();
    return {};
  }

  endTurn(pid) {
    if (this.phase !== 'play') return { error: 'The game is not running.' };
    if (this.current().id !== pid) return { error: 'It is not your turn.' };
    if (this.turnPhase !== 'action') return { error: 'Not just now.' };
    this.nextTurn();
    return {};
  }

  nextTurn() {
    if (this.phase === 'over') return;
    this.suggestion = null;
    this.pendingShow = null;
    this.reveal = null;
    this.awaitingAck = null;
    this.die = null;
    this.dice = null;
    this.reachable = null;
    this.enteredRoom = false;
    if (this.players[this.turn]) this.players[this.turn].dragged = false;
    this.hasSuggested = false;
    this.turnPhase = 'roll';
    // Skip anyone out of the running; they still answer suggestions but take no turns.
    for (let k = 1; k <= this.players.length; k++) {
      const idx = (this.turn + k) % this.players.length;
      if (this.players[idx].eliminated) continue;
      if (idx <= this.turn) this.round++;   // once, only when the table wraps
      this.turn = idx;
      return;
    }
    this.phase = 'over';
    this.winner = null;
    this.reveal = { kind: 'nobody', solution: this.solution };
  }

  note(pid, cardId, value, col) {
    const p = this.player(pid);
    if (!p) return { error: 'We have lost track of you.' };
    if (!CARD[cardId]) return { error: 'No such card.' };
    if (!['', 'no', 'maybe', 'yes'].includes(value)) return { error: 'Bad mark.' };

    // A box on the detective notepad: this card, that player's column.
    if (col) {
      if (!this.player(col)) return { error: 'No such player.' };
      if (col === pid) return {};                    // your own column is your hand
      this.pencil(p, cardId, col, value, true);
      return {};
    }

    if (p.hand.includes(cardId)) return {};          // never overwrite 'have'
    if (value === '') delete p.notes[cardId]; else p.notes[cardId] = value;
    return {};
  }

  /** Writes one box on a player's notepad. Automatic marks never overwrite theirs. */
  pencil(p, cardId, col, value, force) {
    if (!p.grid) p.grid = {};
    const row = p.grid[cardId] || (p.grid[cardId] = {});
    if (!force && row[col]) return;
    if (value === '') delete row[col]; else row[col] = value;
  }

  // ------------------------------------------------------- stand-in play
  //
  // Every decision below is taken from publicState() and that bot's own
  // privateState() and nothing else. A bot therefore knows exactly what the
  // person holding that phone would know — it cannot see a hand, and it cannot
  // see the envelope. `test/rules.test.js` holds that constraint to account.

  /** Which bot, if any, is holding the table up, and how long to pause first. */
  botPending() {
    if (this.phase !== 'play') return null;

    // Someone must tap through a reveal. Give the room time to read it.
    if (this.awaitingAck) {
      const p = this.player(this.awaitingAck);
      if (p && p.isBot) return { pid: p.id, delay: 7000 };
      return null;
    }
    if (this.pendingShow) {
      const p = this.player(this.pendingShow.to);
      if (p && p.isBot) return { pid: p.id, delay: 4500 };
      return null;
    }
    if (this.turnPhase === 'disprove' && this.askingPid) {
      const p = this.player(this.askingPid);
      if (p && p.isBot) return { pid: p.id, delay: 4000 };
      return null;
    }
    const cur = this.current();
    if (cur && cur.isBot && ['roll', 'move', 'action'].includes(this.turnPhase)) {
      // Roll, walk, then think — each long enough for the room to read it.
      const delay = { roll: 3500, move: 3000, action: 4500 }[this.turnPhase];
      return { pid: cur.id, delay };
    }
    return null;
  }

  /** Takes one step for a bot. Returns true if the game moved. */
  runBot(pid) {
    const me = this.player(pid);
    if (!me || !me.isBot) return false;

    const pub = this.publicState();
    const priv = this.privateState(pid);
    if (!priv) return false;

    // Clear anything waiting on this bot first.
    if (priv.shownToYou || priv.awaitingYourAck) {
      this.acknowledge(pid);
      return true;
    }

    if (priv.mustDisprove) {
      const options = priv.mustDisprove.options;
      const asker = pub.suggestion && pub.suggestion.suggesterId;
      // Show the same person the same card again where possible: every fresh
      // card handed over is a fact given away.
      const repeat = options.find(c => me.botShown[asker] === c);
      const card = repeat || options[Math.floor(this.rng() * options.length)];
      me.botShown[asker] = card;
      return !this.disprove(pid, card).error;
    }

    if (!priv.isYourTurn) return false;

    // What this bot has not ruled out: not in its hand, never shown to it.
    const hand = priv.you.hand;
    const notes = priv.you.notes || {};
    const live = list => list.map(x => x.id)
      .filter(id => !hand.includes(id) && notes[id] !== 'shown');
    const s = live(SUSPECTS), w = live(WEAPONS), r = live(ROOMS);
    const certain = s.length === 1 && w.length === 1 && r.length === 1;

    // The nearest room still worth asking about — not the one it is already in.
    const here = BOARD.nodeOf(me);
    const target = () => {
      const pool = r.filter(id => id !== me.room);
      const choices = pool.length ? pool : ROOMS.map(x => x.id).filter(id => id !== me.room);
      return choices.sort((a, b) => BOARD.stepsBetween(here, a) - BOARD.stepsBetween(here, b))[0];
    };

    if (pub.turnPhase === 'roll') {
      if (certain) return !this.accuse(pid, s[0], w[0], r[0]).error;
      if (priv.canStay && r.includes(me.room)) return !this.stay(pid).error;
      if (priv.canPassage && r.includes(priv.passageTo)) return !this.passage(pid).error;
      return !this.roll(pid).error;
    }

    if (pub.turnPhase === 'move') {
      // Walk into any live room within reach; otherwise get as close as it can.
      const inReach = pub.reach.rooms.filter(id => r.includes(id) && id !== me.room);
      if (inReach.length) return !this.move(pid, 'r:' + inReach[0]).error;
      const t = this.bestToward(target());
      return !!t && !this.move(pid, t).error;
    }

    if (pub.turnPhase === 'action') {
      if (certain) return !this.accuse(pid, s[0], w[0], r[0]).error;
      if (priv.canSuggest && s.length && w.length) {
        // Rotate the guess — asking the same pair all night learns nothing.
        const pick = arr => arr[Math.floor(this.rng() * arr.length)];
        return !this.suggest(pid, pick(s), pick(w)).error;
      }
      return !this.endTurn(pid).error;
    }

    return false;
  }

  // ------------------------------------------------------------ the split

  /**
   * Safe for the projector and for every phone. Contains no hand, no token and
   * no solution — except once the game is over, when the envelope is opened.
   */
  publicState() {
    return {
      code: this.code,
      phase: this.phase,
      round: this.round,
      players: this.players.map(p => ({
        id: p.id, name: p.name, charId: p.charId, room: p.room, cell: p.cell,
        eliminated: !!p.eliminated, connected: !!p.connected,
        isBot: !!p.isBot,
        cardCount: p.hand.length
      })),
      currentPlayerId: this.phase === 'play' ? this.current().id : null,
      turnPhase: this.turnPhase,
      die: this.die,
      dice: this.dice,
      // Where the moving pawn could finish — public, as on a real board.
      reach: this.reachable ? {
        cells: Object.keys(this.reachable.dist).filter(k => !k.startsWith('r:')),
        rooms: Object.keys(this.reachable.dist).filter(k => k.startsWith('r:')).map(k => k.slice(2)),
        toward: Object.fromEntries(ROOMS.map(r => {
          const t = this.bestToward(r.id);
          return [r.id, t ? { target: t, left: BOARD.stepsBetween(t, r.id) } : null];
        }))
      } : null,
      lastMove: this.lastMove,
      weaponAt: this.weaponAt || {},
      suggestion: this.suggestion,
      askingPid: this.askingPid || null,
      // The card itself is never here — only that a card changed hands.
      reveal: this.reveal ? {
        kind: this.reveal.kind,
        by: this.reveal.by || null,
        to: this.reveal.to || null,
        accusation: this.reveal.accusation || null,
        solution: this.phase === 'over' ? this.reveal.solution || null : null
      } : null,
      winner: this.winner,
      waitingOn: this.waitingOn(),
      log: this.log.slice(-8),
      canStart: this.canStart()
    };
  }

  /** Who the whole table is waiting for right now, and what they must do. */
  waitingOn() {
    if (this.phase !== 'play') return null;
    if (this.awaitingAck) return { pid: this.awaitingAck, what: 'ack' };
    if (this.pendingShow) return { pid: this.pendingShow.to, what: 'read' };
    if (this.turnPhase === 'disprove' && this.askingPid) return { pid: this.askingPid, what: 'disprove' };
    return { pid: this.current().id, what: this.turnPhase };
  }

  /** One player's own view. Never sent anywhere but to that player's phone. */
  privateState(pid) {
    const me = this.player(pid);
    if (!me) return null;
    const s = this.suggestion;
    const asking = this.turnPhase === 'disprove' && this.askingPid === pid;
    return {
      you: {
        id: me.id, name: me.name, charId: me.charId,
        hand: me.hand.slice(), notes: Object.assign({}, me.notes),
        grid: JSON.parse(JSON.stringify(me.grid || {})),
        eliminated: !!me.eliminated
      },
      yourRoom: me.room,
      yourCell: me.cell,
      canPassage: this.phase === 'play' && this.current().id === pid && this.turnPhase === 'roll' && !!(me.room && PASSAGES[me.room]),
      passageTo: me.room ? PASSAGES[me.room] || null : null,
      canStay: this.phase === 'play' && this.current().id === pid && this.turnPhase === 'roll' && !!(me.room && me.dragged),
      canSuggest: this.phase === 'play' && this.current().id === pid && this.turnPhase === 'action' && !!me.room && this.enteredRoom && !this.hasSuggested,
      isYourTurn: this.phase === 'play' && this.current().id === pid,
      mustDisprove: asking
        ? { options: [s.suspect, s.weapon, s.room].filter(c => me.hand.includes(c)) }
        : null,
      shownToYou: this.pendingShow && this.pendingShow.to === pid
        ? { by: this.pendingShow.by, card: this.pendingShow.card }
        : null,
      awaitingYourAck: this.awaitingAck === pid
    };
  }

  /** Everything a phone needs baked in at load: no round trip, no internet. */
  bootstrap() {
    return {
      code: this.code,
      suspects: SUSPECTS.map(s => ({
        id: s.id, name: s.name, initials: s.initials,
        colour: s.colour, epithet: s.epithet, portrait: s.portrait
      })),
      weapons: WEAPONS.map(w => ({ id: w.id, name: w.name })),
      // col/row let the projector lay the board out; the phone ignores them.
      rooms: ROOMS.map(r => ({ id: r.id, name: r.name })),
      board: BOARD.layout()
    };
  }
}

module.exports = { Game, SUSPECTS, WEAPONS, ROOMS, CARD, PASSAGES, BOARD };
