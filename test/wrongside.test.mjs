import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWrongSideTracker, REAL_WIDTH_M, watchRegion, nextInterval } from '../public/js/wrongside-watch.js';

// Synthetic camera geometry: build the box a vehicle of known width would make at a
// given distance and lateral offset, then check the tracker's decision.
const W = 640, H = 480, FOV = 60;
const tanHalf = Math.tan((FOV * Math.PI) / 360);
function box(cls, d, lateral) {
  const w = (REAL_WIDTH_M[cls] / (2 * tanHalf * d)) * W;
  const cx = (0.5 + lateral / (2 * d * tanHalf)) * W;
  return { class: cls, score: 0.8, bbox: [cx - w / 2, H * 0.4, w, w * 0.8] };
}
// own: rider speed km/h; other: other vehicle's speed TOWARD us (negative = moving away)
function run({ cls = 'car', own, other, lateral, keep = 'left', ownKnown = true, start = 60 }) {
  const tr = createWrongSideTracker({ fovDeg: FOV, keep });
  const closing = (own + other) / 3.6;
  const alerts = [];
  for (let t = 0, d = start; d > 4 && t < 20; t += 0.35, d = start - closing * t) {
    alerts.push(...tr.update(t * 1000, [box(cls, d, lateral)], W, H, ownKnown ? own : null));
  }
  return alerts;
}

test('flags a car coming at us in our own lane (keep-left)', () => {
  const a = run({ own: 30, other: 30, lateral: 0 });
  assert.equal(a.length, 1);
  assert.equal(a[0].type, 'Car');
  assert.ok(Math.abs(a[0].closingKmh - 60) <= 6, `closing ${a[0].closingKmh}`);
  assert.ok(Math.abs(a[0].oncomingKmh - 30) <= 6, `oncoming ${a[0].oncomingKmh}`);
  assert.ok(a[0].distanceM <= 30);
});

test('ignores normal oncoming traffic in the opposite lane', () => {
  assert.equal(run({ own: 30, other: 30, lateral: 3.5 }).length, 0);
});

test('ignores slower same-direction traffic we are catching up to', () => {
  assert.equal(run({ own: 40, other: -25, lateral: 0 }).length, 0);
});

test('ignores parked vehicles in our lane', () => {
  assert.equal(run({ own: 30, other: 0, lateral: 0 }).length, 0);
});

test('works for a two-wheeler, also while we wait at a signal', () => {
  const a = run({ cls: 'motorcycle', own: 0, other: 25, lateral: -0.5 });
  assert.equal(a.length, 1);
  assert.equal(a[0].type, 'Two-wheeler');
  assert.equal(a[0].view, 'front');
  assert.equal(run({ cls: 'motorcycle', own: 0, other: 8, lateral: 0 }).length, 0, 'walking pace is not flagged');
});

test('without GPS speed nothing is flagged: oncoming and slower traffic look alike', () => {
  assert.equal(run({ own: 30, other: 30, lateral: 0, ownKnown: false }).length, 0);
});

test('a same-direction vehicle we overtake is not flagged even with ±20 % distance error', () => {
  // scale error makes closing speed look 20 % higher than it is
  const tr = createWrongSideTracker({ fovDeg: FOV * 0.85 });
  const alerts = [];
  for (let t = 0, d = 50; d > 4; t += 0.35, d = 50 - ((60 - 25) / 3.6) * t) alerts.push(...tr.update(t * 1000, [box('car', d, -0.5)], W, H, 60));
  assert.equal(alerts.length, 0);
});

test('jittery detections (no steady approach) are not flagged', () => {
  const tr = createWrongSideTracker({ fovDeg: FOV });
  const alerts = [];
  const ds = [22, 14, 25, 12, 20, 11, 19, 13];
  ds.forEach((d, i) => alerts.push(...tr.update(i * 350, [box('car', d, 0)], W, H, 30)));
  assert.equal(alerts.length, 0);
});

test('a box cut off by the picture edge is not used for distance', () => {
  const tr = createWrongSideTracker({ fovDeg: FOV });
  const alerts = [];
  for (let t = 0, d = 40; d > 4; t += 0.35, d = 40 - (60 / 3.6) * t) {
    const b = box('car', d, 0); b.bbox[0] = 0; // always touching the left edge
    alerts.push(...tr.update(t * 1000, [b], W, H, 30));
  }
  assert.equal(alerts.length, 0);
});

test('mirrors lanes for keep-right countries', () => {
  assert.equal(run({ own: 30, other: 30, lateral: 0, keep: 'right' }).length, 1);
  assert.equal(run({ own: 30, other: 30, lateral: -3.5, keep: 'right' }).length, 0);
  // keep-right: +3.5 m is beyond our kerb-side lane edge, still not the oncoming side → wrong side
  assert.equal(run({ own: 30, other: 30, lateral: 3.5, keep: 'right' }).length, 1);
});

test('fires once per vehicle', () => {
  assert.equal(run({ own: 20, other: 40, lateral: 0.2, start: 80 }).length, 1);
});

test('keeps tracking a fast-approaching vehicle at a low check rate (2/s)', () => {
  const tr = createWrongSideTracker({ fovDeg: FOV });
  const alerts = [];
  const closing = 58 / 3.6;
  for (let t = 0, d = 50; d > 3; t += 0.5, d = 50 - closing * t) {
    alerts.push(...tr.update(t * 1000, [box('car', d, -0.3)], W, H, 20));
  }
  assert.equal(alerts.length, 1, 'one alert for one approaching car');
});

test('keep-left India: only vehicles coming at us on our left (or dead ahead) count', () => {
  assert.equal(run({ own: 30, other: 30, lateral: -1.5 }).length, 1, 'on our left, near the kerb');
  assert.equal(run({ own: 30, other: 30, lateral: 0.1 }).length, 1, 'dead ahead');
  assert.equal(run({ own: 30, other: 30, lateral: 0.8 }).length, 0, 'slightly to our right is not flagged');
  assert.equal(run({ own: 30, other: 30, lateral: 3.5 }).length, 0, 'normal oncoming lane');
});

test('watches only the rider-side part of the picture', () => {
  const [x, y, w, h] = watchRegion('left', 1920, 1080);
  assert.equal(x, 0); assert.ok(w < 1920 * 0.65 && w > 1920 * 0.55); assert.ok(y > 0 && h < 1080);
  assert.equal(watchRegion('right', 1920, 1080)[0], 1920 - w);
});

test('checks slow down when stopped or idle, speed up when a vehicle is near, back off when the phone is slow', () => {
  assert.equal(nextInterval({ ownSpeedKmh: 0, active: false }), 1200);
  assert.equal(nextInterval({ ownSpeedKmh: 30, active: false }), 500);
  assert.equal(nextInterval({ ownSpeedKmh: 30, active: true }), 300);
  assert.equal(nextInterval({ ownSpeedKmh: 30, active: true, lastInferMs: 400 }), 800);
  assert.equal(nextInterval({ ownSpeedKmh: 30, active: true, lastInferMs: 2000 }), 2000);
});
