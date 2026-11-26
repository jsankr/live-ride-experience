import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rememberPlace, savePlace, forgetPlace, rideEnds, suggestPlaces, ago } from '../public/js/places.js';

const office = { lat: 12.9352, lon: 77.6245, name: 'Koramangala office' };
const day = 86400000, t0 = Date.UTC(2026, 10, 20, 3, 30);

test('trips to the same place merge (within 120 m) and remember the usual arrival time', () => {
  let list = rememberPlace([], office, { now: t0, targetT: new Date(2026, 10, 20, 9, 30).getTime() });
  list = rememberPlace(list, { lat: 12.9356, lon: 77.6249, name: 'Dropped pin 12.93560, 77.62490' }, { now: t0 + day });
  assert.equal(list.length, 1);
  assert.equal(list[0].uses, 2); assert.equal(list[0].name, 'Koramangala office', 'a dropped pin does not overwrite the name');
  assert.equal(list[0].lastTarget, '09:30'); assert.equal(list[0].lastUsed, t0 + day);
});

test('saved places are never pushed out by recents; recents are capped at 15', () => {
  let list = savePlace(rememberPlace([], office, { now: t0 }), null, '');
  list = savePlace(list, list[0].id, 'Office');
  for (let i = 0; i < 20; i++) list = rememberPlace(list, { lat: 13 + i * 0.01, lon: 77.6, name: `P${i}` }, { now: t0 + i * 1000 });
  assert.equal(list.filter((p) => p.saved).length, 1);
  assert.equal(list.filter((p) => !p.saved).length, 15);
  assert.ok(!list.some((p) => p.name === 'P0'), 'oldest recent dropped');
  assert.equal(forgetPlace(list, list[0].id).length, 15);
});

test('suggestions: saved first, then recent, then where past rides ended; not where you are now', () => {
  let list = rememberPlace([], office, { now: t0 });
  list = savePlace(list, list[0].id, 'Office');
  list = rememberPlace(list, { lat: 12.9716, lon: 77.5946, name: 'MG Road' }, { now: t0 + day });
  list = rememberPlace(list, { lat: 12.8000, lon: 77.7000, name: 'Here' }, { now: t0 + 2 * day });
  const ends = rideEnds([
    { summary: { endT: t0 + 3 * day, distanceKm: 25 }, track: [{ lat: 12.77, lon: 80.0 }, { lat: 12.8250, lon: 80.0400 }] },
    { summary: { endT: t0 + 4 * day }, track: [{ lat: 12.9718, lon: 77.5947 }] }, // same as MG Road: not repeated
  ]);
  const s = suggestPlaces(list, { here: { lat: 12.8001, lon: 77.7001 }, ends, now: t0 + 5 * day });
  assert.deepEqual(s.map((p) => p.kind), ['saved', 'recent', 'ride-end']);
  assert.equal(s[0].name, 'Office'); assert.equal(s[1].name, 'MG Road');
  assert.ok(s[0].distanceKm > 10);
  assert.equal(ago(t0, t0 + day), 'yesterday');
});
