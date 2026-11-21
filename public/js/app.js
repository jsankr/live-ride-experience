import { createAnalyzer, comfortClass } from './analytics.js';
import { Elm327, bleTransport, wsTransport } from './obd.js';
import { requestMotionPermission, startMotion, startGps, keepAwake } from './sensors.js';
import { StripChart, FrictionCircle, lineChart, barChart, histogram } from './charts.js';
import { db, uid } from './db.js';
import { EvidenceCamera, saveReport, ocrPlate, normalizePlate, reportToJson, reportsToCsv, syncReport } from './reports.js';

const $ = (id) => document.getElementById(id);
const G = 9.80665;

// ---------------- settings ----------------
const settings = (() => {
  const def = { protocol: '0', bridgeUrl: '', serverUrl: '', serverToken: '', units: 'metric', theme: '', invertYaw: false };
  try { return { ...def, ...JSON.parse(localStorage.getItem('ridelens.settings') || '{}') }; } catch { return def; }
})();
const saveSettings = () => { try { localStorage.setItem('ridelens.settings', JSON.stringify(settings)); } catch { /* private mode */ } };
const imperial = () => settings.units === 'imperial';
const fmtSpeed = (kmh) => Math.round(imperial() ? kmh * 0.621371 : kmh);
const speedUnit = () => (imperial() ? 'mph' : 'km/h');
const fmtTemp = (c) => (c == null ? '—' : imperial() ? `${Math.round(c * 1.8 + 32)}°F` : `${Math.round(c)}°C`);
const fmtAlt = (m) => (m == null ? '—' : imperial() ? `${Math.round(m * 3.28084)} ft` : `${Math.round(m)} m`);
const fmtDist = (km) => (imperial() ? `${(km * 0.621371).toFixed(1)} mi` : `${km.toFixed(1)} km`);
const fmtDur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`; };
const fmtClock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function applyTheme() {
  if (settings.theme) document.documentElement.dataset.theme = settings.theme; else delete document.documentElement.dataset.theme;
}
applyTheme();

function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------------- navigation ----------------
function show(view) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'history') renderHistory();
  if (view === 'wrongside') renderReports();
  if (view === 'live') setTimeout(() => liveMap?.invalidateSize(), 50);
  window.scrollTo({ top: 0 });
}
$('tabbar').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) show(b.dataset.view); });

// ---------------- live state ----------------
let analyzer = createAnalyzer({ invertYaw: settings.invertYaw });
let recording = false, rideId = null, stopFns = [], elm = null;
const lastSeen = { gps: 0, imu: 0, obd: 0 };
let unsubEvents = null;

const charts = {
  vert: new StripChart($('chartVert'), { series: [{ key: 'v', color: '--series-1' }], min: -12, max: 12 }),
  long: new StripChart($('chartLong'), {
    series: [{ key: 'g', color: '--series-2' }], min: -0.8, max: 0.6,
    bands: [{ from: -2, to: -0.35, color: '--status-critical' }, { from: 0.35, to: 2, color: '--status-critical' }],
  }),
  rpm: new StripChart($('chartRpm'), { series: [{ key: 'rpm', color: '--series-3' }], min: 0, max: 8000 }),
};
const gcircle = new FrictionCircle($('gcircle'), { maxG: 0.8 });

function wireAnalyzer() {
  unsubEvents?.();
  unsubEvents = analyzer.onEvent(onEvent);
}
wireAnalyzer();

// ---------------- leaflet maps ----------------
const L = window.L;
function makeMap(id) {
  if (!L) { $(id).innerHTML = '<p class="empty pad">Map unavailable offline.</p>'; return null; }
  const m = L.map(id, { zoomControl: false, attributionControl: true }).setView([20.59, 78.96], 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
  return m;
}
const liveMap = makeMap('liveMap');
let livePath = liveMap ? L.polyline([], { color: getComputedStyle(document.documentElement).getPropertyValue('--series-1').trim(), weight: 4 }).addTo(liveMap) : null;
let liveDot = null;
const liveLayer = liveMap ? L.layerGroup().addTo(liveMap) : null;

const EV = {
  pothole: { icon: 'P', status: 'serious', title: 'Pothole' },
  bump: { icon: 'B', status: 'warning', title: 'Speed bump / ridge' },
  brake: { icon: '!', status: 'critical', title: 'Hard braking' },
  accel: { icon: 'A', status: 'warning', title: 'Hard acceleration' },
  shift: { icon: 'S', status: 'info', title: 'Gear change' },
  coast: { icon: 'C', status: 'warning', title: 'Clutch-in coasting' },
  overheat: { icon: 'T', status: 'critical', title: 'Engine overheating' },
  wrongside: { icon: 'W', status: 'critical', title: 'Wrong-side vehicle reported' },
};
const statusColor = (st) => getComputedStyle(document.documentElement).getPropertyValue(`--status-${st === 'info' ? 'good' : st}`).trim();

function describe(ev) {
  switch (ev.type) {
    case 'pothole': case 'bump': return `${ev.severity} · ${ev.p2pG} g peak-to-peak at ${fmtSpeed(ev.speedKmh)} ${speedUnit()}`;
    case 'brake': case 'accel': return `${ev.peakG} g · ${fmtSpeed(ev.fromKmh)}→${fmtSpeed(ev.toKmh)} ${speedUnit()} in ${(ev.durationMs / 1000).toFixed(1)} s`;
    case 'shift': return `${ev.kind}${ev.from ? ` ${ev.from}→${ev.to}` : ` into ${ev.to}`} · clutch ${ev.durationMs} ms`;
    case 'coast': return `${(ev.durationMs / 1000).toFixed(1)} s without drive`;
    case 'overheat': return `coolant ${fmtTemp(ev.coolant)}`;
    default: return '';
  }
}

function onEvent(ev) {
  const meta = EV[ev.type] || { icon: '•', status: 'info', title: ev.type };
  if (ev.type === 'shift') { charts.rpm.mark(ev.t, '', 'warning'); return; }
  if (ev.type === 'pothole' || ev.type === 'bump') charts.vert.mark(ev.t, '', ev.type === 'pothole' ? 'serious' : 'warning');
  if (ev.type === 'brake' || ev.type === 'accel') charts.long.mark(ev.t, '', 'critical');
  const feed = $('feed');
  feed.querySelector('.empty')?.remove();
  const li = document.createElement('li');
  li.innerHTML = `<span class="ev-icon ${meta.status}">${meta.icon}</span><span><div class="ev-title">${meta.title}</div><div class="ev-sub">${esc(describe(ev))}</div></span><span class="ev-time">${fmtClock(ev.t)}</span>`;
  feed.prepend(li);
  while (feed.children.length > 60) feed.lastChild.remove();
  $('evCount').textContent = analyzer.events.filter((e) => e.type !== 'shift').length;
  if (liveLayer && ev.lat != null) {
    L.circleMarker([ev.lat, ev.lon], { radius: 6, color: statusColor(meta.status), fillOpacity: 0.9, weight: 2 }).bindTooltip(`${meta.title}<br>${describe(ev)}`).addTo(liveLayer);
  }
  if (navigator.vibrate && (ev.type === 'overheat')) navigator.vibrate([200, 100, 200]);
}

// ---------------- sensor plumbing ----------------
const feedImu = (t, a, g) => { lastSeen.imu = Date.now(); analyzer.pushImu(t, a, g); };
const feedGps = (t, f) => { lastSeen.gps = Date.now(); analyzer.pushGps(t, f); };
const feedObd = (t, d) => { lastSeen.obd = Date.now(); analyzer.pushObd(t, d); };

function resetLive() {
  analyzer = createAnalyzer({ invertYaw: settings.invertYaw });
  wireAnalyzer();
  Object.values(charts).forEach((c) => { c.data = []; c.marks = []; });
  gcircle.trail = [];
  $('feed').innerHTML = '<li class="empty">Events appear here as you ride.</li>';
  $('evCount').textContent = '0';
  livePath?.setLatLngs([]); liveLayer?.clearLayers();
}

async function startRide() {
  if (recording) return;
  resetLive();
  rideId = uid();
  recording = true;
  $('recBtn').setAttribute('aria-pressed', 'true');
  $('recLabel').textContent = 'Stop';
  keepAwake(true);
  show('live');
  try { await requestMotionPermission(); stopFns.push(startMotion(feedImu)); } catch (e) { setBanner(`Motion sensors: ${e.message}`); }
  try {
    stopFns.push(startGps(feedGps, (e) => setBanner(`GPS: ${e.message}. Allow precise location for this site.`)));
  } catch (e) { setBanner(e.message); }
  if (!elm) setBanner('No OBD adapter connected — riding on phone sensors only (no rpm, gear, clutch or temperatures). Connect one in Setup.');
}

async function stopRide() {
  if (!recording) return;
  recording = false;
  keepAwake(false);
  $('recBtn').setAttribute('aria-pressed', 'false');
  $('recLabel').textContent = 'Start ride';
  setBanner('');
  stopFns.forEach((f) => f()); stopFns = [];
  const ride = packRide(rideId, analyzer);
  if (ride.summary.distanceKm < 0.05 && ride.timeline.length < 20) { toast('Ride too short to save'); return; }
  await db.put('rides', ride);
  toast('Ride saved');
  openRide(ride);
}

function packRide(id, an) {
  return {
    id, savedAt: Date.now(),
    summary: an.summary(), events: an.events, track: an.track, timeline: an.timeline,
    gears: an.gears,
  };
}

$('recBtn').addEventListener('click', () => (recording ? stopRide() : startRide()));

function setBanner(msg) { const b = $('banner'); b.hidden = !msg; b.textContent = msg; }

// ---------------- render loop ----------------
const ARC = { cx: 110, cy: 110, r: 92, a0: 135, a1: 405 };
function arcPath(f0, f1) {
  const a = (f) => ((ARC.a0 + (ARC.a1 - ARC.a0) * f) * Math.PI) / 180;
  const p = (f) => [ARC.cx + ARC.r * Math.cos(a(f)), ARC.cy + ARC.r * Math.sin(a(f))];
  const [x0, y0] = p(f0), [x1, y1] = p(f1);
  const large = (f1 - f0) * (ARC.a1 - ARC.a0) > 180 ? 1 : 0;
  return `M${x0.toFixed(1)},${y0.toFixed(1)} A${ARC.r},${ARC.r} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)}`;
}
let rpmMax = 10000;
$('rpmTrack').setAttribute('d', arcPath(0, 1));

let lastDom = 0, lastStrip = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const snap = analyzer.snapshot();
  const t = snap.t;
  // strips & G circle (~30 fps)
  if (t && now - lastStrip > 33 && recording) {
    lastStrip = now;
    charts.vert.push(t, { v: snap.vertMs2 });
    charts.long.push(t, { g: snap.longG });
    charts.rpm.push(t, { rpm: snap.obd.fresh ? snap.obd.rpm : null });
    gcircle.push(snap.latG, snap.longG);
    Object.values(charts).forEach((c) => c.draw());
    gcircle.draw();
  }
  if (now - lastDom < 100) return; // DOM at 10 Hz
  lastDom = now;
  const nowMs = Date.now();
  for (const [k, ts] of Object.entries(lastSeen)) {
    document.querySelector(`.chip[data-src="${k}"]`).classList.toggle('on', nowMs - ts < 3000);
  }
  $('speed').textContent = fmtSpeed(snap.speedKmh);
  document.querySelector('.speed small').textContent = speedUnit();
  $('speedSrc').textContent = snap.speedSrc === 'none' ? '' : `speed · ${snap.speedSrc}`;
  const rpm = snap.obd.fresh ? snap.obd.rpm : null;
  if (rpm != null && rpm > rpmMax * 0.95) rpmMax = Math.ceil(rpm / 1000 + 1) * 1000;
  $('rpm').textContent = rpm != null ? `${Math.round(rpm).toLocaleString()} rpm` : '— rpm';
  $('rpmArc').setAttribute('d', rpm ? arcPath(0, Math.min(1, Math.max(0.001, rpm / rpmMax))) : '');
  $('gear').textContent = snap.gear ?? (snap.speedKmh < 3 ? 'N' : '–');
  $('clutch').hidden = !snap.clutchIn;
  $('lean').textContent = `${Math.abs(snap.lean).toFixed(0)}° ${snap.lean > 1 ? 'R' : snap.lean < -1 ? 'L' : ''}`;
  $('leanBike').setAttribute('transform', `rotate(${Math.max(-60, Math.min(60, snap.lean)).toFixed(1)} 100 100)`);
  const sum = recording ? analyzer.summary() : null;
  if (sum) { $('leanMaxL').textContent = `${sum.maxLeanLeft.toFixed(0)}°`; $('leanMaxR').textContent = `${sum.maxLeanRight.toFixed(0)}°`; $('gPeak').textContent = `${sum.peakG.toFixed(2)} g`; }
  $('gNow').textContent = `${Math.hypot(snap.latG, snap.longG).toFixed(2)} g`;
  $('coolant').textContent = fmtTemp(snap.obd.coolant ?? snap.obd.oil);
  $('coolantHint').textContent = snap.obd.oil != null && snap.obd.coolant == null ? 'oil temp' : snap.obd.intake != null ? `intake ${fmtTemp(snap.obd.intake)}` : 'engine temp';
  $('throttle').textContent = snap.obd.throttle != null ? `${Math.round(snap.obd.throttle)}%` : '—';
  $('throttleBar').style.width = `${snap.obd.throttle ?? 0}%`;
  $('alt').textContent = fmtAlt(snap.alt);
  $('climb').textContent = `↑${fmtAlt(snap.ascent)} ↓${fmtAlt(snap.descent)}`;
  $('dist').textContent = fmtDist(snap.distanceKm);
  $('elapsed').textContent = fmtDur(snap.elapsedMs);
  $('rough').textContent = `${snap.roughRms.toFixed(2)}`;
  const c = $('comfort'); c.className = `status-pill ${snap.comfort.status}`; c.textContent = snap.comfort.label;
  $('score').textContent = recording ? snap.scores.overall : '—';
  $('scoreHint').textContent = recording ? `${snap.scores.smooth} · ${snap.scores.braking} · ${snap.scores.shifting ?? '—'}` : 'smooth · brake · shift';
  // map
  if (liveMap && snap.fix && recording) {
    const ll = [snap.fix.lat, snap.fix.lon];
    const pts = livePath.getLatLngs();
    const last = pts[pts.length - 1];
    if (!last || last.lat !== ll[0] || last.lng !== ll[1]) {
      livePath.addLatLng(ll);
      if (!liveDot) liveDot = L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: statusColor('good'), fillOpacity: 1 }).addTo(liveMap);
      liveDot.setLatLng(ll);
      if (pts.length <= 1) liveMap.setView(ll, 16); else liveMap.panTo(ll, { animate: false });
    }
  }
}
requestAnimationFrame(frame);

// ---------------- OBD ----------------
const obdLog = (m) => { const l = $('obdLog'); l.textContent += `${m}\n`; l.scrollTop = l.scrollHeight; };
async function connectObd(makeTransport) {
  try {
    elm?.close();
    $('obdLog').textContent = '';
    obdLog('Connecting…');
    const tx = await makeTransport();
    obdLog(`Connected to ${tx.name}. Initialising ELM327…`);
    elm = new Elm327(tx, { protocol: settings.protocol, log: obdLog });
    tx.onClose?.(() => { obdLog('Adapter disconnected'); elm = null; });
    const sup = await elm.init();
    obdLog(`Supported PIDs: ${[...sup].join(' ') || '(none reported)'}`);
    obdLog(`Polling: ${elm.pidList().join(' ')}`);
    elm.start(feedObd);
    toast('OBD connected');
  } catch (e) { obdLog(`Error: ${e.message}`); toast(e.message, 4000); }
}
$('bleBtn').addEventListener('click', () => connectObd(bleTransport));
$('wifiBtn').addEventListener('click', () => {
  const url = $('bridgeUrl').value.trim() || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/obd?host=192.168.0.10&port=35000`;
  connectObd(() => wsTransport(url));
});
$('obdStop').addEventListener('click', () => { elm?.close(); elm = null; obdLog('Disconnected'); });

