'use strict';
/**
 * A Game of Consequence — local server.
 *
 * Node standard library only: no npm install, no build step, nothing to break
 * on the night. The Mac runs this; phones join over the same Wi-Fi.
 *
 *   node server.js [port]
 *
 * Routes
 *   GET  /                  the projector screen (host key minted on first load)
 *   GET  /join              the phone client
 *   GET  /events            SSE state push, for both roles
 *   POST /api/join          { name } -> { pid, token }
 *   POST /api/action        { pid, token, type, ... }
 *   POST /api/host          { key, type }   start / reset / kick
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { Game } = require('./game');

const PORT = Number(process.argv[2]) || 7373;
const PUBLIC = path.join(__dirname, 'public');

/**
 * How long the stand-ins pause before each move, as a multiplier. 1 is the
 * pace a table can follow. Lower it if they feel slow, raise it if the room
 * cannot keep up; the tests run it very low so a whole game takes seconds.
 *
 *   CONSEQUENCE_BOT_PACE=0.5 node server.js
 */
const BOT_PACE = (() => {
  const raw = Number(process.env.CONSEQUENCE_BOT_PACE);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1;
})();

/**
 * Playing with friends who are not on your Wi-Fi: a tunnel (cloudflared or
 * ngrok) gives this Mac a public https address. When one is running, the QR
 * code points there instead of at the local network.
 *
 *   CONSEQUENCE_PUBLIC_URL=https://something.trycloudflare.com node server.js
 *
 * If nothing is set, a running ngrok is found automatically.
 */
let publicUrl = (process.env.CONSEQUENCE_PUBLIC_URL || '').replace(/\/+$/, '') || null;
function findNgrok() {
  if (process.env.CONSEQUENCE_PUBLIC_URL) return;
  const req = http.get({ host: '127.0.0.1', port: 4040, path: '/api/tunnels', timeout: 800 }, res => {
    let raw = ''; res.on('data', c => raw += c);
    res.on('end', () => {
      try {
        const t = (JSON.parse(raw).tunnels || []).find(x => /^https:/.test(x.public_url) &&
          String((x.config || {}).addr || '').endsWith(':' + PORT));
        const next = t ? t.public_url.replace(/\/+$/, '') : null;
        if (next !== publicUrl) { publicUrl = next; if (next) console.log('  Online at  ' + next + '/join'); }
      } catch (e) { /* not ngrok */ }
    });
  });
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
}
findNgrok();
setInterval(findNgrok, 10000).unref();

/**
 * The host controls (start, reset, remove) belong to whoever is sitting at this
 * Mac. Once a tunnel makes the game reachable from the internet, "anyone who
 * opens the main page" is no longer a living room, so the projector page is only
 * served to this machine itself. A tunnel connects from localhost too, but it
 * always adds a forwarding header, which is how it is told apart.
 */
function isThisMac(req) {
  const a = req.socket.remoteAddress || '';
  const loop = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  const h = req.headers;
  const forwarded = h['x-forwarded-for'] || h['cf-connecting-ip'] || h['x-forwarded-host'] || h['forwarded'] || h['x-real-ip'];
  return loop && !forwarded;
}

/**
 * On a cloud server there is no "this Mac": the host sits at a laptop somewhere
 * else. Set CONSEQUENCE_HOST_PASSWORD and open /?host=<password> to get the
 * projector and its controls. Without the password everyone is a player.
 */
const HOST_PASSWORD = process.env.CONSEQUENCE_HOST_PASSWORD || '';

