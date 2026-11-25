import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeHazards, hazardsGeoJson, hazardsCsv } from '../public/js/hazards.js';

const ev = (type, lat, lon, severity, t = 1) => ({ type, lat, lon, severity, p2pG: 2, t });
test('the same pothole on different rides becomes one spot', () => {
  const rides = [
    { id: 'r1', events: [ev('pothole', 12.97, 77.59, 'moderate'), ev('bump', 12.98, 77.60, 'minor')] },
    { id: 'r2', events: [ev('pothole', 12.97005, 77.59004, 'severe', 5), ev('pothole', 12.975, 77.595, 'minor')] }, // first is ~7 m from r1's
  ];
  const spots = mergeHazards(rides);
  assert.equal(spots.length, 3);
  const p = spots[0];
  assert.equal(p.type, 'pothole'); assert.equal(p.hits, 2); assert.equal(p.rides, 2); assert.equal(p.worst, 'severe');
  assert.equal(spots.at(-1).type, 'bump'); // potholes listed before breakers
});

test('exports GeoJSON and CSV', () => {
  const spots = mergeHazards([{ id: 'r', events: [ev('pothole', 12.97, 77.59, 'severe')] }]);
  const gj = hazardsGeoJson(spots);
  assert.deepEqual(gj.features[0].geometry.coordinates, [77.59, 12.97]);
  assert.equal(gj.features[0].properties.kind, 'pothole');
  assert.match(hazardsCsv(spots), /^kind,severity,lat,lon/);
  assert.match(hazardsCsv(spots), /pothole,severe,12.97,77.59,1,1/);
});
