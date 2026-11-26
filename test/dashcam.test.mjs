import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickMime, fileName, retention, overlapping, extFor } from '../public/js/dashcam.js';

test('prefers MP4, falls back to WebM', () => {
  assert.equal(pickMime((m) => m.startsWith('video/mp4')), 'video/mp4;codecs=avc1.42E01E');
  assert.equal(pickMime((m) => m === 'video/webm;codecs=vp8'), 'video/webm;codecs=vp8');
  assert.equal(pickMime(() => false), '');
  assert.equal(extFor('video/mp4'), 'mp4'); assert.equal(extFor('video/webm'), 'webm');
});

test('file names carry local date and time', () => {
  const t = new Date(2026, 10, 25, 14, 30, 5).getTime();
  assert.equal(fileName(t, 'video/mp4'), 'RideLens_2026-11-25_14-30-05.mp4');
  assert.equal(fileName(t, 'video/webm', 'INCIDENT'), 'RideLens_2026-11-25_14-30-05_INCIDENT.webm');
});

test('keeps 7 days, overwrites older, never deletes locked clips', () => {
  const day = 86400000, now = 100 * day;
  const clips = [
    { id: 'old', start: now - 9 * day, end: now - 9 * day + 60000, size: 10 },
    { id: 'oldLocked', start: now - 9 * day, end: now - 9 * day + 60000, size: 10, locked: true },
    { id: 'recent', start: now - 2 * day, end: now - 2 * day + 60000, size: 10 },
  ];
  assert.deepEqual(retention(clips, now, { days: 7 }), ['old']);
});

test('frees the oldest unlocked clips first when over the storage budget', () => {
  const clips = [1, 2, 3, 4].map((i) => ({ id: `c${i}`, start: i * 1000, end: i * 1000 + 500, size: 100, locked: i === 1 }));
  assert.deepEqual(retention(clips, 10000, { days: 7, maxBytes: 250 }), ['c2', 'c3']);
});

test('finds the clips around an incident', () => {
  const clips = [{ id: 'a', start: 0, end: 60000 }, { id: 'b', start: 60000, end: 120000 }, { id: 'c', start: 120000, end: 180000 }];
  assert.deepEqual(overlapping(clips, 70000).map((c) => c.id), ['a', 'b']);
});

import { clipsInRange, DAY_PARTS } from '../public/js/dashcam.js';
test('bulk delete selects by day and time of day, skipping locked clips unless asked', () => {
  const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();
  const clips = [
    { id: 'a', start: at(25, 7), locked: false }, { id: 'b', start: at(25, 9, 30), locked: true },
    { id: 'c', start: at(25, 18), locked: false }, { id: 'd', start: at(25, 23, 15), locked: false },
    { id: 'e', start: at(26, 2), locked: false }, { id: 'f', start: at(26, 8), locked: false },
  ];
  assert.deepEqual(clipsInRange(clips, { day: '2026-11-25', from: DAY_PARTS.all[0], to: DAY_PARTS.all[1] }), ['a', 'c', 'd']);
  assert.deepEqual(clipsInRange(clips, { day: '2026-11-25', from: DAY_PARTS.morning[0], to: DAY_PARTS.morning[1], includeLocked: true }), ['a', 'b']);
  assert.deepEqual(clipsInRange(clips, { day: '2026-11-25', from: DAY_PARTS.evening[0], to: DAY_PARTS.evening[1] }), ['c']);
  assert.deepEqual(clipsInRange(clips, { from: DAY_PARTS.night[0], to: DAY_PARTS.night[1] }), ['d', 'e'], 'night wraps past midnight');
  assert.deepEqual(clipsInRange(clips, { day: '2026-11-26', from: '07:30', to: '09:00' }), ['f']);
});
