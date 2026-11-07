// Wonder Wall — a live sticky-note wall for classrooms.
// Teacher creates a wall, students scan the QR code, then type or draw a note.
// Run: node server.js   (optional env: PORT, TEACHER_PIN, PUBLIC_URL)

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 3000;
const TEACHER_PIN = process.env.TEACHER_PIN || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 2 * 1024 * 1024; // 2 MB (drawings are PNG data URLs)

// ---------- storage ----------
// Uses Postgres when DATABASE_URL is set (online hosting); otherwise JSON files in DATA_DIR.
// Only a small summary of every wall stays in memory. Full walls (with drawings) are loaded
// when opened and unloaded again after a while, so memory stays small however many walls you save.
const summaries = new Map(); // code -> { code, title, prompt, createdAt, open, count }
const cache = new Map();     // code -> { wall, used }
const loading = new Map();   // code -> Promise<wall|null>
const db = process.env.DATABASE_URL
  ? new (require('pg').Pool)({ connectionString: process.env.DATABASE_URL, max: 3 })
  : null;
const summary = (w) => ({
  code: w.code, title: w.title, prompt: w.prompt, createdAt: w.createdAt,
  open: w.open, count: w.notes.length,
});
const fileOf = (code) => path.join(DATA_DIR, code + '.json');

async function loadSummaries() {
  if (db) {
    await db.query('CREATE TABLE IF NOT EXISTS walls (code text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
    const { rows } = await db.query(`SELECT code, data->>'title' AS title, data->>'prompt' AS prompt,
      (data->>'createdAt')::bigint AS "createdAt", (data->>'open')::boolean AS open,
      jsonb_array_length(data->'notes') AS count FROM walls`);
    for (const r of rows) summaries.set(r.code, { ...r, createdAt: Number(r.createdAt), prompt: r.prompt || '' });
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!f.endsWith('.json')) continue;
    try { const w = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); summaries.set(w.code, summary(w)); }
    catch (e) { console.error('Could not read', f, e.message); }
  }
}
async function getWall(code) {
  code = String(code).toUpperCase();
  const hit = cache.get(code);
  if (hit) { hit.used = Date.now(); return hit.wall; }
  if (!summaries.has(code)) return null;
  if (!loading.has(code)) {
    loading.set(code, (async () => {
      let w = null;
      if (db) { const { rows } = await db.query('SELECT data FROM walls WHERE code = $1', [code]); w = rows[0]?.data || null; }
      else { try { w = JSON.parse(await fs.promises.readFile(fileOf(code), 'utf8')); } catch {} }
      if (w && summaries.has(code)) cache.set(code, { wall: w, used: Date.now() });
      return w;
    })().finally(() => loading.delete(code)));
  }
  return loading.get(code);
}
const saveTimers = new Map(); // code -> { timer, wall }
function writeWall(w) {
  if (!summaries.has(w.code)) return Promise.resolve(); // deleted meanwhile
  if (db) {
    return db.query('INSERT INTO walls (code, data) VALUES ($1, $2) ON CONFLICT (code) DO UPDATE SET data = EXCLUDED.data, updated_at = now()',
      [w.code, JSON.stringify(w)]).catch((e) => console.error('save failed', e.message));
  }
  const file = fileOf(w.code);
  return fs.promises.writeFile(file + '.tmp', JSON.stringify(w))
    .then(() => fs.promises.rename(file + '.tmp', file)).catch((e) => console.error('save failed', e.message));
}
function saveWall(w) {
  summaries.set(w.code, summary(w));
  clearTimeout(saveTimers.get(w.code)?.timer);
  saveTimers.set(w.code, { wall: w, timer: setTimeout(() => { saveTimers.delete(w.code); writeWall(w); }, 300) });
}
// When the host restarts the app (e.g. a new deploy), save anything still waiting first.
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  const pending = [...saveTimers.values()]; saveTimers.clear();
  pending.forEach((p) => clearTimeout(p.timer));
  await Promise.all(pending.map((p) => writeWall(p.wall)));
  if (db) await db.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
