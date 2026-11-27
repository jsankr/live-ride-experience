import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cumulative, locate, pointAt, maneuversFrom, nextManeuver, turnText, turnIcon, fmtAhead, createTurnPrompter,
  hazardsAhead, createHazardAlerter, classifyFlow, worstTraffic, probesAhead, tomtomFlow, osmBreakers, mergeSpots, bboxAround, dist,
} from '../public/js/nav.js';

// a straight road due north from Chennai Central, ~2 km, vertices every ~111 m
const coords = Array.from({ length: 19 }, (_, i) => [80.275, 13.082 + i * 0.001]);
const cum = cumulative(coords);
const route = { coords, cum };
const at = (m) => pointAt(coords, cum, m);

test('distance along the route and back to a point', () => {
  assert.ok(Math.abs(cum.at(-1) - 2001) < 5, `total ${cum.at(-1)}`);
  const p = at(750);
  assert.ok(Math.abs(locate(coords, cum, p).along - 750) < 1);
  const beside = { lat: p.lat, lon: p.lon + 0.0002 }; // ~22 m east of the road
  const l = locate(coords, cum, beside);
  assert.ok(Math.abs(l.along - 750) < 1 && Math.abs(l.off - 21.7) < 1.5, JSON.stringify(l));
});

test('OSRM steps become maneuvers at their distance; plain "continue straight" is dropped', () => {
  const steps = [
    { distance: 500, name: 'EVR Salai', maneuver: { type: 'depart', modifier: 'right' } },
    { distance: 300, name: 'EVR Salai', maneuver: { type: 'new name', modifier: 'straight' } },
    { distance: 800, name: 'Anna Salai', maneuver: { type: 'turn', modifier: 'left' } },
    { distance: 400, name: '', maneuver: { type: 'roundabout', modifier: 'right', exit: 2 } },
    { distance: 0, name: '', maneuver: { type: 'arrive', modifier: 'straight' } },
  ];
  const ms = maneuversFrom(steps);
  assert.deepEqual(ms.map((m) => [m.type, m.at]), [['turn', 800], ['roundabout', 1600], ['arrive', 2000]]);
  const n = nextManeuver(ms, 650);
  assert.equal(n.inM, 150); assert.equal(turnText(n), 'Turn left onto Anna Salai'); assert.equal(turnIcon(n), 'left');
  assert.equal(turnText(ms[1]), 'Roundabout, exit 2');
  assert.equal(nextManeuver(ms, 1990).type, 'arrive');
  assert.equal(nextManeuver(ms, 2001), null);
});

test('distances read like a navigation app', () => {
  assert.equal(fmtAhead(1234), '1.2 km'); assert.equal(fmtAhead(437), '450 m'); assert.equal(fmtAhead(83), '80 m'); assert.equal(fmtAhead(4), '10 m');
  assert.equal(fmtAhead(160.9, true), '550 ft'); assert.equal(fmtAhead(3218, true), '2.0 mi');
});

test('turn prompts: far, near, now, each once, and none skipped back', () => {
  const say = createTurnPrompter();
  const m = { at: 1000, type: 'turn', modifier: 'right', name: 'Mount Road' };
  const heard = [];
  for (let d = 900; d >= 0; d -= 10) { const s = say({ ...m, inM: d }, 40); if (s) heard.push([d, s]); }
  assert.equal(heard.length, 3, JSON.stringify(heard));
  assert.match(heard[0][1], /^In 400 m, turn right onto Mount Road$/);
  assert.match(heard[1][1], /^In 1\d0 m, turn right/);
  assert.equal(heard[2][1], 'Turn right onto Mount Road');
  // joining late (already 100 m away): only the near and now prompts
  const say2 = createTurnPrompter();
  const late = [];
  for (let d = 100; d >= 0; d -= 10) { const s = say2({ ...m, inM: d }, 40); if (s) late.push(s); }
  assert.equal(late.length, 2);
});

test('hazards ahead along the route: only near the road and in front of us', () => {
  const spots = [
    { type: 'bump', ...at(400) },
    { type: 'pothole', ...at(250) },
    { type: 'pothole', ...at(100) }, // behind us
    { type: 'bump', lat: at(300).lat, lon: at(300).lon + 0.001 }, // ~108 m off the road
    { type: 'bump', ...at(1500) }, // too far ahead
  ];
  const ahead = hazardsAhead(spots, { fix: at(150), route, travelled: 150, lookM: 600 });
  assert.deepEqual(ahead.map((h) => [h.spot.type, Math.round(h.ahead)]), [['pothole', 100], ['bump', 250]]);
});

