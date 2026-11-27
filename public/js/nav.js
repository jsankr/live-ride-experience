// Riding HUD navigation, Waze-style: next turn and how far, hazards coming up (potholes and
// speed breakers) with an alert as you approach, and the traffic ahead.
//
// Where the data comes from (nothing is invented):
//  * Turns: OSRM route steps (OpenStreetMap). Distances are measured along the route.
//  * Potholes and breakers: the ones RideLens itself detected on your earlier rides (the
//    hazard map), plus speed breakers mapped in OpenStreetMap (traffic_calming=*) via the
//    Overpass API. Waze's own crowd reports are not available to other apps.
//  * Traffic: TomTom Traffic Flow (current vs free-flow speed on the road ahead), only with
//    the rider's own free API key. Waze and Google do not offer live traffic to other apps.
// Pure functions here are DOM-free and unit-tested; fetchers take a fetch implementation.

const R = 6371000, D2R = Math.PI / 180;
export const dist = (a, b) => {
  const dLat = (b.lat - a.lat) * D2R, dLon = (b.lon - a.lon) * D2R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};
export const bearing = (a, b) => {
  const y = Math.sin((b.lon - a.lon) * D2R) * Math.cos(b.lat * D2R);
  const x = Math.cos(a.lat * D2R) * Math.sin(b.lat * D2R) - Math.sin(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.cos((b.lon - a.lon) * D2R);
  return (Math.atan2(y, x) / D2R + 360) % 360;
};
export const angleGap = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// ---------- along-route geometry ----------
// cumulative metres at each vertex of a [lon, lat] polyline
export function cumulative(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + dist({ lon: coords[i - 1][0], lat: coords[i - 1][1] }, { lon: coords[i][0], lat: coords[i][1] }));
  return cum;
}
// nearest point of the route to p: { along (m from start), off (m from the line) }
export function locate(coords, cum, p) {
  const k = Math.cos(p.lat * D2R);
  const xy = ([lon, lat]) => [(lon - p.lon) * D2R * R * k, (lat - p.lat) * D2R * R];
  let best = { along: 0, off: Infinity };
  for (let i = 0; i < coords.length - 1; i++) {
    const [ax, ay] = xy(coords[i]), [bx, by] = xy(coords[i + 1]);
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const f = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
    const off = Math.hypot(ax + f * dx, ay + f * dy);
    if (off < best.off) best = { along: cum[i] + f * (cum[i + 1] - cum[i]), off };
  }
  return best;
}
// the point `along` metres from the route start: { lat, lon }
export function pointAt(coords, cum, along) {
  if (along <= 0) return { lon: coords[0][0], lat: coords[0][1] };
  for (let i = 1; i < coords.length; i++) {
    if (cum[i] >= along) {
      const f = (along - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]);
      return { lon: coords[i - 1][0] + f * (coords[i][0] - coords[i - 1][0]), lat: coords[i - 1][1] + f * (coords[i][1] - coords[i - 1][1]) };
    }
  }
  const last = coords[coords.length - 1];
  return { lon: last[0], lat: last[1] };
}

