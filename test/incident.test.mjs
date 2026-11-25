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

test('detects a crash-level impact', () => {
  const an = createAnalyzer();
  let t = upright(an, 1e12, 8);
  t = upright(an, t, 0.1, () => ({ x: 4.5 * G, y: 1 * G, z: 0 }));
  upright(an, t, 2);
  const ev = an.events.filter((e) => e.type === 'crash');
  assert.equal(ev.length, 1); assert.ok(ev[0].peakG >= 4);
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