test('hazards ahead without a route: by heading', () => {
  const fix = at(0);
  const spots = [{ type: 'bump', ...at(200) }, { type: 'pothole', lat: fix.lat - 0.002, lon: fix.lon }];
  assert.deepEqual(hazardsAhead(spots, { fix, heading: 2, lookM: 600 }).map((h) => h.spot.type), ['bump']);
  assert.deepEqual(hazardsAhead(spots, { fix, heading: 182, lookM: 600 }).map((h) => h.spot.type), ['pothole']);
  assert.equal(hazardsAhead(spots, { fix, heading: null }).length, 0, 'no heading, no guess');
});

test('hazard alert fires once, about 7 s ahead (never under 60 m)', () => {
  const alert = createHazardAlerter();
  const spot = { type: 'bump', ...at(400) };
  assert.equal(alert([{ spot, ahead: 200 }], 50, 0), null, '50 km/h: warn at ~97 m');
  assert.equal(alert([{ spot, ahead: 95 }], 50, 1000).spot, spot);
  assert.equal(alert([{ spot, ahead: 60 }], 50, 2000), null, 'only once');
  const slow = createHazardAlerter();
  assert.equal(slow([{ spot, ahead: 70 }], 10, 0), null);
  assert.equal(slow([{ spot, ahead: 58 }], 10, 0).spot, spot);
});

test('traffic level from current vs free-flow speed; worst stretch wins', () => {
  assert.equal(classifyFlow(40, 45).level, 'free');
  assert.equal(classifyFlow(28, 45).level, 'slow');
  assert.equal(classifyFlow(14, 45).level, 'heavy');
  assert.equal(classifyFlow(5, 45).level, 'jam');
  assert.equal(classifyFlow(0, 45, true).level, 'closed');
  assert.equal(classifyFlow(undefined, 45).level, 'unknown');
  const w = worstTraffic([{ ahead: 400, currentKmh: 40, freeKmh: 45 }, { ahead: 1200, currentKmh: 12, freeKmh: 45 }, { ahead: 2500, currentKmh: 3, freeKmh: 45, confidence: 0.2 }]);
  assert.equal(w.level, 'heavy'); assert.equal(w.ahead, 1200);
});

test('traffic probes lie on the route ahead, not past the end', () => {
  const p = probesAhead(route, 1000);
  assert.deepEqual(p.map((x) => x.ahead), [400]);
  assert.ok(Math.abs(locate(coords, cum, p[0]).along - 1400) < 1);
});

test('TomTom flow and OpenStreetMap breakers parse; a rejected key says so', async () => {
  const ok = async () => ({ ok: true, status: 200, json: async () => ({ flowSegmentData: { currentSpeed: 12, freeFlowSpeed: 40, confidence: 0.9, roadClosure: false } }) });
  assert.deepEqual(await tomtomFlow({ lat: 13, lon: 80 }, 'k', ok), { currentKmh: 12, freeKmh: 40, closed: false, confidence: 0.9 });
  await assert.rejects(tomtomFlow({ lat: 13, lon: 80 }, 'bad', async () => ({ ok: false, status: 403 })), /key rejected/);
  const osm = async (url, init) => {
    assert.match(decodeURIComponent(init.body), /traffic_calming/);
    return { ok: true, json: async () => ({ elements: [{ type: 'node', lat: 13.1, lon: 80.2, tags: { traffic_calming: 'hump' } }] }) };
  };
  assert.deepEqual((await osmBreakers(bboxAround([{ lat: 13.1, lon: 80.2 }]), osm)).map((s) => s.type), ['bump']);
});

test('an OpenStreetMap breaker where RideLens already detected one is not doubled', () => {
  const own = [{ type: 'bump', lat: 13.1, lon: 80.2 }];
  const osm = [{ type: 'bump', lat: 13.10005, lon: 80.2, source: 'osm' }, { type: 'bump', lat: 13.11, lon: 80.2, source: 'osm' }];
  const m = mergeSpots(own, osm);
  assert.equal(m.length, 2); assert.equal(m[0].source, 'rides');
  assert.ok(dist(m[0], osm[0]) < 20);
});

import { cleanTomTomKey, looksLikeTomTomKey } from '../public/js/nav.js';
test('a pasted TomTom key is cleaned up however it was copied', () => {
  const k = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  for (const pasted of [k, ` ${k}\n`, `"${k}"`, `key=${k}`, `Key: ${k}`, `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?point=13,80&key=${k}`, `https://x/#tomtom=1&key=${k}`]) {
    assert.equal(cleanTomTomKey(pasted), k, pasted);
  }
  assert.ok(looksLikeTomTomKey(k));
  assert.ok(!looksLikeTomTomKey('my first api key'));
  assert.ok(!looksLikeTomTomKey(k.slice(0, 20)));
});

// ---- TomTom Orbis routing (real response: Chennai Central -> Adyar, 27 Nov 2026 12:17 IST) ----
import { readFileSync } from 'node:fs';
import { parseTomTomRoute, maneuverFromTomTom, eventsAhead, tomtomRoute, TEC_CAUSE } from '../public/js/nav.js';
import { createTrip } from '../public/js/trip.js';
const tt = JSON.parse(readFileSync(new URL('./fixtures/tomtom-orbis-chennai.json', import.meta.url)));

