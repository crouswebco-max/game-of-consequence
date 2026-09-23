'use strict';
/**
 * One real phone, three stand-ins, against the real server.
 *
 *   node test/solo.test.js
 *
 * This is the configuration a short-handed table actually uses, so it gets its
 * own run: the bots must carry the game between the human's turns, the human
 * must never see a bot's cards, and the whole thing must finish.
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 7396;
const HOST = '127.0.0.1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const fail = m => { failures++; console.log('  FAIL ' + m); };
const ok = m => console.log('  ok   ' + m);

function post(p, body) {
  return new Promise(res => {
    const d = JSON.stringify(body);
    const r = http.request({ host: HOST, port: PORT, path: p, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d) } }, s => {
      let raw = ''; s.on('data', c => raw += c);
      s.on('end', () => { try { res(JSON.parse(raw)); } catch (e) { res({}); } });
    });
    r.on('error', () => res({}));
    r.end(d);
  });
}

function get(p) {
  return new Promise(res => {
    http.get({ host: HOST, port: PORT, path: p }, s => {
      let raw = ''; s.on('data', c => raw += c);
      s.on('end', () => res({ status: s.statusCode, body: raw }));
    }).on('error', () => res({ status: 0, body: '' }));
  });
}

function listen(p, onMsg) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port: PORT, path: p }, res => {
      if (res.statusCode !== 200) return reject(new Error('stream refused ' + res.statusCode));
      let buf = '';
      res.on('data', chunk => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = frame.split('\n').find(l => l.startsWith('data: '));
          if (line) { try { onMsg(JSON.parse(line.slice(6))); } catch (e) {} }
        }
      });
      resolve();
    });
    req.on('error', reject);
  });
}

(async () => {
  console.log('\nSolo — one person, three stand-ins\n');

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), String(PORT)], {
    stdio: ['ignore', 'ignore', 'pipe'], env: Object.assign({}, process.env, { CONSEQUENCE_BOT_PACE: '0.01' })
  });
  server.stderr.on('data', d => process.stderr.write('  server: ' + d));
  const stop = () => { try { server.kill(); } catch (e) {} };
  process.on('exit', stop);
  await sleep(700);

  const boardPage = await get('/');
  const boot = JSON.parse(boardPage.body.match(/window\.__BOOT__=(\{.*?\});/s)[1]);
  const hostKey = boot.hostKey;

  // one person joins
  const me = await post('/api/join', { name: 'Juan' });
  if (!me.pid) { fail('the person could not join'); stop(); process.exit(1); }

  const frames = [];
  let pub = null, priv = null;
  await listen(`/events?role=player&pid=${me.pid}&token=${me.token}`, m => {
    frames.push(m);
    if (m.type === 'state') { pub = m.pub; priv = m.priv; }
  });
  const hostFrames = [];
  await listen(`/events?role=host&key=${encodeURIComponent(hostKey)}`, m => hostFrames.push(m));
  await sleep(250);

  await post('/api/action', { pid: me.pid, token: me.token, type: 'claim', charId: 'cross' });

  // three stand-ins
  for (let i = 0; i < 3; i++) {
    const out = await post('/api/host', { key: hostKey, type: 'addBot' });
    if (out.error) fail('could not add a stand-in: ' + out.error);
  }
  await sleep(250);

  if (!pub || pub.players.length !== 4) fail('expected four at the table, got ' + (pub ? pub.players.length : 0));
  else ok('one person and three stand-ins are seated');

  if (!pub.canStart) fail('the table will not start short-handed');
  else ok('the table is ready to begin with one real player');

  const started = await post('/api/host', { key: hostKey, type: 'start' });
  if (started.error) { fail('start refused: ' + started.error); stop(); process.exit(1); }
  await sleep(500);
  if (!priv || !priv.you.hand.length) { fail('the person was dealt nothing'); stop(); process.exit(1); }
  ok('the person holds ' + priv.you.hand.length + ' cards');

  // Play. The bots move on the server's own timer; the human only acts when
  // the game is actually waiting on them.
  const started_at = Date.now();
  let acted = 0;
  while (pub && pub.phase === 'play' && Date.now() - started_at < 170000) {
    const hand = priv.you.hand;
    const notes = priv.you.notes || {};
    const live = k => boot[k].map(x => x.id).filter(id => !hand.includes(id) && notes[id] !== 'shown');

    if (priv.shownToYou || priv.awaitingYourAck) {
      await post('/api/action', { pid: me.pid, token: me.token, type: 'continue' });
      acted++;
    } else if (priv.mustDisprove) {
      await post('/api/action', { pid: me.pid, token: me.token, type: 'disprove', cardId: priv.mustDisprove.options[0] });
      acted++;
    } else if (priv.isYourTurn) {
      if (pub.turnPhase === 'roll') {
        const s = live('suspects'), w = live('weapons'), r = live('rooms');
        if (s.length === 1 && w.length === 1 && r.length === 1)
          await post('/api/action', { pid: me.pid, token: me.token, type: 'accuse', suspectId: s[0], weaponId: w[0], roomId: r[0] });
        else if (priv.canStay && r.includes(priv.yourRoom))
          await post('/api/action', { pid: me.pid, token: me.token, type: 'stay' });
        else await post('/api/action', { pid: me.pid, token: me.token, type: 'roll' });
      } else if (pub.turnPhase === 'move') {
        const liveRooms = live('rooms');
        const inReach = pub.reach.rooms.filter(r => liveRooms.includes(r) && r !== priv.yourRoom);
        if (inReach.length) await post('/api/action', { pid: me.pid, token: me.token, type: 'move', target: 'r:' + inReach[0] });
        else await post('/api/action', { pid: me.pid, token: me.token, type: 'toward',
          roomId: liveRooms.filter(r => r !== priv.yourRoom)[0] || 'hall' });
      } else if (pub.turnPhase === 'action') {
        const s = live('suspects'), w = live('weapons'), r = live('rooms');
        if (s.length === 1 && w.length === 1 && r.length === 1) {
          await post('/api/action', { pid: me.pid, token: me.token, type: 'accuse', suspectId: s[0], weaponId: w[0], roomId: r[0] });
        } else if (priv.canSuggest) {
          await post('/api/action', {
            pid: me.pid, token: me.token, type: 'suggest',
            suspectId: s[0] || boot.suspects[0].id, weaponId: w[0] || boot.weapons[0].id
          });
        } else {
          await post('/api/action', { pid: me.pid, token: me.token, type: 'endTurn' });
        }
      }
      acted++;
    }
    await sleep(25);      // let the bots have their turn on the server's timer
  }

  if (!pub || pub.phase !== 'over') fail('the game never finished');
  else ok(`finished — ${pub.winner ? (pub.winner === me.pid ? 'the person won' : 'a stand-in won') : 'unsolved'}`);

  if (acted === 0) fail('the person was never asked to do anything');
  else ok(`the person acted ${acted} times; the stand-ins carried the rest`);

  // ------------------------------------------------------------- the audit

  const botPids = pub.players.filter(p => p.isBot).map(p => p.id);
  if (botPids.length !== 3) fail('the stand-ins are not marked as such in the public state');
  else ok('stand-ins are marked on the projector so nobody is misled');

  let leaks = 0;
  for (const f of frames) {
    if (f.type !== 'state' || !f.priv) continue;
    if (f.priv.you.id !== me.pid) leaks++;
    if (JSON.stringify(f).includes('botShown')) leaks++;
    if (f.pub.phase !== 'over' && f.pub.reveal && f.pub.reveal.solution) leaks++;
  }
  if (leaks) fail(leaks + ' leaks reached the person');
  else ok('nothing private reached the person across ' + frames.length + ' payloads');

  let hostLeaks = 0;
  for (const f of hostFrames) {
    if (f.type !== 'state') continue;
    if (f.priv) hostLeaks++;
    if (JSON.stringify(f).includes('"hand"')) hostLeaks++;
    if (JSON.stringify(f).includes('botShown')) hostLeaks++;
  }
  if (hostLeaks) fail(hostLeaks + ' leaks reached the projector');
  else ok('the projector saw no hand and no stand-in memory');

  console.log(`\n${failures ? failures + ' FAILURES' : 'all clear'}\n`);
  stop();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
