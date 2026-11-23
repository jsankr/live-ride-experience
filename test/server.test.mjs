import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ridelens-'));
process.env.DATA_DIR = dir;
process.env.API_TOKEN = 'test-token';
const { createServer } = await import('../server/server.mjs');
const server = createServer();
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const auth = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const jpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');

test('serves the app shell', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /RideLens/);
  assert.equal((await fetch(base + '/../server/server.mjs')).status, 404);
});

test('rejects unauthenticated API calls', async () => {
  assert.equal((await fetch(base + '/api/reports')).status, 401);
});

test('stores reports with photos and aggregates repeat plates', async () => {
  for (const id of ['report-aaaa-1', 'report-aaaa-2']) {
    const r = await fetch(base + '/api/reports', { method: 'POST', headers: auth, body: JSON.stringify({ id, t: Date.now(), lat: 12.9, lon: 77.6, plate: 'ka 01 ab 1234', plateValid: true, vehicleType: 'Car', photos: [{ t: 1, key: true, dataUrl: jpeg }] }) });
    assert.equal(r.status, 201);
  }
  const list = await (await fetch(base + '/api/reports?plate=KA01AB1234', { headers: auth })).json();
  assert.equal(list.length, 2);
  assert.equal(list[0].photos.length, 1);
  const img = await fetch(base + list[0].photos[0].url, { headers: auth });
  assert.equal(img.status, 200);
  const plates = await (await fetch(base + '/api/plates', { headers: auth })).json();
  assert.equal(plates[0].plate, 'KA01AB1234');
  assert.equal(plates[0].reports, 2);
  const patched = await (await fetch(base + '/api/reports/report-aaaa-1', { method: 'PATCH', headers: auth, body: JSON.stringify({ status: 'submitted to police' }) })).json();
  assert.equal(patched.status, 'submitted to police');
  const bad = await fetch(base + '/api/reports', { method: 'POST', headers: auth, body: JSON.stringify({ id: '../../etc', t: 1 }) });
  assert.equal(bad.status, 400);
});

test('keeps evidence analysis and an air-quality estimate on synced reports', async () => {
  const record = {
    id: 'evidence-test-0001', t: 1700000000000, gpsTime: 1699999999900,
    keyPhoto: 0, airQuality: { us_aqi: 77, pm2_5: 21 },
    analysis: { status: 'complete', vehicle: { type: 'Two-wheeler', frame: 0 } },
  };
  const response = await fetch(base + '/api/reports', { method: 'POST', headers: auth, body: JSON.stringify(record) });
  assert.equal(response.status, 201);
  const saved = await (await fetch(base + '/api/reports/' + record.id, { headers: auth })).json();
  assert.deepEqual(saved.airQuality, record.airQuality);
  assert.deepEqual(saved.analysis, record.analysis);
  assert.equal(saved.gpsTime, record.gpsTime);
});

test('bridges WebSocket to a Wi-Fi ELM327 over TCP', async () => {
  const elm = net.createServer((s) => s.on('data', (d) => s.write(d.toString().trim() === '010C' ? '41 0C 1A F8\r\r>' : 'OK\r\r>')));
  await new Promise((r) => elm.listen(0, '127.0.0.1', r));
  const ws = new WebSocket(`${base.replace('http', 'ws')}/obd?host=127.0.0.1&port=${elm.address().port}&token=test-token`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const reply = await new Promise((r) => { let buf = ''; ws.onmessage = (e) => { buf += e.data; if (buf.includes('>')) r(buf); }; ws.send('010C\r'); });
  assert.match(reply, /41 0C 1A F8/);
  ws.close(); elm.close();
});

test('bridge refuses public hosts', async () => {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/obd?host=8.8.8.8&port=35000&token=test-token`);
  const ok = await new Promise((r) => { ws.onopen = () => r(true); ws.onerror = () => r(false); });
  assert.equal(ok, false);
});
