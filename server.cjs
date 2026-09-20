'use strict';

// RDZEŃ: shared authoritative arena. Node.js built-ins only; no npm install.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const os = require('node:os');

const PORT = Number(process.env.PORT || 8787);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('PORT musi być liczbą od 1 do 65535.');
  process.exit(1);
}
let html, Engine;
try {
  html = fs.readFileSync(path.join(__dirname, 'rdzen-arena.html'), 'utf8');
  const match = html.match(/<script\b(?=[^>]*\bid=["']arena-engine["'])[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error('Brak wspólnego silnika arena-engine w pliku HTML.');
  const context = vm.createContext({ console, Math, Date, performance });
  vm.runInContext(match[1], context, { filename: 'arena-engine.js', timeout: 5000 });
  Engine = context.ArenaEngine;
  for (const method of ['createWorld', 'join', 'remove', 'input', 'step', 'upgrade', 'chooseClass', 'respawn', 'snapshot']) {
    if (typeof Engine?.[method] !== 'function') throw new Error('Brak funkcji silnika: ' + method);
  }
} catch (error) {
  console.error('Nie można uruchomić areny: ' + error.message);
  console.error('Umieść server.cjs oraz rdzen-arena.html w tym samym folderze.');
  process.exit(1);
}

const rooms = new Map();
const sessions = new Map();
const joinLimits = new Map();
const idleInput = Object.freeze({ x: 0, y: 0, angle: 0, fire: false, boost: false, dash: false });
const MAX_ROOMS = 20;
const MAX_PLAYERS = 12;
const RECONNECT_MS = 10000;
const BODY_LIMIT = 4096;

function json(res, status, data) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function cors(req, res) {
  const origin = req.headers.origin;
  let allowed = '*';
  if (origin === 'null') allowed = 'null';
  else if (origin) {
    try {
      const parsed = new URL(origin);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) return false;
      allowed = origin;
    } catch { return false; }
  }
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return true;
}

async function readJSON(req) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw Object.assign(new Error('Wymagany Content-Type: application/json.'), { status: 415 });
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw Object.assign(new Error('Wiadomość jest za duża.'), { status: 413 });
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Nieprawidłowy JSON.'), { status: 400 }); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Object.assign(new Error('Wymagany obiekt JSON.'), { status: 400 });
  return data;
}

function getSession(req) {
  const token = String(req.headers.authorization || '').match(/^Bearer ([a-f0-9]{48})$/)?.[1];
  return token ? sessions.get(token) : null;
}

function allowSession(session, kind, now) {
  const rate = kind === 'input' ? 60 : 8;
  const bucket = session.limits[kind];
  bucket.available = Math.min(rate * 2, bucket.available + (now - bucket.time) * rate / 1000);
  bucket.time = now;
  if (bucket.available < 1) return false;
  bucket.available -= 1;
  return true;
}

function endSession(session) {
  if (!sessions.delete(session.token)) return;
  session.room.members.delete(session.id);
  Engine.remove(session.room.world, session.id);
  const stream = session.stream;
  session.stream = null;
  if (stream && !stream.writableEnded) stream.end();
  if (!session.room.members.size) rooms.delete(session.room.name);
}

function validateInput(data) {
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  if (!finite(data.x) || !finite(data.y) || !finite(data.angle)) return null;
  const clamp = value => Math.max(-1, Math.min(1, value));
  return {
    x: clamp(data.x), y: clamp(data.y), angle: data.angle % (Math.PI * 2),
    fire: data.fire === true, boost: data.boost === true, dash: data.dash === true,
  };
}

const server = http.createServer(async (req, res) => {
  if (!cors(req, res)) return json(res, 403, { error: 'Nieprawidłowe źródło żądania.' });
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  let url;
  try { url = new URL(req.url, 'http://arena.local'); }
  catch { return json(res, 400, { error: 'Nieprawidłowy adres.' }); }
  const now = performance.now();
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(html);
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, name: 'RDZEŃ', protocol: 1, players: sessions.size, rooms: rooms.size });
    }
    if (req.method === 'POST' && url.pathname === '/join') {
      const address = req.socket.remoteAddress || 'unknown';
      let limit = joinLimits.get(address);
      if (!limit || now - limit.start > 60000) { limit = { start: now, count: 0 }; joinLimits.set(address, limit); }
      if (++limit.count > 30) return json(res, 429, { error: 'Za dużo prób dołączenia. Poczekaj minutę.' });
      const data = await readJSON(req);
      let roomName = typeof data.room === 'string' && data.room.trim() ? data.room.trim().toUpperCase() : '';
      if (!roomName) {
        // Fill an existing arena first. Create another only when every arena is full.
        const available = [...rooms.values()].filter(room => room.members.size < MAX_PLAYERS)
          .sort((a, b) => b.members.size - a.members.size)[0];
        if (available) roomName = available.name;
        else {
          roomName = 'ARENA';
          for (let n = 2; rooms.has(roomName); n++) roomName = 'ARENA' + n;
        }
      }
      if (!/^[A-Z0-9]{3,12}$/.test(roomName)) return json(res, 400, { error: 'Kod pokoju: od 3 do 12 liter A-Z lub cyfr.' });
      const name = Array.from(String(data.name || 'Pilot').replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, 18).join('') || 'Pilot';
      let room = rooms.get(roomName);
      if (!room) {
        if (rooms.size >= MAX_ROOMS) return json(res, 503, { error: 'Serwer ma już maksymalną liczbę pokoi.' });
        room = { name: roomName, world: Engine.createWorld({ bots: 6, difficulty: 'normal', seed: crypto.randomInt(1, 2147483647) }), members: new Set() };
        rooms.set(roomName, room);
      }
      if (room.members.size >= MAX_PLAYERS) return json(res, 409, { error: 'Ten pokój jest pełny (12 graczy).' });
      const id = crypto.randomUUID();
      const token = crypto.randomBytes(24).toString('hex');
      Engine.join(room.world, { id, name });
      const session = {
        id, token, room, stream: null, deadline: now + RECONNECT_MS,
        lastInput: now, inputIdle: false,
        limits: { input: { time: now, available: 120 }, action: { time: now, available: 16 } },
      };
      room.members.add(id);
      sessions.set(token, session);
      return json(res, 200, { id, token, room: roomName });
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      const token = url.searchParams.get('token');
      const session = /^[a-f0-9]{48}$/.test(token || '') ? sessions.get(token) : null;
      if (!session) return json(res, 401, { error: 'Sesja wygasła. Dołącz ponownie.' });
      const previous = session.stream;
      session.stream = res;
      session.deadline = Infinity;
      if (previous && !previous.writableEnded) previous.end();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      req.socket.setNoDelay(true);
      res.write('retry: 1500\n\n');
      res.write('event: state\ndata: ' + JSON.stringify(Engine.snapshot(session.room.world)) + '\n\n');
      res.on('close', () => {
        if (session.stream === res) {
          session.stream = null;
          session.deadline = performance.now() + RECONNECT_MS;
          Engine.input(session.room.world, session.id, idleInput);
          session.inputIdle = true;
        }
      });
      return;
    }
    if (req.method === 'POST' && (url.pathname === '/input' || url.pathname === '/action')) {
      const session = getSession(req);
      if (!session) return json(res, 401, { error: 'Sesja wygasła. Dołącz ponownie.' });
      const kind = url.pathname === '/input' ? 'input' : 'action';
      if (!allowSession(session, kind, now)) return json(res, 429, { error: 'Za dużo wiadomości. Zwolnij.' });
      const data = await readJSON(req);
      if (kind === 'input') {
        const input = validateInput(data);
        if (!input) return json(res, 400, { error: 'Nieprawidłowe sterowanie.' });
        Engine.input(session.room.world, session.id, input);
        session.lastInput = performance.now();
        session.inputIdle = false;
      } else if (data.type === 'upgrade' && typeof data.stat === 'string' && data.stat.length < 40) {
        Engine.upgrade(session.room.world, session.id, data.stat);
      } else if (data.type === 'class' && typeof data.classId === 'string' && data.classId.length < 40) {
        Engine.chooseClass(session.room.world, session.id, data.classId);
      } else if (data.type === 'respawn') {
        Engine.respawn(session.room.world, session.id);
      } else if (data.type === 'leave') {
        endSession(session);
      } else return json(res, 400, { error: 'Nieznana akcja.' });
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'Nie znaleziono.' });
  } catch (error) {
    if (!error.status) console.error('Błąd żądania:', error.message);
    json(res, error.status || 500, { error: error.status ? error.message : 'Błąd serwera. Spróbuj ponownie.' });
  }
});

