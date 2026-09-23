'use strict';
/** Renders the projector and a phone in a real browser so the design can be looked at. */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 7398;
const OUT = process.argv[2] || '/tmp/shots';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function post(p, body) {
  return new Promise(res => {
    const d = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d) } }, s => {
      let raw = ''; s.on('data', c => raw += c); s.on('end', () => { try { res(JSON.parse(raw)); } catch (e) { res({}); } });
    });
    r.end(d);
  });
}

(async () => {
  require('fs').mkdirSync(OUT, { recursive: true });
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), String(PORT)], { stdio: 'ignore' });
  await sleep(700);

  const browser = await chromium.launch({ args: ['--force-color-profile=srgb'] });
  const big = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await big.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await sleep(900);
  await big.screenshot({ path: OUT + '/1-lobby-empty.png' });

  // four phones take seats
  const phones = [];
  const chars = ['thorne', 'cross', 'vale', 'ashe'];
  for (const [i, name] of ['Juan', 'Alison', 'Ben', 'Lucy'].entries()) {
    const j = await post('/api/join', { name });
    phones.push(j);
    await post('/api/action', { pid: j.pid, token: j.token, type: 'claim', charId: chars[i] });
  }

  // a real phone page, so the lobby shows a connected pip
  const small = await browser.newPage({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true
  });
  await small.goto(`http://127.0.0.1:${PORT}/join`, { waitUntil: 'domcontentloaded' });
  await small.evaluate(me => {
    localStorage.setItem('consequence:' + window.__BOOT__.code, JSON.stringify(me));
  }, { pid: phones[0].pid, token: phones[0].token });
  await small.reload({ waitUntil: 'domcontentloaded' });
  await sleep(600);
  await small.screenshot({ path: OUT + '/2-phone-lobby.png' });

  await sleep(500);
  await big.screenshot({ path: OUT + '/3-lobby-full.png' });

  // begin
  const boot = await big.evaluate(() => window.__BOOT__);
  await post('/api/host', { key: boot.hostKey, type: 'start' });
  await sleep(1200);
  await big.screenshot({ path: OUT + '/4-board.png' });
  await small.screenshot({ path: OUT + '/5-phone-turn.png' });

  // drive a few turns so the board has weapons, pawns and a ledger
  const byPid = {};
  phones.forEach(p => byPid[p.pid] = p);
  for (let i = 0; i < 40; i++) {
    const pub = await big.evaluate(() => window.__BOOT__ && (window.pubPeek || null)) || null;
    const st = await big.evaluate(() => {
      const el = document.querySelector('.turncard .nm');
      return { phase: document.querySelector('.grid') ? 'play' : 'lobby', who: el ? el.textContent : '' };
    });
    if (st.phase !== 'play') break;
    // poke the server directly using whatever the current state is
    const snap = await fetchState();
    if (!snap) break;
    const me = byPid[snap.currentPlayerId];
    if (snap.turnPhase === 'roll') await post('/api/action', { pid: me.pid, token: me.token, type: 'roll' });
    else if (snap.turnPhase === 'move') await post('/api/action', { pid: me.pid, token: me.token, type: 'move', roomId: snap.allowedRooms[i % snap.allowedRooms.length] });
    else if (snap.turnPhase === 'action') {
      if (i < 24) await post('/api/action', { pid: me.pid, token: me.token, type: 'suggest', suspectId: 'snow', weaponId: 'candlestick' });
      else await post('/api/action', { pid: me.pid, token: me.token, type: 'endTurn' });
    } else {
      // clear whatever is pending
      for (const p of phones) {
        await post('/api/action', { pid: p.pid, token: p.token, type: 'continue' });
      }
      // someone may need to show a card
      for (const p of phones) {
        const pv = await privOf(p);
        if (pv && pv.mustDisprove) await post('/api/action', { pid: p.pid, token: p.token, type: 'disprove', cardId: pv.mustDisprove.options[0] });
      }
    }
    await sleep(90);
    if (i === 14) { await sleep(400); await big.screenshot({ path: OUT + '/6-board-underway.png' }); }
  }
  await sleep(600);
  await big.screenshot({ path: OUT + '/7-board-late.png' });
  await small.screenshot({ path: OUT + '/8-phone-late.png' });

  // the notebook tab
  try {
    await small.click('[data-tab="notebook"]');
    await sleep(400);
    await small.screenshot({ path: OUT + '/9-phone-notebook.png' });
  } catch (e) { /* not in a state that shows tabs */ }

  await browser.close();
  server.kill();
  console.log('shots in ' + OUT);

  // --- helpers that read state through a throwaway SSE connection
  function fetchState() {
    return new Promise(res => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: `/events?role=host&key=${boot.hostKey}` }, s => {
        let buf = '';
        s.on('data', c => {
          buf += c;
          const i = buf.indexOf('\n\n');
          if (i < 0) return;
          const line = buf.slice(0, i).split('\n').find(l => l.startsWith('data: '));
          req.destroy();
          try { res(JSON.parse(line.slice(6)).pub); } catch (e) { res(null); }
        });
      });
      req.on('error', () => res(null));
    });
  }
  function privOf(p) {
    return new Promise(res => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: `/events?role=player&pid=${p.pid}&token=${p.token}` }, s => {
        let buf = '';
        s.on('data', c => {
          buf += c;
          const i = buf.indexOf('\n\n');
          if (i < 0) return;
          const line = buf.slice(0, i).split('\n').find(l => l.startsWith('data: '));
          req.destroy();
          try { res(JSON.parse(line.slice(6)).priv); } catch (e) { res(null); }
        });
      });
      req.on('error', () => res(null));
    });
  }
})().catch(e => { console.error(e); process.exit(1); });
