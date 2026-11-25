import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseLatLon, wazeUrl, gmapsUrl, projectOnRoute, remainingFrom, etaStatus, createTrip } from '../public/js/trip.js';

// Real OSRM response (fetched 2026-11-25): MG Road area -> Indiranagar, Bengaluru
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/osrm-bengaluru.json', import.meta.url)));
const fakeFetch = async () => ({ ok: true, json: async () => fixture });
const route = fixture.routes[0];
const coords = route.geometry.coordinates;
const DEST = { lat: 12.9784, lon: 77.6408 };

test('parses coordinates from text, Google Maps and Waze links', () => {
  assert.deepEqual(parseLatLon('12.9716, 77.5946'), { lat: 12.9716, lon: 77.5946 });
  assert.deepEqual(parseLatLon('https://www.google.com/maps/place/X/@12.97,77.64,15z/data=!3d12.9784!4d77.6408'), { lat: 12.9784, lon: 77.6408 });
  assert.deepEqual(parseLatLon('https://maps.google.com/?q=12.97,77.64'), { lat: 12.97, lon: 77.64 });
  assert.deepEqual(parseLatLon('https://waze.com/ul?ll=12.97%2C77.64&navigate=yes'), { lat: 12.97, lon: 77.64 });
  assert.equal(parseLatLon('MG Road'), null);
  assert.equal(parseLatLon('95, 200'), null);
});

test('builds Waze and Google Maps navigation links', () => {
  assert.equal(wazeUrl(DEST), 'https://waze.com/ul?ll=12.9784%2C77.6408&navigate=yes');
  assert.match(gmapsUrl(DEST), /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=12\.9784%2C77\.6408&travelmode=two-wheeler&dir_action=navigate$/);
});

test('remaining distance/time at the start equals the full route', () => {
  const [lon, lat] = coords[0];
  const ann = route.legs[0].annotation;
  const rem = remainingFrom({ segments: ann, durationScale: route.duration / ann.duration.reduce((a, b) => a + b, 0) }, projectOnRoute(coords, { lat, lon }));
  assert.ok(Math.abs(rem.meters - route.distance) < 5, `${rem.meters} vs ${route.distance}`);
  assert.ok(Math.abs(rem.seconds - route.duration) < 2);
});

test('target-time status and required speed', () => {
  const now = 0;
  const s = etaStatus({ now, remainingS: 600, targetT: 15 * 60000, remainingM: 6000 });
  assert.equal(s.state, 'early'); assert.equal(s.slackMin, 5);
  assert.equal(Math.round(s.requiredKmh), 24); // 6 km in 15 min
  assert.equal(etaStatus({ now, remainingS: 1200, targetT: 15 * 60000, remainingM: 6000 }).state, 'late');
});

test('trip follows the route and learns the rider pace', async () => {
  const trip = createTrip({ dest: DEST, targetT: null, fetchImpl: fakeFetch });
  const [lon0, lat0] = coords[0];
  assert.equal(trip.update(0, { lat: lat0, lon: lon0, accuracy: 5 }), true); // needs a route
  await trip.fetchRoute({ lat: lat0, lon: lon0 });
  // ride along the route at exactly HALF the route's predicted speed
  const segS = route.legs[0].annotation.duration;
  const scale = route.duration / segS.reduce((a, b) => a + b, 0);
  let t = 0;
  for (let i = 0; i < coords.length; i++) {
    t += i ? segS[i - 1] * scale * 2 * 1000 : 0;
    trip.update(t, { lat: coords[i][1], lon: coords[i][0], accuracy: 5 });
    if (i === Math.floor(coords.length / 2)) {
      const st = trip.status(t);
      assert.ok(Math.abs(st.paceEta.pace - 2) < 0.05, `pace ${st.paceEta.pace}`);
      assert.ok(st.remainingKm > 0.5 && st.remainingKm < route.distance / 1000);
    }
  }
  assert.ok(trip.state.arrived);
});

test('asks to reroute after leaving the route for 15 s', async () => {
  const trip = createTrip({ dest: DEST, fetchImpl: fakeFetch });
  const [lon0, lat0] = coords[0];
  trip.update(0, { lat: lat0, lon: lon0, accuracy: 5 });
  await trip.fetchRoute({ lat: lat0, lon: lon0 });
  trip.update(1000, { lat: lat0, lon: lon0, accuracy: 5 });
  const off = { lat: lat0 + 0.005, lon: lon0, accuracy: 5 }; // ~550 m away
  assert.equal(trip.update(2000, off), false);
  assert.equal(trip.update(18000, off), true);
});

test('editing the target time updates the status', async () => {
  const trip = createTrip({ dest: DEST, targetT: null, fetchImpl: fakeFetch });
  const [lon0, lat0] = coords[0];
  trip.update(0, { lat: lat0, lon: lon0, accuracy: 5 });
  await trip.fetchRoute({ lat: lat0, lon: lon0 });
  trip.update(1000, { lat: lat0, lon: lon0, accuracy: 5 });
  trip.state.targetT = 1000 + 60 * 60000;
  assert.equal(trip.status(1000).routeEta.state, 'early');
});
