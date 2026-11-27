// Destination search as you type, and by voice.
//
// Sources, nearest to the rider first:
//  * Your saved and recent places, matched instantly on the phone.
//  * With a TomTom key: TomTom Search in type-ahead mode (shops, hospitals, landmarks,
//    streets and areas; "phoe" already finds Phoenix Marketcity in Chennai).
//  * Without one: Photon (komoot), an OpenStreetMap search built for type-ahead.
//    Nominatim, used by the Search button, does not allow searching on every keystroke.
// Pure functions take a fetch implementation and are unit-tested.

const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);

// saved and recent places whose name contains every typed word (as the start of a word)
export function localMatches(places, q, limit = 4) {
  const want = words(q);
  if (!want.length) return [];
  return places.filter((p) => {
    const have = words(p.name);
    return want.every((w) => have.some((h) => h.startsWith(w)));
  }).sort((a, b) => (b.saved - a.saved) || ((b.uses || 0) - (a.uses || 0))).slice(0, limit)
    .map((p) => ({ name: p.name, detail: p.saved ? 'Saved place' : 'Recent', lat: p.lat, lon: p.lon, source: 'mine' }));
}

export async function tomtomSuggest(q, near, key, fetchImpl = fetch, limit = 6) {
  const p = new URLSearchParams({ typeahead: 'true', limit: String(limit), language: 'en-GB', key });
  if (near) { p.set('lat', near.lat.toFixed(5)); p.set('lon', near.lon.toFixed(5)); p.set('radius', '60000'); }
  const res = await fetchImpl(`https://api.tomtom.com/search/2/search/${encodeURIComponent(q)}.json?${p}`);
  if (res.status === 401 || res.status === 403) throw new Error('TomTom key rejected');
  if (!res.ok) throw new Error(`TomTom search: ${res.status}`);
  return ((await res.json()).results || []).map((r) => {
    const a = r.address || {};
    const name = r.poi?.name || a.streetName || a.municipalitySubdivision || a.municipality || a.freeformAddress || q;
    const detail = r.poi ? a.freeformAddress : [a.municipalitySubdivision, a.municipality].filter((x) => x && x !== name).join(', ') || a.freeformAddress;
    return { name, detail: detail || '', lat: r.position.lat, lon: r.position.lon, distM: r.dist ?? null, source: 'tomtom' };
  });
}

export async function photonSuggest(q, near, fetchImpl = fetch, limit = 6) {
  const p = new URLSearchParams({ q, limit: String(limit), lang: 'en' });
  if (near) { p.set('lat', near.lat.toFixed(5)); p.set('lon', near.lon.toFixed(5)); }
  const res = await fetchImpl(`https://photon.komoot.io/api/?${p}`);
  if (!res.ok) throw new Error(`place search: ${res.status}`);
  return ((await res.json()).features || []).map((f) => {
    const x = f.properties || {}, [lon, lat] = f.geometry?.coordinates || [];
    const street = [x.housenumber, x.street].filter(Boolean).join(' ');
    const name = x.name || street || x.district || x.city || q;
    const detail = [x.name ? street : '', x.district, x.city, x.state].filter((v) => v && v !== name).filter((v, i, arr) => arr.indexOf(v) === i).join(', ');
    return { name, detail, lat, lon, distM: null, source: 'osm' };
  }).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
}

// One suggestion list from all sources: mine first, then the search, without near-duplicates.
export function mergeSuggestions(mine, found, limit = 8) {
  const out = [...mine];
  for (const r of found) {
    // same name within ~300 m is the same place (a mall's entrance vs its centre)
    const dup = out.some((o) => Math.abs(o.lat - r.lat) < 0.003 && Math.abs(o.lon - r.lon) < 0.003 && words(o.name).join(' ') === words(r.name).join(' '));
    if (!dup) out.push(r);
  }
  return out.slice(0, limit);
}

// Typed text that is a coordinate, Plus Code, map link or what3words address goes to the
// existing parsers (Search button / Enter), not to type-ahead.
export const looksLikeAddressCode = (q) => /^\s*-?\d{1,3}\.\d+\s*,?\s*-?\d{1,3}\.\d+|[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{0,3}|https?:\/\/|^\/{0,3}[a-z]+\.[a-z]+\.[a-z]+$/i.test(q);

// Debounced suggestions that never show an older answer after a newer one.
export function createSuggester({ search, onResults, delayMs = 250, minChars = 2, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null, seq = 0;
  const cache = new Map();
  return (q) => {
    clearTimer(timer);
    const query = String(q || '').trim();
    const my = ++seq;
    if (query.length < minChars || looksLikeAddressCode(query)) { onResults(null, query); return; }
    const key = query.toLowerCase();
    if (cache.has(key)) { onResults(cache.get(key), query); return; }
    timer = setTimer(async () => {
      try {
        const r = await search(query);
        cache.set(key, r);
        if (my === seq) onResults(r, query); // a newer keystroke has started: drop this answer
      } catch (e) { if (my === seq) onResults({ error: e.message }, query); }
    }, delayMs);
  };
}
