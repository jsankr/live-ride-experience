import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePid, parseSupported, Elm327 } from '../public/js/obd.js';

test('parses common PIDs from raw ELM327 replies', () => {
  assert.equal(parsePid('0C', '41 0C 1A F8 \r\r>'), 1726);
  assert.equal(parsePid('0D', '410D3C\r>'), 60);
  assert.equal(parsePid('05', 'SEARCHING...\r41 05 7B\r>'), 83);
  assert.equal(Math.round(parsePid('11', '41 11 80')), 50);
  assert.equal(parsePid('0D', 'NO DATA\r>'), null);
  assert.equal(parsePid('0C', '7E8 04 41 0C 0B B8\r'), 750); // headers on
});

test('decodes the supported-PID bitmap', () => {
  const s = parseSupported('00', '41 00 BE 1F A8 13');
  for (const p of ['01', '03', '04', '05', '06', '07', '0C', '0D', '0F', '10', '11', '13', '15', '1C', '1F', '20']) assert.ok(s.has(p), p);
  assert.ok(!s.has('02'));
});

test('ELM327 session initialises and polls against a fake adapter', async () => {
  const replies = { '0100': '41 00 18 18 80 00', '010C': '41 0C 1A F8', '010D': '41 0D 28', '0105': '41 05 6E', '0111': '41 11 33' };
  let listener;
  const tx = {
    onData: (fn) => { listener = fn; },
    write: async (s) => { const c = s.trim(); setTimeout(() => listener((replies[c] ?? 'OK') + '\r\r>'), 1); },
    close() {},
  };
  const elm = new Elm327(tx);
  const sup = await elm.init();
  assert.deepEqual([...sup].sort(), ['04', '05', '0C', '0D', '11']);
  const got = await new Promise((resolve) => elm.start((t, d) => { elm.stop(); resolve(d); }));
  assert.equal(got.rpm, 1726);
  assert.equal(got.speed, 40);
  assert.equal(got.throttle, 20);
});
