import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnalyzer, G, comfortClass, haversine } from '../public/js/analytics.js';
import { createSimulator } from './simulator.js';

function runSim({ seconds = 900, seed = 7, obd = true } = {}) {
  const an = createAnalyzer();
  const sim = createSimulator({
    seed,
    onImu: (t, a, g) => an.pushImu(t, a, g),
    onGps: (t, f) => an.pushGps(t, f),
    onObd: obd ? (t, d) => an.pushObd(t, d) : undefined,
  });
  for (let i = 0; i < seconds * 50; i++) sim.step(0.02);
  return { an, sim };
}

const { an, sim } = runSim();
const sum = an.summary();
const count = (type) => an.events.filter((e) => e.type === type).length;
console.log('truth', { ...sim.truth, shiftMs: undefined }, '\nsummary', sum);

test('learns the forward axis of an arbitrarily mounted phone', () => {
  const { fwd } = an.mount;
  assert.ok(fwd, 'forward axis learned');
  // bike forward expressed in phone frame for a 25 deg tilt mount: (0, sin25, -cos25)
  const th = 25 * Math.PI / 180;
  const cos = fwd.y * Math.sin(th) + fwd.z * -Math.cos(th);
  assert.ok(cos > 0.95, `alignment ${cos.toFixed(3)}`);
});

test('detects potholes and speed bumps', () => {
  const truthImpacts = sim.truth.potholes + sim.truth.bumps;
  const found = count('pothole') + count('bump');
  assert.ok(Math.abs(found - truthImpacts) <= Math.max(2, truthImpacts * 0.15), `${found} vs ${truthImpacts}`);
  assert.ok(Math.abs(count('pothole') - sim.truth.potholes) <= Math.max(2, sim.truth.potholes * 0.2), `potholes ${count('pothole')} vs ${sim.truth.potholes}`);
});

test('detects hard braking without false alarms from normal riding', () => {
  assert.ok(Math.abs(count('brake') - sim.truth.hardBrakes) <= 1, `${count('brake')} vs ${sim.truth.hardBrakes}`);
  assert.equal(count('accel'), 0);
});

test('learns gear ratios and times the clutch on shifts', () => {
  const ratios = sum.gearRatios;
  const truth = [120, 80, 60, 48, 40];
  assert.equal(ratios.length, 5, `ratios ${ratios}`);
  ratios.forEach((r, i) => assert.ok(Math.abs(r - truth[i]) / truth[i] < 0.04, `gear ${i + 1}: ${r}`));
  const shifts = an.shifts.filter((e) => e.kind === 'upshift' || e.kind === 'downshift');
  assert.ok(shifts.length >= sim.truth.shifts * 0.8, `${shifts.length} vs ${sim.truth.shifts}`);
  const avgTruth = sim.truth.shiftMs.reduce((a, b) => a + b, 0) / sim.truth.shiftMs.length;
  assert.ok(Math.abs(sum.scores.avgShiftMs - avgTruth) < 200, `avg ${sum.scores.avgShiftMs} vs ${avgTruth.toFixed(0)}`);
});

test('lean angle tracks the simulated lean', () => {
  const peak = Math.max(sum.maxLeanLeft, sum.maxLeanRight);
  assert.ok(Math.abs(peak - sim.truth.maxLean) < 6, `${peak} vs ${sim.truth.maxLean.toFixed(1)}`);
});

test('works without OBD (phone sensors only)', () => {
  const { an: an2, sim: sim2 } = runSim({ seconds: 600, seed: 11, obd: false });
  const s2 = an2.summary();
  assert.equal(s2.gearRatios.length, 0);
  assert.ok(s2.distanceKm > 1);
  const impacts = an2.events.filter((e) => e.type === 'pothole' || e.type === 'bump').length;
  assert.ok(Math.abs(impacts - sim2.truth.potholes - sim2.truth.bumps) <= 3);
});

test('helpers', () => {
  assert.equal(comfortClass(0.2).label, 'Comfortable');
  assert.equal(comfortClass(2.0).status, 'critical');
  assert.ok(Math.abs(haversine(0, 0, 0, 1) - 111195) < 10);
  assert.ok(G > 9.8);
});

test('detector counts hold across different random rides', () => {
  for (const seed of [3, 21, 99]) {
    const { an: a, sim: sm } = runSim({ seconds: 600, seed });
    const c = (type) => a.events.filter((e) => e.type === type).length;
    assert.ok(Math.abs(c('brake') - sm.truth.hardBrakes) <= 1, `seed ${seed} brakes ${c('brake')} vs ${sm.truth.hardBrakes}`);
    assert.ok(Math.abs(c('pothole') + c('bump') - sm.truth.potholes - sm.truth.bumps) <= 3, `seed ${seed} impacts`);
    assert.ok(c('accel') <= 1, `seed ${seed} false accels ${c('accel')}`);
  }
});
