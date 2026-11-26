import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inTimeRange, selectReports, selectClips, selectEvents, removeEvents, REPORT_KINDS } from '../public/js/select.js';

const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();

test('time ranges: day, morning, custom and past midnight', () => {
  assert.equal(inTimeRange(at(25, 7), { day: '2026-11-25', from: '05:00', to: '12:00' }), true);
  assert.equal(inTimeRange(at(25, 7), { day: '2026-11-26', from: '05:00', to: '12:00' }), false);
  assert.equal(inTimeRange(at(25, 23, 30), { from: '22:00', to: '05:00' }), true);
  assert.equal(inTimeRange(at(26, 6), { from: '22:00', to: '05:00' }), false);
});

test('reports: pick likely false positives by kind, vehicle type and time', () => {
  const reps = [
    { id: 'a', t: at(26, 9), auto: { type: 'Car' }, plate: '', status: 'new', analysis: { status: 'complete', vehicle: null } },
    { id: 'b', t: at(26, 9, 30), auto: { type: 'Car' }, plate: 'TN09AB1234', status: 'verified', vehicleType: 'Car', analysis: { status: 'complete', vehicle: { type: 'Car' } } },
    { id: 'c', t: at(26, 18), plate: '', status: 'dismissed', vehicleType: 'Two-wheeler' },
  ];
  assert.deepEqual(selectReports(reps, { kind: 'auto-no-plate' }), ['a']);
  assert.deepEqual(selectReports(reps, { kind: 'auto-no-vehicle' }), ['a']);
  assert.deepEqual(selectReports(reps, { kind: 'dismissed' }), ['c']);
  assert.deepEqual(selectReports(reps, { kind: 'unreviewed' }), ['a']);
  assert.deepEqual(selectReports(reps, { kind: 'type:Car' }), ['b']);
  assert.deepEqual(selectReports(reps, { kind: 'all', from: '05:00', to: '12:00' }), ['a', 'b']);
  assert.ok(REPORT_KINDS.length >= 5);
});

test('clips: plain video, everything, or only clips locked for one reason', () => {
  const clips = [
    { id: '1', start: at(26, 8), locked: false }, { id: '2', start: at(26, 8, 5), locked: true, incidents: ['Crash-level impact'] },
    { id: '3', start: at(26, 8, 9), locked: true, incidents: ['Wrong-side vehicle', 'Crash-level impact'] }, { id: '4', start: at(26, 19), locked: true, incidents: ['Manual capture'] },
  ];
  assert.deepEqual(selectClips(clips, { kind: 'unlocked' }), ['1']);
  assert.deepEqual(selectClips(clips, { kind: 'Crash-level impact' }), ['2', '3']);
  assert.deepEqual(selectClips(clips, { kind: 'any', from: '17:00', to: '22:00' }), ['4']);
});

test('ride events: removing false ones recounts the summary and keeps a record', () => {
  const ride = { summary: { potholes: 3, bumps: 1, hardBrakes: 1 }, events: [
    { id: 'p1', type: 'pothole', t: at(26, 9) }, { id: 'p2', type: 'pothole', t: at(26, 9, 5) }, { id: 'p3', type: 'pothole', t: at(26, 10) },
    { id: 'b1', type: 'bump', t: at(26, 9, 1) }, { id: 'k1', type: 'brake', t: at(26, 9, 2) }, { id: 'c1', type: 'crash', t: at(26, 9, 3) },
  ] };
  const ids = selectEvents(ride.events, { types: ['pothole'], from: '09:00', to: '09:30' });
  assert.deepEqual(ids, ['p1', 'p2']);
  const out = removeEvents(ride, [...ids, 'c1']);
  assert.equal(out.summary.potholes, 1); assert.equal(out.summary.bumps, 1); assert.equal(out.summary.hardBrakes, 1);
  assert.equal(out.events.length, 3); assert.equal(out.removedEvents.length, 3);
  assert.equal(removeEvents(ride, []), ride, 'nothing to remove: unchanged');
});