// ---------------- setup form ----------------
const bind = (id, key, ev = 'change', after) => {
  const el = $(id);
  if (el.type === 'checkbox') el.checked = !!settings[key]; else el.value = settings[key] ?? '';
  el.addEventListener(ev, () => { settings[key] = el.type === 'checkbox' ? el.checked : el.value; saveSettings(); after?.(); });
};
bind('protocol', 'protocol');
bind('bridgeUrl', 'bridgeUrl', 'input');
bind('serverUrl', 'serverUrl', 'input');
bind('serverToken', 'serverToken', 'input');
bind('units', 'units');
bind('theme', 'theme', 'change', applyTheme);
bind('invertYaw', 'invertYaw', 'change', () => toast('Applies from the next ride'));
$('testServer').addEventListener('click', async () => {
  const st = $('serverStatus');
  try {
    const r = await fetch(`${settings.serverUrl.replace(/\/$/, '')}/api/health`, { headers: settings.serverToken ? { authorization: `Bearer ${settings.serverToken}` } : {} });
    st.textContent = r.ok ? 'Connected ✓' : `HTTP ${r.status}`;
  } catch (e) { st.textContent = `Failed: ${e.message}`; }
});

// ---------------- ride report ----------------
const SCORE_STATUS = (v) => (v >= 80 ? ['good', 'Excellent'] : v >= 60 ? ['warning', 'Good'] : v >= 40 ? ['serious', 'Needs work'] : ['critical', 'Risky']);
let reportMap = null;

