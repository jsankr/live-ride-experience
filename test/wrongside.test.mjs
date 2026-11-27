import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWrongSideTracker, REAL_WIDTH_M, REAL_HEIGHT_M, watchRegion, nextInterval, tailLightScore, looksLikeRear, mergeRiders } from '../public/js/wrongside-watch.js';

// Synthetic camera geometry: build the box a vehicle of known width would make at a
// given distance and lateral offset, then check the tracker's decision.
const W = 640, H = 480, FOV = 60;
const tanHalf = Math.tan((FOV * Math.PI) / 360);
const F = W / (2 * tanHalf); // focal length in px
// sideM: length of vehicle side visible (a car we pass on the left shows its flank too)
function box(cls, d, lateral, { sideM = 0, score = 0.8 } = {}) {
  const front = (REAL_WIDTH_M[cls] / d) * F;
  const cx = (0.5 + lateral / (2 * d * tanHalf)) * W;
  // flank of length sideM at lateral offset: projects from x/d to x/(d+sideM)
  const flank = sideM ? Math.abs(lateral) * F * (1 / d - 1 / (d + sideM)) : 0;
  const w = front + flank, h = (REAL_HEIGHT_M[cls] / d) * F;
  const bottom = H * 0.45 + (1.1 / d) * F;
  const x = lateral < 0 ? cx - front / 2 : cx - front / 2 - flank; // flank sits on the side nearer the centre
  return { class: cls, score, bbox: [x, bottom - h, w, h] };
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
  assert.equal(nextInterval({ ownSpeedKmh: 30, active: false }), 250);
  assert.equal(nextInterval({ ownSpeedKmh: 30, active: true }), 150);
  assert.equal(nextInterval({ ownSpeedKmh: 30, active: true, lastInferMs: 400 }), 800);
  assert.equal(nextInterval({ ownSpeedKmh: 30, active: true, lastInferMs: 2000 }), 2000);
});

// ---- regressions from the 27 Nov 2026 ride: 15 alerts, all slower traffic we overtook on
// the left (tail lamps visible), while real wrong-side riders on the left were missed ----

// step a scene through the tracker at a fixed check rate; make(d, i) returns detections
function drive({ own, closingKmh, start, dt = 0.25, make, stop = 4, tracker = createWrongSideTracker({ fovDeg: FOV }) }) {
  const alerts = [];
  for (let t = 0, i = 0, d = start; d > stop && t < 30; t += dt, i++, d = start - (closingKmh / 3.6) * t) {
    alerts.push(...tracker.update(t * 1000, make(d, i), W, H, own));
  }
  return alerts;
}

test('overtaking a slower car on our left, its flank in view, is not flagged', () => {
  for (const [own, other] of [[68, 45], [62, 40], [40, 20], [57, 30]]) {
    const a = drive({ own, closingKmh: own - other, start: 30, make: (d) => [box('car', d, -2.2, { sideM: 4 })] });
    assert.equal(a.length, 0, `own ${own}, car ${other}: ${JSON.stringify(a[0])}`);
  }
});

test('a car showing tail lamps is never flagged, even if the numbers say oncoming', () => {
  const a = drive({ own: 30, closingKmh: 60, start: 40, make: (d) => [{ ...box('car', d, -0.5), rear: true }] });
  assert.equal(a.length, 0);
  const b = drive({ own: 30, closingKmh: 60, start: 40, make: (d) => [{ ...box('car', d, -0.5), rear: false }] });
  assert.equal(b.length, 1, 'same car seen from the front is flagged');
});

