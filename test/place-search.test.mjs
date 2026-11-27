import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localMatches, tomtomSuggest, photonSuggest, mergeSuggestions, looksLikeAddressCode, createSuggester } from '../public/js/place-search.js';

const places = [
  { name: 'Office RNTBCI', lat: 12.83, lon: 80.05, saved: true, uses: 40 },
  { name: 'Phoenix Marketcity', lat: 12.991, lon: 80.217, saved: false, uses: 2 },
  { name: 'Home', lat: 13.05, lon: 80.21, saved: true, uses: 90 },
];

test('saved and recent places match as you type, by the start of each word', () => {
  assert.deepEqual(localMatches(places, 'phoe').map((p) => p.name), ['Phoenix Marketcity']);
  assert.deepEqual(localMatches(places, 'off rnt').map((p) => p.name), ['Office RNTBCI']);
  assert.deepEqual(localMatches(places, 'arket'), [], 'not from the middle of a word');
  assert.equal(localMatches(places, 'ho')[0].detail, 'Saved place');
});

test('TomTom type-ahead: names, area and distance, biased to the rider', async () => {
  let url;
  const fetchImpl = async (u) => { url = u; return { ok: true, status: 200, json: async () => ({ results: [
    { type: 'POI', poi: { name: 'Phoenix Marketcity' }, dist: 11756, position: { lat: 12.9915, lon: 80.2171 }, address: { freeformAddress: 'Velachery Main Road, Velachery, Chennai 600042, Tamil Nadu', municipality: 'Chennai' } },
    { type: 'Geography', dist: 5603, position: { lat: 13.088, lon: 80.214 }, address: { municipalitySubdivision: 'Anna Nagar East', municipality: 'Chennai', freeformAddress: 'Anna Nagar East, Chennai, Tamil Nadu' } },
  ] }) }; };
  const r = await tomtomSuggest('phoe', { lat: 13.0827, lon: 80.2707 }, 'k', fetchImpl);
  assert.match(url, /search\/2\/search\/phoe\.json\?typeahead=true&limit=6&language=en-GB&key=k&lat=13\.08270&lon=80\.27070&radius=60000/);
  assert.deepEqual(r.map((x) => [x.name, x.detail, x.distM]), [
    ['Phoenix Marketcity', 'Velachery Main Road, Velachery, Chennai 600042, Tamil Nadu', 11756],
    ['Anna Nagar East', 'Chennai', 5603]]);
  await assert.rejects(tomtomSuggest('x', null, 'bad', async () => ({ ok: false, status: 403 })), /key rejected/);
});

test('Photon (no key): OpenStreetMap places with their area', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ features: [
    { geometry: { coordinates: [80.2171, 12.9915] }, properties: { name: 'Phoenix Marketcity', street: 'Velachery Main Road', district: 'Velachery', city: 'Chennai', state: 'Tamil Nadu' } },
    { geometry: { coordinates: [80.25, 13.06] }, properties: { street: 'Anna Salai', housenumber: '12', city: 'Chennai' } },
  ] }) });
  const r = await photonSuggest('phoenix', null, fetchImpl);
  assert.deepEqual(r.map((x) => [x.name, x.detail]), [['Phoenix Marketcity', 'Velachery Main Road, Velachery, Chennai, Tamil Nadu'], ['12 Anna Salai', 'Chennai']]);
});

test('my places first, and the same place from a search is not listed twice', () => {
  const mine = localMatches(places, 'phoenix');
  const found = [{ name: 'Phoenix Marketcity', lat: 12.9912, lon: 80.2168 }, { name: 'Phoenix Mall Parking', lat: 12.99, lon: 80.21 }];
  assert.deepEqual(mergeSuggestions(mine, found).map((x) => x.name), ['Phoenix Marketcity', 'Phoenix Mall Parking']);
  assert.equal(mergeSuggestions(mine, found)[0].source, 'mine');
});

test('coordinates, Plus Codes, links and what3words skip type-ahead', () => {
  for (const q of ['13.0827, 80.2707', 'WHX8+2G Bengaluru', 'https://maps.app.goo.gl/abc', '///filled.count.soap']) assert.ok(looksLikeAddressCode(q), q);
  for (const q of ['phoenix mall', 'anna nagar 2nd avenue', 'apollo']) assert.ok(!looksLikeAddressCode(q), q);
});

test('suggester waits for a pause in typing and never shows an older answer last', async () => {
  const shown = [], timers = [];
  let resolveSlow;
  const search = (q) => (q === 'pho' ? new Promise((r) => { resolveSlow = () => r(['slow pho']); }) : Promise.resolve([`fast ${q}`]));
  const s = createSuggester({ search, onResults: (r, q) => shown.push([q, r]), setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
  s('p'); // too short: cleared
  s('pho'); timers.at(-1)(); // its answer comes late
  s('phoen'); await timers.at(-1)();
  resolveSlow(); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(shown, [['p', null], ['phoen', ['fast phoen']]], 'the late "pho" answer is dropped');
  s('phoen'); assert.deepEqual(shown.at(-1), ['phoen', ['fast phoen']], 'cached');
});