// Measured facts only. No advice that isn't backed by this ride's own data.
function insights(ride) {
  const s = ride.summary, out = [];
  const km = Math.max(s.distanceKm, 0.1);
  out.push(`<b>${s.hardBrakes}</b> hard-braking event${s.hardBrakes === 1 ? '' : 's'} (≥ 0.35 g), ${((s.hardBrakes / km) * 10).toFixed(1)} per 10 km.`);
  if (s.scores.avgShiftMs) out.push(`Average measured clutch time per gear change: <b>${s.scores.avgShiftMs} ms</b> over ${ride.events.filter((e) => e.type === 'shift' && (e.kind === 'upshift' || e.kind === 'downshift')).length} shifts.`);
  if (s.clutchPct != null) out.push(`Clutch disengaged (or neutral) for <b>${s.clutchPct}%</b> of moving time.`);
  out.push(`<b>${s.potholes}</b> pothole${s.potholes === 1 ? '' : 's'} and <b>${s.bumps}</b> bump${s.bumps === 1 ? '' : 's'} detected, each with its GPS position in the event log.`);
  if (s.avgRoughness != null) out.push(`Average vertical vibration: ${s.avgRoughness} m/s² RMS (unweighted; ISO 2631 bands are shown on the map as a rough reference only).`);
  if (s.maxCoolant != null) out.push(`Highest coolant temperature reported by the ECU: <b>${fmtTemp(s.maxCoolant)}</b>.`);
  if (Math.max(s.maxLeanLeft, s.maxLeanRight) > 0) out.push(`Peak lean, estimated from gyro × speed: ${s.maxLeanLeft}° left, ${s.maxLeanRight}° right.`);
  return out;
}