test('TomTom route: geometry, live-traffic time and per-segment times that add up', () => {
  const r = parseTomTomRoute(tt);
  assert.equal(r.coords.length, 471);
  assert.ok(Math.abs(r.distance - 17629) / 17629 < 0.01, `length ${r.distance}`);
  const sum = r.segments.duration.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 2776) < 2, `segment times ${sum} vs 2776 s`);
  assert.equal(r.live, true); assert.equal(r.trafficDelayS, 107);
});

test('TomTom route: the jam and the road works on it, where they are', () => {
  const r = parseTomTomRoute(tt);
  assert.deepEqual(r.events.map((e) => [e.kind, e.label, e.speedKmh]), [['jam', 'Traffic jam', 9], ['works', 'Road works', 32]]);
  assert.ok(r.events[0].at > 11000 && r.events[0].at < r.events[0].endAt && r.events[1].at > r.events[0].endAt);
  assert.equal(r.events[0].alert, false, 'a jam goes on the chip, not a banner');
  assert.equal(r.events[1].alert, true, 'road works get a warning');
  const ahead = eventsAhead(r, r.events[0].at - 900);
  assert.equal(Math.round(ahead[0].inM), 900);
  assert.equal(eventsAhead(r, r.events[1].endAt + 1).length, 0, 'none left once past');
  assert.equal(TEC_CAUSE[2], 'Accident');
});

test('TomTom turns: types, sentences, and arrival phrased for prompts', () => {
  const r = parseTomTomRoute(tt);
  assert.ok(r.maneuvers.length >= 10);
  assert.ok(r.maneuvers.every((m, i) => i === 0 || m.at >= r.maneuvers[i - 1].at), 'in route order');
  const last = r.maneuvers.at(-1);
  assert.equal(last.type, 'arrive'); assert.match(turnText(last), /^Arrive at destination/);
  assert.deepEqual(maneuverFromTomTom('ROUNDABOUT_SLIGHT_RIGHT'), { type: 'roundabout', modifier: 'right' });
  assert.deepEqual(maneuverFromTomTom('KEEP_LEFT'), { type: 'fork', modifier: 'slight left' });
  assert.deepEqual(maneuverFromTomTom('SHARP_RIGHT'), { type: 'turn', modifier: 'sharp right' });
  assert.equal(maneuverFromTomTom('STRAIGHT'), null); assert.equal(maneuverFromTomTom('DEPART'), null);
  assert.equal(turnText({ type: 'roundabout', modifier: 'right', text: 'At the roundabout take the third exit to stay on Basin Bridge Road' }), 'At the roundabout take the third exit to stay on Basin Bridge Road');
  const say = createTurnPrompter();
  assert.equal(say({ ...last, inM: 300 }, 30), 'In 300 m, arrive at destination, on the ' + last.modifier);
});

test('trip: TomTom with a key, OSRM without one or when TomTom refuses', async () => {
  const urls = [];
  const fetchOk = async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => tt }; };
  const dest = { lat: 13.0067, lon: 80.2572, name: 'Adyar' };
  const t1 = createTrip({ dest, fetchImpl: fetchOk, routeKey: () => 'k' });
  await t1.fetchRoute({ lat: 13.0827, lon: 80.2707 });
  assert.match(urls[0], /api\.tomtom\.com\/maps\/orbis\/routing\/calculateRoute\/13\.082700,80\.270700:13\.006700,80\.257200\/json\?apiVersion=2&sectionType=traffic/);
  assert.equal(t1.state.route.live, true);
  assert.equal(t1.update(Date.now(), { lat: 13.0827, lon: 80.2707, accuracy: 5 }), false);
  assert.equal(t1.update(Date.now() + 181000, { lat: 13.0827, lon: 80.2707, accuracy: 5 }), true, 'stale after 3 minutes');
  // refused key: falls back to OSRM so there is still a route
  const osrm = JSON.parse(readFileSync(new URL('./fixtures/osrm-bengaluru.json', import.meta.url)));
  const fetchMixed = async (url) => /tomtom/.test(url) ? { ok: false, status: 403 } : { ok: true, status: 200, json: async () => osrm };
  const t2 = createTrip({ dest, fetchImpl: fetchMixed, routeKey: () => 'bad' });
  await t2.fetchRoute({ lat: 12.971848, lon: 77.594697 });
  assert.equal(t2.state.route.live, undefined);
  t2.update(Date.now(), { lat: 12.971848, lon: 77.594697, accuracy: 5 }); // on the route's first point
  assert.match(t2.status().source, /TomTom live traffic failed: TomTom key rejected/);
  await assert.rejects(tomtomRoute({ lat: 1, lon: 1 }, { lat: 2, lon: 2 }, 'x', async () => ({ ok: false, status: 400 })), /TomTom routing: 400/);
});