function isHost(req, url) {
  if (isThisMac(req)) return true;
  if (!HOST_PASSWORD) return false;
  const given = Buffer.from(url.searchParams.get('host') || '');
  const want = Buffer.from(HOST_PASSWORD);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

let game = new Game();
const tokens = new Map();                       // pid -> token
const HOST_KEY = crypto.randomBytes(16).toString('hex');

/** Open SSE connections. Each knows who it belongs to, so it gets its own view. */
const clients = new Set();                      // { res, role, pid }

// ------------------------------------------------------------------ helpers

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(s),
    'cache-control': 'no-store'
  });
  res.end(s);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => {
      raw += c;
      if (raw.length > 1e5) { reject(new Error('too big')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/** The one function that decides what each connection is allowed to see. */
function payloadFor(client) {
  const pub = game.publicState();
  if (client.role === 'host') return { type: 'state', pub, host: true, hostKey: undefined };
  const priv = game.privateState(client.pid);
  if (!priv) return { type: 'kicked' };
  return { type: 'state', pub, priv };
}

function push() {
  for (const c of clients) {
    let line;
    try { line = 'data: ' + JSON.stringify(payloadFor(c)) + '\n\n'; }
    catch (e) { continue; }
    try { c.res.write(line); } catch (e) { clients.delete(c); }
  }
  scheduleBots();
}

/**
 * Stand-in detectives move on a timer rather than instantly, so the table can
 * watch a turn happen instead of seeing four of them flash past. Only ever one
 * timer is outstanding; every state change reschedules it.
 */
let botTimer = null;
let botStall = 0;                           // consecutive no-ops, to stop a spin
let holdUntil = 0;                          // the projector is mid-cutscene until then
function scheduleBots() {
  clearTimeout(botTimer);
  const next = game.botPending();
  if (!next) { botStall = 0; return; }
  if (botStall > 8) return;                 // a bot is wedged; leave it to the host
  const taken = game;                       // the game this timer belongs to
  botTimer = setTimeout(() => {
    if (game !== taken) return;             // a reset happened; abandon quietly
    let moved = false;
    try { moved = game.runBot(next.pid); }
    catch (e) { console.error('  bot error:', e.message); moved = false; }
    if (moved) { botStall = 0; push(); }    // push() reschedules
    else { botStall++; scheduleBots(); }
  }, Math.max(1, next.delay * BOT_PACE, holdUntil - Date.now() + 700 * BOT_PACE));
}

function lanAddress() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      // Prefer real Wi-Fi over virtual adapters (Docker, VPNs, Parallels).
      const score = /^en|^wl/.test(name) ? 0 : 1;
      candidates.push({ score, address: net.address });
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  return candidates.length ? candidates[0].address : '127.0.0.1';
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.ico': 'image/x-icon'
};

function serveStatic(res, rel) {
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'no' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'public, max-age=3600'
    });
    fs.createReadStream(file).pipe(res);
  });
}

/** Injects the bootstrap object into a page at its /*__BOOT__*​/ marker. */
function servePage(res, name, boot) {
  fs.readFile(path.join(PUBLIC, name), 'utf8', (err, html) => {
    if (err) { res.writeHead(500); return res.end('missing ' + name); }
    const out = html.replace('/*__BOOT__*/',
      'window.__BOOT__=' + JSON.stringify(boot).replace(/</g, '\\u003c') + ';');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(out)
    });
    res.end(out);
  });
}

