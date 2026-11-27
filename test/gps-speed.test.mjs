import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpeedFilter } from '../public/js/gps-speed.js';

let seed = 3;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const gauss = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
const M = 1 / 111320; // degrees per metre (latitude)
const at = (northM, eastM = 0) => ({ lat: 13.06 + northM * M, lon: 80.25 + (eastM * M) / Math.cos(13.06 * Math.PI / 180) });

test('sitting still with the phone: GPS wander and Doppler noise read 0 km/h and add no distance', () => {
  for (const [withDoppler, accM, wanderM] of [[true, 5, 3], [false, 5, 3], [true, 15, 8], [false, 20, 12], [false, 35, 25]]) {
    const f = createSpeedFilter();
    let maxKmh = 0, distM = 0;
    for (let i = 0; i < 300; i++) { // 5 minutes at 1 Hz
      const r = f(i * 1000, { ...at(gauss() * wanderM, gauss() * wanderM), accuracy: accM, speed: withDoppler ? Math.abs(gauss()) * 0.5 : null });
      maxKmh = Math.max(maxKmh, r.speed * 3.6); distM += r.stepM;
    }
    assert.equal(maxKmh, 0, `doppler=${withDoppler} acc=${accM} wander=${wanderM}: showed ${maxKmh.toFixed(1)} km/h`);
    assert.equal(distM, 0, `added ${distM.toFixed(0)} m standing still`);
  }
});

test('riding at 30 km/h: shown within 2 s with Doppler, and distance adds up', () => {
  const f = createSpeedFilter();
  const v = 30 / 3.6; let first = null, distM = 0, last;
  for (let i = 0; i < 60; i++) {
    last = f(i * 1000, { ...at(i * v + gauss() * 3), accuracy: 6, speed: v + gauss() * 0.3 });
    if (last.moving && first == null) first = i;
    distM += last.stepM;
  }
  assert.ok(first <= 3, `moving after ${first} s`);
  assert.ok(Math.abs(last.speed * 3.6 - 30) < 3, `${(last.speed * 3.6).toFixed(1)} km/h`);
  assert.ok(Math.abs(distM - 59 * v) / (59 * v) < 0.1, `distance ${distM.toFixed(0)} m of ${(59 * v).toFixed(0)}`);
});

test('riding without Doppler (some browsers): moving within a few seconds, speed from position', () => {
  const f = createSpeedFilter();
  const v = 25 / 3.6; let first = null, last;
  for (let i = 0; i < 30; i++) { last = f(i * 1000, { ...at(i * v + gauss() * 3), accuracy: 8, speed: null }); if (last.moving && first == null) first = i; }
  assert.ok(first != null && first <= 6, `moving after ${first} s`); // slower to start without Doppler: the price of never showing wander as speed
  assert.ok(Math.abs(last.speed * 3.6 - 25) < 5, `${(last.speed * 3.6).toFixed(1)} km/h`);
});

test('stopping at a signal: back to 0 within a few seconds, no flicker while waiting', () => {
  const f = createSpeedFilter();
  const v = 35 / 3.6;
  for (let i = 0; i < 20; i++) f(i * 1000, { ...at(i * v), accuracy: 6, speed: v });
  const stopAt = 19 * v; let zeroAfter = null, flicker = 0;
  for (let i = 20; i < 80; i++) {
    const r = f(i * 1000, { ...at(stopAt + gauss() * 4), accuracy: 8, speed: Math.abs(gauss()) * 0.4 });
    if (!r.moving && zeroAfter == null) zeroAfter = i - 20;
    if (zeroAfter != null && r.moving) flicker++;
  }
  assert.ok(zeroAfter != null && zeroAfter <= 3, `0 after ${zeroAfter} s`);
  assert.equal(flicker, 0);
});

test('a GPS jump is not speed or distance', () => {
  const f = createSpeedFilter();
  for (let i = 0; i < 5; i++) f(i * 1000, { ...at(0), accuracy: 5, speed: 0 });
  const r = f(5000, { ...at(1200), accuracy: 5, speed: null });
  assert.equal(r.jump, true); assert.equal(r.speed, 0); assert.equal(r.stepM, 0);
});