server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 40;
let lastStep = performance.now();
let lastPing = lastStep;
const timer = setInterval(() => {
  const now = performance.now();
  const dt = Math.max(0.001, Math.min(0.1, (now - lastStep) / 1000));
  lastStep = now;
  for (const session of sessions.values()) {
    if (!session.stream && now >= session.deadline) { endSession(session); continue; }
    if (!session.inputIdle && now - session.lastInput > 400) {
      Engine.input(session.room.world, session.id, idleInput);
      session.inputIdle = true;
    }
  }
  for (const room of rooms.values()) {
    Engine.step(room.world, dt);
    const state = 'event: state\ndata: ' + JSON.stringify(Engine.snapshot(room.world)) + '\n\n';
    for (const id of room.members) {
      // Room size is capped; room membership never contains client credentials.
      const session = [...sessions.values()].find(item => item.id === id);
      const stream = session?.stream;
      if (!stream || stream.destroyed || stream.writableEnded) continue;
      if (stream.writableLength > 1024 * 1024) { stream.destroy(); continue; }
      stream.write(state);
      if (now - lastPing >= 10000) stream.write(': ping\n\n');
    }
  }
  if (now - lastPing >= 10000) {
    lastPing = now;
    for (const [address, limit] of joinLimits) if (now - limit.start > 60000) joinLimits.delete(address);
  }
}, 40);

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${PORT} jest zajęty. Zamknij drugi serwer lub ustaw zmienną PORT.` : error.message);
  clearInterval(timer);
  process.exitCode = 1;
});
server.listen(PORT, '0.0.0.0', () => {
  console.log('\nRDZEŃ — serwer multiplayer działa.');
  console.log(`Na tym komputerze: http://localhost:${PORT}`);
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const network of interfaces || []) {
      if (network.family === 'IPv4' && !network.internal) console.log(`W tej samej sieci: http://${network.address}:${PORT}`);
    }
  }
  console.log('Otwórzcie ten sam adres. Gra automatycznie łączy z aktywnym pokojem. Ctrl+C zatrzymuje serwer.\n');
});

function shutdown() {
  clearInterval(timer);
  for (const session of [...sessions.values()]) endSession(session);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