// ------------------------------------------------------------------- routes

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;

  // ---- the projector
  if (p === '/' || p === '/board' || p === '/board.html') {
    // Anyone else who types the bare address is a player, so send them to join.
    if (!isHost(req, url)) { res.writeHead(302, { location: '/join' }); return res.end(); }
    const boot = game.bootstrap();
    boot.hostKey = HOST_KEY;
    boot.lanUrl = `http://${lanAddress()}:${PORT}/join`;
    boot.joinUrl = publicUrl ? publicUrl + '/join' : boot.lanUrl;
    boot.online = !!publicUrl;
    return servePage(res, 'board.html', boot);
  }

  // ---- a phone
  if (p === '/join' || p === '/phone' || p === '/phone.html') {
    return servePage(res, 'phone.html', game.bootstrap());
  }

  // ---- state push
  if (p === '/events') {
    const role = url.searchParams.get('role') === 'host' ? 'host' : 'player';
    const pid = url.searchParams.get('pid');
    const token = url.searchParams.get('token');

    if (role === 'host') {
      if (url.searchParams.get('key') !== HOST_KEY) { res.writeHead(401); return res.end(); }
    } else {
      if (!pid || tokens.get(pid) !== token) { res.writeHead(401); return res.end(); }
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    res.write('retry: 2000\n\n');

    const client = { res, role, pid };
    clients.add(client);
    if (pid) { const pl = game.player(pid); if (pl) pl.connected = true; }

    res.write('data: ' + JSON.stringify(payloadFor(client)) + '\n\n');

    const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 15000);
    req.on('close', () => {
      clearInterval(beat);
      clients.delete(client);
      if (pid) {
        const pl = game.player(pid);
        // Only mark away if this was their last open connection.
        if (pl && ![...clients].some(c => c.pid === pid)) { pl.connected = false; push(); }
      }
    });
    return;
  }

  // ---- taking a seat
  if (p === '/api/join' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'Bad request.' }); }
    const out = game.addPlayer(body.name);
    if (out.error) return json(res, 200, { error: out.error });
    const token = crypto.randomBytes(24).toString('hex');
    tokens.set(out.player.id, token);
    push();
    return json(res, 200, { pid: out.player.id, token });
  }

  // ---- a move
  if (p === '/api/action' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'Bad request.' }); }
    const { pid, token, type } = body;
    if (!pid || tokens.get(pid) !== token) return json(res, 401, { error: 'Rejoin — this seat has gone stale.' });

    let out;
    switch (type) {
      case 'claim':    out = game.claim(pid, body.charId); break;
      case 'roll':     out = game.roll(pid); break;
      case 'move':     out = game.move(pid, body.target || body.roomId); break;
      case 'toward':   out = game.toward(pid, body.roomId); break;
      case 'passage':  out = game.passage(pid); break;
      case 'stay':     out = game.stay(pid); break;
      case 'suggest':  out = game.suggest(pid, body.suspectId, body.weaponId); break;
      case 'disprove': out = game.disprove(pid, body.cardId); break;
      case 'accuse':   out = game.accuse(pid, body.suspectId, body.weaponId, body.roomId); break;
      case 'continue': out = game.acknowledge(pid); break;
      case 'endTurn':  out = game.endTurn(pid); break;
      case 'note':     out = game.note(pid, body.cardId, body.value, body.col); break;
      default:         out = { error: 'Unknown action.' };
    }
    push();
    return json(res, 200, out);
  }

  // ---- the projector's own controls
  if (p === '/api/host' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'Bad request.' }); }
    if (body.key !== HOST_KEY) return json(res, 401, { error: 'Not the host.' });

    let out = {};
    if (body.type === 'start') out = game.start();
    else if (body.type === 'addBot') out = game.addBot();
    else if (body.type === 'hold') {
      // The projector is playing a cutscene: stand-ins wait for it to finish,
      // so the story on the wall and the game underneath stay in step.
      const ms = Math.max(0, Math.min(30000, Number(body.ms) || 0));
      holdUntil = Date.now() + ms;
      scheduleBots();
      return json(res, 200, {});
    }
    else if (body.type === 'reset') {
      clearTimeout(botTimer);
      game = new Game();
      tokens.clear();
      for (const c of clients) {
        if (c.role !== 'host') { try { c.res.write('data: {"type":"kicked"}\n\n'); } catch (e) {} }
      }
      out = { code: game.code };
    } else if (body.type === 'kick') {
      const i = game.players.findIndex(x => x.id === body.pid);
      if (i >= 0) { tokens.delete(body.pid); game.players.splice(i, 1); }
    } else out = { error: 'Unknown host action.' };

    push();
    return json(res, 200, out);
  }

  // ---- everything else is a file
  if (p.startsWith('/public/')) return serveStatic(res, p.slice('/public/'.length));
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
  const ip = lanAddress();
  console.log('');
  console.log('  A GAME OF CONSEQUENCE');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  Projector   http://localhost:${PORT}/`);
  console.log(`  Phones      http://${ip}:${PORT}/join   (same Wi-Fi)`);
  if (publicUrl) console.log(`  Online      ${publicUrl}/join   (anywhere)`);
  console.log(`  Room code   ${game.code}`);
  console.log('');
  console.log('  Phones must be on the same Wi-Fi. Ctrl-C to stop.');
  console.log('');
});

module.exports = { server, get game() { return game; }, HOST_KEY, PORT };
