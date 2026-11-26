import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnalyzer, G } from '../public/js/analytics.js';
import { createSimulator } from './simulator.js';

function upright(an, t0, seconds, extra = () => ({ x: 0, y: 0, z: 0 })) {
  let t = t0;
  for (let i = 0; i < seconds * 50; i++, t += 20) {
    const e = extra(t);
    an.pushImu(t, { x: 0.2 + e.x, y: G * 0.9 + e.y, z: G * 0.43 + e.z }, { x: 0, y: 0, z: 0 });
  }
  return t;
}

// GPS fix at a given speed, so the crash rule can see whether the bike stopped
const gps = (an, t, kmh) => an.pushGps(t, { lat: 12.97, lon: 77.59, alt: 900, speed: kmh / 3.6, heading: null, accuracy: 5 });
function rideWith(an, t, seconds, kmh, extra) {
  for (let s = 0; s < seconds; s++) { gps(an, t, typeof kmh === 'function' ? kmh(s) : kmh); t = upright(an, t, 1, extra); }
  return t;
}

test('a crash-level impact followed by the bike stopping is a crash', () => {
  const an = createAnalyzer();
  let t = rideWith(an, 1e12, 8, 50);
  gps(an, t, 50); t = upright(an, t, 0.1, () => ({ x: 4.5 * G, y: 1 * G, z: 0 }));
  rideWith(an, t, 6, (s) => Math.max(0, 40 - s * 15));
  const ev = an.events.filter((e) => e.type === 'crash');
  assert.equal(ev.length, 1); assert.ok(ev[0].peakG >= 4); assert.equal(ev[0].confirmedBy, 'stopped');
});

test('a 4.5 g vibration spike while riding on is not a crash (26 Nov ride had 30 of these)', () => {
  const an = createAnalyzer();
  let t = rideWith(an, 1e12, 8, 70);
  gps(an, t, 70); t = upright(an, t, 0.1, () => ({ x: 4.5 * G, y: 1 * G, z: 0 }));
  rideWith(an, t, 10, 72);
  assert.equal(an.events.filter((e) => e.type === 'crash').length, 0);
});

test('without GPS, an impact counts only when the bike then falls over', () => {
  const an = createAnalyzer();
  let t = upright(an, 1e12, 8);
  t = upright(an, t, 0.1, () => ({ x: 4.5 * G, y: 1 * G, z: 0 }));
  for (let i = 0; i < 150; i++, t += 20) an.pushImu(t, { x: G, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
  const ev = an.events.filter((e) => e.type === 'crash');
  assert.equal(ev.length, 1); assert.equal(ev[0].confirmedBy, 'fall');
});

test('detects the bike lying on its side, not a brief wobble', () => {
  const an = createAnalyzer();
  let t = upright(an, 1e12, 8);
  // brief 0.6 s tilt: no event
  const tilted = (tt) => an.pushImu(tt, { x: G, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
  for (let i = 0; i < 30; i++, t += 20) tilted(t);
  t = upright(an, t, 3);
  assert.equal(an.events.filter((e) => e.type === 'fall').length, 0);
  // 3 s on its side: one fall event
  for (let i = 0; i < 150; i++, t += 20) tilted(t);
  const falls = an.events.filter((e) => e.type === 'fall');
  assert.equal(falls.length, 1); assert.ok(falls[0].tiltDeg >= 55);
});

test('normal riding (simulated 10 min, potholes and hard brakes) raises no crash or fall', () => {
  const an = createAnalyzer();
  const sim = createSimulator({ seed: 21, onImu: (t, a, g) => an.pushImu(t, a, g), onGps: (t, f) => an.pushGps(t, f), onObd: (t, d) => an.pushObd(t, d) });
  for (let i = 0; i < 600 * 50; i++) sim.step(0.02);
  assert.ok(sim.truth.potholes > 5 && sim.truth.hardBrakes > 3);
  assert.equal(an.events.filter((e) => e.type === 'crash' || e.type === 'fall').length, 0);
});
