#!/usr/bin/env node
// RideLens server - zero dependencies (Node >= 22.5 for node:sqlite).
//   * serves the PWA from ../public
//   * stores wrong-side reports (+ photos) and ride summaries in SQLite
//   * bridges Wi-Fi ELM327 adapters (raw TCP) to the browser over WebSocket at /obd
//
// Env: PORT=8080  DATA_DIR=./data  API_TOKEN=secret  TLS_CERT=cert.pem TLS_KEY=key.pem
//      OBD_ALLOW_ANY_HOST=1 (by default the bridge only dials private/LAN addresses)
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(here, '../public');
const DATA = path.resolve(process.env.DATA_DIR || path.join(here, '../data'));
const PHOTOS = path.join(DATA, 'photos');
const PORT = +process.env.PORT || 8080;
const TOKEN = process.env.API_TOKEN || '';
fs.mkdirSync(PHOTOS, { recursive: true });

// ---------------- database ----------------
export const db = new DatabaseSync(path.join(DATA, 'ridelens.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY, t INTEGER NOT NULL, lat REAL, lon REAL, accuracy REAL, heading REAL,
    my_speed_kmh REAL, violation TEXT, vehicle_type TEXT, plate TEXT, plate_valid INTEGER,
    color TEXT, notes TEXT, status TEXT, ride_id TEXT, received_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS reports_plate ON reports(plate);
  CREATE INDEX IF NOT EXISTS reports_t ON reports(t);
  CREATE TABLE IF NOT EXISTS report_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    t INTEGER, is_key INTEGER, file TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rides (
    id TEXT PRIMARY KEY, start_t INTEGER, distance_km REAL, score INTEGER, potholes INTEGER,
    hard_brakes INTEGER, json TEXT NOT NULL, received_at INTEGER NOT NULL
  );
`);

const upsertReport = db.prepare(`INSERT INTO reports (id,t,lat,lon,accuracy,heading,my_speed_kmh,violation,vehicle_type,plate,plate_valid,color,notes,status,ride_id,received_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET vehicle_type=excluded.vehicle_type, plate=excluded.plate, plate_valid=excluded.plate_valid,
    color=excluded.color, notes=excluded.notes, status=excluded.status`);
const insPhoto = db.prepare('INSERT INTO report_photos (report_id,t,is_key,file) VALUES (?,?,?,?)');
const photosOf = db.prepare('SELECT t, is_key, file FROM report_photos WHERE report_id = ? ORDER BY t');

const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const str = (v, n = 200) => (v == null ? null : String(v).slice(0, n));
const num = (v) => (v == null || v === '' || Number.isNaN(+v) ? null : +v);

export function storeReport(r) {
  if (!r || !ID_RE.test(r.id || '')) throw httpError(400, 'invalid id');
  if (!Number.isFinite(+r.t)) throw httpError(400, 'invalid t');
  const plate = str(r.plate, 16)?.toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
  const existing = db.prepare('SELECT 1 FROM reports WHERE id = ?').get(r.id);
  upsertReport.run(r.id, +r.t, num(r.lat), num(r.lon), num(r.accuracy), num(r.heading), num(r.mySpeedKmh),
    str(r.violation, 40) || 'wrong-side', str(r.vehicleType, 40), plate, r.plateValid ? 1 : 0,
    str(r.color, 40), str(r.notes, 2000), str(r.status, 40) || 'new', str(r.rideId, 64), Date.now());
  if (!existing && Array.isArray(r.photos)) {
    r.photos.slice(0, 20).forEach((p, i) => {
      const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(p?.dataUrl || '');
      if (!m) return;
      const file = `${r.id}-${i}.jpg`;
      fs.writeFileSync(path.join(PHOTOS, file), Buffer.from(m[1], 'base64'));
      insPhoto.run(r.id, num(p.t), p.key ? 1 : 0, file);
    });
  }
  return { id: r.id, created: !existing };
}

function rowToReport(row) {
  return { ...row, plate_valid: !!row.plate_valid, photos: photosOf.all(row.id).map((p) => ({ ...p, url: `/photos/${p.file}` })) };
}

// ---------------- http ----------------
function httpError(status, msg) { const e = new Error(msg); e.status = status; return e; }
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'content-type': isJson ? 'application/json' : 'text/plain', ...cors, ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
};
async function readJson(req, limit = 30 * 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw httpError(413, 'payload too large'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw httpError(400, 'invalid JSON'); }
}
function authed(req) {
  if (!TOKEN) return true;
  const h = req.headers.authorization || '';
  const given = Buffer.from(h.replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(TOKEN);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png' };
function serveFile(res, root, rel) {
  const p = path.resolve(root, '.' + path.posix.normalize('/' + rel));
  if (!p.startsWith(root)) return send(res, 403, 'forbidden');
  fs.stat(p, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-cache', ...cors });
    fs.createReadStream(p).pipe(res);
  });
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (p === '/api/health') return send(res, 200, { ok: true, auth: !!TOKEN });
    if (p.startsWith('/api/') || p.startsWith('/photos/')) {
      if (!authed(req)) return send(res, 401, { error: 'unauthorized' });
    }
    if (p.startsWith('/photos/')) return serveFile(res, PHOTOS, p.slice('/photos/'.length));

    if (p === '/api/reports' && req.method === 'POST') return send(res, 201, storeReport(await readJson(req)));
    if (p === '/api/reports' && req.method === 'GET') {
      const where = [], args = [];
      if (url.searchParams.get('plate')) { where.push('plate = ?'); args.push(url.searchParams.get('plate').toUpperCase().replace(/[^A-Z0-9]/g, '')); }
      if (url.searchParams.get('since')) { where.push('t >= ?'); args.push(+url.searchParams.get('since')); }
      if (url.searchParams.get('status')) { where.push('status = ?'); args.push(url.searchParams.get('status')); }
      const limit = Math.min(500, +url.searchParams.get('limit') || 100);
      const rows = db.prepare(`SELECT * FROM reports ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t DESC LIMIT ${limit}`).all(...args);
      return send(res, 200, rows.map(rowToReport));
    }
    if (p === '/api/plates' && req.method === 'GET') {
      // repeat offenders: plates seen in more than one report
      return send(res, 200, db.prepare(`SELECT plate, COUNT(*) AS reports, MIN(t) AS first_t, MAX(t) AS last_t, GROUP_CONCAT(DISTINCT vehicle_type) AS vehicle_types
        FROM reports WHERE plate IS NOT NULL AND plate != '' GROUP BY plate ORDER BY reports DESC, last_t DESC LIMIT 200`).all());
    }
    const m = /^\/api\/reports\/([A-Za-z0-9-]{8,64})$/.exec(p);
    if (m) {
      const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(m[1]);
      if (!row) return send(res, 404, { error: 'not found' });
      if (req.method === 'GET') return send(res, 200, rowToReport(row));
      if (req.method === 'PATCH') {
        const b = await readJson(req, 64 * 1024);
        db.prepare('UPDATE reports SET status = COALESCE(?, status), notes = COALESCE(?, notes) WHERE id = ?').run(str(b.status, 40), str(b.notes, 2000), m[1]);
        return send(res, 200, rowToReport(db.prepare('SELECT * FROM reports WHERE id = ?').get(m[1])));
      }
      if (req.method === 'DELETE') {
        for (const ph of photosOf.all(m[1])) fs.rmSync(path.join(PHOTOS, ph.file), { force: true });
        db.prepare('DELETE FROM report_photos WHERE report_id = ?').run(m[1]);
        db.prepare('DELETE FROM reports WHERE id = ?').run(m[1]);
        return send(res, 200, { deleted: m[1] });
      }
    }
    if (p === '/api/rides' && req.method === 'POST') {
      const r = await readJson(req);
      if (!ID_RE.test(r.id || '') || !r.summary) throw httpError(400, 'invalid ride');
      const s = r.summary;
      db.prepare(`INSERT OR REPLACE INTO rides (id,start_t,distance_km,score,potholes,hard_brakes,json,received_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(r.id, num(s.startT), num(s.distanceKm), num(s.scores?.overall), num(s.potholes), num(s.hardBrakes), JSON.stringify(r), Date.now());
      return send(res, 201, { id: r.id });
    }
    if (p === '/api/rides' && req.method === 'GET') {
      return send(res, 200, db.prepare('SELECT id,start_t,distance_km,score,potholes,hard_brakes FROM rides ORDER BY start_t DESC LIMIT 200').all());
    }
    if (p.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    return serveFile(res, PUBLIC, p === '/' ? 'index.html' : p.slice(1));
  } catch (e) {
    return send(res, e.status || 500, { error: e.status ? e.message : 'internal error' });
  }
}

// ---------------- WebSocket <-> TCP bridge for Wi-Fi ELM327 ----------------
const PRIVATE = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^127\./, /^169\.254\./];
function wsFrame(str) {
  const payload = Buffer.from(str);
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x81, len]) : len < 65536 ? Buffer.from([0x81, 126, len >> 8, len & 255]) : null;
  if (!head) throw new Error('frame too large');
  return Buffer.concat([head, payload]);
}
function wsParse(buf) { // returns {frames, rest}
  const frames = []; let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off], b1 = buf[off + 1];
    let len = b1 & 0x7f, p = off + 2;
    if (len === 126) { if (buf.length - p < 2) break; len = buf.readUInt16BE(p); p += 2; } else if (len === 127) { return { frames, rest: Buffer.alloc(0), error: true }; }
    const masked = b1 & 0x80;
    if (buf.length - p < (masked ? 4 : 0) + len) break;
    let data = buf.subarray(p + (masked ? 4 : 0), p + (masked ? 4 : 0) + len);
    if (masked) { const k = buf.subarray(p, p + 4); data = Buffer.from(data.map((x, i) => x ^ k[i & 3])); }
    frames.push({ op: b0 & 0x0f, data });
    off = p + (masked ? 4 : 0) + len;
  }
  return { frames, rest: buf.subarray(off) };
}

