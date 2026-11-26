import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRoad, summarizeWrongSide, roadReportHtml, wrongSideReportHtml } from '../public/js/ride-reports.js';

const t0 = Date.UTC(2026, 10, 26, 13, 17);
const ride = {
  id: 'r1',
  summary: { startT: t0, endT: t0 + 46 * 60000, distanceKm: 25.5, avgSpeedKmh: 39.8, maxSpeedKmh: 106.9, avgRoughness: 1.56, mountShake: 1.4, hardAccels: 3, scores: { overall: 40 } },
  timeline: [{ t: t0, rpm: null }],
  track: [{ t: t0, lat: 12.77, lon: 80.0 }, { t: t0 + 60000, lat: 12.79, lon: 80.02 }],
  events: [
    { type: 'pothole', t: t0 + 1000, lat: 12.771, lon: 80.001, severity: 'severe', p2pG: 2.1, speedKmh: 40 },
    { type: 'pothole', t: t0 + 500, lat: 12.770, lon: 80.000, severity: 'minor', p2pG: 0.9, speedKmh: 30 },
    { type: 'bump', t: t0 + 2000, lat: 12.772, lon: 80.002, severity: 'moderate', p2pG: 1.2, speedKmh: 18 },
    { type: 'gap', t: t0 + 3000, durationMs: 5742 },
    { type: 'brake', t: t0 + 4000, lat: 12.773, lon: 80.003, peakG: 0.5, fromKmh: 50, toKmh: 30 },
  ],
};

test('road summary lists hazards in time order, judges the road and explains doubts', () => {
  const s = summarizeRoad(ride);
  assert.deepEqual(s.counts, { potholes: 2, bumps: 1, rough: 0, hardBrakes: 1, hardAccels: 3, crashes: 0, falls: 0 });
  assert.equal(s.potholes[0].severity, 'minor', 'sorted by time');
  assert.equal(s.road, 'Fair road, some damage', 'few hazards, but a rough surface');
  assert.ok(s.notes.some((n) => /mount/.test(n)), 'warns about the shaking mount');
  assert.ok(s.notes.some((n) => /paused 1 time/.test(n)), 'reports recording gaps');
  const html = roadReportHtml(ride, s);
  assert.match(html, /<!doctype html>/); assert.match(html, /maps\.google\.com\/\?q=12\.771,80\.001/);
});

test('wrong-side summary counts by type, plates, helmets and leaves dismissed ones to the caller', () => {
  const reps = [
    { id: 'a', t: t0 + 9000, vehicleType: 'Car', plate: 'TN09AB1234', plateValid: true, status: 'new', photos: [], auto: { keep: 'left', closingKmh: 78, ownSpeedKmh: 24, oncomingKmh: 54, sightings: 4 }, lat: 12.79, lon: 80.01, accuracy: 6 },
    { id: 'b', t: t0 + 5000, vehicleType: 'Two-wheeler', plate: 'TN09AB1234', status: 'new', photos: [], analysis: { helmet: { verdict: 'no helmet', p: 0.82 } } },
    { id: 'c', t: t0 + 7000, vehicleType: '', status: 'new', photos: [] },
  ];
  const s = summarizeWrongSide(reps);
  assert.equal(s.total, 3); assert.equal(s.auto, 1); assert.equal(s.noHelmet, 1);
  assert.deepEqual(s.byType, { 'Two-wheeler': 1, 'Unknown vehicle': 1, Car: 1 });
  assert.deepEqual(s.repeat, [{ plate: 'TN09AB1234', n: 2 }]);
  assert.equal(s.list[0].id, 'b', 'time order');
  const html = wrongSideReportHtml(ride, s, { a: { snapshot: 'data:image/jpeg;base64,AA==' } });
  assert.match(html, /TN09AB1234/); assert.match(html, /wrong side/); assert.match(html, /data:image\/jpeg/);
  assert.doesNotMatch(wrongSideReportHtml(ride, summarizeWrongSide([{ id: 'x', t: 1, plate: '<b>x</b>', status: 'new', photos: [] }]), {}), /<b>x<\/b>/, 'escapes text');
});
