// Trip: destination, target arrival time and a live ETA.
//
// Where the numbers come from (nothing is invented):
//  * Route + per-segment free-flow durations: OSRM public server (OpenStreetMap data,
//    car profile, NO live traffic).
//  * "At your pace" ETA: the route's remaining duration scaled by how this trip has
//    actually gone so far (real elapsed time / route-predicted time for the part covered).
//  * If routing is unreachable: straight-line distance / your average moving speed, labelled so.
// Waze and Google Maps do not let other apps read their live ETA, so RideLens can only
// hand the destination to them (deep links) and compute its own estimate.

import { haversine } from './analytics.js';

export const OSRM = 'https://router.project-osrm.org';
export const NOMINATIM = 'https://nominatim.openstreetmap.org';

// ---------- pure helpers (tested in Node) ----------

// Accepts "12.97, 77.59", Google Maps links (…/@12.97,77.59,15z, ?q=12.97,77.59,
// ?destination=…, !3d12.97!4d77.59) and Waze links (?ll=12.97,77.59 / %2C).
export function parseLatLon(input) {
  const s = decodeURIComponent(String(input || '').trim());
  const pats = [
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
    /[?&](?:ll|q|query|destination|daddr)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
    /^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/,
  ];
  for (const re of pats) {
    const m = re.exec(s);
    if (!m) continue;
    const lat = +m[1], lon = +m[2];
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
  }
  return null;
}

export const wazeUrl = ({ lat, lon }) => `https://waze.com/ul?ll=${lat}%2C${lon}&navigate=yes`;
export const gmapsUrl = ({ lat, lon }) =>
  `https://www.google.com/maps/dir/?api=1&destination=${lat}%2C${lon}&travelmode=two-wheeler&dir_action=navigate`;

// Project point p onto the route polyline; returns segment index, fraction along it and
// distance from the route (metres). coords are [lon, lat] pairs (GeoJSON order).
export function projectOnRoute(coords, p) {
  const R = 6371000, D2R = Math.PI / 180;
  const k = Math.cos(p.lat * D2R);
  const xy = ([lon, lat]) => [(lon - p.lon) * D2R * R * k, (lat - p.lat) * D2R * R];
  let best = { i: 0, f: 0, d: Infinity };
  for (let i = 0; i < coords.length - 1; i++) {
    const [ax, ay] = xy(coords[i]), [bx, by] = xy(coords[i + 1]);
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const f = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
    const d = Math.hypot(ax + f * dx, ay + f * dy);
    if (d < best.d) best = { i, f, d };
  }
  return best;
}

// Remaining distance/duration from a projection, using OSRM per-segment annotations.
export function remainingFrom(route, proj) {
  const { distance: dist, duration: dur } = route.segments;
  let m = dist[proj.i] * (1 - proj.f), s = dur[proj.i] * (1 - proj.f);
  for (let j = proj.i + 1; j < dist.length; j++) { m += dist[j]; s += dur[j]; }
  // OSRM's route total includes turn/junction penalties that the per-segment
  // annotations leave out; scale so the remaining time matches OSRM's own total.
  return { meters: m, seconds: s * (route.durationScale ?? 1) };
}

// ETA status against a target arrival time.
export function etaStatus({ now, remainingS, targetT, remainingM }) {
  const eta = now + remainingS * 1000;
  const out = { eta };
  if (targetT) {
    out.slackMin = Math.round((targetT - eta) / 60000);
    out.state = out.slackMin >= 2 ? 'early' : out.slackMin >= -2 ? 'on-time' : 'late';
    const left = (targetT - now) / 1000;
    out.requiredKmh = left > 0 && remainingM != null ? (remainingM / left) * 3.6 : null;
  }
  return out;
}