function onUpgrade(req, socket) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/obd' || req.headers.upgrade?.toLowerCase() !== 'websocket') return socket.destroy();
  if (TOKEN && url.searchParams.get('token') !== TOKEN) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
  const host = url.searchParams.get('host') || '192.168.0.10';
  const port = +url.searchParams.get('port') || 35000;
  if (!net.isIP(host) || (!process.env.OBD_ALLOW_ANY_HOST && !PRIVATE.some((re) => re.test(host)))) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\nOBD bridge only dials LAN addresses'); return;
  }
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const tcp = net.connect({ host, port, timeout: 8000 });
  tcp.setNoDelay(true);
  tcp.on('data', (d) => { if (!socket.destroyed) socket.write(wsFrame(d.toString('latin1'))); });
  const end = () => { tcp.destroy(); socket.destroy(); };
  tcp.on('error', end); tcp.on('close', end); tcp.on('timeout', () => { if (!tcp.readyState || tcp.connecting) end(); });
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    const r = wsParse(Buffer.concat([buf, chunk]));
    buf = r.rest;
    if (r.error) return end();
    for (const f of r.frames) {
      if (f.op === 1 || f.op === 2) tcp.write(f.data);
      else if (f.op === 8) return end();
      else if (f.op === 9) socket.write(Buffer.concat([Buffer.from([0x8a, f.data.length]), f.data]));
    }
  });
  socket.on('error', end); socket.on('close', end);
}

// ---------------- start ----------------
export function createServer() {
  const tls = process.env.TLS_CERT && process.env.TLS_KEY;
  const server = tls
    ? https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }, handle)
    : http.createServer(handle);
  server.on('upgrade', onUpgrade);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, () => {
    console.log(`RideLens on ${process.env.TLS_CERT ? 'https' : 'http'}://localhost:${PORT}  (data: ${DATA}${TOKEN ? ', token auth on' : ''})`);
  });
}