function stat(label, val, unit = '') { return `<div class="stat"><div class="label">${label}</div><div class="val">${val}${unit ? `<small>${unit}</small>` : ''}</div></div>`; }

let currentRide = null;
function openRide(ride) { show('report'); currentRide = ride; renderReport(ride); }
let resizeT;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { if (currentRide && document.querySelector('#view-report.active')) renderReport(currentRide); }, 250);
});

function renderReport(ride) {
  const s = ride.summary;
  const [st, word] = SCORE_STATUS(s.scores.overall);
  const C = 2 * Math.PI * 40;
  const dur = (s.endT ?? 0) - (s.startT ?? 0);
  const body = $('reportBody');
  body.innerHTML = `
    <div class="report-head">
      <svg class="score-ring" viewBox="0 0 96 96" role="img" aria-label="Ride score ${s.scores.overall}, ${word}">
        <circle class="bg" cx="48" cy="48" r="40"/><circle class="fg" cx="48" cy="48" r="40" stroke="var(--status-${st})" stroke-dasharray="${(C * s.scores.overall) / 100} ${C}"/>
        <text x="48" y="48">${s.scores.overall}</text>
      </svg>
      <div style="flex:1;min-width:200px">
        <h2>${new Date(s.startT).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</h2>
        <div class="muted"><span class="status-pill ${st}">${word}</span> · heuristic score · smoothness ${s.scores.smooth} · braking ${s.scores.braking} · shifting ${s.scores.shifting ?? '—'}</div>
      </div>
      <span class="actions"><button class="ghost" data-x="json">JSON</button><button class="ghost" data-x="csv">CSV</button><button class="ghost" data-x="gpx">GPX</button></span>
    </div>
    <div class="stats">
      ${stat('Distance', fmtDist(s.distanceKm))}
      ${stat('Duration', fmtDur(dur))}
      ${stat('Avg / max speed', `${fmtSpeed(s.avgSpeedKmh)} / ${fmtSpeed(s.maxSpeedKmh)}`, speedUnit())}
      ${stat('Max lean L / R', `${s.maxLeanLeft.toFixed(0)}° / ${s.maxLeanRight.toFixed(0)}°`)}
      ${stat('Peak g-force', s.peakG.toFixed(2), 'g')}
      ${stat('Climb / descent', `${fmtAlt(s.ascent)} / ${fmtAlt(s.descent)}`)}
      ${stat('Potholes · bumps', `${s.potholes} · ${s.bumps}`)}
      ${stat('Hard brakes', s.hardBrakes)}
      ${stat('Gear shifts', s.shifts)}
      ${stat('Avg clutch time', s.scores.avgShiftMs ?? '—', s.scores.avgShiftMs ? 'ms' : '')}
      ${stat('Max coolant', fmtTemp(s.maxCoolant))}
      ${stat('Road roughness', s.avgRoughness ?? '—', s.avgRoughness != null ? 'm/s²' : '')}
    </div>
    <div class="grid report-grid">
      <article class="card wide"><h3>What was measured</h3><ul class="insights">${insights(ride).map((i) => `<li>${i}</li>`).join('')}</ul></article>
      <article class="card wide map-card"><div id="reportMap" class="map" style="min-height:360px"></div></article>
      <article class="card wide"><div class="card-head"><h3>Speed</h3><span class="muted">${speedUnit()}</span></div><div class="chart-wrap" id="cSpeed"></div></article>
      <article class="card"><div class="card-head"><h3>Braking &amp; acceleration</h3><span class="muted">g · dashed = hard brake</span></div><div class="chart-wrap" id="cLong"></div></article>
      <article class="card"><div class="card-head"><h3>Road roughness</h3><span class="muted">m/s² RMS · dashed = pothole</span></div><div class="chart-wrap" id="cRough"></div></article>
      <article class="card"><div class="card-head"><h3>Elevation</h3><span class="muted">${imperial() ? 'ft' : 'm'}</span></div><div class="chart-wrap" id="cAlt"></div></article>
      <article class="card"><div class="card-head"><h3>Lean angle</h3><span class="muted">° · + right / − left</span></div><div class="chart-wrap" id="cLean"></div></article>
      <article class="card"><div class="card-head"><h3>Engine rpm</h3><span class="muted">OBD</span></div><div class="chart-wrap" id="cRpm"></div></article>
      <article class="card"><div class="card-head"><h3>Clutch time per shift</h3><span class="muted">ms</span></div><div class="chart-wrap" id="cShift"></div></article>
      <article class="card"><h3>Event breakdown</h3><div id="cEvents"></div></article>
      <article class="card"><h3>Learned gear ratios</h3><div id="cGears"></div></article>
      <article class="card wide"><h3>Event log</h3><div class="table-scroll"><table class="events"><thead><tr><th>Time</th><th>Event</th><th>Detail</th><th>Location</th></tr></thead><tbody>
        ${ride.events.filter((e) => e.type !== 'shift').map((e) => `<tr><td>${fmtClock(e.t)}</td><td><span class="status-pill ${(EV[e.type] || {}).status || ''}">${(EV[e.type] || {}).title || e.type}</span></td><td>${esc(describe(e))}</td><td>${e.lat != null ? `<a href="https://maps.google.com/?q=${e.lat},${e.lon}" target="_blank" rel="noopener">${e.lat.toFixed(5)}, ${e.lon.toFixed(5)}</a>` : '—'}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No events.</td></tr>'}
      </tbody></table></div></article>
    </div>`;

  const tl = ride.timeline.map((d) => ({ ...d, vU: fmtSpeed(d.v), altU: d.alt == null ? null : imperial() ? d.alt * 3.28084 : d.alt }));
  const mk = (types, status) => ride.events.filter((e) => types.includes(e.type)).map((e) => ({ t: e.t, status: typeof status === 'function' ? status(e) : status }));
  lineChart($('cSpeed'), { data: tl, key: 'vU', area: true, unit: ` ${speedUnit()}`, zero: true, height: 180 });
  lineChart($('cLong'), { data: tl, key: 'long', color: '--series-2', unit: ' g', fmt: (v) => v.toFixed(2), markers: mk(['brake'], 'critical') });
  lineChart($('cRough'), { data: tl, key: 'vert', color: '--series-1', unit: ' m/s²', fmt: (v) => v.toFixed(1), zero: true, markers: mk(['pothole'], 'serious') });
  lineChart($('cAlt'), { data: tl, key: 'altU', color: '--series-3', area: true, unit: imperial() ? ' ft' : ' m' });
  lineChart($('cLean'), { data: tl, key: 'lean', color: '--series-2', unit: '°', min: -50, max: 50 });
  lineChart($('cRpm'), { data: tl, key: 'rpm', color: '--series-3', unit: ' rpm', zero: true, markers: mk(['coast'], 'warning') });
  histogram($('cShift'), ride.events.filter((e) => e.type === 'shift' && (e.kind === 'upshift' || e.kind === 'downshift')).map((e) => e.durationMs), { step: 100, unit: ' ms' });
  barChart($('cEvents'), [
    { label: 'Potholes', value: s.potholes }, { label: 'Bumps', value: s.bumps },
    { label: 'Hard brakes', value: s.hardBrakes }, { label: 'Hard accel.', value: s.hardAccels },
    { label: 'Clutch coasting', value: ride.events.filter((e) => e.type === 'coast').length },
  ]);
  const gears = s.gearRatios || [];
  $('cGears').innerHTML = gears.length
    ? `<div class="bars">${gears.map((r, i) => `<div class="bar-row"><span class="bar-label">Gear ${i + 1}</span><span class="bar-track"><span class="bar-fill" style="width:${(r / gears[0]) * 100}%;background:var(--series-3)"></span></span><span class="bar-value">${r}</span></div>`).join('')}</div><p class="fine">rpm per km/h, learned from OBD. Gear and clutch detection rely on these clusters.</p>`
    : '<p class="empty">Needs OBD rpm + speed.</p>';

  // map coloured by ISO comfort class
  if (reportMap) { reportMap.remove(); reportMap = null; }
  if (L && ride.track.length > 1) {
    reportMap = makeMap('reportMap');
    reportMap.addControl(L.control.zoom({ position: 'topright' }));
    for (let i = 1; i < ride.track.length; i++) {
      const a = ride.track[i - 1], b = ride.track[i];
      L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color: statusColor(comfortClass(b.rough).status), weight: 5, opacity: 0.9 }).addTo(reportMap);
    }
    for (const e of ride.events) {
      if (e.lat == null || e.type === 'shift') continue;
      const m = EV[e.type] || EV.bump;
      L.circleMarker([e.lat, e.lon], { radius: 6, color: '#fff', weight: 2, fillColor: statusColor(m.status), fillOpacity: 1 }).bindPopup(`<b>${m.title}</b><br>${esc(describe(e))}<br>${fmtClock(e.t)}`).addTo(reportMap);
    }
    const legend = L.control({ position: 'bottomleft' });
    legend.onAdd = () => {
      const d = L.DomUtil.create('div', 'card'); d.style.padding = '8px 10px'; d.style.fontSize = '12px';
      d.innerHTML = '<b>Road comfort (ISO 2631)</b><br>' + [['good', 'Comfortable'], ['warning', 'Fairly uncomfortable'], ['serious', 'Uncomfortable'], ['critical', 'Very uncomfortable']].map(([k, l]) => `<span class="status-pill ${k}" style="margin-top:4px">${l}</span>`).join('<br>');
      return d;
    };
    legend.addTo(reportMap);
    reportMap.fitBounds(L.latLngBounds(ride.track.map((p) => [p.lat, p.lon])), { padding: [20, 20] });
  } else $('reportMap').innerHTML = '<p class="empty pad">No GPS track.</p>';

  body.querySelector('.actions').addEventListener('click', (e) => {
    const x = e.target.dataset.x; if (!x) return;
    const name = `ride-${new Date(s.startT).toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
    if (x === 'json') download(`${name}.json`, JSON.stringify(ride), 'application/json');
    if (x === 'csv') {
      const cols = ['t', 'v', 'long', 'lat', 'vert', 'jerk', 'lean', 'rpm', 'gear', 'clutch', 'thr', 'cool', 'alt'];
      download(`${name}.csv`, [cols.join(','), ...ride.timeline.map((r) => cols.map((c) => (c === 't' ? new Date(r.t).toISOString() : r[c] ?? '')).join(','))].join('\n'), 'text/csv');
    }
    if (x === 'gpx') {
      const pts = ride.track.map((p) => `<trkpt lat="${p.lat}" lon="${p.lon}">${p.alt != null ? `<ele>${p.alt}</ele>` : ''}<time>${new Date(p.t).toISOString()}</time></trkpt>`).join('');
      download(`${name}.gpx`, `<?xml version="1.0"?><gpx version="1.1" creator="RideLens" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>${pts}</trkseg></trk></gpx>`, 'application/gpx+xml');
    }
  });
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(text instanceof Blob ? text : new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------- history ----------------
async function renderHistory() {
  const rides = (await db.all('rides')).sort((a, b) => b.summary.startT - a.summary.startT);
  const list = $('historyList');
  if (!rides.length) {
    list.innerHTML = '<div class="card"><p class="empty">No rides yet. Recorded rides appear here.</p></div>';
    return;
  }
  list.innerHTML = rides.map((r) => {
    const s = r.summary; const [st] = SCORE_STATUS(s.scores.overall);
    return `<div class="item ride-item" data-id="${r.id}" role="button" tabindex="0">
      <span class="ride-badge" style="color:var(--status-${st})">${s.scores.overall}</span>
      <span><b>${new Date(s.startT).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</b><br>
      <span class="muted">${fmtDist(s.distanceKm)} · ${fmtDur(s.endT - s.startT)} · ${s.potholes} potholes · ${s.hardBrakes} hard brakes</span></span>
      <button class="ghost" data-del="${r.id}" aria-label="Delete ride">✕</button></div>`;
  }).join('');
  list.onclick = async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); if (confirm('Delete this ride?')) { await db.del('rides', del.dataset.del); renderHistory(); } return; }
    const it = e.target.closest('.item'); if (!it) return;
    openRide(await db.get('rides', it.dataset.id));
  };
}