function removeWall(code) {
  summaries.delete(code); cache.delete(code);
  clearTimeout(saveTimers.get(code)?.timer); saveTimers.delete(code);
  if (db) return db.query('DELETE FROM walls WHERE code = $1', [code]).catch((e) => console.error(e.message));
  fs.rm(fileOf(code), { force: true }, () => {});
}
// Unload walls nobody has used for 20 minutes (never one that is open on a screen or still saving).
const IDLE_MS = Number(process.env.WALL_IDLE_MS) || 20 * 60 * 1000;
setInterval(() => {
  for (const [code, c] of cache)
    if (Date.now() - c.used > IDLE_MS && !listeners.get(code)?.size && !saveTimers.has(code)) cache.delete(code);
}, Math.min(IDLE_MS, 60 * 1000));
function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from(crypto.randomBytes(5), (b) => chars[b % chars.length]).join(''); }
  while (summaries.has(c));
  return c;
}

// ---------- live updates (Server-Sent Events) ----------
const listeners = new Map(); // code -> Set(res)
function broadcast(code, event, data) {
  const set = listeners.get(code);
  if (!set) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(msg);
}
setInterval(() => { for (const set of listeners.values()) for (const r of set) r.write(': ping\n\n'); }, 25000);

// ---------- helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(new Error('bad json')); } });
  });
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((s) => s.trim().split('=')).filter((p) => p[0]));
}
const pinToken = TEACHER_PIN ? crypto.createHash('sha256').update('ww:' + TEACHER_PIN).digest('hex') : '';
const loginAttempts = new Map();
const isTeacher = (req) => !TEACHER_PIN || cookies(req).ww_teacher === pinToken;
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  return 'localhost';
}
function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  let host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  // If the teacher opened it on localhost, give students the computer's Wi-Fi address instead.
  if (/^(localhost|127\.0\.0\.1)(:|$)/.test(host)) host = host.replace(/^(localhost|127\.0\.0\.1)/, lanAddress());
  return `${proto}://${host}`;
}
function serveFile(res, file) {
  fs.readFile(path.join(PUBLIC_DIR, file), (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const COLORS = ['#fff475', '#ffb3c7', '#a7f3d0', '#bfdbfe', '#fed7aa', '#ddd6fe'];

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = (re) => p.match(re);
  let r;

  try {
    // Pages
    if (req.method === 'GET') {
      if (p === '/') return serveFile(res, isTeacher(req) ? 'teacher.html' : 'login.html');
      if ((r = m(/^\/wall\/([A-Z0-9]{5})$/))) return serveFile(res, isTeacher(req) ? 'wall.html' : 'login.html');
      if (m(/^\/(s|j)\/[A-Za-z0-9]{5}$/)) return serveFile(res, 'student.html');
      if (p === '/join') return serveFile(res, 'join.html');
      if (p === '/healthz') return send(res, 200, 'ok', 'text/plain');
      if (m(/^\/[\w-]+\.(css|js|svg|png)$/)) return serveFile(res, p.slice(1));
    }

    // Teacher login
    if (p === '/api/login' && req.method === 'POST') {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
      const a = loginAttempts.get(ip) || { n: 0, t: Date.now() };
      if (Date.now() - a.t > 10 * 60 * 1000) { a.n = 0; a.t = Date.now(); }
      if (a.n >= 10) return send(res, 429, { error: 'Too many tries. Wait 10 minutes.' });
      const { pin } = await readBody(req);
      if (TEACHER_PIN && pin !== TEACHER_PIN) { a.n++; loginAttempts.set(ip, a); return send(res, 401, { error: 'Wrong PIN' }); }
      res.setHeader('Set-Cookie', `ww_teacher=${pinToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
      return send(res, 200, { ok: true });
    }

    // Student-facing (public) API
    if ((r = m(/^\/api\/walls\/([A-Za-z0-9]{5})\/info$/)) && req.method === 'GET') {
      const w = summaries.get(r[1].toUpperCase()); // no need to load the drawings
      if (!w) return send(res, 404, { error: 'Wall not found' });
      return send(res, 200, { code: w.code, title: w.title, prompt: w.prompt, open: w.open });
    }
    if ((r = m(/^\/api\/walls\/([A-Za-z0-9]{5})\/notes$/)) && req.method === 'POST') {
      const w = await getWall(r[1]);
      if (!w) return send(res, 404, { error: 'Wall not found' });
      if (!w.open) return send(res, 403, { error: 'This wall is closed.' });
      const b = await readBody(req);
      const note = {
        id: crypto.randomUUID(),
        name: clean(b.name, 40),
        text: clean(b.text, 500).replace(/\s+/g, ' '),
        drawing: typeof b.drawing === 'string' && b.drawing.startsWith('data:image/png;base64,') ? b.drawing : '',
        color: COLORS.includes(b.color) ? b.color : COLORS[0],
        createdAt: Date.now(),
        x: null, y: null,
      };
      if (!note.text && !note.drawing) return send(res, 400, { error: 'Write or draw something first.' });
      w.notes.push(note);
      saveWall(w);
      broadcast(w.code, 'note', note);
      return send(res, 201, { ok: true });
    }

    // Everything below is teacher-only
    if (p.startsWith('/api/') && !isTeacher(req)) return send(res, 401, { error: 'Teacher login required' });

    if (p === '/api/walls' && req.method === 'GET')
      return send(res, 200, [...summaries.values()].sort((a, b) => b.createdAt - a.createdAt));

    if (p === '/api/walls' && req.method === 'POST') {
      const b = await readBody(req);
      const w = { code: newCode(), title: clean(b.title, 80) || 'Wonder Wall', prompt: clean(b.prompt, 200), createdAt: Date.now(), open: true, notes: [] };
      cache.set(w.code, { wall: w, used: Date.now() });
      saveWall(w);
      return send(res, 201, summary(w));
    }

    if ((r = m(/^\/api\/walls\/([A-Z0-9]{5})$/))) {
      const w = await getWall(r[1]);
      if (!w) return send(res, 404, { error: 'Wall not found' });
      if (req.method === 'GET') return send(res, 200, { ...w, joinUrl: `${baseUrl(req)}/s/${w.code}` });
      if (req.method === 'PATCH') {
        const b = await readBody(req);
        if (typeof b.open === 'boolean') w.open = b.open;
        if (typeof b.title === 'string') w.title = clean(b.title, 80) || w.title;
        if (typeof b.prompt === 'string') w.prompt = clean(b.prompt, 200);
        saveWall(w);
        broadcast(w.code, 'wall', summary(w));
        return send(res, 200, summary(w));
      }
      if (req.method === 'DELETE') {
        removeWall(w.code);
        return send(res, 200, { ok: true });
      }
    }

    if ((r = m(/^\/api\/walls\/([A-Z0-9]{5})\/notes\/([\w-]+)$/))) {
      const w = await getWall(r[1]);
      const note = w && w.notes.find((n) => n.id === r[2]);
      if (!note) return send(res, 404, { error: 'Note not found' });
      if (req.method === 'DELETE') {
        w.notes = w.notes.filter((n) => n !== note);
        saveWall(w); broadcast(w.code, 'remove', { id: note.id });
        return send(res, 200, { ok: true });
      }
      if (req.method === 'PATCH') { // move a note on the wall
        const b = await readBody(req);
        if (Number.isFinite(b.x) && Number.isFinite(b.y)) { note.x = Math.max(0, Math.min(1, b.x)); note.y = Math.max(0, b.y); }
        saveWall(w); broadcast(w.code, 'move', { id: note.id, x: note.x, y: note.y });
        return send(res, 200, { ok: true });
      }
    }

    if ((r = m(/^\/api\/walls\/([A-Z0-9]{5})\/qr\.svg$/)) && req.method === 'GET') {
      const svg = await QRCode.toString(`${baseUrl(req)}/s/${r[1]}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      return send(res, 200, svg, 'image/svg+xml');
    }

    if ((r = m(/^\/api\/walls\/([A-Z0-9]{5})\/events$/)) && req.method === 'GET') {
      if (!summaries.has(r[1])) return send(res, 404, { error: 'Wall not found' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': connected\n\n');
      if (!listeners.has(r[1])) listeners.set(r[1], new Set());
      listeners.get(r[1]).add(res);
      req.on('close', () => listeners.get(r[1])?.delete(res));
      return;
    }

    if ((r = m(/^\/api\/walls\/([A-Z0-9]{5})\/export$/)) && req.method === 'GET') {
      const w = await getWall(r[1]);
      if (!w) return send(res, 404, { error: 'Wall not found' });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="wonder-wall-${w.code}.json"` });
      return res.end(JSON.stringify(w, null, 2));
    }

    send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

loadSummaries().then(() => server.listen(PORT, () => {
  console.log(`\nWonder Wall is running!`);
  console.log(`  Teacher (this computer):  http://localhost:${PORT}`);
  console.log(`  Same Wi-Fi devices:       http://${lanAddress()}:${PORT}`);
  console.log(TEACHER_PIN ? '  Teacher PIN is ON.' : '  Tip: set TEACHER_PIN=1234 to lock the teacher pages.');
  console.log('');
}));
