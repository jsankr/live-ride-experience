// Road hazard map across rides: the same pothole hit on different rides becomes one spot.
import { haversine } from './analytics.js';

const RANK = { minor: 1, moderate: 2, severe: 3 };

// rides: [{ id, events: [...] }] -> spots sorted worst first
export function mergeHazards(rides, { radiusM = 15 } = {}) {
  const spots = [];
  for (const ride of rides) {
    for (const e of ride.events || []) {
      if ((e.type !== 'pothole' && e.type !== 'bump') || e.lat == null) continue;
      let spot = spots.find((s) => s.type === e.type && haversine(s.lat, s.lon, e.lat, e.lon) <= radiusM);
      if (!spot) { spot = { type: e.type, lat: e.lat, lon: e.lon, hits: 0, rides: new Set(), worst: 'minor', maxP2pG: 0, lastT: 0 }; spots.push(spot); }
      spot.lat = (spot.lat * spot.hits + e.lat) / (spot.hits + 1); // running centre
      spot.lon = (spot.lon * spot.hits + e.lon) / (spot.hits + 1);
      spot.hits++; spot.rides.add(ride.id);
      if ((RANK[e.severity] || 0) > (RANK[spot.worst] || 0)) spot.worst = e.severity;
      spot.maxP2pG = Math.max(spot.maxP2pG, e.p2pG || 0);
      spot.lastT = Math.max(spot.lastT, e.t);
    }
  }
  return spots.map((s) => ({ ...s, rides: s.rides.size, lat: +s.lat.toFixed(6), lon: +s.lon.toFixed(6) }))
    .sort((a, b) => (b.type === 'pothole') - (a.type === 'pothole') || RANK[b.worst] - RANK[a.worst] || b.rides - a.rides || b.maxP2pG - a.maxP2pG);
}

export function hazardsGeoJson(spots) {
  return {
    type: 'FeatureCollection',
    features: spots.map((s) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: { kind: s.type === 'pothole' ? 'pothole' : 'speed breaker', severity: s.worst, timesHit: s.hits, ridesSeenOn: s.rides, peakToPeakG: +s.maxP2pG.toFixed(2), lastSeen: new Date(s.lastT).toISOString() },
    })),
  };
}

export function hazardsCsv(spots) {
  const rows = spots.map((s) => [s.type === 'pothole' ? 'pothole' : 'speed breaker', s.worst, s.lat, s.lon, s.hits, s.rides, s.maxP2pG.toFixed(2), new Date(s.lastT).toISOString(), `https://maps.google.com/?q=${s.lat},${s.lon}`].join(','));
  return ['kind,severity,lat,lon,times_hit,rides_seen_on,peak_to_peak_g,last_seen,google_maps', ...rows].join('\n');
}