$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { const ride = JSON.parse(await f.text()); if (!ride.summary) throw new Error('Not a RideLens ride'); ride.id ||= uid(); await db.put('rides', ride); renderHistory(); toast('Imported'); }
  catch (err) { toast(err.message); }
});

// ---------------- wrong-side reporting ----------------
const camera = new EvidenceCamera($('camVideo'));
let camOn = false, wsMap = null;
async function setCamera(on) {
  try {
    if (on) { await camera.start(); } else camera.stop();
    camOn = on;
    $('camOff').hidden = on; $('captureBtn').disabled = !on;
    $('camToggle').textContent = on ? 'Stop camera' : 'Start camera';
  } catch (e) { toast(`Camera: ${e.message}`, 4000); }
}
$('camToggle').addEventListener('click', () => setCamera(!camOn));

async function capture() {
  const fab = $('fab');
  if (fab.classList.contains('busy')) return;
  fab.classList.add('busy');
  try {
    if (!camOn) { await setCamera(true); await new Promise((r) => setTimeout(r, 700)); }
    if (!camOn) return;
    navigator.vibrate?.(60);
    const frames = await camera.burst();
    if (!frames.length) throw new Error('No frames captured');
    const snap = analyzer.snapshot();
    const rep = await saveReport({ frames, snapshot: snap.fix ? snap : null, rideId: recording ? rideId : null });
    if (recording) {
      const ev = { id: rep.id, type: 'wrongside', t: rep.t, lat: rep.lat, lon: rep.lon, speedKmh: snap.speedKmh, severity: 'severe' };
      analyzer.events.push(ev); onEvent(ev);
    }
    toast(`Saved ${frames.length} photos · add plate details after the ride`);
    if (document.querySelector('#view-wrongside.active')) renderReports();
  } catch (e) { toast(e.message, 4000); } finally { fab.classList.remove('busy'); }
}
$('fab').addEventListener('click', capture);
$('captureBtn').addEventListener('click', capture);
document.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || $('reportDialog').open) return;
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'MediaPlayPause' || e.key === 'AudioVolumeUp') { e.preventDefault(); capture(); }
});

