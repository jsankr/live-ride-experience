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
import { cumulative, locate, maneuversFrom, tomtomRoute } from './nav.js';

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

// Degrees-minutes-seconds, e.g. 12°58'17.8"N 77°35'40.6"E (Google Maps copy format)
export function parseDms(input) {
  const re = /(\d{1,3})°\s*(\d{1,2})['′]\s*(\d{1,2}(?:\.\d+)?)["″]?\s*([NSEW])/gi;
  const parts = [...String(input || '').matchAll(re)];
  if (parts.length !== 2) return null;
  const val = ([, d, m, sec, h]) => (+d + +m / 60 + +sec / 3600) * (/[SW]/i.test(h) ? -1 : 1);
  const a = parts.find((p) => /[NS]/i.test(p[4])), b = parts.find((p) => /[EW]/i.test(p[4]));
  if (!a || !b) return null;
  return { lat: +val(a).toFixed(7), lon: +val(b).toFixed(7) };
}

// ---------- Plus Codes (Open Location Code), decoded offline ----------
const OLC = '23456789CFGHJMPQRVWX';
const OLC_RES = [20, 1, 0.05, 0.0025, 0.000125];
export function olcEncode(lat, lon, len = 10) {
  lat = Math.min(89.9999999, Math.max(-90, lat)) + 90;
  lon = ((((lon + 180) % 360) + 360) % 360);
  let code = '';
  for (let i = 0; i < len / 2; i++) {
    const r = OLC_RES[i];
    const dl = Math.floor(lat / r), dn = Math.floor(lon / r);
    lat -= dl * r; lon -= dn * r;
    code += OLC[dl] + OLC[dn];
    if (code.length === 8) code += '+';
  }
  return code.length === 8 ? `${code}+` : code;
}
export function olcDecode(code) {
  const c = String(code).toUpperCase().replace('+', '').replace(/0+$/, '');
  if (!/^[23456789CFGHJMPQRVWX]+$/.test(c) || c.length < 2) return null;
  let lat = -90, lon = -180, latRes = 20, lonRes = 20;
  for (let i = 0; i < Math.min(c.length, 10); i += 2) {
    latRes = OLC_RES[i / 2]; lonRes = latRes;
    lat += OLC.indexOf(c[i]) * latRes; lon += OLC.indexOf(c[i + 1] ?? '2') * lonRes;
  }
  for (let i = 10; i < c.length; i++) { // grid refinement: 4 rows x 5 columns
    latRes /= 5; lonRes /= 4;
    const d = OLC.indexOf(c[i]);
    lat += Math.floor(d / 4) * latRes; lon += (d % 4) * lonRes;
  }
  return { lat: +(lat + latRes / 2).toFixed(7), lon: +(lon + lonRes / 2).toFixed(7) };
}
// Full code ("7J4VWHX8+2G") or short code + reference ("WHX8+2G" near a known point).
export function parsePlusCode(input, ref) {
  const m = String(input || '').toUpperCase().match(/\b([23456789CFGHJMPQRVWX]{2,8})\+([23456789CFGHJMPQRVWX]{2,3})?\b/);
  if (!m) return null;
  const head = m[1], tail = m[2] || '';
  if (head.length === 8) return olcDecode(head + tail);
  if (!ref || head.length % 2) return { short: `${head}+${tail}`, needsReference: true };
  const pad = 8 - head.length;
  const res = 20 ** (2 - pad / 2);
  const full = olcEncode(ref.lat, ref.lon).replace('+', '').slice(0, pad) + head + tail;
  const p = olcDecode(full);
  // pick the candidate cell nearest the reference
  if (p.lat - ref.lat > res / 2) p.lat -= res; else if (ref.lat - p.lat > res / 2) p.lat += res;
  if (p.lon - ref.lon > res / 2) p.lon -= res; else if (ref.lon - p.lon > res / 2) p.lon += res;
  return { lat: +p.lat.toFixed(7), lon: +p.lon.toFixed(7) };
}
export const looksLikeW3w = (s) => /^(?:\/\/\/)?\p{L}+\.\p{L}+\.\p{L}+$/u.test(String(s || '').trim());
export async function what3words(words, key) {
  const w = String(words).trim().replace(/^\/\/\//, '');
  const res = await fetch(`https://api.what3words.com/v3/convert-to-coordinates?words=${encodeURIComponent(w)}&key=${encodeURIComponent(key)}`);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.coordinates) throw new Error(j.error?.message || `what3words answered ${res.status}`);
  return { lat: j.coordinates.lat, lon: j.coordinates.lng, name: `///${w}${j.nearestPlace ? ` · near ${j.nearestPlace}` : ''}` };
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
// routeKey: () => the rider's TomTom key, or '' (then OSRM, which has no live traffic)
export function createTrip({ dest, targetT = null, fetchImpl = fetch, routeKey = () => '' } = {}) {
  const t = {
    dest, targetT, route: null, routeErr: null, routedAt: 0, offSince: 0,
    startT: null, lastFix: null, lastProj: null,
    // pace: real seconds spent vs route-predicted seconds for the same covered stretch
    actualS: 0, predictedS: 0,
    straightKm: null, avgKmh: null, movingS: 0, movingM: 0,
    arrived: false,
  };

  async function fetchRoute(from) {
    const key = routeKey();
    if (key) {
      try {
        t.route = await tomtomRoute(from, dest, key, fetchImpl);
        t.routedAt = Date.now(); t.routeErr = null; t.lastProj = null; t.offSince = 0; t.liveErr = null;
        return t.route;
      } catch (e) { t.liveErr = e.message; /* fall back to OSRM below: a route without traffic beats none */ }
    }
    const url = `${OSRM}/route/v1/driving/${from.lon},${from.lat};${dest.lon},${dest.lat}?overview=full&geometries=geojson&annotations=distance,duration&steps=true`;
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
    // turn-by-turn for the riding HUD: metres along the route to each maneuver
    t.route.cum = cumulative(t.route.coords);
    const steps = r.legs[0].steps || [];
    const stepTotal = steps.reduce((a, x) => a + (x.distance || 0), 0);
    const k = stepTotal > 0 ? t.route.cum[t.route.cum.length - 1] / stepTotal : 1;
    t.route.maneuvers = maneuversFrom(steps).map((m) => ({ ...m, at: m.at * k }));
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
    // a live-traffic route goes stale: fetch it again every 3 minutes for fresh ETA and traffic
    if (t.route.live && now - t.routedAt > 180000 && !t.arrived) return true;
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
      out.source = t.route.source + (t.liveErr && !t.route.live ? ` (TomTom live traffic failed: ${t.liveErr})` : '');
      out.live = !!t.route.live;
      out.remainingS = rem.seconds * (p || 1);
      if (t.route.cum && t.lastFix) out.travelledM = locate(t.route.coords, t.route.cum, t.lastFix).along;
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
