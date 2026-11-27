// End-of-ride reports: two small self-contained HTML files.
//  1. Road report: how the ride went, every pothole / speed breaker / rough stretch with GPS.
//  2. Wrong-side report: every vehicle that came at the rider on the wrong side, with
//     snapshot (date, time, GPS stamped on it), vehicle / rider / plate crops and findings.
// The summarise* functions are pure (unit-tested); the HTML builders take images that the
// browser has already turned into data URLs, so each file opens anywhere, offline.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gmaps = (lat, lon) => `https://maps.google.com/?q=${lat},${lon}`;
const fmtT = (t) => new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDT = (t) => new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDur = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };

export function summarizeRoad(ride) {
  const s = ride.summary, km = s.distanceKm || 0;
  const pick = (type) => ride.events.filter((e) => e.type === type).sort((a, b) => a.t - b.t);
  const potholes = pick('pothole'), bumps = pick('bump'), rough = pick('rough'), brakes = pick('brake');
  const crashes = pick('crash'), falls = pick('fall'), gaps = pick('gap');
  const perKm = km > 0.5 ? (potholes.length + rough.length) / km : null;
  // road verdict from hazards per km and the background roughness
  const road = perKm == null ? 'Too short to judge'
    : perKm < 0.3 && (s.avgRoughness ?? 0) < 0.8 ? 'Good road'
      : perKm < 1 ? 'Fair road, some damage'
        : perKm < 2.5 ? 'Poor road, frequent damage' : 'Very poor road';
  const notes = [];
  if (s.mountShake != null && s.mountShake > 1.0) notes.push(`The phone shook ${s.mountShake} m/s² even on the smoothest quarter of the ride (a firmly mounted phone reads ~0.3–0.6). A loose or undamped mount hides real potholes among mount shake and inflates the counts. Use a vibration-damped mount.`);
  if (gaps.length) notes.push(`Recording paused ${gaps.length} time${gaps.length > 1 ? 's' : ''} (${fmtDur(gaps.reduce((a, g) => a + (g.durationMs || 0), 0))} in total) while RideLens was not on screen. Nothing was measured in those gaps.`);
  if (!ride.timeline.some((p) => p.rpm != null)) notes.push('No OBD-II engine data on this ride: gear, clutch and coolant figures are not available.');
  return {
    startT: s.startT, endT: s.endT, km, durationMs: (s.endT || 0) - (s.startT || 0),
    avgKmh: s.avgSpeedKmh, maxKmh: s.maxSpeedKmh, score: s.scores?.overall ?? null,
    road, hazardsPerKm: perKm == null ? null : +perKm.toFixed(2),
    potholes, bumps, rough, brakes, crashes, falls, notes,
    counts: { potholes: potholes.length, bumps: bumps.length, rough: rough.length, hardBrakes: brakes.length, hardAccels: s.hardAccels ?? 0, crashes: crashes.length, falls: falls.length },
  };
}

export function summarizeWrongSide(reports) {
  const list = [...reports].sort((a, b) => a.t - b.t);
  const byType = {}, plates = new Map();
  for (const r of list) {
    const type = r.vehicleType || r.analysis?.vehicle?.type || 'Unknown vehicle';
    byType[type] = (byType[type] || 0) + 1;
    if (r.plate) plates.set(r.plate, (plates.get(r.plate) || 0) + 1);
  }
  const noHelmet = list.filter((r) => r.analysis?.helmet?.verdict === 'no helmet').length;
  return {
    total: list.length, auto: list.filter((r) => r.auto).length, manual: list.filter((r) => !r.auto).length,
    withPlate: list.filter((r) => r.plate).length, noHelmet,
    dismissed: list.filter((r) => r.status === 'dismissed').length,
    byType, repeat: [...plates].filter(([, n]) => n > 1).map(([plate, n]) => ({ plate, n })), list,
  };
}