const thumbUrls = new Map();
const thumb = (r) => {
  const p = r.photos[r.keyPhoto] || r.photos[0]; if (!p) return '';
  if (!thumbUrls.has(r.id)) thumbUrls.set(r.id, URL.createObjectURL(p.blob));
  return thumbUrls.get(r.id);
};

async function renderReports() {
  const reps = (await db.all('reports')).sort((a, b) => b.t - a.t);
  const plates = new Map();
  reps.forEach((r) => r.plate && plates.set(r.plate, (plates.get(r.plate) || 0) + 1));
  const repeat = [...plates.values()].filter((n) => n > 1).length;
  $('wsStats').innerHTML = `<span><b>${reps.length}</b>reports</span><span><b>${reps.filter((r) => r.plateValid).length}</b>valid plates</span><span><b>${repeat}</b>repeat offenders</span><span><b>${reps.filter((r) => r.synced).length}</b>synced</span>`;
  $('wsList').innerHTML = reps.length ? reps.map((r) => `
    <div class="item" data-id="${r.id}" role="button" tabindex="0">
      <img src="${thumb(r)}" alt="">
      <span>${r.plate ? `<span class="plate-tag">${esc(r.plate)}</span>` : '<span class="plate-tag none">NO PLATE</span>'} ${plates.get(r.plate) > 1 ? `<span class="status-pill critical">×${plates.get(r.plate)}</span>` : ''}<br>
      <span class="muted">${esc(r.vehicleType || 'Vehicle')} · ${new Date(r.t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${esc(r.status)}${r.synced ? ' · synced' : ''}</span></span>
      <span class="muted">${r.photos.length} 📷</span>
    </div>`).join('') : '<p class="empty">No reports yet. Tap the red camera button when a vehicle comes at you on the wrong side.</p>';
  $('wsList').onclick = async (e) => { const it = e.target.closest('.item'); if (it) openReport(await db.get('reports', it.dataset.id)); };
  if (!wsMap) wsMap = makeMap('wsMap');
  if (wsMap) {
    setTimeout(() => wsMap.invalidateSize(), 50);
    wsMap.eachLayer((l) => { if (l instanceof L.CircleMarker) wsMap.removeLayer(l); });
    const pts = reps.filter((r) => r.lat != null);
    pts.forEach((r) => L.circleMarker([r.lat, r.lon], { radius: 8, color: '#fff', weight: 2, fillColor: statusColor('critical'), fillOpacity: 1 })
      .bindPopup(`<img src="${thumb(r)}" style="width:160px;border-radius:6px"><br><b>${esc(r.plate || 'Unknown plate')}</b><br>${new Date(r.t).toLocaleString()}`).addTo(wsMap));
    if (pts.length) wsMap.fitBounds(L.latLngBounds(pts.map((r) => [r.lat, r.lon])), { padding: [30, 30], maxZoom: 16 });
  }
}