// ---------- turns ----------
// OSRM steps -> maneuvers with their distance from the route start
export function maneuversFrom(steps = []) {
  const out = [];
  let cum = 0;
  for (const s of steps) {
    const m = s.maneuver || {};
    if (m.type && m.type !== 'depart') {
      out.push({ at: cum, type: m.type, modifier: m.modifier || 'straight', name: s.name || s.ref || '', exit: m.exit ?? null,
        location: m.location ? { lon: m.location[0], lat: m.location[1] } : null });
    }
    cum += s.distance || 0;
  }
  // "continue straight" / "new name" with no direction change are not turns a rider needs
  return out.filter((m) => !((m.type === 'new name' || m.type === 'continue' || m.type === 'notification') && /straight/.test(m.modifier)));
}
export function nextManeuver(maneuvers, travelled) {
  const m = maneuvers.find((x) => x.at > travelled + 3);
  return m ? { ...m, inM: m.at - travelled } : null;
}
const SIDE = { left: 'left', right: 'right', 'slight left': 'slight left', 'slight right': 'slight right', 'sharp left': 'sharp left', 'sharp right': 'sharp right', uturn: 'U-turn', straight: 'straight' };
export function turnText(m) {
  if (!m) return '';
  if (m.type === 'arrive') return `Arrive at destination${/left|right/.test(m.modifier) ? `, on the ${m.modifier}` : ''}`;
  if (m.text) return m.text; // TomTom's own sentence (roundabout exits, which side, street)
  if (m.type === 'toll') return 'Pass through the toll gate';
  const onto = m.name ? ` onto ${m.name}` : '';
  if (m.type === 'roundabout' || m.type === 'rotary' || m.type === 'exit roundabout') return `Roundabout${m.exit ? `, exit ${m.exit}` : ''}${onto}`;
  if (m.modifier === 'uturn') return `Make a U-turn${onto}`;
  if (m.type === 'fork') return `Keep ${/left/.test(m.modifier) ? 'left' : 'right'} at the fork${onto}`;
  if (m.type === 'merge') return `Merge ${/left/.test(m.modifier) ? 'left' : 'right'}${onto}`;
  if (m.type === 'on ramp') return `Take the ramp${onto}`;
  if (m.type === 'off ramp') return `Take the exit${onto}`;
  if (m.modifier === 'straight') return `Continue straight${onto}`;
  return `Turn ${SIDE[m.modifier] || m.modifier}${onto}`;
}
// icon key for the arrow drawn in the HUD
export function turnIcon(m) {
  if (!m) return 'straight';
  if (m.type === 'arrive') return 'arrive';
  if (m.type === 'roundabout' || m.type === 'rotary' || m.type === 'exit roundabout') return 'roundabout';
  return { left: 'left', right: 'right', 'slight left': 'slight-left', 'slight right': 'slight-right', 'sharp left': 'sharp-left', 'sharp right': 'sharp-right', uturn: 'uturn' }[m.modifier] || 'straight';
}
// rounded the way navigation apps say it: 1.2 km, 450 m, 80 m
export function fmtAhead(m, imperial = false) {
  if (imperial) {
    const ft = m * 3.28084;
    return ft >= 1000 ? `${(m / 1609.34).toFixed(1)} mi` : `${Math.max(10, Math.round(ft / 50) * 50)} ft`;
  }
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km`;
  return `${Math.max(10, Math.round(m / (m >= 200 ? 50 : 10)) * (m >= 200 ? 50 : 10))} m`;
}

// Spoken turn prompts at a far, a near and a "now" distance, scaled with speed; each once.
export function createTurnPrompter() {
  const said = new Map(); // maneuver -> furthest stage already spoken (0 far, 1 near, 2 now)
  return (next, speedKmh = 30) => {
    if (!next) return null;
    const v = Math.max(5, speedKmh) / 3.6;
    const limits = [Math.max(400, v * 25), Math.max(120, v * 9), Math.max(25, v * 2.5)];
    let stage = -1; // the closest stage we are inside
    for (let i = 0; i < 3; i++) if (next.inM <= limits[i]) stage = i;
    const id = next.location ? `${next.location.lat.toFixed(4)},${next.location.lon.toFixed(4)}` : next.at; // stable across re-routes
    if (stage < 0 || (said.get(id) ?? -1) >= stage) return null;
    said.set(id, stage);
    return stage === 2 ? turnText(next) : `In ${fmtAhead(next.inM)}, ${turnText(next).replace(/^./, (c) => c.toLowerCase())}`;
  };
}

// ---------- hazards ahead ----------
// spots: [{ type: 'pothole'|'bump', lat, lon, worst?, rides?, source }]
// With a route: hazards within 25 m of it, ahead of us along it. Without: within a cone of
// our heading (straight-line distance). Returns nearest first: { spot, ahead (m) }.
export function hazardsAhead(spots, { fix, heading = null, route = null, travelled = null, lookM = 600 }) {
  const out = [];
  if (!fix) return out;
  for (const s of spots) {
    if (route && travelled != null) {
      const loc = locate(route.coords, route.cum, s);
      if (loc.off > 25) continue;
      const ahead = loc.along - travelled;
      if (ahead > 0 && ahead <= lookM) out.push({ spot: s, ahead });
    } else {
      const d = dist(fix, s);
      if (d > lookM || d < 3 || heading == null) continue;
      // narrow cone far away, wider close in (lane offset)
      const allowed = Math.min(60, 12 + (180 / Math.PI) * Math.atan2(8, d));
      if (angleGap(bearing(fix, s), heading) <= allowed) out.push({ spot: s, ahead: d });
    }
  }
  return out.sort((a, b) => a.ahead - b.ahead);
}
// Raises one alert per spot when it comes within the warning distance (about 7 s ahead,
// never less than 60 m). Returns the new alert or null.
export function createHazardAlerter({ seconds = 7, minM = 60 } = {}) {
  const warned = new Map(); // key -> time
  return (ahead, speedKmh, now = Date.now()) => {
    for (const [k, t] of warned) if (now - t > 10 * 60000) warned.delete(k);
    const warnAt = Math.max(minM, (Math.max(0, speedKmh) / 3.6) * seconds);
    for (const h of ahead) {
      if (h.ahead > warnAt) break;
      const key = `${h.spot.type}|${h.spot.lat.toFixed(5)}|${h.spot.lon.toFixed(5)}`;
      if (warned.has(key)) continue;
      warned.set(key, now);
      return h;
    }
    return null;
  };
}
export const hazardLabel = (s) => s.label || (s.type === 'pothole' ? 'Pothole' : 'Speed breaker');

// Speed breakers mapped in OpenStreetMap, inside a bounding box [s, w, n, e]
export async function osmBreakers(bbox, fetchImpl = fetch) {
  const q = `[out:json][timeout:20];node["traffic_calming"~"^(bump|hump|table|cushion|yes|rumble_strip|dip)$"](${bbox.map((v) => v.toFixed(5)).join(',')});out;`;
  const res = await fetchImpl('https://overpass-api.de/api/interpreter', { method: 'POST', body: `data=${encodeURIComponent(q)}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  if (!res.ok) throw new Error(`OpenStreetMap hazards: ${res.status}`);
  const j = await res.json();
  return (j.elements || []).filter((e) => e.type === 'node').map((e) => ({ type: e.tags?.traffic_calming === 'dip' ? 'pothole' : 'bump', lat: e.lat, lon: e.lon, source: 'osm', worst: 'moderate', rides: 0 }));
}
export function bboxAround(points, padM = 150) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const p of points) { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lon); e = Math.max(e, p.lon); }
  const dLat = padM / 111320, dLon = padM / (111320 * Math.cos(((s + n) / 2) * D2R));
  return [s - dLat, w - dLon, n + dLat, e + dLon];
}
// merge, dropping an OSM breaker where RideLens already has its own detection
export function mergeSpots(own, osm, radiusM = 20) {
  return [...own.map((s) => ({ ...s, source: s.source || 'rides' })), ...osm.filter((o) => !own.some((s) => s.type === o.type && dist(s, o) <= radiusM))];
}

