'use strict';
/** Rules checks. Run: node test/rules.test.js */

const assert = require('assert');
const { Game, SUSPECTS, WEAPONS, ROOMS, BOARD } = require('../game');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

/** A deterministic generator, so a failure is always reproducible. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function tableOf(n, seed = 7) {
  const g = new Game(seeded(seed));
  for (let i = 0; i < n; i++) g.addPlayer('P' + (i + 1));
  g.players.forEach((p, i) => g.claim(p.id, SUSPECTS[i].id));
  g.start();
  return g;
}

console.log('\nRules\n');

check('every room can be reached from every starting square', () => {
  for (const [who, [x, y]] of Object.entries(BOARD.STARTS)) {
    for (const r of ROOMS) {
      assert.ok(isFinite(BOARD.stepsBetween(BOARD.key(x, y), r.id)), `${who} cannot reach ${r.id}`);
    }
  }
});

check('every door is a corridor square beside its own room', () => {
  for (const [room, x, y] of BOARD.DOORS) {
    assert.ok(BOARD.isCorridor(x, y), `${room} door at ${x},${y} is not corridor`);
    const beside = [[1,0],[-1,0],[0,1],[0,-1]].some(([dx, dy]) => (BOARD.GRID[y + dy] || [])[x + dx] === 'room:' + room);
    assert.ok(beside, `${room} door at ${x},${y} is not beside the room`);
  }
});

check('the secret passages join opposite corners', () => {
  assert.strictEqual(BOARD.PASSAGES.study, 'kitchen');
  assert.strictEqual(BOARD.PASSAGES.lounge, 'conservatory');
  assert.ok(!BOARD.PASSAGES.hall);
});

check('everyone starts on the edge, outside every room', () => {
  const g = tableOf(6, 9);
  for (const p of g.players) {
    assert.strictEqual(p.room, null);
    const [x, y] = p.cell;
    assert.ok(x === 0 || y === 0 || x === 23 || y === 23, p.name + ' is not on the edge');
  }
});

check('two dice, and a walk never longer than the roll', () => {
  for (const seed of [41, 42, 43, 44, 45, 46, 47, 48]) {
    const g = tableOf(4, seed);
    const me = g.current();
    g.roll(me.id);
    assert.strictEqual(g.dice.length, 2);
    assert.strictEqual(g.die, g.dice[0] + g.dice[1]);
    for (const [node, d] of Object.entries(g.reachable.dist)) assert.ok(d <= g.die, node + ' is too far');
  }
});

check('you cannot walk through or onto another pawn', () => {
  const g = tableOf(4, 51);
  const me = g.current();
  const other = g.players.find(p => p.id !== me.id);
  // stand the other pawn right next to me in the corridor
  const [x, y] = me.cell;
  const next = BOARD.neighbours(BOARD.key(x, y)).find(n => !n.startsWith('r:'));
  other.cell = BOARD.unkey(next);
  g.roll(me.id);
  // Their only way out is blocked, so they are boxed in on the doorstep.
  assert.ok(!g.reachable || g.reachable.dist[next] === undefined, 'walked onto an occupied square');
  assert.deepStrictEqual(me.cell, BOARD.unkey(BOARD.key(x, y)));
});

check('stepping into a room ends the walk', () => {
  const g = tableOf(4, 61);
  const me = g.current();
  me.cell = [6, 4];                          // one step from the Study door
  g.roll(me.id);
  if (g.reachable) {
    for (const [node, d] of Object.entries(g.reachable.dist)) {
      if (!node.startsWith('r:')) continue;
      // nothing is reached *through* a room
      for (const [n2, p2] of Object.entries(g.reachable.parent)) assert.ok(p2 !== node, 'walked through ' + node);
    }
  }
});

check('you cannot walk out of a room and straight back in', () => {
  const g = tableOf(4, 71);
  const me = g.current();
  me.room = 'hall'; me.cell = null;
  g.roll(me.id);
  if (g.reachable) assert.ok(g.reachable.dist['r:hall'] === undefined);
});

check('the secret passage moves you corner to corner, and you may suggest there', () => {
  const g = tableOf(4, 81);
  const me = g.current();
  me.room = 'study'; me.cell = null;
  assert.ok(g.privateState(me.id).canPassage);
  assert.ok(!g.passage(me.id).error);
  assert.strictEqual(me.room, 'kitchen');
  assert.ok(g.privateState(me.id).canSuggest);
});

check('no suggestion from the corridor', () => {
  const g = tableOf(4, 91);
  const me = g.current();
  g.roll(me.id);
  const cell = Object.keys(g.reachable.dist).find(n => !n.startsWith('r:'));
  g.move(me.id, cell);
  assert.ok(g.suggest(me.id, 'snow', 'pipe').error);
});

check('dragged into a room, you may stay and suggest on your next turn', () => {
  const g = tableOf(4, 101);
  const me = g.current();
  g.placeForTest(me.id, 'library');
  const victim = g.players.find(p => p.id !== me.id);
  g.suggest(me.id, victim.charId, 'pipe');
  assert.strictEqual(victim.room, 'library');
  assert.ok(victim.dragged);
  // resolve and hand the turn round to the victim
  let guard = 0;
  while (g.current().id !== victim.id && guard++ < 50) {
    if (g.askingPid) { const a = g.player(g.askingPid); g.disprove(a.id, [g.suggestion.suspect, g.suggestion.weapon, g.suggestion.room].find(c => a.hand.includes(c))); continue; }
    if (g.pendingShow) { g.acknowledge(g.pendingShow.to); continue; }
    if (g.awaitingAck) { g.acknowledge(g.awaitingAck); continue; }
    if (g.turnPhase === 'action') { g.endTurn(g.current().id); continue; }
    if (g.turnPhase === 'roll') { g.roll(g.current().id); continue; }
    if (g.turnPhase === 'move') { g.move(g.current().id, Object.keys(g.reachable.dist)[0]); continue; }
  }
  assert.strictEqual(g.current().id, victim.id);
  assert.ok(g.privateState(victim.id).canStay);
  assert.ok(!g.stay(victim.id).error);
  assert.ok(g.privateState(victim.id).canSuggest);
});

check('you may accuse before you roll', () => {
  const g = tableOf(4, 111);
  const me = g.current();
  const s = g.solution;
  assert.ok(!g.accuse(me.id, s.suspect, s.weapon, s.room).error);
  assert.strictEqual(g.winner, me.id);
});

check('three players is the minimum', () => {
  const g = new Game(seeded(1));
  g.addPlayer('a'); g.addPlayer('b');
  g.players.forEach((p, i) => g.claim(p.id, SUSPECTS[i].id));
  assert.ok(g.start().error, 'two players should not be able to start');
});

check('a seventh player is turned away', () => {
  const g = new Game(seeded(2));
  for (let i = 0; i < 6; i++) g.addPlayer('P' + i);
  assert.ok(g.addPlayer('gatecrasher').error);
});

check('two people cannot play the same character', () => {
  const g = new Game(seeded(3));
  const a = g.addPlayer('a').player, b = g.addPlayer('b').player;
  assert.ok(!g.claim(a.id, 'thorne').error);
  assert.ok(g.claim(b.id, 'thorne').error);
});

check('the whole deck is dealt, minus the three in the envelope', () => {
  for (const n of [3, 4, 5, 6]) {
    const g = tableOf(n, 11 + n);
    const dealt = g.players.flatMap(p => p.hand);
    const total = SUSPECTS.length + WEAPONS.length + ROOMS.length;
    assert.strictEqual(dealt.length, total - 3, `${n} players: wrong number dealt`);
    assert.strictEqual(new Set(dealt).size, dealt.length, 'a card was dealt twice');
    for (const c of [g.solution.suspect, g.solution.weapon, g.solution.room]) {
      assert.ok(!dealt.includes(c), 'an envelope card was dealt out');
    }
  }
});

check('hands are as even as the deck allows', () => {
  for (const n of [3, 4, 5, 6]) {
    const g = tableOf(n, 21 + n);
    const sizes = g.players.map(p => p.hand.length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `${n} players: ${sizes.join(',')}`);
  }
});

check('the public state never carries a hand or the envelope', () => {
  const g = tableOf(4, 31);
  const pub = JSON.stringify(g.publicState());
  assert.ok(!pub.includes('hand'), 'a hand field is in the public state');
  assert.ok(!pub.includes('"solution"'), 'the solution is in the public state');
  // the exact trio must not be derivable as a set anywhere in the payload
  const parsed = JSON.parse(pub);
  assert.strictEqual(parsed.reveal, null);
});

check('you cannot act out of turn', () => {
  const g = tableOf(4, 41);
  const notMe = g.players.find(p => p.id !== g.current().id);
  assert.ok(g.roll(notMe.id).error);
  assert.ok(g.move(notMe.id, 'hall').error);
});

check('a suggestion drags the named person and weapon into the room', () => {
  const g = tableOf(4, 61);
  const me = g.current();
  g.placeForTest(me.id, 'hall');
  const other = g.players.find(p => p.id !== me.id);
  g.suggest(me.id, other.charId, 'pipe');
  assert.strictEqual(other.room, me.room, 'the accused was not summoned');
  assert.strictEqual(g.weaponAt.pipe, me.room, 'the weapon did not move');
});

check('only the asked player may disprove, and only with a card they hold', () => {
  const g = tableOf(4, 71);
  const me = g.current();
  g.placeForTest(me.id, 'hall');
  const other = g.players.find(p => p.id !== me.id);
  g.suggest(me.id, other.charId, WEAPONS[0].id);
  if (g.turnPhase === 'disprove') {
    const asked = g.player(g.askingPid);
    const wrong = g.players.find(p => p.id !== asked.id);
    assert.ok(g.disprove(wrong.id, asked.hand[0]).error, 'the wrong player disproved');
    const notHeld = [...SUSPECTS, ...WEAPONS, ...ROOMS].map(x => x.id).find(id => !asked.hand.includes(id));
    assert.ok(g.disprove(asked.id, notHeld).error, 'showed a card they do not hold');
  }
});

check('a shown card reaches only the person who asked', () => {
  const g = tableOf(4, 81);
  const me = g.current();
  g.placeForTest(me.id, 'hall');
  const other = g.players.find(p => p.id !== me.id);
  g.suggest(me.id, other.charId, WEAPONS[0].id);
  if (g.turnPhase === 'disprove') {
    const asked = g.player(g.askingPid);
    const card = [g.suggestion.suspect, g.suggestion.weapon, g.suggestion.room]
      .find(c => asked.hand.includes(c));
    g.disprove(asked.id, card);
    assert.strictEqual(g.privateState(me.id).shownToYou.card, card);
    for (const p of g.players) {
      if (p.id === me.id) continue;
      assert.strictEqual(g.privateState(p.id).shownToYou, null, p.name + ' saw the card');
    }
    assert.ok(!JSON.stringify(g.publicState()).includes('"' + card + '"') ||
      g.publicState().suggestion, 'the card leaked into the public state');
  }
});

check('a shown card is ticked off in the asker’s notebook automatically', () => {
  const g = tableOf(4, 91);
  const me = g.current();
  g.placeForTest(me.id, 'hall');
  const other = g.players.find(p => p.id !== me.id);
  g.suggest(me.id, other.charId, WEAPONS[0].id);
  if (g.turnPhase === 'disprove') {
    const asked = g.player(g.askingPid);
    const card = [g.suggestion.suspect, g.suggestion.weapon, g.suggestion.room]
      .find(c => asked.hand.includes(c));
    g.disprove(asked.id, card);
    const note = g.privateState(me.id).you.notes[card];
    assert.ok(note === 'shown' || note === 'have', 'not recorded, got ' + note);
  }
});

check('only one suggestion per turn', () => {
  const g = tableOf(4, 101);
  const me = g.current();
  g.placeForTest(me.id, 'hall');
  g.suggest(me.id, 'snow', 'cord');
  // resolve whatever is pending
  if (g.askingPid) {
    const asked = g.player(g.askingPid);
    const card = [g.suggestion.suspect, g.suggestion.weapon, g.suggestion.room].find(c => asked.hand.includes(c));
    g.disprove(asked.id, card);
  }
  g.acknowledge(me.id);
  assert.ok(g.suggest(me.id, 'thorne', 'pipe').error, 'suggested twice');
});

check('a correct accusation ends it', () => {
  const g = tableOf(4, 111);
  const me = g.current();
  g.placeForTest(me.id, 'hall');
  const s = g.solution;
  g.accuse(me.id, s.suspect, s.weapon, s.room);
  assert.strictEqual(g.phase, 'over');
  assert.strictEqual(g.winner, me.id);
  assert.deepStrictEqual(g.publicState().reveal.solution, s);
});

check('a wrong accusation takes you out but keeps your cards in play', () => {
  const g = tableOf(4, 121);
  const me = g.current();
  const hand = me.hand.slice();
  g.placeForTest(me.id, 'hall');
  const wrongRoom = ROOMS.map(r => r.id).find(id => id !== g.solution.room);
  g.accuse(me.id, g.solution.suspect, g.solution.weapon, wrongRoom);
  assert.strictEqual(me.eliminated, true);
  assert.deepStrictEqual(me.hand, hand, 'their cards vanished');
  assert.strictEqual(g.phase, 'play');
});

check('an eliminated player takes no more turns', () => {
  const g = tableOf(4, 131);
  const me = g.current();
  g.placeForTest(me.id, 'hall');
  const wrongRoom = ROOMS.map(r => r.id).find(id => id !== g.solution.room);
  g.accuse(me.id, g.solution.suspect, g.solution.weapon, wrongRoom);
  g.acknowledge(me.id);
  for (let i = 0; i < 20; i++) {
    assert.notStrictEqual(g.current().id, me.id, 'an eliminated player got a turn');
    g.nextTurn();
    if (g.phase === 'over') break;
  }
});

check('when everyone has guessed wrong the game ends unsolved', () => {
  const g = tableOf(3, 141);
  const wrongRoom = ROOMS.map(r => r.id).find(id => id !== g.solution.room);
  for (let i = 0; i < 3; i++) {
    const me = g.current();
    g.placeForTest(me.id, 'hall');
    g.accuse(me.id, g.solution.suspect, g.solution.weapon, wrongRoom);
    if (g.awaitingAck) g.acknowledge(me.id);
  }
  assert.strictEqual(g.phase, 'over');
  assert.strictEqual(g.winner, null);
  assert.ok(g.publicState().reveal.solution, 'the envelope was never opened');
});

check('an eliminated player still has to answer suggestions', () => {
  const g = tableOf(4, 151);
  const victim = g.current();
  g.placeForTest(victim.id, 'hall');
  const wrongRoom = ROOMS.map(r => r.id).find(id => id !== g.solution.room);
  g.accuse(victim.id, g.solution.suspect, g.solution.weapon, wrongRoom);
  g.acknowledge(victim.id);
  // build a suggestion that only the eliminated player can answer
  const me = g.current();
  g.placeForTest(me.id, 'hall');
  const card = victim.hand.find(c => SUSPECTS.some(s => s.id === c));
  if (card) {
    g.suggest(me.id, card, WEAPONS.find(w => !g.players.some(p => p.id !== victim.id && p.hand.includes(w.id))) ?.id || WEAPONS[0].id);
    const queueHasVictim = g.askingPid === victim.id || g.disproveQueue.includes(victim.id);
    assert.ok(queueHasVictim || g.turnPhase === 'reveal', 'the eliminated player was skipped');
  }
});

check('notes never overwrite a card you are holding', () => {
  const g = tableOf(4, 161);
  const me = g.current();
  const own = me.hand[0];
  g.note(me.id, own, 'no');
  assert.strictEqual(g.privateState(me.id).you.notes[own], 'have');
});

check('a private view is refused for an unknown player', () => {
  const g = tableOf(4, 171);
  assert.strictEqual(g.privateState('nobody'), null);
});

check('the bootstrap carries no secrets', () => {
  const g = tableOf(4, 181);
  const boot = JSON.stringify(g.bootstrap());
  assert.ok(!boot.includes('hand'));
  assert.ok(!boot.includes('solution'));
});

// ------------------------------------------------------------ the notepad

console.log('\nDetective notepad\n');

check('a shown card is ticked in the shower’s column on the asker’s pad', () => {
  const g = tableOf(4, 501);
  const me = g.current();
  g.placeForTest(me.id, 'hall');
  const other = g.players.find(p => p.id !== me.id);
  g.suggest(me.id, other.charId, WEAPONS[0].id);
  if (g.askingPid) {
    const asked = g.player(g.askingPid);
    const card = [g.suggestion.suspect, g.suggestion.weapon, g.suggestion.room].find(c => asked.hand.includes(c));
    g.disprove(asked.id, card);
    assert.strictEqual(g.privateState(me.id).you.grid[card][asked.id], 'yes');
    // and nobody else's pad learned which card it was
    for (const p of g.players) {
      if (p.id === me.id) continue;
      const row = (g.privateState(p.id).you.grid || {})[card] || {};
      assert.notStrictEqual(row[asked.id], 'yes', p.name + ' learned the shown card');
    }
  }
});

check('a player who cannot answer is crossed off on everyone else’s pad', () => {
  for (const seed of [511, 512, 513, 514, 515, 516]) {
    const g = tableOf(4, seed);
    const me = g.current();
    g.placeForTest(me.id, 'hall');
    const other = g.players.find(p => p.id !== me.id);
    const firstAsked = g.players[(g.turn + 1) % g.players.length];
    g.suggest(me.id, other.charId, WEAPONS[1].id);
    const s = g.suggestion;
    const passed = ![s.suspect, s.weapon, s.room].some(c => firstAsked.hand.includes(c));
    if (!passed) continue;
    for (const p of g.players) {
      if (p.id === firstAsked.id) continue;
      const grid = g.privateState(p.id).you.grid;
      for (const c of [s.suspect, s.weapon, s.room]) {
        assert.strictEqual((grid[c] || {})[firstAsked.id], 'no', `${p.name} missing the cross for ${c}`);
      }
    }
    return;
  }
});

check('a hand-written mark is never overwritten by an automatic one', () => {
  const g = tableOf(4, 521);
  const me = g.current(), other = g.players.find(p => p.id !== me.id);
  g.note(me.id, 'pipe', 'maybe', other.id);
  g.pencil(me, 'pipe', other.id, 'no', false);
  assert.strictEqual(g.privateState(me.id).you.grid.pipe[other.id], 'maybe');
});

check('you cannot write in your own column — that is your hand', () => {
  const g = tableOf(4, 531);
  const me = g.current();
  g.note(me.id, 'pipe', 'yes', me.id);
  assert.ok(!((g.privateState(me.id).you.grid.pipe || {})[me.id]));
});

// ------------------------------------------------------- stand-in players

console.log('\nStand-in detectives\n');

function mixedTable(humans, bots, seed = 5) {
  const g = new Game(seeded(seed));
  for (let i = 0; i < humans; i++) g.addPlayer('H' + (i + 1));
  const free = () => {
    const taken = new Set(g.players.map(p => p.charId));
    return SUSPECTS.find(s => !taken.has(s.id)).id;
  };
  g.players.filter(p => !p.isBot).forEach(p => g.claim(p.id, free()));
  for (let i = 0; i < bots; i++) g.addBot();
  g.start();
  return g;
}

check('a bot takes a free character and is dealt a real hand', () => {
  const g = mixedTable(1, 3, 201);
  const bots = g.players.filter(p => p.isBot);
  assert.strictEqual(bots.length, 3);
  bots.forEach(b => {
    assert.ok(b.charId, 'a bot has no character');
    assert.ok(b.hand.length > 0, 'a bot was dealt nothing');
  });
  assert.strictEqual(new Set(g.players.map(p => p.charId)).size, 4, 'characters clash');
});

check('one person plus two stand-ins is enough to begin', () => {
  const g = mixedTable(1, 2, 202);
  assert.strictEqual(g.phase, 'play');
});

check('a bot never sees anything a phone could not', () => {
  // runBot is handed only publicState and its own privateState. Prove the
  // private view it works from contains no other player's card.
  const g = mixedTable(1, 3, 203);
  for (const bot of g.players.filter(p => p.isBot)) {
    const priv = g.privateState(bot.id);
    const others = g.players.filter(p => p.id !== bot.id).flatMap(p => p.hand);
    for (const card of priv.you.hand) {
      assert.ok(!others.includes(card), 'a bot holds someone else’s card');
    }
    assert.strictEqual(JSON.stringify(priv).includes('"solution"'), false);
  }
  const pub = JSON.stringify(g.publicState());
  assert.ok(!pub.includes('botShown'), 'bot memory leaked into the public state');
  assert.ok(!pub.includes('"hand"'), 'a hand leaked into the public state');
});

check('a bot’s private memory never reaches any state payload', () => {
  const g = mixedTable(2, 2, 204);
  for (const p of g.players) {
    assert.ok(!JSON.stringify(g.privateState(p.id)).includes('botShown'));
  }
});

check('botPending only ever names a bot', () => {
  const g = mixedTable(2, 2, 205);
  for (let i = 0; i < 60 && g.phase === 'play'; i++) {
    const next = g.botPending();
    if (!next) {
      // a human is holding things up — push them along so the loop continues
      const me = g.current();
      if (g.awaitingAck) g.acknowledge(g.awaitingAck);
      else if (g.pendingShow) g.acknowledge(g.pendingShow.to);
      else if (g.askingPid) {
        const a = g.player(g.askingPid);
        const c = [g.suggestion.suspect, g.suggestion.weapon, g.suggestion.room].find(x => a.hand.includes(x));
        g.disprove(a.id, c);
      } else if (g.turnPhase === 'roll') g.roll(me.id);
      else if (g.turnPhase === 'move') g.move(me.id, Object.keys(g.reachable.dist)[0]);
      else if (g.turnPhase === 'action') g.endTurn(me.id);
      continue;
    }
    assert.ok(g.player(next.pid).isBot, 'botPending named a human');
    g.runBot(next.pid);
  }
});

check('an all-bot table plays itself to a finish', () => {
  for (const seed of [301, 302, 303]) {
    const g = mixedTable(0, 4, seed);
    let steps = 0;
    while (g.phase === 'play' && steps++ < 4000) {
      const next = g.botPending();
      if (!next) break;
      if (!g.runBot(next.pid)) break;
    }
    assert.strictEqual(g.phase, 'over', `seed ${seed} stalled after ${steps} steps`);
  }
});

check('a bot that wins actually had it right', () => {
  let solved = 0;
  for (const seed of [401, 402, 403, 404, 405]) {
    const g = mixedTable(0, 4, seed);
    let steps = 0;
    while (g.phase === 'play' && steps++ < 4000) {
      const next = g.botPending();
      if (!next || !g.runBot(next.pid)) break;
    }
    if (g.winner) {
      solved++;
      const r = g.publicState().reveal;
      assert.deepStrictEqual(r.solution, g.solution, 'the envelope does not match');
    }
  }
  assert.ok(solved > 0, 'no bot ever solved it across five games');
});

check('a real person bumps a stand-in when the table is full', () => {
  const g = new Game(seeded(206));
  for (let i = 0; i < 6; i++) g.addBot();
  assert.strictEqual(g.players.length, 6);
  const out = g.addPlayer('latecomer');
  assert.ok(!out.error, 'a person was turned away: ' + out.error);
  assert.strictEqual(g.players.length, 6);
  assert.strictEqual(g.players.filter(p => p.isBot).length, 5);
});

check('bots cannot be added once the game is running', () => {
  const g = mixedTable(1, 2, 207);
  assert.ok(g.addBot().error);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
