'use strict';
/**
 * Four simulated phones play a whole game against the real server over real
 * HTTP, and every byte each phone receives is kept and audited afterwards.
 *
 *   node test/playtest.js
 *
 * The point is not that the rules work — rules.test.js covers that — but that
 * nothing private ever reaches the wrong screen.
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 7399;
const HOST = '127.0.0.1';

let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL ' + msg); };
const ok = (msg) => console.log('  ok   ' + msg);

function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: HOST, port: PORT, path: pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { resolve({}); } });
    });
    req.on('error', reject);
    req.end(data);
  });
}

function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: HOST, port: PORT, path: pathname }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    }).on('error', reject);
  });
}

/** An SSE listener that keeps everything it is sent. */
function listen(pathname, onState) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port: PORT, path: pathname }, res => {
      if (res.statusCode !== 200) { reject(new Error('stream refused: ' + res.statusCode)); return; }
      let buf = '';
      res.on('data', chunk => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = frame.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          try { onState(JSON.parse(line.slice(6))); } catch (e) { /* ignore keepalives */ }
        }
      });
      resolve({ req, res });
    });
    req.on('error', reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// -------------------------------------------------------------------- main

(async () => {
  console.log('\nPlaytest — four phones, one projector, real HTTP\n');

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let banner = '';
  server.stdout.on('data', d => banner += d);
  server.stderr.on('data', d => process.stderr.write('  server: ' + d));

  const stop = () => { try { server.kill(); } catch (e) {} };
  process.on('exit', stop);

  await sleep(600);

  // ---- the projector loads first and takes the host key out of the page
  const boardPage = await get('/');
  const bootMatch = boardPage.body.match(/window\.__BOOT__=(\{.*?\});/s);
  if (!bootMatch) { fail('the projector page did not get a bootstrap'); stop(); process.exit(1); }
  const boot = JSON.parse(bootMatch[1]);
  const hostKey = boot.hostKey;
  if (!hostKey) { fail('no host key on the projector page'); stop(); process.exit(1); }
  ok('the projector page carries a host key');

  // ---- through a tunnel, the main page must not hand out the host controls
  const tunnelled = await new Promise(res => http.get({ host: HOST, port: PORT, path: '/',
    headers: { 'x-forwarded-for': '203.0.113.9' } }, r => { let b = ''; r.on('data', c => b += c);
    r.on('end', () => res({ status: r.statusCode, loc: r.headers.location, body: b })); }));
  if (tunnelled.status !== 302 || tunnelled.body.includes(hostKey)) fail('a visitor through a tunnel got the host page');
  else ok('visitors from the internet are sent to the join page, never the host controls');
  const cf = await new Promise(res => http.get({ host: HOST, port: PORT, path: '/board',
    headers: { 'cf-connecting-ip': '198.51.100.4' } }, r => { r.resume(); res(r.statusCode); }));
  if (cf !== 302) fail('a Cloudflare-tunnelled visitor got the host page');

  // ---- the phone page must NOT carry it
  const phonePage = await get('/join');
  if (phonePage.body.includes(hostKey)) fail('the host key leaked onto the phone page');
  else ok('the phone page has no host key');

  // ---- four phones take seats
  const phones = [];
  for (const name of ['Juan', 'Alison', 'Ben', 'Lucy']) {
    const out = await post('/api/join', { name });
    if (!out.pid || !out.token) { fail('join failed for ' + name); stop(); process.exit(1); }
    phones.push({ name, pid: out.pid, token: out.token, pub: null, priv: null, frames: [] });
  }
  ok('four phones joined and were given separate tokens');

  if (new Set(phones.map(p => p.token)).size !== 4) fail('tokens are not unique');

  // ---- a phone with a made-up token gets nowhere
  const forged = await post('/api/action', { pid: phones[0].pid, token: 'nonsense', type: 'roll' });
  if (!forged.error) fail('a forged token was accepted'); else ok('a forged token is refused');

  const badStream = await get(`/events?role=player&pid=${phones[0].pid}&token=nonsense`);
  if (badStream.status !== 401) fail('a forged token opened a stream'); else ok('a forged token cannot open a stream');

  const badHost = await get('/events?role=host&key=nope');
  if (badHost.status !== 401) fail('a wrong host key opened the host stream'); else ok('a wrong host key is refused');

  // ---- everyone connects
  const hostFrames = [];
  await listen(`/events?role=host&key=${encodeURIComponent(hostKey)}`, m => hostFrames.push(m));
  for (const p of phones) {
    await listen(`/events?role=player&pid=${p.pid}&token=${p.token}`, m => {
      p.frames.push(m);
      if (m.type === 'state') { p.pub = m.pub; p.priv = m.priv; }
    });
  }
  await sleep(300);

  // ---- pick characters, then begin
  const chars = ['thorne', 'cross', 'vale', 'ashe'];
  for (let i = 0; i < phones.length; i++) {
    await post('/api/action', { pid: phones[i].pid, token: phones[i].token, type: 'claim', charId: chars[i] });
  }
  await sleep(200);

  const dup = await post('/api/action', { pid: phones[1].pid, token: phones[1].token, type: 'claim', charId: 'thorne' });
  if (!dup.error) fail('two phones claimed the same character'); else ok('a taken character is refused');
  await post('/api/action', { pid: phones[1].pid, token: phones[1].token, type: 'claim', charId: 'cross' });

  const notHost = await post('/api/host', { key: 'guess', type: 'start' });
  if (!notHost.error) fail('a non-host started the game'); else ok('only the host can start');

  await post('/api/host', { key: hostKey, type: 'start' });
  await sleep(300);
  if (!phones[0].pub || phones[0].pub.phase !== 'play') { fail('the game did not start'); stop(); process.exit(1); }
  ok('the game started and every phone was dealt a hand');

  const byPid = Object.fromEntries(phones.map(p => [p.pid, p]));
  const handOf = p => (p.priv && p.priv.you.hand) || [];

  if (phones.some(p => handOf(p).length === 0)) fail('someone was dealt nothing');
  const allCards = phones.flatMap(handOf);
  if (new Set(allCards).size !== allCards.length) fail('a card was dealt to two people');
  ok('the deal is clean — ' + allCards.length + ' cards out, no duplicates');

  // ---- play it out
  let guard = 0;
  while (phones[0].pub && phones[0].pub.phase === 'play' && guard++ < 6000) {
    const pub = phones[0].pub;
    const me = byPid[pub.currentPlayerId];

    // anyone holding an ack blocks the table, so clear those first
    const waiting = phones.find(p => p.priv && p.priv.awaitingYourAck);
    if (waiting) { await post('/api/action', { pid: waiting.pid, token: waiting.token, type: 'continue' }); await sleep(12); continue; }
    const showing = phones.find(p => p.priv && p.priv.shownToYou);
    if (showing) { await post('/api/action', { pid: showing.pid, token: showing.token, type: 'continue' }); await sleep(12); continue; }
    const asked = phones.find(p => p.priv && p.priv.mustDisprove);
    if (asked) {
      const opts = asked.priv.mustDisprove.options;
      await post('/api/action', { pid: asked.pid, token: asked.token, type: 'disprove', cardId: opts[0] });
      await sleep(12); continue;
    }

    if (!me) break;

    // What this player can still rule nothing out about: not in their hand,
    // and never shown to them. This is exactly what a human tracks on the pad.
    const hand = handOf(me);
    const notes = (me.priv && me.priv.you.notes) || {};
    const live = kind => boot[kind].map(x => x.id)
      .filter(id => !hand.includes(id) && notes[id] !== 'shown');

    if (pub.turnPhase === 'roll') {
      const s = live('suspects'), w = live('weapons'), r = live('rooms');
      if (s.length === 1 && w.length === 1 && r.length === 1)
        await post('/api/action', { pid: me.pid, token: me.token, type: 'accuse', suspectId: s[0], weaponId: w[0], roomId: r[0] });
      else if (me.priv.canStay && r.includes(me.priv.yourRoom))
        await post('/api/action', { pid: me.pid, token: me.token, type: 'stay' });
      else await post('/api/action', { pid: me.pid, token: me.token, type: 'roll' });
    } else if (pub.turnPhase === 'move') {
      // Walk into a live room if one is in reach, otherwise head for the nearest.
      const liveRooms = live('rooms');
      const inReach = pub.reach.rooms.filter(r => liveRooms.includes(r) && r !== me.priv.yourRoom);
      if (inReach.length) await post('/api/action', { pid: me.pid, token: me.token, type: 'move', target: 'r:' + inReach[0] });
      else {
        const aim = (liveRooms.filter(r => r !== me.priv.yourRoom)[0]) || boot.rooms[guard % 9].id;
        await post('/api/action', { pid: me.pid, token: me.token, type: 'toward', roomId: aim });
      }
    } else if (pub.turnPhase === 'action') {
      const s = live('suspects'), w = live('weapons'), r = live('rooms');
      if (s.length === 1 && w.length === 1 && r.length === 1) {
        await post('/api/action', { pid: me.pid, token: me.token, type: 'accuse', suspectId: s[0], weaponId: w[0], roomId: r[0] });
      } else if (me.priv.canSuggest) {
        // Rotate the guess, otherwise the same pair is asked all night and
        // nothing new is ever learned.
        await post('/api/action', {
          pid: me.pid, token: me.token, type: 'suggest',
          suspectId: s.length ? s[guard % s.length] : boot.suspects[0].id,
          weaponId: w.length ? w[guard % w.length] : boot.weapons[0].id
        });
      } else {
        await post('/api/action', { pid: me.pid, token: me.token, type: 'endTurn' });
      }
    } else {
      await sleep(40);
    }
    await sleep(12);
  }
  await sleep(400);

  const final = phones[0].pub;
  if (!final || final.phase !== 'over') fail('the game never finished (guard ' + guard + ')');
  else ok(`the game finished in ${guard} steps — ${final.winner ? 'solved' : 'unsolved'}`);

  // -------------------------------------------------------------- the audit

  console.log('\nLeak audit\n');

  const solution = final && final.reveal && final.reveal.solution;
  if (!solution) fail('the envelope was never revealed at the end');

  let leaks = 0;

  // 1. No phone may ever see another phone's hand.
  //
  // Card ids share a namespace with character ids and room ids, so a blunt
  // substring search flags your own character and the room you are standing in.
  // Only these fields can legitimately carry a card, so only these are checked.
  const report = new Set();
  for (const p of phones) {
    const mine = new Set(handOf(p));
    const theirs = new Map();                       // card -> owner name
    for (const o of phones) if (o !== p) for (const c of handOf(o)) theirs.set(c, o.name);

    for (const frame of p.frames) {
      if (frame.type !== 'state' || !frame.priv) continue;
      const priv = frame.priv;

      for (const c of priv.you.hand || []) {
        if (theirs.has(c)) { leaks++; report.add(`${p.name}'s hand contained ${theirs.get(c)}'s ${c}`); }
      }
      for (const c of (priv.mustDisprove && priv.mustDisprove.options) || []) {
        if (!mine.has(c)) { leaks++; report.add(`${p.name} was offered ${c}, which is not theirs`); }
      }
      // notes may legitimately hold 'have' (own) and 'shown' (shown to them)
      for (const [c, mark] of Object.entries(priv.you.notes || {})) {
        if (mark === 'have' && !mine.has(c)) { leaks++; report.add(`${p.name}'s notebook claims ${c}`); }
      }
      // shownToYou is the one place another player's card may appear, and only
      // when that player was the one asked
      if (priv.shownToYou && !theirs.has(priv.shownToYou.card) && !mine.has(priv.shownToYou.card)) {
        leaks++; report.add(`${p.name} was shown ${priv.shownToYou.card}, which nobody holds`);
      }
    }
  }
  for (const line of report) console.log('       ' + line);
  if (leaks) fail(leaks + ' hand leaks between phones'); else ok('no phone ever saw another phone\'s hand');

  // 2. No token but your own, ever, anywhere.
  let tokenLeaks = 0;
  for (const p of [...phones, { name: 'projector', frames: hostFrames, token: '\u0000' }]) {
    const text = JSON.stringify(p.frames);
    for (const o of phones) {
      if (o.token === p.token) continue;
      if (text.includes(o.token)) { tokenLeaks++; console.log(`       ${p.name} received ${o.name}'s token`); }
    }
  }
  if (tokenLeaks) fail(tokenLeaks + ' token leaks'); else ok('no token reached anyone but its owner');

  // 3. The projector must never hold a hand or the envelope mid-game.
  let hostLeaks = 0;
  for (const frame of hostFrames) {
    if (frame.type !== 'state') continue;
    const text = JSON.stringify(frame);
    if (text.includes('"hand"')) { hostLeaks++; }
    if (frame.pub && frame.pub.phase !== 'over' && frame.pub.reveal && frame.pub.reveal.solution) hostLeaks++;
    if (frame.priv) hostLeaks++;
  }
  if (hostLeaks) fail(hostLeaks + ' leaks to the projector'); else ok('the projector saw no hand and no early envelope');

  // 4. The envelope must not be derivable from any mid-game public state.
  let earlySolution = 0;
  for (const p of phones) {
    for (const frame of p.frames) {
      if (frame.type !== 'state' || !frame.pub || frame.pub.phase === 'over') continue;
      if (frame.pub.reveal && frame.pub.reveal.solution) earlySolution++;
      if (JSON.stringify(frame.pub).includes('"solution"')) {
        const r = frame.pub.reveal;
        if (r && r.solution) earlySolution++;
      }
    }
  }
  if (earlySolution) fail('the envelope appeared in a public state before the end');
  else ok('the envelope stayed sealed until the end');

  // 5. Every private view belonged to its owner.
  let wrongOwner = 0;
  for (const p of phones) {
    for (const frame of p.frames) {
      if (frame.type !== 'state' || !frame.priv) continue;
      if (frame.priv.you.id !== p.pid) wrongOwner++;
    }
  }
  if (wrongOwner) fail(wrongOwner + ' frames went to the wrong phone'); else ok('every private view reached its owner');

  const frames = phones.reduce((n, p) => n + p.frames.length, 0) + hostFrames.length;
  console.log(`\n  audited ${frames} payloads across ${phones.length} phones and one projector`);
  console.log(`\n${failures ? failures + ' FAILURES' : 'all clear'}\n`);

  stop();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