test('wrong-side rider flickering between person and motorcycle is still one track and flagged', () => {
  const a = drive({ own: 40, closingKmh: 40 + 25, start: 32, make: (d, i) => {
    const bike = box('motorcycle', d, -1.8, { score: 0.38 });
    if (i % 3 === 1) return [{ ...bike, class: 'person', bbox: [bike.bbox[0] + bike.bbox[2] * 0.15, bike.bbox[1], bike.bbox[2] * 0.67, bike.bbox[3] * 0.7] }];
    if (i % 3 === 2) return [bike, { class: 'person', score: 0.6, bbox: [bike.bbox[0] + 2, bike.bbox[1] - 10, bike.bbox[2] * 0.7, bike.bbox[3] * 0.6] }];
    return [bike];
  } });
  assert.equal(a.length, 1);
  assert.equal(a[0].type, 'Two-wheeler');
});

test('low-confidence (0.32) head-on two-wheeler is tracked', () => {
  const a = drive({ own: 50, closingKmh: 50 + 25, start: 30, make: (d) => [box('motorcycle', d, -1.5, { score: 0.32 })] });
  assert.equal(a.length, 1);
});

test('a pedestrian walking toward us on the left is not flagged', () => {
  const p = (d) => ({ class: 'person', score: 0.8, bbox: (({ bbox }) => bbox)(box('person', d, -2)) });
  assert.equal(drive({ own: 30, closingKmh: 35, start: 30, make: (d) => [p(d)] }).length, 0);
  assert.equal(drive({ own: 0, closingKmh: 6, start: 20, dt: 0.5, make: (d) => [p(d)] }).length, 0);
});

test('a far car appearing inside a near car\'s old box is not chained into one fast track', () => {
  const tr = createWrongSideTracker({ fovDeg: FOV });
  const alerts = [];
  // near car steady at 8 m (moving with us), then gone; a far car shows up at the same spot
  for (let i = 0; i < 4; i++) alerts.push(...tr.update(i * 250, [box('car', 8, -0.3)], W, H, 40));
  for (let i = 4; i < 10; i++) alerts.push(...tr.update(i * 250, [box('car', 25 - (i - 4) * 0.5, -0.3)], W, H, 40));
  assert.equal(alerts.length, 0);
});

test('a wrong-side auto (labelled truck) coming at us is flagged; one we overtake is not', () => {
  assert.equal(drive({ own: 35, closingKmh: 35 + 25, start: 30, make: (d) => [box('truck', d, -1.2)] }).length, 1);
  assert.equal(drive({ own: 38, closingKmh: 38 - 20, start: 30, make: (d) => [box('truck', d, -1.5, { sideM: 2.6 })] }).length, 0);
});

test('mergeRiders folds a rider into the bike under them', () => {
  const m = mergeRiders([{ class: 'motorcycle', score: 0.4, bbox: [100, 200, 40, 60] }, { class: 'person', score: 0.7, bbox: [105, 150, 30, 90] }]);
  assert.equal(m.length, 1); assert.equal(m[0].class, 'motorcycle'); assert.deepEqual(m[0].bbox, [100, 150, 40, 110]);
});

test('tail-lamp check: red on both sides = rear; red all over = not rear', () => {
  const img = (paint) => { const w = 40, h = 30, data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = paint(x / w, y / h); data.set([r, g, b, 255], (y * w + x) * 4); }
    return { data, width: w, height: h }; };
  const rear = img((fx, fy) => (fy > 0.35 && fy < 0.55 && (fx < 0.15 || fx > 0.85) ? [200, 30, 40] : [230, 230, 230]));
  assert.ok(looksLikeRear(tailLightScore(rear)));
  const redBus = img(() => [190, 30, 35]);
  assert.ok(!looksLikeRear(tailLightScore(redBus)));
  const front = img((fx, fy) => (fy > 0.35 && fy < 0.55 && (fx < 0.15 || fx > 0.85) ? [250, 245, 220] : [120, 120, 125]));
  assert.ok(!looksLikeRear(tailLightScore(front)));
});

test('portrait crop fed to the detector is close to square', () => {
  const [, , w, h] = watchRegion('left', 1080, 1984);
  assert.ok(h / w <= 1.35, `aspect ${h / w}`);
});