const CSS = `
:root{--bg:#fff;--fg:#15191f;--muted:#5c6673;--line:#d9dee4;--card:#f5f7f9;--bad:#c62828;--warn:#b26a00;--ok:#2e7d32}
@media (prefers-color-scheme:dark){:root{--bg:#101418;--fg:#e8edf2;--muted:#98a3b0;--line:#2b343e;--card:#18202a;--bad:#ef6461;--warn:#f0a63a;--ok:#5cc489}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:20px max(16px,env(safe-area-inset-left))}
main{max-width:920px;margin:0 auto;display:grid;gap:18px}h1{font-size:1.6rem;margin:0}h2{font-size:1.15rem;margin:0 0 8px}
.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.stat{background:var(--card);border-radius:10px;padding:10px 12px}.stat b{display:block;font-size:1.4rem;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;font-size:.88rem}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.wrap{overflow-x:auto}a{color:inherit}.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:.78rem;font-weight:600;color:#fff}
.severe,.critical{background:var(--bad)}.moderate,.serious{background:var(--warn)}.minor,.warning{background:#8a8f2a}
.note{border-left:4px solid var(--warn);background:var(--card);padding:8px 12px;border-radius:6px}
.case{border:1px solid var(--line);border-radius:12px;padding:14px;display:grid;gap:10px;break-inside:avoid}
.case img{max-width:100%;border-radius:8px;display:block}.crops{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.crops figure{margin:0}.crops img{width:100%;height:150px;object-fit:contain;background:var(--card)}figcaption{font-size:.78rem;color:var(--muted)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:3px 14px;margin:0;font-size:.9rem}dt{color:var(--muted)}dd{margin:0}
svg.route{width:100%;height:auto;background:var(--card);border-radius:10px}
footer{font-size:.8rem;color:var(--muted)}`;

function routeSvg(ride, marks) {
  const pts = (ride.track || []).filter((p) => Number.isFinite(p.lat));
  if (pts.length < 2) return '';
  const lat0 = pts.reduce((a, p) => a + p.lat, 0) / pts.length, kx = Math.cos(lat0 * Math.PI / 180);
  const xs = pts.map((p) => p.lon * kx), ys = pts.map((p) => p.lat);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const W = 800, H = 480, pad = 24, span = Math.max(x1 - x0, (y1 - y0) * W / H, 1e-4), k = (W - 2 * pad) / span;
  const P = (lat, lon) => [(W / 2 + (lon * kx - (x0 + x1) / 2) * k).toFixed(1), (H / 2 - (lat - (y0 + y1) / 2) * k).toFixed(1)];
  const line = pts.map((p) => P(p.lat, p.lon).join(',')).join(' ');
  const dots = marks.filter((m) => Number.isFinite(m.lat)).map((m) => { const [x, y] = P(m.lat, m.lon); return `<circle cx="${x}" cy="${y}" r="7" fill="${m.color}" stroke="#fff" stroke-width="2"><title>${esc(m.title)}</title></circle>`; }).join('');
  const [sx, sy] = P(pts[0].lat, pts[0].lon), [ex, ey] = P(pts[pts.length - 1].lat, pts[pts.length - 1].lon);
  return `<svg class="route" viewBox="0 0 ${W} ${H}" role="img" aria-label="Route with hazards"><polyline points="${line}" fill="none" stroke="#7a8796" stroke-width="4" stroke-linejoin="round"/>${dots}
<circle cx="${sx}" cy="${sy}" r="8" fill="#2e7d32"/><circle cx="${ex}" cy="${ey}" r="8" fill="#15191f" stroke="#fff" stroke-width="2"/></svg>`;
}

