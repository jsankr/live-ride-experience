import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnalyzer, G, comfortClass, comfortLegend, COMFORT, haversine } from '../public/js/analytics.js';
import { createSimulator } from './simulator.js';

function runSim({ seconds = 900, seed = 7, obd = true, flip = false } = {}) {
  const an = createAnalyzer();
  const f = flip ? -1 : 1;
  const sim = createSimulator({
    seed,
    onImu: (t, a, g) => an.pushImu(t, flip ? { x: -a.x, y: -a.y, z: -a.z } : a, g),
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

test('learns the gyro sign automatically (browsers disagree on accelerometer sign)', () => {
  for (const flip of [false, true]) {
    const an = createAnalyzer();
    const sim = createSimulator({
      seed: 5,
      onImu: (t, a, g) => an.pushImu(t, flip ? { x: -a.x, y: -a.y, z: -a.z } : a, g),
      onGps: (t, f) => an.pushGps(t, f), onObd: (t, d) => an.pushObd(t, d),
    });
    let agree = 0, n = 0;
    for (let i = 0; i < 600 * 50; i++) {
      sim.step(0.02);
      const truth = sim.state.lean * 180 / Math.PI;
      if (i > 120 * 50 && i % 10 === 0 && Math.abs(truth) > 8) { n++; if (Math.sign(an.snapshot().lean) === Math.sign(truth)) agree++; }
    }
    assert.ok(an.snapshot().yawSignLearned, `sign learned (flip=${flip})`);
    assert.ok(n > 50 && agree / n > 0.95, `flip=${flip}: left/right agreement ${agree}/${n}`);
  }
});

test('ignores Safari-style invalid GPS values and position jumps', () => {
  const a = createAnalyzer();
  const t0 = 1e12, M = 1 / 111320;
  // Safari: speed and heading -1 ("unknown"); riding north at ~19.5 km/h (5.4 m/s) for 10 s
  for (let i = 0; i <= 10; i++) a.pushGps(t0 + i * 1000, { lat: 12.97 + i * 5.4 * M, lon: 77.59, alt: 900, speed: -1, heading: -1, accuracy: 5 });
  assert.ok(Math.abs(a.snapshot().speedKmh - 19.5) < 2, `computed ${a.snapshot().speedKmh}`);
  const before = a.snapshot().distanceKm;
  a.pushGps(t0 + 11000, { lat: 12.98, lon: 77.59, alt: 900, speed: null, heading: null, accuracy: 5 }); // 1.1 km jump
  assert.ok(a.snapshot().speedKmh < 25, `jump rejected: ${a.snapshot().speedKmh}`);
  assert.ok(a.snapshot().distanceKm - before < 0.01, 'jump not added to distance');
});

test('sitting still: GPS wander is not speed and adds no distance (was ~3 km/h)', () => {
  const a = createAnalyzer();
  const t0 = 1e12, M = 1 / 111320;
  let maxKmh = 0;
  for (let i = 0; i < 120; i++) {
    const w = [Math.sin(i * 1.7) * 4, Math.cos(i * 2.3) * 4]; // a few metres of wander
    a.pushGps(t0 + i * 1000, { lat: 12.97 + w[0] * M, lon: 77.59 + w[1] * M, alt: 900, speed: Math.abs(Math.sin(i)) * 0.5, heading: -1, accuracy: 8 });
    maxKmh = Math.max(maxKmh, a.snapshot().speedKmh);
  }
  assert.equal(maxKmh, 0);
  assert.equal(a.snapshot().distanceKm, 0);
});

test('comfort colours: only Comfortable is green, and the legend covers every band', () => {
  assert.equal(comfortClass(0.2).status, 'good');
  assert.equal(comfortClass(0.5).label, 'A little uncomfortable');
  assert.notEqual(comfortClass(0.5).status, 'good');
  const statuses = COMFORT.map((c) => c[2]);
  for (let i = 1; i < statuses.length; i++) {
    const rank = (st) => ['good', 'warning', 'serious', 'critical'].indexOf(st);
    assert.ok(rank(statuses[i]) >= rank(statuses[i - 1]), 'severity never decreases');
  }
  const legend = comfortLegend();
  assert.deepEqual(legend.map((r) => r[0]), ['good', 'warning', 'serious', 'critical']);
  for (const [, label] of COMFORT) assert.ok(legend.some((r) => r[1].toLowerCase().includes(label.toLowerCase())), `legend mentions ${label}`);
});

test('downsample keeps extremes and averages per bucket', async () => {
  const { downsample } = await import('../public/js/charts.js');
  const pts = Array.from({ length: 1000 }, (_, i) => ({ t: i * 100, v: i === 500 ? 9 : i % 2 ? 1 : -1 }));
  const b = downsample(pts, 'v', 50);
  assert.equal(b.length, 50);
  assert.equal(b.reduce((a, x) => a + x.n, 0), 1000, 'every sample lands in one bucket');
  assert.equal(Math.max(...b.map((x) => x.max)), 9, 'a one-sample spike survives binning');
  assert.ok(Math.abs(b[0].mean) < 1e-9, 'mean of alternating ±1 is 0');
  assert.deepEqual(downsample([], 'v', 10), []);
  assert.equal(downsample([{ t: 0, v: null }, { t: 1, v: 2 }], 'v', 4).length, 1, 'null samples are skipped');
});

test('rough roads: jolts become rough stretches, not hundreds of potholes or breakers', () => {
  for (const seed of [7, 21, 99]) {
    const a = createAnalyzer();
    const sm = createSimulator({ seed, roughRoads: true, onImu: (t, x, g) => a.pushImu(t, x, g), onGps: (t, f) => a.pushGps(t, f), onObd: (t, d) => a.pushObd(t, d) });
    for (let i = 0; i < 900 * 50; i++) sm.step(0.02);
    const c = (k) => a.events.filter((e) => e.type === k).length;
    assert.ok(sm.truth.roughJolts > 300, 'scenario has hundreds of non-event jolts');
    assert.ok(Math.abs(c('pothole') - sm.truth.potholes) <= Math.max(4, sm.truth.potholes * 0.25), `seed ${seed} potholes ${c('pothole')} vs ${sm.truth.potholes}`);
    assert.ok(c('bump') <= sm.truth.bumps, `seed ${seed} breakers never over-counted: ${c('bump')} vs ${sm.truth.bumps}`);
    assert.ok(Math.abs(c('rough') - sm.truth.roughStretches) <= Math.max(3, sm.truth.roughStretches * 0.4), `seed ${seed} rough ${c('rough')} vs ${sm.truth.roughStretches}`);
  }
});

test('smooth roads: potholes and speed breakers counted exactly, no rough stretches', () => {
  for (const seed of [7, 3, 5]) {
    const a = createAnalyzer();
    const sm = createSimulator({ seed, onImu: (t, x, g) => a.pushImu(t, x, g), onGps: (t, f) => a.pushGps(t, f), onObd: (t, d) => a.pushObd(t, d) });
    for (let i = 0; i < 900 * 50; i++) sm.step(0.02);
    const c = (k) => a.events.filter((e) => e.type === k).length;
    assert.ok(Math.abs(c('pothole') - sm.truth.potholes) <= 1, `potholes ${c('pothole')} vs ${sm.truth.potholes}`);
    assert.ok(Math.abs(c('bump') - sm.truth.bumps) <= 1, `breakers ${c('bump')} vs ${sm.truth.bumps}`);
    assert.equal(c('rough'), 0);
  }
});

// ---- 27 Nov 12:50 ride: the page was busy (camera + 4K dashcam) and got its motion samples
// in bursts of ~8 sharing one timestamp; breakers were logged as potholes or missed ----
const rideWith = (opts, seed = 11, minutes = 15) => {
  const a = createAnalyzer();
  const sm = createSimulator({ seed, onImu: (t, x, g) => a.pushImu(t, x, g), onGps: (t, f) => a.pushGps(t, f), onObd: (t, d) => a.pushObd(t, d), ...opts });
  for (let i = 0; i < minutes * 60 * 50; i++) sm.step(0.02);
  const c = (k) => a.events.filter((e) => e.type === k).length;
  return { a, sm, c };
};
test('motion samples delivered in bursts give the same road events as a steady stream', () => {
  for (const seed of [11, 23]) {
    const steady = rideWith({}, seed), bursty = rideWith({ burst: 8 }, seed);
    for (const k of ['pothole', 'bump', 'brake']) {
      assert.ok(Math.abs(bursty.c(k) - steady.c(k)) <= Math.max(1, steady.c(k) * 0.15), `seed ${seed} ${k}: bursty ${bursty.c(k)} vs steady ${steady.c(k)}`);
    }
    assert.ok(bursty.c('bump') >= bursty.sm.truth.bumps - 2 && bursty.c('bump') <= bursty.sm.truth.bumps, `seed ${seed} breakers ${bursty.c('bump')} vs ${bursty.sm.truth.bumps}`);
  }
});
test('a real speed breaker (climb, crest, landing) is a breaker, not a pothole', () => {
  for (const seed of [11, 23, 5]) {
    const { a, sm, c } = rideWith({ breakers: 'real' }, seed);
    // (the detector before this fix: 0 breakers and 45 potholes for 16 + 32 on seed 11)
    assert.ok(c('bump') >= sm.truth.bumps - 2 && c('bump') <= sm.truth.bumps, `seed ${seed} breakers ${c('bump')} vs ${sm.truth.bumps}`);
    assert.ok(Math.abs(c('pothole') - sm.truth.potholes) <= 2, `seed ${seed} potholes ${c('pothole')} vs ${sm.truth.potholes}`);
    assert.ok(a.events.filter((e) => e.type === 'bump').every((e) => e.form === 'breaker'));
  }
});
test('small humps and joints taken at speed are counted as small bumps', () => {
  for (const seed of [11, 23, 5]) {
    const { a, sm } = rideWith({ smallBumps: true }, seed);
    const small = a.events.filter((e) => e.type === 'bump' && e.form === 'small').length;
    assert.ok(sm.truth.smallBumps >= 5, 'scenario has small bumps');
    assert.ok(small >= sm.truth.smallBumps * 0.7 && small <= sm.truth.smallBumps + 1, `seed ${seed} small bumps ${small} vs ${sm.truth.smallBumps}`);
  }
});
