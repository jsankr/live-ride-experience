// Saved and recent destinations, so a regular ride is one tap instead of typing.
// Pure functions (unit-tested); the app keeps the list in localStorage.
import { haversine } from './analytics.js';

const SAME_PLACE_M = 120;   // two picks this close are the same destination
const MAX_RECENT = 15;      // unsaved places kept; saved (starred) places are never dropped

const near = (a, b, m) => haversine(a.lat, a.lon, b.lat, b.lon) <= m;
const clockOf = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// Record a trip destination. Returns a new list.
export function rememberPlace(list, place, { now = Date.now(), targetT = null } = {}) {
  const out = list.map((p) => ({ ...p }));
  let hit = out.find((p) => near(p, place, SAME_PLACE_M));
  if (!hit) {
    hit = { id: `p${now.toString(36)}${Math.round(Math.abs(place.lat * 1e4 + place.lon * 1e4)).toString(36)}`, lat: place.lat, lon: place.lon, name: place.name || '', saved: false, uses: 0 };
    out.push(hit);
  }
  hit.uses = (hit.uses || 0) + 1;
  hit.lastUsed = now;
  if (!hit.saved && place.name && !/^Dropped pin|^-?\d/.test(place.name)) hit.name = place.name; // keep a custom name
  if (targetT) hit.lastTarget = clockOf(targetT); // e.g. "09:30" for the office
  const unsaved = out.filter((p) => !p.saved).sort((a, b) => b.lastUsed - a.lastUsed);
  const drop = new Set(unsaved.slice(MAX_RECENT).map((p) => p.id));
  return out.filter((p) => !drop.has(p.id));
}

export function savePlace(list, id, name) {
  return list.map((p) => (p.id === id ? { ...p, saved: true, name: (name || p.name || '').trim() || p.name } : p));
}
export function unsavePlace(list, id) { return list.map((p) => (p.id === id ? { ...p, saved: false } : p)); }
export function forgetPlace(list, id) { return list.filter((p) => p.id !== id); }

// Where saved rides ended: candidate destinations even before any trip was set.
export function rideEnds(rides) {
  return rides.map((r) => {
    const tr = r.track || [];
    const last = tr[tr.length - 1];
    return last && Number.isFinite(last.lat) ? { lat: last.lat, lon: last.lon, t: r.summary?.endT ?? last.t, km: r.summary?.distanceKm ?? null } : null;
  }).filter(Boolean);
}

// Suggestions, best first: saved places, then recent trips, then places past rides ended.
// Places within 300 m of where you are now are left out (you're already there).
export function suggestPlaces(list, { here = null, ends = [], now = Date.now(), limit = 8 } = {}) {
  const dist = (p) => (here ? haversine(here.lat, here.lon, p.lat, p.lon) / 1000 : null);
  const away = (p) => !here || dist(p) > 0.3;
  const saved = list.filter((p) => p.saved && away(p)).sort((a, b) => (b.uses || 0) - (a.uses || 0) || (b.lastUsed || 0) - (a.lastUsed || 0));
  const recent = list.filter((p) => !p.saved && away(p)).sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  // ride ends that aren't already a known place, newest first, merged among themselves
  const extra = [];
  for (const e of [...ends].sort((a, b) => b.t - a.t)) {
    if (!away(e) || list.some((p) => near(p, e, 200)) || extra.some((x) => near(x, e, 200))) continue;
    extra.push({ id: `end${e.t}`, lat: +e.lat.toFixed(6), lon: +e.lon.toFixed(6), name: '', fromRide: true, lastUsed: e.t, uses: 0 });
  }
  return [...saved.map((p) => ({ ...p, kind: 'saved' })), ...recent.map((p) => ({ ...p, kind: 'recent' })), ...extra.map((p) => ({ ...p, kind: 'ride-end' }))]
    .slice(0, limit).map((p) => ({ ...p, distanceKm: dist(p) == null ? null : +dist(p).toFixed(1) }));
}

export function ago(t, now = Date.now()) {
  const d = Math.round((now - t) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 7 ? `${d} days ago` : d < 60 ? `${Math.round(d / 7)} wk ago` : `${Math.round(d / 30)} mo ago`;
}