// ---------- trip tracker ----------
export function createTrip({ dest, targetT = null, fetchImpl = fetch } = {}) {
  const t = {
    dest, targetT, route: null, routeErr: null, routedAt: 0, offSince: 0,
    startT: null, lastFix: null, lastProj: null,
    // pace: real seconds spent vs route-predicted seconds for the same covered stretch
    actualS: 0, predictedS: 0,
    straightKm: null, avgKmh: null, movingS: 0, movingM: 0,
    arrived: false,
  };

  async function fetchRoute(from) {
    const url = `${OSRM}/route/v1/driving/${from.lon},${from.lat};${dest.lon},${dest.lat}?overview=full&geometries=geojson&annotations=distance,duration&steps=false`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`routing server answered ${res.status}`);
    const j = await res.json();
    if (j.code !== 'Ok' || !j.routes?.length) throw new Error(j.message || j.code || 'no route');
    const r = j.routes[0];
    t.route = {
      coords: r.geometry.coordinates, distance: r.distance, duration: r.duration,
      segments: r.legs[0].annotation, source: 'OSRM (OpenStreetMap, no live traffic)',
      durationScale: r.duration / Math.max(1, r.legs[0].annotation.duration.reduce((a, b) => a + b, 0)),
    };
    t.routedAt = Date.now(); t.routeErr = null; t.lastProj = null; t.offSince = 0;
    return t.route;
  }

  // Feed every GPS fix. Returns true when a (re)route should be requested.
  function update(now, fix) {
    if (t.startT == null) t.startT = now;
    const prev = t.lastFix;
    if (prev) {
      const d = haversine(prev.lat, prev.lon, fix.lat, fix.lon);
      const dt = (now - prev.t) / 1000;
      if (dt > 0 && d / dt > 0.8 && d / dt < 100) { t.movingS += dt; t.movingM += d; }
    }
    t.lastFix = { ...fix, t: now };
    t.avgKmh = t.movingS > 30 ? (t.movingM / t.movingS) * 3.6 : null;
    t.straightKm = haversine(fix.lat, fix.lon, dest.lat, dest.lon) / 1000;
    if (t.straightKm < 0.05) t.arrived = true;
    if (!t.route) return true;
    const proj = projectOnRoute(t.route.coords, fix);
    if (proj.d > 80 && (fix.accuracy ?? 0) < 50) {
      t.offSince ||= now;
      return now - t.offSince > 15000; // off route for 15 s -> reroute
    }
    t.offSince = 0;
    if (t.lastProj && prev) {
      const before = remainingFrom(t.route, t.lastProj).seconds;
      const after = remainingFrom(t.route, proj).seconds;
      const covered = before - after;
      if (covered >= 0) { t.predictedS += covered; t.actualS += (now - prev.t) / 1000; }
    }
    t.lastProj = proj;
    return false;
  }

  function pace() { // null until there's enough evidence
    if (t.predictedS < 120) return null;
    return Math.max(0.5, Math.min(3, t.actualS / t.predictedS));
  }

  function status(now = Date.now()) {
    const targetT = t.targetT;
    const out = { dest, targetT, arrived: t.arrived, routeErr: t.routeErr, source: null };
    if (t.route && t.lastProj) {
      const rem = remainingFrom(t.route, t.lastProj);
      const p = pace();
      out.remainingKm = rem.meters / 1000;
      out.routeEta = etaStatus({ now, remainingS: rem.seconds, targetT, remainingM: rem.meters });
      if (p) out.paceEta = { ...etaStatus({ now, remainingS: rem.seconds * p, targetT, remainingM: rem.meters }), pace: p };
      out.source = t.route.source;
    } else if (t.straightKm != null && t.avgKmh) {
      out.remainingKm = t.straightKm;
      out.straightEta = etaStatus({ now, remainingS: (t.straightKm / t.avgKmh) * 3600, targetT, remainingM: t.straightKm * 1000 });
      out.source = 'straight-line distance ÷ your average moving speed';
    } else if (t.straightKm != null) {
      out.remainingKm = t.straightKm;
      out.source = 'straight-line distance only (route not available yet)';
    }
    return out;
  }

  return {
    get state() { return t; },
    fetchRoute: async (from) => { try { return await fetchRoute(from); } catch (e) { t.routeErr = e.message; throw e; } },
    update, status, pace,
  };
}

// ---------- network helpers ----------
export async function geocode(q, near) {
  const params = new URLSearchParams({ q, format: 'jsonv2', limit: '6' });
  if (near) { // bias results to ~1 degree around the rider
    params.set('viewbox', `${near.lon - 1},${near.lat + 1},${near.lon + 1},${near.lat - 1}`);
  }
  const res = await fetch(`${NOMINATIM}/search?${params}`, { headers: { 'Accept-Language': navigator.language || 'en' } });
  if (!res.ok) throw new Error(`place search answered ${res.status}`);
  return (await res.json()).map((r) => ({ name: r.display_name, lat: +r.lat, lon: +r.lon }));
}