// ---- parked vehicles facing us on the kerb are not wrong-side riders ----
// box of a vehicle with a given REAL size (not the class average)
function sized(cls, d, lateral, realW, realH) {
  const w = (realW / d) * F, h = (realH / d) * F, cx = (0.5 + lateral / (2 * d * tanHalf)) * W;
  const bottom = H * 0.45 + (1.1 / d) * F;
  return { class: cls, score: 0.8, rear: false, bbox: [cx - w / 2, bottom - h, w, h] };
}
test('parked vehicles of any size, facing us at the kerb, are never flagged', () => {
  for (const [cls, w, h] of [['car', 1.6, 1.42], ['car', 1.8, 1.95], ['truck', 1.4, 1.7], ['truck', 2.5, 3.5], ['motorcycle', 0.6, 1.1], ['motorcycle', 0.9, 1.2], ['bus', 2.55, 3.2]]) {
    for (const own of [20, 40, 65]) {
      const a = drive({ own, closingKmh: own, start: 35, make: (d) => [sized(cls, d, -2.2, w, h)] });
      assert.equal(a.length, 0, `${cls} ${w}x${h} parked, us ${own}: ${JSON.stringify(a[0])}`);
    }
  }
});
test('a parked scooter is not flagged while GPS lags behind our acceleration', () => {
  const tr = createWrongSideTracker({ fovDeg: FOV });
  const alerts = [];
  for (let t = 0, d = 35, v = 30; d > 4; t += 0.25) {
    v += 1.5 * 3.6 * 0.25; d -= (v / 3.6) * 0.25; // accelerating 1.5 m/s²
    alerts.push(...tr.update(t * 1000, [sized('motorcycle', d, -2, 0.62, 1.1)], W, H, v - 1.5 * 3.6)); // GPS ~1 s behind
  }
  assert.equal(alerts.length, 0);
});
test('a small wrong-side scooter coming at us IS flagged, with its size measured from the road', () => {
  const a = drive({ own: 40, closingKmh: 40 + 25, start: 35, make: (d) => [sized('motorcycle', d, -1.6, 0.62, 1.1)] });
  assert.equal(a.length, 1);
  assert.ok(Math.abs(a[0].sizeMeasured - 0.62) < 0.08, `measured ${a[0].sizeMeasured}`);
  assert.equal(a[0].category, 'Two-wheeler');
});

// ---- evidence: follow the alerted vehicle and keep its closest views ----
import { createSubjectFollower, subjectCrop } from '../public/js/wrongside-watch.js';
test('follower keeps the first and the largest views, and hands over when the vehicle leaves', () => {
  const f = createSubjectFollower({ followS: 2.5, keepShots: 3 });
  f.start({ trackId: 7 }, 0);
  for (const a of [100, 50, 400, 900, 30, 2500]) f.add(7, { areaPx: a });
  assert.deepEqual(f.get(7).shots.map((s) => s.areaPx), [100, 900, 2500]);
  const tracks = [{ id: 7, last: { t: 1, clipped: false } }];
  assert.equal(f.due(1, tracks).length, 0, 'still in view');
  tracks[0].last = { t: 1.25, clipped: true };
  const done = f.due(1.25, tracks);
  assert.equal(done.length, 1); assert.equal(done[0].alert.trackId, 7);
  assert.equal(f.has(7), false);
});
test('follower hands over after the follow time even if the vehicle is still seen', () => {
  const f = createSubjectFollower({ followS: 2.5 });
  f.start({ trackId: 1 }, 0);
  assert.equal(f.due(3, [{ id: 1, last: { t: 3, clipped: false } }]).length, 1);
});
test('evidence crop leaves room above for the rider and stays inside the frame', () => {
  const [x, y, w, h] = subjectCrop([100, 400, 100, 200], 1080, 1920);
  assert.ok(y <= 400 - 100 && x < 100 && x + w > 200 && y + h > 600);
  const c = subjectCrop([0, 0, 50, 50], 1080, 1920);
  assert.equal(c[0], 0); assert.equal(c[1], 0);
});