const rows = (list, cols) => list.length ? `<div class="wrap"><table><thead><tr>${cols.map(([h]) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${list.map((e, i) => `<tr>${cols.map(([, f]) => `<td>${f(e, i)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p class="muted">None on this ride.</p>';
const where = (e) => (e.lat != null ? `<a href="${gmaps(e.lat, e.lon)}">${e.lat.toFixed(5)}, ${e.lon.toFixed(5)}</a>` : 'no GPS fix');

export function roadReportHtml(ride, sum = summarizeRoad(ride)) {
  const c = sum.counts;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RideLens road report ${esc(fmtDT(sum.startT))}</title><style>${CSS}</style></head><body><main>
<header><h1>Road report</h1><div class="muted">${esc(fmtDT(sum.startT))} · ${sum.km.toFixed(1)} km · ${fmtDur(sum.durationMs)} · avg ${Math.round(sum.avgKmh)} / max ${Math.round(sum.maxKmh)} km/h</div></header>
<section><h2>How the ride was</h2><p><b>${esc(sum.road)}</b>${sum.hazardsPerKm != null ? ` · ${sum.hazardsPerKm} potholes or rough stretches per km` : ''}${sum.score != null ? ` · ride score ${sum.score}/100` : ''}</p>
<div class="grid"><div class="stat"><b>${c.potholes}</b>potholes</div><div class="stat"><b>${c.bumps}</b>speed breakers</div><div class="stat"><b>${c.rough}</b>rough stretches</div><div class="stat"><b>${c.hardBrakes}</b>hard brakes</div><div class="stat"><b>${c.hardAccels}</b>hard accelerations</div><div class="stat"><b>${c.crashes + c.falls}</b>crash / fall alerts</div></div></section>
${sum.notes.map((n) => `<p class="note">${esc(n)}</p>`).join('')}
${routeSvg(ride, [...sum.potholes.map((e) => ({ ...e, color: '#c62828', title: `Pothole ${e.severity}` })), ...sum.bumps.map((e) => ({ ...e, color: '#b26a00', title: 'Speed breaker' }))])}
<section><h2>Potholes (${c.potholes})</h2>${rows(sum.potholes, [['#', (e, i) => i + 1], ['Time', (e) => fmtT(e.t)], ['Severity', (e) => `<span class="pill ${esc(e.severity)}">${esc(e.severity)}</span>`], ['Jolt', (e) => `${e.p2pG} g`], ['Your speed', (e) => `${Math.round(e.speedKmh)} km/h`], ['Location', where]])}</section>
<section><h2>Speed breakers (${c.bumps})</h2>${rows(sum.bumps, [['#', (e, i) => i + 1], ['Time', (e) => fmtT(e.t)], ['Severity', (e) => `<span class="pill ${esc(e.severity)}">${esc(e.severity)}</span>`], ['Jolt', (e) => `${e.p2pG} g`], ['Your speed', (e) => `${Math.round(e.speedKmh)} km/h`], ['Location', where]])}</section>
<section><h2>Rough stretches (${c.rough})</h2>${rows(sum.rough, [['#', (e, i) => i + 1], ['Time', (e) => fmtT(e.t)], ['Length', (e) => (e.lengthM != null ? `${e.lengthM} m` : '—')], ['Jolts', (e) => e.jolts], ['Worst', (e) => `${e.peakG} g`], ['Start', where]])}</section>
<section><h2>Hard braking (${c.hardBrakes})</h2>${rows(sum.brakes, [['Time', (e) => fmtT(e.t)], ['Peak', (e) => `${e.peakG} g`], ['Speed', (e) => `${Math.round(e.fromKmh)} → ${Math.round(e.toKmh)} km/h`], ['Location', where]])}</section>
<footer>Measured by RideLens on the rider's phone. Pothole and breaker detection is an estimate from the phone's motion sensors, confirmed by the rear wheel hitting the same spot; road events need a firmly mounted phone. Locations are GPS fixes (typically ±5–10 m).</footer>
</main></body></html>`;
}

// images: { [reportId]: { snapshot, vehicle, rider, head, plate } } as data URLs
export function wrongSideReportHtml(ride, sum, images) {
  const types = Object.entries(sum.byType).map(([t, n]) => `${n} × ${esc(t)}`).join(', ') || 'none';
  const cases = sum.list.map((r, i) => {
    const im = images[r.id] || {}, a = r.analysis || {}, au = r.auto;
    const crops = [['vehicle', 'Vehicle'], ['rider', 'Rider and vehicle'], ['head', 'Rider head'], ['plate', 'Number plate']].filter(([k]) => im[k])
      .map(([k, l]) => `<figure><img src="${im[k]}" alt="${l}"><figcaption>${l}</figcaption></figure>`).join('');
    const facts = [
      ['When', fmtDT(r.t)],
      ['Where', r.lat != null ? `<a href="${gmaps(r.lat, r.lon)}">${r.lat.toFixed(6)}, ${r.lon.toFixed(6)}</a> (±${Math.round(r.accuracy || 0)} m)` : 'No GPS fix'],
      ['Vehicle', esc(`${r.color ? `${r.color} ` : ''}${r.vehicleType || a.vehicle?.type || 'Unknown'}`)],
      ['Category', esc(r.category || a.vehicle?.category || (/two-wheeler|cycle/i.test(r.vehicleType || '') ? 'Two-wheeler' : /car/i.test(r.vehicleType || '') ? 'Four-wheeler' : 'Not determined'))],
      ['Registration', r.plate ? `<b>${esc(r.plate)}</b>${r.plateValid ? '' : ' (format not standard, check photo)'}` : 'Not read: see plate snapshot'],
      ['Direction', au ? esc(`Coming toward the rider on the ${au.keep === 'right' ? 'right' : 'left'} (wrong side), front of vehicle facing the camera. Closing ${au.closingKmh} km/h while the rider did ${au.ownSpeedKmh ?? '?'} km/h, so the vehicle itself moved ~${au.oncomingKmh} km/h against traffic. Tracked ${au.sightings} times.`) : 'Captured by the rider (manual)'],
      ...(a.helmet && a.helmet.verdict !== 'not seen' ? [['Helmet (AI estimate)', esc(`${a.helmet.verdict} · P(no helmet) ${a.helmet.p}`)]] : []),
      ...(a.vehicle?.riders ? [['People on vehicle', String(a.vehicle.riders)]] : []),
      ['Rider speed', r.mySpeedKmh != null ? `${r.mySpeedKmh} km/h` : '—'],
      ['Status', esc(r.status)],
    ];
    return `<article class="case"><h2>${i + 1}. ${esc(r.plate || 'Unknown plate')} · ${esc(r.vehicleType || a.vehicle?.type || 'Vehicle')}</h2>
${im.snapshot ? `<img src="${im.snapshot}" alt="Evidence photo with date, time and GPS">` : ''}
${crops ? `<div class="crops">${crops}</div>` : ''}
<dl>${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
${(a.notAssessed || []).length ? `<p class="muted" style="margin:0">${a.notAssessed.map((n) => esc(n.why)).join(' ')}</p>` : ''}
${r.notes ? `<p style="margin:0">${esc(r.notes)}</p>` : ''}</article>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RideLens wrong-side report ${esc(fmtDT(ride?.summary?.startT ?? sum.list[0]?.t ?? Date.now()))}</title><style>${CSS}</style></head><body><main>
<header><h1>Wrong-side vehicles</h1><div class="muted">${ride ? `${esc(fmtDT(ride.summary.startT))} · ${ride.summary.distanceKm.toFixed(1)} km ride` : 'Selected reports'} · keep-left traffic: a vehicle coming toward the rider on the rider's left is on the wrong side</div></header>
<div class="grid"><div class="stat"><b>${sum.total}</b>wrong-side vehicles</div><div class="stat"><b>${sum.withPlate}</b>with plate read</div><div class="stat"><b>${sum.noHelmet}</b>riders likely without helmet</div><div class="stat"><b>${sum.repeat.length}</b>repeat plates</div></div>
<p>By type: ${types}.</p>
${cases || '<p class="muted">No wrong-side vehicles on this ride.</p>'}
<footer>Evidence captured automatically by RideLens on the rider's phone camera. Vehicle type, colour, plate and helmet are machine estimates: check each against its photo before submitting. Seat belts and mirrors are not assessed. Share only with traffic police or an official grievance channel; do not post plates or faces publicly.</footer>
</main></body></html>`;
}

// ---------- browser helpers ----------
export const blobToDataUrl = (b) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.onerror = () => r(null); fr.readAsDataURL(b); });

// Key photo with a stamped evidence strip: date, time, GPS, rider speed. Downscaled to keep the file small.
export async function stampedSnapshot(blob, lines, maxW = 1280) {
  const img = await createImageBitmap(blob);
  try {
    const k = Math.min(1, maxW / img.width), w = Math.round(img.width * k), h = Math.round(img.height * k);
    const fs = Math.max(14, Math.round(w / 48)), bar = fs * (lines.length + 0.8);
    const c = document.createElement('canvas'); c.width = w; c.height = h + bar;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0, w, h);
    g.fillStyle = '#000'; g.fillRect(0, h, w, bar);
    g.fillStyle = '#fff'; g.font = `600 ${fs}px system-ui, sans-serif`;
    lines.forEach((l, i) => g.fillText(l, fs * 0.6, h + fs * (i + 1.05)));
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
  } finally { img.close(); }
}