// ---------- traffic ----------
export function classifyFlow(currentKmh, freeKmh, closed = false) {
  if (closed) return { level: 'closed', label: 'Road closed' };
  if (!(currentKmh >= 0) || !(freeKmh > 0)) return { level: 'unknown', label: 'No traffic data' };
  const r = currentKmh / freeKmh;
  if (r >= 0.75) return { level: 'free', label: 'Clear', ratio: r };
  if (r >= 0.5) return { level: 'slow', label: 'Slow', ratio: r };
  if (r >= 0.25) return { level: 'heavy', label: 'Heavy', ratio: r };
  return { level: 'jam', label: 'Standstill', ratio: r };
}
const LEVEL = { unknown: -1, free: 0, slow: 1, heavy: 2, jam: 3, closed: 4 };
// points on the route ahead to sample (metres ahead)
export function probesAhead(route, travelled, aheadM = [400, 1200, 2500]) {
  const left = route.cum[route.cum.length - 1] - travelled;
  return aheadM.filter((a) => a < left).map((a) => ({ ahead: a, ...pointAt(route.coords, route.cum, travelled + a) }));
}
// A pasted key may come with spaces, quotes, a "key=" prefix or inside a whole request URL.
// TomTom keys are 32 letters and digits.
export function cleanTomTomKey(text = '') {
  const t = String(text).trim();
  const fromUrl = t.match(/[?&#]key=([A-Za-z0-9]+)/);
  const v = (fromUrl ? fromUrl[1] : t).replace(/^["'`\s]+|["'`\s]+$/g, '').replace(/^key\s*[:=]\s*/i, '');
  return v;
}
export const looksLikeTomTomKey = (k) => /^[A-Za-z0-9]{32}$/.test(k);

export async function tomtomFlow(p, key, fetchImpl = fetch) {
  const url = `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?point=${p.lat.toFixed(6)},${p.lon.toFixed(6)}&unit=KMPH&key=${encodeURIComponent(key)}`;
  const res = await fetchImpl(url);
  if (res.status === 403 || res.status === 401) throw new Error('TomTom key rejected');
  if (!res.ok) throw new Error(`TomTom traffic: ${res.status}`);
  const f = (await res.json()).flowSegmentData || {};
  return { currentKmh: f.currentSpeed, freeKmh: f.freeFlowSpeed, closed: !!f.roadClosure, confidence: f.confidence ?? null };
}
// worst stretch among sampled points: { level, label, ahead, currentKmh, freeKmh }
export function worstTraffic(samples) {
  let worst = null;
  for (const s of samples) {
    const c = classifyFlow(s.currentKmh, s.freeKmh, s.closed);
    if (c.level === 'unknown' || (s.confidence != null && s.confidence < 0.4)) continue;
    if (!worst || LEVEL[c.level] > LEVEL[worst.level] || (LEVEL[c.level] === LEVEL[worst.level] && s.ahead < worst.ahead)) worst = { ...c, ahead: s.ahead, currentKmh: s.currentKmh, freeKmh: s.freeKmh };
  }
  return worst;
}

// ---------- TomTom Orbis routing: live-traffic route, turns, and what is on the road ----------
// One request gives the route with a live-traffic ETA, spoken-style turn instructions and
// the traffic events along it (jams with speed and delay, road works, closures, accidents).
// Used when the rider has a TomTom key; OSRM (no traffic) otherwise.
// Cause codes are TPEG-TEC main causes, as TomTom reports them in sections[].tec.
export const TEC_CAUSE = {
  1: 'Traffic jam', 2: 'Accident', 3: 'Road works', 4: 'Narrow lanes', 5: 'Road blocked', 6: 'Slippery road',
  7: 'Water on road', 8: 'Fire', 9: 'Hazardous conditions', 10: 'Object on road', 11: 'Animals on road',
  12: 'People on road', 13: 'Broken-down vehicle', 14: 'Vehicle on wrong side', 15: 'Rescue work',
  16: 'Police measures', 17: 'Extreme weather', 18: 'Poor visibility', 19: 'Heavy rain', 20: 'Reckless driver',
  23: 'Major event', 26: 'Slow vehicles', 27: 'Queue ahead', 30: 'Police checkpoint',
};
// events worth a banner and a spoken warning before you reach them (a jam is on the chip)
const ALERT_CAUSES = new Set([2, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 20, 27]);
export function trafficEventFrom(sec, cum, coords) {
  const cause = sec.tec?.causes?.[0]?.mainCauseCode ?? null;
  const cat = sec.simpleCategory || 'OTHER';
  const kind = cat === 'ROAD_CLOSURE' ? 'closure' : cat === 'ROAD_WORK' ? 'works' : cause && cause !== 1 && cause !== 26 && cause !== 29 ? 'incident' : 'jam';
  const label = cat === 'ROAD_CLOSURE' ? 'Road closed' : cat === 'ROAD_WORK' ? 'Road works' : (cause && TEC_CAUSE[cause]) || (cat === 'JAM' ? 'Traffic jam' : 'Traffic incident');
  const at = cum[Math.min(sec.startPointIndex ?? 0, cum.length - 1)], endAt = cum[Math.min(sec.endPointIndex ?? 0, cum.length - 1)];
  const [lon, lat] = coords[Math.min(sec.startPointIndex ?? 0, coords.length - 1)];
  return { kind, label, cause, at, endAt, lat, lon, speedKmh: sec.effectiveSpeedInKmh ?? null, delayS: sec.delayInSeconds ?? 0,
    magnitude: sec.magnitudeOfDelay ?? 0, id: sec.eventId || `${kind}|${lat.toFixed(4)}|${lon.toFixed(4)}`,
    alert: kind === 'closure' || kind === 'works' || (kind === 'incident' && ALERT_CAUSES.has(cause)) };
}
// TomTom maneuver -> the { type, modifier } the HUD and prompts use
export function maneuverFromTomTom(code = '') {
  const side = /LEFT/.test(code) ? 'left' : /RIGHT/.test(code) ? 'right' : 'straight';
  if (/^ARRIVE/.test(code)) return { type: 'arrive', modifier: side };
  if (/ROUNDABOUT/.test(code)) return { type: 'roundabout', modifier: side };
  if (/UTURN/.test(code)) return { type: 'turn', modifier: 'uturn' };
  if (/^SHARP_/.test(code)) return { type: 'turn', modifier: `sharp ${side}` };
  if (/^(SLIGHT|BEAR)_/.test(code)) return { type: 'turn', modifier: `slight ${side}` };
  if (/^KEEP_/.test(code)) return { type: 'fork', modifier: `slight ${side}` };
  if (/^TURN_/.test(code)) return { type: 'turn', modifier: side };
  if (/EXIT|LEAVE/.test(code)) return { type: 'off ramp', modifier: side };
  if (/ENTER|MERGE|MOTORWAY|FREEWAY|HIGHWAY/.test(code)) return { type: 'merge', modifier: side };
  if (/TOLL/.test(code)) return { type: 'toll', modifier: 'straight' };
  return null; // DEPART, STRAIGHT, and anything that is not a turn
}
export function parseTomTomRoute(j) {
  const r = j?.routes?.[0];
  if (!r) throw new Error(j?.detailedError?.message || 'no route');
  const coords = r.legs.flatMap((l, i) => (i ? l.points.slice(1) : l.points)).map((p) => [p.longitude, p.latitude]);
  const cum = cumulative(coords);
  const total = cum[cum.length - 1], k = total > 0 ? total / Math.max(1, r.summary.lengthInMeters) : 1;
  const events = (r.sections || []).filter((s) => s.sectionType === 'TRAFFIC').map((s) => trafficEventFrom(s, cum, coords)).sort((a, b) => a.at - b.at);
  // per-segment time: traffic stretches at their measured speed, the rest at the speed that
  // makes the whole add up to TomTom's live-traffic travel time
  const dist = cum.slice(1).map((c, i) => c - cum[i]);
  const slow = new Array(dist.length).fill(null);
  for (const s of r.sections || []) if (s.sectionType === 'TRAFFIC' && s.effectiveSpeedInKmh > 0) for (let i = s.startPointIndex; i < s.endPointIndex && i < dist.length; i++) slow[i] = s.effectiveSpeedInKmh / 3.6;
  const tSlow = dist.reduce((a, d, i) => a + (slow[i] ? d / slow[i] : 0), 0), dRest = dist.reduce((a, d, i) => a + (slow[i] ? 0 : d), 0);
  const vRest = dRest / Math.max(1, r.summary.travelTimeInSeconds - tSlow) || 10;
  const duration = dist.map((d, i) => d / (slow[i] || Math.max(1, vRest)));
  const maneuvers = (r.guidance?.instructions || []).map((ins) => {
    const m = maneuverFromTomTom(ins.maneuver);
    if (!m) return null;
    const name = ins.nextRoadInfo?.streetName?.text || '';
    return { at: (ins.routeOffsetInMeters ?? 0) * k, ...m, name, exit: ins.roundaboutExitNumber ?? null,
      text: (ins.instructionMessage || '').replace(/\.$/, ''), location: ins.maneuverPoint ? { lat: ins.maneuverPoint.latitude, lon: ins.maneuverPoint.longitude } : null };
  }).filter(Boolean);
  return { coords, cum, distance: total, duration: r.summary.travelTimeInSeconds, segments: { distance: dist, duration }, durationScale: 1,
    maneuvers, events, live: true, trafficDelayS: r.summary.trafficDelayInSeconds ?? 0, source: 'TomTom (live traffic)' };
}
export async function tomtomRoute(from, to, key, fetchImpl = fetch) {
  const url = `https://api.tomtom.com/maps/orbis/routing/calculateRoute/${from.lat.toFixed(6)},${from.lon.toFixed(6)}:${to.lat.toFixed(6)},${to.lon.toFixed(6)}/json`
    + `?apiVersion=2&sectionType=traffic&guidanceVersion=2&instructionsType=text&instructionPhonetics=IPA&language=en-GB&key=${encodeURIComponent(key)}`;
  const res = await fetchImpl(url);
  if (res.status === 401 || res.status === 403) throw new Error('TomTom key rejected');
  if (!res.ok) throw new Error(`TomTom routing: ${res.status}`);
  return parseTomTomRoute(await res.json());
}
// traffic events still ahead of us on the route, nearest first
export function eventsAhead(route, travelled, lookM = 15000) {
  return (route?.events || []).filter((e) => e.endAt > travelled && e.at - travelled <= lookM).map((e) => ({ ...e, inM: Math.max(0, e.at - travelled) }));
}