function openReport(r) {
  const dlg = $('reportDialog');
  let sel = r.keyPhoto || 0;
  const urls = r.photos.map((p) => URL.createObjectURL(p.blob));
  const vt = ['', 'Two-wheeler', 'Car', 'Auto-rickshaw', 'Bus', 'Truck / tempo', 'Tractor', 'Cycle', 'Other'];
  dlg.innerHTML = `<div class="sheet-body">
    <div class="card-head"><h3>Wrong-side report</h3><button class="ghost" data-a="close">Close</button></div>
    <img class="main-photo" id="rpMain" src="${urls[sel]}" alt="Evidence photo">
    <div class="strip-photos">${urls.map((u, i) => `<img src="${u}" data-i="${i}" class="${i === sel ? 'sel' : ''}" alt="frame ${i + 1}">`).join('')}</div>
    <p class="fine">${new Date(r.t).toLocaleString()} · ${r.lat != null ? `<a href="https://maps.google.com/?q=${r.lat},${r.lon}" target="_blank" rel="noopener">${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}</a> (±${Math.round(r.accuracy || 0)} m)` : 'no GPS fix'}${r.mySpeedKmh != null ? ` · you at ${fmtSpeed(r.mySpeedKmh)} ${speedUnit()}` : ''}</p>
    <label>Registration number
      <div class="row" style="margin:0"><input id="rpPlate" value="${esc(r.plate)}" placeholder="KA 01 AB 1234" style="flex:1;text-transform:uppercase"><button class="ghost" data-a="ocr">Read plate</button></div>
      <span id="rpPlateMsg" class="muted"></span>
    </label>
    <div class="two">
      <label>Vehicle type <select id="rpType">${vt.map((v) => `<option ${v === r.vehicleType ? 'selected' : ''} value="${v}">${v || '—'}</option>`).join('')}</select></label>
      <label>Colour <input id="rpColor" value="${esc(r.color)}" placeholder="e.g. white"></label>
    </div>
    <label>Status <select id="rpStatus">${['new', 'verified', 'submitted to police', 'dismissed'].map((v) => `<option ${v === r.status ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label>Notes <textarea id="rpNotes" placeholder="Road, direction, behaviour…">${esc(r.notes)}</textarea></label>
    <div class="row"><button data-a="save">Save</button><button class="ghost" data-a="share">Share to authorities</button><button class="ghost" data-a="sync">Sync</button><button class="ghost" data-a="del" style="margin-left:auto;color:var(--status-critical)">Delete</button></div>
    <p class="fine">This is evidence of a traffic violation. Share it only with traffic police or official grievance channels. Do not post plates or faces publicly.</p>
  </div>`;
  const plateMsg = () => { const n = normalizePlate($('rpPlate').value); $('rpPlateMsg').textContent = n.plate ? (n.valid ? `✓ ${n.plate} looks like a valid Indian registration` : `⚠ ${n.plate} doesn't match a standard format. Saved anyway.`) : ''; };
  plateMsg();
  $('rpPlate').addEventListener('input', plateMsg);
  const collect = () => {
    const n = normalizePlate($('rpPlate').value);
    Object.assign(r, { plate: n.plate, plateValid: n.valid, vehicleType: $('rpType').value, color: $('rpColor').value, status: $('rpStatus').value, notes: $('rpNotes').value, keyPhoto: sel });
  };
  dlg.onclick = async (e) => {
    const img = e.target.closest('.strip-photos img');
    if (img) { sel = +img.dataset.i; $('rpMain').src = urls[sel]; dlg.querySelectorAll('.strip-photos img').forEach((x) => x.classList.toggle('sel', x === img)); return; }
    const a = e.target.dataset.a; if (!a) return;
    if (a === 'close') dlg.close();
    if (a === 'save') { collect(); r.synced = false; await db.put('reports', r); thumbUrls.delete(r.id); toast('Saved'); dlg.close(); renderReports(); }
    if (a === 'del') { if (confirm('Delete this report and its photos?')) { await db.del('reports', r.id); dlg.close(); renderReports(); } }
    if (a === 'ocr') {
      $('rpPlateMsg').textContent = 'Loading OCR engine…';
      try {
        const res = await ocrPlate(r.photos[sel].blob, (m) => { if (m.status) $('rpPlateMsg').textContent = `${m.status} ${m.progress ? Math.round(m.progress * 100) + '%' : ''}`; });
        if (res.plates.length) { $('rpPlate').value = res.plates[0]; plateMsg(); }
        else $('rpPlateMsg').textContent = `No plate found (read: "${res.text.trim().slice(0, 40)}"). Try another frame or type it.`;
      } catch (err) { $('rpPlateMsg').textContent = err.message; }
    }
    if (a === 'share') {
      collect(); await db.put('reports', r);
      const text = `Wrong-side driving report\nVehicle: ${r.vehicleType || 'unknown'} ${r.color || ''}\nRegistration: ${r.plate || 'not readable'}\nTime: ${new Date(r.t).toLocaleString()}\nLocation: ${r.lat != null ? `https://maps.google.com/?q=${r.lat},${r.lon}` : 'unknown'}\n${r.notes || ''}`;
      const file = new File([r.photos[sel].blob], `wrongside-${r.plate || r.id}.jpg`, { type: 'image/jpeg' });
      try {
        if (navigator.canShare?.({ files: [file] })) await navigator.share({ text, files: [file] });
        else { await navigator.clipboard?.writeText(text); download(file.name, file); toast('Text copied, photo downloaded'); }
      } catch { /* cancelled */ }
    }
    if (a === 'sync') {
      collect(); await db.put('reports', r);
      if (!settings.serverUrl) { toast('Set a server URL in Setup first'); return; }
      try { await syncReport(r, settings); toast('Synced to server'); renderReports(); } catch (err) { toast(err.message, 4000); }
    }
  };
  dlg.addEventListener('close', () => urls.forEach((u) => URL.revokeObjectURL(u)), { once: true });
  dlg.showModal();
}

$('wsCsv').addEventListener('click', async () => download('wrongside-reports.csv', reportsToCsv(await db.all('reports')), 'text/csv'));
$('wsJson').addEventListener('click', async () => {
  const all = await Promise.all((await db.all('reports')).map((r) => reportToJson(r)));
  download('wrongside-reports.json', JSON.stringify(all, null, 1), 'application/json');
});
$('wsSync').addEventListener('click', async () => {
  if (!settings.serverUrl) { toast('Set a server URL in Setup first'); show('setup'); return; }
  const pending = (await db.all('reports')).filter((r) => !r.synced);
  let ok = 0;
  for (const r of pending) { try { await syncReport(r, settings); ok++; } catch (e) { toast(e.message, 4000); break; } }
  toast(`Synced ${ok}/${pending.length}`); renderReports();
});

// ---------------- PWA ----------------
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
