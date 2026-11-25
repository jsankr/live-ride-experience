import { airCategory, airCell } from './air-quality.js';
import { setupEvidenceLocation } from './evidence-location.js';
import { analyzeEvidence, loadDetector, readPlateCrop } from './evidence-analysis.js';
import { startAutoWatch } from './wrongside-watch.js';
import { createYouTubePlayer, parseYouTubeLink } from './ytplayer.js';
import { Dashcam, fileName, retention, overlapping, stamp } from './dashcam.js';
import { createAnalyzer, comfortClass, comfortLegend } from './analytics.js';
import { Elm327, bleTransport, wsTransport } from './obd.js';
import { requestMotionPermission, startMotion, startGps, keepAwake } from './sensors.js';
import { StripChart, FrictionCircle, lineChart, barChart, histogram } from './charts.js';
import { db, uid } from './db.js';
import { createTrip, geocode, parseLatLon, parseDms, parsePlusCode, looksLikeW3w, what3words, wazeUrl, gmapsUrl } from './trip.js';
import { EvidenceCamera, saveReport, normalizePlate, reportToJson, reportsToCsv, syncReport } from './reports.js';

const $ = (id) => document.getElementById(id);
const G = 9.80665;

// ---------------- settings ----------------
const settings = (() => {
  const def = { protocol: '0', bridgeUrl: '', serverUrl: '', serverToken: '', units: 'metric', theme: '', invertYaw: '', keepSide: 'left', autoWatch: true, ytLink: '', dashcam: true, dcDays: '7', dcQuality: '720', w3wKey: '' };
  try {
    const v = { ...def, ...JSON.parse(localStorage.getItem('ridelens.settings') || '{}') };
    if (typeof v.invertYaw === 'boolean') v.invertYaw = v.invertYaw ? 'invert' : ''; // migrate old checkbox
    return v;
  } catch { return def; }
})();
const yawOpt = () => (settings.invertYaw === 'invert' ? true : settings.invertYaw === 'normal' ? false : null);
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
let currentView = 'live';
let yt = null; // YouTube Music player, created on first use
let musicCardVisible = false;
function show(view) {
  currentView = view;
  const tq = document.getElementById('tripQuick'); if (tq) tq.hidden = view !== 'live'; // trip pill only on Live
  refreshMusicFab();
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  document.querySelectorAll('.tabbar button').forEach((b) => {
    const active = b.dataset.view === view;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  publishCockpit();
  if (view === 'history') renderHistory();
  if (view === 'wrongside') { renderReports(); renderClips(); }
  if (view === 'live') setTimeout(() => liveMap?.invalidateSize(), 50);
  window.scrollTo({ top: 0 });
}
$('tabbar').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) show(b.dataset.view); });

// ---------------- live state ----------------
let analyzer = createAnalyzer({ invertYaw: yawOpt() });
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
  gap: { icon: '⏸', status: 'warning', title: 'Recording paused (RideLens not on screen)' },
  crash: { icon: '!', status: 'critical', title: 'Crash-level impact' },
  fall: { icon: '!', status: 'critical', title: 'Bike fell over' },
};
const statusColor = (st) => getComputedStyle(document.documentElement).getPropertyValue(`--status-${st === 'info' ? 'good' : st}`).trim();

function describe(ev) {
  switch (ev.type) {
    case 'pothole': case 'bump': return `${ev.severity} · ${ev.p2pG} g peak-to-peak at ${fmtSpeed(ev.speedKmh)} ${speedUnit()}`;
    case 'brake': case 'accel': return `${ev.peakG} g · ${fmtSpeed(ev.fromKmh)}→${fmtSpeed(ev.toKmh)} ${speedUnit()} in ${(ev.durationMs / 1000).toFixed(1)} s`;
    case 'shift': return `${ev.kind}${ev.from ? ` ${ev.from}→${ev.to}` : ` into ${ev.to}`} · clutch ${ev.durationMs} ms`;
    case 'coast': return `${(ev.durationMs / 1000).toFixed(1)} s without drive`;
    case 'overheat': return `coolant ${fmtTemp(ev.coolant)}`;
    case 'crash': return `${ev.peakG} g impact at ${fmtSpeed(ev.speedKmh)} ${speedUnit()}`;
    case 'fall': return `tilted ${ev.tiltDeg}° from upright`;
    case 'gap': return `no sensor data for ${fmtDur(ev.durationMs)}: the browser pauses sensors while another app is in front or the screen is off`;
    case 'wrongside': return ev.auto ? `auto-detected ${ev.auto.type?.toLowerCase() || 'vehicle'} · ~${ev.auto.distanceM} m away, closing ${ev.auto.closingKmh} km/h` : 'captured manually';
    default: return '';
  }
}

function onEvent(ev) {
  if (ev.type === 'crash' || ev.type === 'fall' || (ev.type === 'brake' && ev.severity === 'severe')) recordIncident(ev.type, ev);
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
  analyzer = createAnalyzer({ invertYaw: yawOpt() });
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
  setBanner('');
  show('live');
  // Ask, but judge by whether data actually arrives: permission answers differ between browsers.
  const t0 = Date.now();
  let permErr = null;
  try { await requestMotionPermission(); } catch (e) { permErr = e.message; }
  try { stopFns.push(startMotion(feedImu)); } catch (e) { setBanner(`Motion sensors: ${e.message}`); }
  const check = setTimeout(() => {
    if (recording && lastSeen.imu < t0) setBanner(`No motion-sensor data received. ${permErr || 'Allow motion access for this site in the browser settings.'}`);
  }, 3000);
  stopFns.push(() => clearTimeout(check));
  try {
    stopFns.push(startGps(feedGps, (e) => {
      // timeouts happen while the GPS is still acquiring; only report denial or a GPS that never delivered
      if (e.code === 1) setBanner('GPS: permission denied. Allow precise location for this site.');
      else if (lastSeen.gps < t0) setBanner(`GPS: no fix yet (${e.message || 'unavailable'}). Ride with a clear view of the sky.`);
    }));
  } catch (e) { setBanner(e.message); }
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

// banner collects every problem from this ride start instead of showing only the last one
const bannerMsgs = new Set();
function setBanner(msg) {
  if (!msg) bannerMsgs.clear(); else bannerMsgs.add(msg);
  const b = $('banner'); b.hidden = !bannerMsgs.size; b.innerHTML = [...bannerMsgs].map(esc).join('<br>');
}

// ---------------- render loop ----------------
function setSrc(key, cls, text) {
  const el = $(`src-${key}`); if (!el) return;
  if (el.textContent !== text) { el.className = `src ${cls}`; el.textContent = text; }
  el.closest('.tile')?.classList.toggle('nodata', cls === 'none');
}
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

let lastDom = 0, lastStrip = 0, lastCockpit = 0;
let routeSource, routeLength, route = [];
let timelineSource, timelineLength, timeline = [];
function publishCockpit(snap = analyzer.snapshot()) {
  const track = analyzer.track;
  if (track !== routeSource || track.length !== routeLength) {
    routeSource = track;
    routeLength = track.length;
    const stride = Math.max(1, Math.ceil(track.length / 340));
    route = [];
    for (let index = 0; index < track.length; index += stride) route.push(track[index]);
    if (track.length && route.at(-1) !== track.at(-1)) route.push(track.at(-1));
  }
  const samples = analyzer.timeline;
  if (samples !== timelineSource || samples.length !== timelineLength) {
    timelineSource = samples;
    timelineLength = samples.length;
    const cutoff = (samples.at(-1)?.t ?? 0) - 30000;
    let start = samples.length;
    while (start > 0 && samples[start - 1].t >= cutoff) start--;
    timeline = samples.slice(start);
  }
  window.dispatchEvent(new CustomEvent('ridelens:cockpit', {
    detail: { snap, route, timeline, recording, view: currentView, imperial: imperial() },
  }));
}
window.addEventListener('ridelens:map-visible', () => liveMap?.invalidateSize());


function frame(now) {
  requestAnimationFrame(frame);
  const snap = analyzer.snapshot();
  if (now - lastCockpit >= 250) {
    lastCockpit = now;
    publishCockpit(snap);
  }
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
  document.querySelector('#rideDetails .speed small').textContent = speedUnit();
  const sp = $('speedSrc');
  sp.className = `speed-src src ${snap.speedSrc === 'obd' ? 'obd' : snap.speedSrc === 'none' ? 'none' : ''}`;
  sp.textContent = snap.speedSrc === 'none' ? 'No speed yet' : `Speed · ${snap.speedSrc === 'obd' ? 'OBD' : 'GPS'}`;
  // provenance badges: a phone-only ride shows what is missing instead of zeros
  const obdLive = !!snap.obd.fresh;
  for (const k of ['coolant', 'throttle']) {
    const has = obdLive && (k === 'throttle' ? snap.obd.throttle != null : (snap.obd.coolant ?? snap.obd.oil) != null);
    setSrc(k, has ? 'obd' : 'none', has ? 'OBD' : 'Needs OBD');
  }
  setSrc('score', obdLive ? 'fused' : '', obdLive ? 'Fused' : 'Phone');
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
  $('coolantHint').textContent = !snap.obd.fresh && snap.obd.coolant == null && snap.obd.oil == null ? 'connect an adapter in Setup' : snap.obd.oil != null && snap.obd.coolant == null ? 'oil temp' : snap.obd.intake != null ? `intake ${fmtTemp(snap.obd.intake)}` : 'engine temp';
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
bind('keepSide', 'keepSide', 'change', () => { if (autoStop) { stopAuto(); startAuto(); } });
bind('w3wKey', 'w3wKey', 'input');
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

// Report map pins: events closer than ~44 px on screen merge into one bubble
// (count, coloured by its most severe event); tapping a bubble zooms into it.
const SEVERITY = ['info', 'good', 'warning', 'serious', 'critical'];
function clusterEvents(map, events) {
  const layer = L.layerGroup().addTo(map);
  const draw = () => {
    layer.clearLayers();
    const cells = new Map();
    for (const e of events) {
      const p = map.latLngToLayerPoint([e.lat, e.lon]);
      const k = `${Math.floor(p.x / 44)}:${Math.floor(p.y / 44)}`;
      (cells.get(k) || cells.set(k, []).get(k)).push(e);
    }
    for (const group of cells.values()) {
      if (group.length === 1) {
        const e = group[0], m = EV[e.type] || EV.bump;
        L.circleMarker([e.lat, e.lon], { radius: 6, color: '#fff', weight: 2, fillColor: statusColor(m.status), fillOpacity: 1 })
          .bindPopup(`<b>${m.title}</b><br>${esc(describe(e))}<br>${fmtClock(e.t)}`).addTo(layer);
        continue;
      }
      const worst = group.reduce((w, e) => Math.max(w, SEVERITY.indexOf((EV[e.type] || EV.bump).status)), 0);
      const lat = group.reduce((a, e) => a + e.lat, 0) / group.length, lon = group.reduce((a, e) => a + e.lon, 0) / group.length;
      const size = Math.min(44, 24 + Math.round(Math.sqrt(group.length) * 4));
      const counts = {}; for (const e of group) { const t = (EV[e.type] || EV.bump).title; counts[t] = (counts[t] || 0) + 1; }
      L.marker([lat, lon], { icon: L.divIcon({ className: '', html: `<div class="ev-cluster ${SEVERITY[worst]}" style="width:${size}px;height:${size}px">${group.length}</div>`, iconSize: [size, size] }),
        title: Object.entries(counts).map(([t, n]) => `${n} × ${t}`).join(', ') })
        .on('click', () => map.fitBounds(L.latLngBounds(group.map((e) => [e.lat, e.lon])), { padding: [40, 40], maxZoom: 18 }))
        .addTo(layer);
    }
  };
  map.on('zoomend', draw);
  draw();
}

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
      <article class="card"><div class="card-head"><h3>Braking &amp; acceleration</h3><span class="muted">g · band = range · ticks = hard brakes</span></div><div class="chart-wrap" id="cLong"></div></article>
      <article class="card"><div class="card-head"><h3>Road roughness</h3><span class="muted">m/s² · band = range · ticks = potholes</span></div><div class="chart-wrap" id="cRough"></div></article>
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
    clusterEvents(reportMap, ride.events.filter((e) => e.lat != null && e.type !== 'shift'));
    const legend = L.control({ position: 'bottomleft' });
    legend.onAdd = () => {
      const d = L.DomUtil.create('div', 'card'); d.style.padding = '8px 10px'; d.style.fontSize = '12px';
      let lo = 0;
      d.innerHTML = '<b>Road comfort (ISO 2631)</b><br>' + comfortLegend().map(([k, l, hi]) => {
        const range = hi === Infinity ? `≥ ${lo}` : `${lo}–${hi}`; lo = hi;
        return `<span class="status-pill ${k}" style="margin-top:4px" title="${range} m/s² RMS">${l}</span>`;
      }).join('<br>');
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
let camOn = false, wsMap = null, cameraChanging = false;
const evidenceLocation = setupEvidenceLocation(() => analyzer.snapshot().fix);
let analysisQueue = Promise.resolve();
function saveAnalysis(id, analysis) {
  return db.updateReport(id, (current) => {
    const vehicle = analysis.vehicle;
    const plate = analysis.plate;
    return {
      ...current, analysis,
      vehicleType: current.vehicleType || (vehicle?.confidence >= 0.65 ? vehicle.type : ''),
      color: current.color || (vehicle?.confidence >= 0.65 ? vehicle.color || '' : ''),
      plate: current.plate || (plate?.confidence >= 75 ? plate.value : ''),
      plateValid: current.plate ? current.plateValid : plate?.confidence >= 75,
      synced: false,
    };
  });
}
async function setCamera(on) {
  if (cameraChanging) return;
  cameraChanging = true;
  $('camToggle').disabled = true;
  try {
    if (on) { await camera.start(); } else camera.stop();
    camOn = on;
    evidenceLocation.camera(on);
    if (on) loadDetector().catch(() => {});
    if (on && settings.autoWatch) startAuto(); else stopAuto();
    if (on && settings.dashcam) startDashcam(); else stopDashcam();
    $('camOff').hidden = on; $('captureBtn').disabled = !on;
    $('camToggle').textContent = on ? 'Stop camera' : 'Start camera';
  } catch (e) { camera.stop(); toast(`Camera: ${e.message}`, 4000); }
  finally { cameraChanging = false; $('camToggle').disabled = false; }
}
$('camToggle').addEventListener('click', () => setCamera(!camOn));

async function capture(detection = null) {
  const fab = $('fab');
  if (fab.classList.contains('busy')) return;
  fab.classList.add('busy');
  const capturedAt = Date.now();
  const snap = analyzer.snapshot();
  const associatedRide = recording ? rideId : null;
  const air = evidenceLocation.snapshot();
  try {
    if (!camOn) { await setCamera(true); await new Promise((r) => setTimeout(r, 700)); }
    if (!camOn) return;
    navigator.vibrate?.(60);
    const [frames, fix] = await Promise.all([camera.burst(), evidenceLocation.fixAt(capturedAt)]);
    if (!frames.length) throw new Error('No frames captured');
    const airQuality = fix && air?.cell === airCell(fix) && Math.abs(air.time - capturedAt) <= 90 * 60000 ? air : null;
    const speed = associatedRide && snap.speedSrc !== 'none' ? snap.speedKmh : null;
    let rep = await saveReport({ frames, snapshot: { fix, speedKmh: speed }, rideId: associatedRide, capturedAt, airQuality });
    if (detection) {
      // hands-free trigger: keep the measurements that caused it, pre-fill the vehicle type
      rep = await db.updateReport(rep.id, (r) => ({ ...r, auto: detection, vehicleType: r.vehicleType || detection.type, notes: r.notes || `Auto-detected: ${detection.type} ~${detection.distanceM} m away, closing ${detection.closingKmh} km/h in your lane.` })) || rep;
    }
    if (recording && rideId === associatedRide) {
      const ev = { id: rep.id, type: 'wrongside', t: rep.t, lat: rep.lat, lon: rep.lon, speedKmh: speed, severity: 'severe', auto: detection || undefined };
      analyzer.events.push(ev); onEvent(ev);
    }
    recordIncident(detection ? 'wrongside' : 'manual', { reportId: rep.id, auto: detection || undefined, t: capturedAt }, frames);
    toast(detection ? `Wrong-side ${detection.type.toLowerCase()} detected · ${frames.length} photos saved` : `Saved ${frames.length} photos · analysing vehicle and plate`);
    if (detection) navigator.vibrate?.([80, 60, 80]);
    if (currentView === 'wrongside') renderReports();
    analysisQueue = analysisQueue.then(async () => {
      let timer;
      const partial = { status: 'partial', vehicle: null, plate: null };
      const analysis = await Promise.race([
        analyzeEvidence(rep.photos).catch(() => partial),
        new Promise((resolve) => { timer = setTimeout(() => resolve(partial), 45000); }),
      ]).finally(() => clearTimeout(timer));
      await saveAnalysis(rep.id, analysis);
      if (currentView === 'wrongside') renderReports();
    }).catch(() => {});

  } catch (e) { toast(e.message, 4000); } finally { fab.classList.remove('busy'); }
}
$('fab').addEventListener('click', () => capture());
$('captureBtn').addEventListener('click', () => capture());
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.repeat || $('reportDialog').open) return;
  const active = document.activeElement;
  if (active?.closest('input, textarea, select, [contenteditable="true"]')) return;
  const mediaKey = e.key === 'MediaPlayPause' || e.key === 'AudioVolumeUp';
  const activationKey = e.key === 'Enter' || e.key === ' ';
  if (mediaKey || (activationKey && !active?.closest('button, a[href], summary, [role="button"]'))) {
    e.preventDefault();
    capture();
  }
});

// ---------------- hands-free wrong-side detection ----------------
let autoStop = null;
function startAuto() {
  if (autoStop || !camOn) return;
  $('autoStatus').textContent = 'Loading vehicle detector…';
  autoStop = startAutoWatch({
    video: $('camVideo'), overlay: $('camOverlay'), loadDetector, keep: settings.keepSide || 'left',
    getOwnSpeedKmh: () => { const sn = analyzer.snapshot(); return sn.speedSrc !== 'none' && Date.now() - (sn.fix?.t ?? 0) < 5000 ? sn.speedKmh : null; },
    onAlert: (d) => {
      const detection = { type: d.type, vehicleClass: d.vehicleClass, distanceM: d.distanceM, lateralM: d.lateralM, closingKmh: d.closingKmh,
        oncomingKmh: d.oncomingKmh, ownSpeedKmh: d.ownSpeedKmh, score: d.score, sightings: d.sightings, keep: settings.keepSide || 'left',
        box: d.box.map((v, i) => +(v / (i % 2 ? d.frameH : d.frameW)).toFixed(4)) };
      capture(detection);
    },
    onStatus: (st) => {
      window.__autoWatchStatus = st; // for diagnostics/tests
      $('autoStatus').textContent = st.error ? st.error
        : `Watching the road · ${st.fps.toFixed(1)} checks/s · ${st.vehicles} vehicle${st.vehicles === 1 ? '' : 's'} in view`;
    },
  });
}
function stopAuto() { autoStop?.(); autoStop = null; $('autoStatus').textContent = camOn ? 'Off. Use the capture button, or turn this on.' : 'Starts with the camera.'; }
$('autoWatch').checked = settings.autoWatch !== false;
$('autoWatch').addEventListener('change', (e) => {
  settings.autoWatch = e.target.checked; saveSettings();
  if (e.target.checked) startAuto(); else stopAuto();
});

// ---------------- background: record honest gaps ----------------
// Browsers stop sensors, GPS and camera for pages that are not on screen; nothing in a web
// page can prevent that. Log each gap so reports never present it as continuous data.
let hiddenAt = null;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (hiddenAt == null) return;
  const durationMs = Date.now() - hiddenAt;
  const start = hiddenAt; hiddenAt = null;
  if (recording && durationMs > 2000) {
    const ev = { id: `gap-${start}`, type: 'gap', t: start, durationMs, severity: 'minor', lat: analyzer.snapshot().fix?.lat ?? null, lon: analyzer.snapshot().fix?.lon ?? null };
    analyzer.events.push(ev); onEvent(ev);
    setBanner(`Recording was paused for ${fmtDur(durationMs)} while RideLens was not on screen. Keep it in front during the ride: music apps can keep playing behind it.`);
  }
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
      <span>${r.auto ? '<span class="tag-auto">AUTO</span> ' : ''}${r.plate ? `<span class="plate-tag">${esc(r.plate)}</span>` : '<span class="plate-tag none">NO PLATE</span>'} ${plates.get(r.plate) > 1 ? `<span class="status-pill critical">×${plates.get(r.plate)}</span>` : ''}<br>
      <span class="muted">${esc(r.vehicleType || 'Vehicle')} · ${new Date(r.t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${esc(r.status)}${r.synced ? ' · synced' : ''}</span></span>
      <span class="muted">${r.photos.length} 📷</span>
    </div>`).join('') : '<p class="empty">No reports yet. Tap the red camera button when a vehicle comes at you on the wrong side.</p>';
  $('wsList').onkeydown = (event) => {
    const item = event.target.closest('.item');
    if (item && ['Enter', ' '].includes(event.key)) { event.preventDefault(); item.click(); }
  };
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
  if (!r) return;
  const { vehicle, plate } = r.analysis ?? {};
  const air = r.airQuality;
  const dlg = $('reportDialog');
  let sel = r.keyPhoto || 0;
  const urls = r.photos.map((p) => URL.createObjectURL(p.blob));
  const vt = ['', 'Two-wheeler', 'Car', 'Auto-rickshaw', 'Bus', 'Truck / tempo', 'Tractor', 'Cycle', 'Other'];
  dlg.innerHTML = `<div class="sheet-body">
    <div class="card-head"><h3>Wrong-side report</h3><button class="ghost" data-a="close">Close</button></div>
    <div class="evidence-crop" id="rpCrop">
      <img class="main-photo" id="rpMain" src="${urls[sel]}" alt="Evidence photo">
      <span id="rpBox" hidden aria-hidden="true"></span>
    </div>
    <p class="fine"><a id="rpPhotoLink" href="${urls[sel]}" target="_blank" rel="noopener">Open full-resolution photo</a></p>
    <div class="strip-photos">${urls.map((u, i) => `<img src="${u}" data-i="${i}" class="${i === sel ? 'sel' : ''}" alt="frame ${i + 1}">`).join('')}</div>
    <p class="fine">${new Date(r.t).toLocaleString()} · ${r.lat != null ? `<a href="https://maps.google.com/?q=${r.lat},${r.lon}" target="_blank" rel="noopener">${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}</a> (±${Math.round(r.accuracy || 0)} m)` : 'no GPS fix'}${r.mySpeedKmh != null ? ` · you at ${fmtSpeed(r.mySpeedKmh)} ${speedUnit()}` : ''}</p>
    ${air ? `<p class="fine" data-tone="${airCategory(air.india_aqi).tone}">Air at capture · ${air.us_aqi != null ? `US AQI ${esc(air.us_aqi)}` : `India AQI ${esc(air.india_aqi ?? '—')}`} · Open-Meteo estimate</p>` : ''}
    ${r.analysis ? `<p class="fine">${r.analysis.status === 'pending' ? 'Analysis pending. Reopen to check results.' : r.analysis.status === 'partial' ? 'Some analysis was unavailable. Review the saved photos.' : 'Review automatic suggestions against the photos.'}</p>` : ''}
    ${vehicle ? `<div class="row"><button class="ghost" data-a="vehicle">Use ${esc(vehicle.type)}</button>${vehicle.color ? `<button class="ghost" data-a="color">Use ${esc(vehicle.color)}</button>` : ''}<button class="ghost" data-a="vehicle-frame">Vehicle frame ${vehicle.frame + 1}${vehicle.rider ? ' · possible rider' : ''}</button></div>` : ''}
    ${plate ? `<div class="row"><button class="ghost" data-a="plate">Use ${esc(plate.value)}</button><button class="ghost" data-a="plate-frame">Plate frame ${plate.frame + 1}</button></div>` : ''}
    <div class="row">
      <button class="ghost" data-a="analyse">Reanalyse photos</button>
      <button class="ghost" data-a="crop" aria-pressed="false">Select plate area</button>
    </div>
    <label for="rpPlate">Registration number</label>
    <div>
      <div class="row" style="margin:0"><input id="rpPlate" value="${esc(r.plate)}" placeholder="Enter registration" style="flex:1;text-transform:uppercase"><button class="ghost" data-a="ocr">Read plate</button></div>
      <span id="rpPlateMsg" class="muted" role="status"></span>
    </div>
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
  const collect = async () => {
    const n = normalizePlate($('rpPlate').value);
    const fields = { plate: n.plate, plateValid: n.valid, vehicleType: $('rpType').value, color: $('rpColor').value, status: $('rpStatus').value, notes: $('rpNotes').value, keyPhoto: sel, synced: false };
    const saved = await db.updateReport(r.id, (current) => ({ ...current, ...fields }));
    if (saved) Object.assign(r, saved);
  };
  const photo = $('rpMain');
  const crop = $('rpCrop');
  const box = $('rpBox');
  const cropButton = dlg.querySelector('[data-a="crop"]');
  let region, anchor;
  function toggleCrop(on) {
    cropButton.setAttribute('aria-pressed', String(on));
    crop.classList.toggle('selecting', on);
    if (!on) { anchor = null; region = null; box.hidden = true; }
  }
  function pointer(event) {
    const rect = photo.getBoundingClientRect();
    const scale = Math.min(rect.width / photo.naturalWidth, rect.height / photo.naturalHeight);
    const width = photo.naturalWidth * scale, height = photo.naturalHeight * scale;
    const offsetX = (rect.width - width) / 2, offsetY = (rect.height - height) / 2;
    const clamp = (value) => Math.max(0, Math.min(1, value));
    return { x: clamp((event.clientX - rect.left - offsetX) / width), y: clamp((event.clientY - rect.top - offsetY) / height), offsetX, offsetY, width, height };
  }
  function drawCrop(point) {
    const x = Math.min(anchor.x, point.x), y = Math.min(anchor.y, point.y);
    const w = Math.abs(point.x - anchor.x), h = Math.abs(point.y - anchor.y);
    region = w > 0.006 && h > 0.006 ? [x, y, w, h] : null;
    box.hidden = !region;
    Object.assign(box.style, { left: `${point.offsetX + x * point.width}px`, top: `${point.offsetY + y * point.height}px`,
      width: `${w * point.width}px`, height: `${h * point.height}px` });
  }
  photo.onpointerdown = (event) => {
    if (!crop.classList.contains('selecting') || !photo.naturalWidth) return;
    event.preventDefault();
    anchor = pointer(event);
    region = null; box.hidden = true;
    photo.setPointerCapture(event.pointerId);
  };
  photo.onpointermove = (event) => { if (anchor) drawCrop(pointer(event)); };
  photo.onpointerup = (event) => {
    if (!anchor) return;
    drawCrop(pointer(event)); anchor = null;
    $('rpPlateMsg').textContent = region ? 'Plate area selected. Tap Read plate.' : 'Drag a box around the whole plate.';
    dlg.querySelector('[data-a="ocr"]').scrollIntoView({ block: 'nearest' });
  };
  photo.onpointercancel = () => { anchor = null; };
  function selectFrame(index) {
    if (!urls[index]) return;
    toggleCrop(false);
    sel = index; $('rpMain').src = urls[index]; $('rpPhotoLink').href = urls[index];
    dlg.querySelectorAll('.strip-photos img').forEach((image) => image.classList.toggle('sel', +image.dataset.i === index));
  }
  dlg.onclick = async (e) => {
    const img = e.target.closest('.strip-photos img');
    if (img) { selectFrame(+img.dataset.i); return; }
    const a = e.target.dataset.a;
    if (a === 'vehicle') $('rpType').value = vehicle.type;
    if (a === 'color') $('rpColor').value = vehicle.color;
    if (a === 'plate') { $('rpPlate').value = plate.value; plateMsg(); }
    if (a === 'vehicle-frame') selectFrame(vehicle.frame);
    if (a === 'plate-frame') selectFrame(plate.frame);
    if (a === 'close') dlg.close();
    if (a === 'save') { await collect(); thumbUrls.delete(r.id); toast('Saved'); dlg.close(); renderReports(); }
    if (a === 'del') { if (confirm('Delete this report and its photos?')) { await db.del('reports', r.id); dlg.close(); renderReports(); } }
    if (a === 'crop') {
      const on = !crop.classList.contains('selecting');
      toggleCrop(on);
      $('rpPlateMsg').textContent = on ? 'Drag a box around the whole plate in the photo.' : '';
      if (on) photo.scrollIntoView({ block: 'nearest' });
    }
    if (a === 'ocr' || a === 'analyse') {
      const progress = $('rpPlateMsg');
      const fields = { plate: $('rpPlate'), vehicleType: $('rpType'), color: $('rpColor') };
      const before = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]));
      const buttons = [...dlg.querySelectorAll('[data-a="ocr"], [data-a="analyse"]')];
      buttons.forEach((button) => { button.disabled = true; });
      const frame = sel;
      const selectedRegion = region;
      const update = (m) => { if (m.status) progress.textContent = m.status; };
      progress.textContent = 'Analysing photos on this device…';
      try {
        const analysis = a === 'analyse' ? await analyzeEvidence(r.photos, update)
          : selectedRegion ? { plate: await readPlateCrop(r.photos[frame].blob, selectedRegion, update) }
            : await analyzeEvidence([r.photos[frame]], update);
        if (!progress.isConnected || !dlg.open) return;
        const suggested = { plate: analysis.plate?.value, vehicleType: analysis.vehicle?.type, color: analysis.vehicle?.color };
        const applied = [];
        for (const [key, field] of Object.entries(fields)) {
          if (suggested[key] && field.value === before[key] && (!field.value.trim() || (key === 'plate' && a === 'ocr' && selectedRegion))) {
            field.value = suggested[key];
            applied.push(key === 'vehicleType' ? 'vehicle type' : key);
          }
        }
        progress.textContent = applied.length ? `Filled ${applied.join(', ')}. Review and tap Save.`
          : analysis.plate ? `Read ${analysis.plate.value}. Compare it with the existing entry.`
            : 'No reliable plate read. Try selecting a tighter plate area, another frame, or entering it manually.';
      } catch (err) { progress.textContent = err.message; }
      finally { buttons.forEach((button) => { button.disabled = false; }); }
    }
    if (a === 'share') {
      await collect();
      const text = `Wrong-side driving report\nVehicle: ${r.vehicleType || 'unknown'} ${r.color || ''}\nRegistration: ${r.plate || 'not readable'}\nTime: ${new Date(r.t).toLocaleString()}\nLocation: ${r.lat != null ? `https://maps.google.com/?q=${r.lat},${r.lon}` : 'unknown'}\n${r.notes || ''}`;
      const file = new File([r.photos[sel].blob], `wrongside-${r.plate || r.id}.jpg`, { type: 'image/jpeg' });
      try {
        if (navigator.canShare?.({ files: [file] })) await navigator.share({ text, files: [file] });
        else { await navigator.clipboard?.writeText(text); download(file.name, file); toast('Text copied, photo downloaded'); }
      } catch { /* cancelled */ }
    }
    if (a === 'sync') {
      await collect();
      if (!settings.serverUrl) { toast('Set a server URL in Setup first'); return; }
      try { await syncReport(r, settings); toast('Synced to server'); renderReports(); } catch (err) { toast(err.message, 4000); }
    }
  };
  dlg.addEventListener('close', () => urls.forEach((u) => URL.revokeObjectURL(u)), { once: true });
  dlg.showModal();
}

$('wsCsv').addEventListener('click', async () => download('wrongside-reports.csv', reportsToCsv(await db.all('reports')), 'text/csv'));
$('wsJson').addEventListener('click', async () => {
  const all = await Promise.all((await db.all('reports')).map((r) => reportToJson(r, { photos: 'all' })));
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
// ---------------- trip: destination, target time, live ETA ----------------
let trip = null, tripStopGps = null, tripRouting = false, tripPick = null, tripLine = null, tripPin = null;
const fmtHM = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function targetFromInput(v) {
  if (!v) return null;
  const [h, m] = v.split(':').map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  if (d.getTime() < Date.now() - 60000) d.setDate(d.getDate() + 1); // a time already past means tomorrow
  return d.getTime();
}

function openTripDialog() {
  tripPick = trip ? { ...trip.state.dest } : null;
  $('tripQuery').value = '';
  $('tripResults').innerHTML = '';
  $('tripTime').value = trip?.state.targetT ? new Date(trip.state.targetT).toTimeString().slice(0, 5) : '';
  showPick();
  $('tripDialog').showModal();
  setupTripMap(); showPick();
}
let tripMap = null, tripMapPin = null;
function setupTripMap() {
  if (!L) return;
  const center = tripPick || analyzer.snapshot().fix || trip?.state.lastFix;
  if (!tripMap) {
    tripMap = L.map('tripMap', { zoomControl: true, attributionControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(tripMap);
    tripMap.on('click', (e) => { tripPick = { lat: +e.latlng.lat.toFixed(6), lon: +e.latlng.lng.toFixed(6), name: `Dropped pin ${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}` }; showPick(); });
  }
  tripMap.setView(center ? [center.lat, center.lon] : [20.59, 78.96], center ? 15 : 4);
  setTimeout(() => tripMap.invalidateSize(), 60);
}
function showPick() {
  if (tripMap && tripPick) {
    tripMapPin ??= L.marker([tripPick.lat, tripPick.lon]).addTo(tripMap);
    tripMapPin.setLatLng([tripPick.lat, tripPick.lon]);
    if (!tripMap.getBounds().contains([tripPick.lat, tripPick.lon])) tripMap.setView([tripPick.lat, tripPick.lon], 15);
  }
  $('tripPicked').textContent = tripPick ? `Destination: ${tripPick.name || `${tripPick.lat.toFixed(5)}, ${tripPick.lon.toFixed(5)}`}` : 'No destination chosen.';
  $('tripStart').disabled = !tripPick;
}
async function runTripSearch() {
  const q = $('tripQuery').value.trim();
  if (!q) return;
  const fixNow = analyzer.snapshot().fix || trip?.state.lastFix || null;
  const pick = (p, name) => { tripPick = { lat: p.lat, lon: p.lon, name: name || `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` }; $('tripResults').innerHTML = ''; showPick(); };
  const ll = parseLatLon(q) || parseDms(q);
  if (ll) return pick(ll);
  let pc = parsePlusCode(q, fixNow);
  if (pc?.needsReference) {
    // short Plus Code without GPS: use the locality written after it ("WHX8+2G Bengaluru") as reference
    const locality = q.replace(/[23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{0,3}/i, '').replace(/^[\s,]+/, '').trim();
    if (!locality) { $('tripResults').innerHTML = '<li class="muted">Short Plus Code: add the town after it (e.g. "WHX8+2G Bengaluru"), or allow location.</li>'; return; }
    $('tripResults').innerHTML = `<li class="muted">Finding ${esc(locality)} to complete the Plus Code…</li>`;
    try { const [ref] = await geocode(locality, null); if (ref) pc = parsePlusCode(q, ref); } catch { /* handled below */ }
    if (!pc || pc.needsReference) { $('tripResults').innerHTML = `<li class="muted">Couldn't find "${esc(locality)}" to complete the short Plus Code.</li>`; return; }
  }
  if (pc) return pick(pc, `Plus Code ${q.trim()}`);
  if (looksLikeW3w(q)) {
    if (!settings.w3wKey) { $('tripResults').innerHTML = '<li class="muted">what3words needs an API key (below). Or use a Plus Code or drop a pin on the map.</li>'; return; }
    $('tripResults').innerHTML = '<li class="muted">Looking up what3words…</li>';
    try { const w = await what3words(q, settings.w3wKey); return pick(w, w.name); }
    catch (err) { $('tripResults').innerHTML = `<li class="muted">${esc(err.message)}</li>`; return; }
  }
  $('tripResults').innerHTML = '<li class="muted">Searching…</li>';
  try {
    const near = analyzer.snapshot().fix;
    const res = await geocode(q, near ? { lat: near.lat, lon: near.lon } : null);
    $('tripResults').innerHTML = res.length
      ? res.map((r, i) => `<li><button type="button" data-i="${i}">${esc(r.name)}</button></li>`).join('')
      : '<li class="muted">No places found. Try a different name or paste coordinates.</li>';
    $('tripResults').onclick = (e) => {
      const b = e.target.closest('button[data-i]'); if (!b) return;
      tripPick = res[+b.dataset.i];
      $('tripResults').querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b));
      showPick();
    };
  } catch (err) { $('tripResults').innerHTML = `<li class="muted">${esc(err.message)}</li>`; }
}

function startTrip(dest, targetT) {
  endTrip(true);
  trip = createTrip({ dest, targetT });
  $('tripWaze').href = wazeUrl(dest);
  $('tripGmaps').href = gmapsUrl(dest);
  $('tripDest').textContent = `To ${dest.name || `${dest.lat.toFixed(5)}, ${dest.lon.toFixed(5)}`}`;
  $('tripEmpty').hidden = true; $('tripLive').hidden = false;
  if (liveMap) {
    tripPin = L.circleMarker([dest.lat, dest.lon], { radius: 9, color: '#fff', weight: 3, fillColor: statusColor('critical'), fillOpacity: 1 }).bindTooltip('Destination').addTo(liveMap);
  }
  try {
    tripStopGps = startGps(onTripFix, (e) => { if (e.code === 1) toast('Location permission is needed for the trip ETA', 4000); });
  } catch (e) { toast(e.message, 4000); }
  renderTrip();
}

function endTrip(silent) {
  tripStopGps?.(); tripStopGps = null;
  trip = null;
  tripLine?.remove(); tripPin?.remove(); tripLine = tripPin = null;
  $('tripEmpty').hidden = false; $('tripLive').hidden = true;
  renderTripQuick(null);
  if (!silent) toast('Trip ended');
}

async function onTripFix(t, fix) {
  if (!trip) return;
  const s = Number.isFinite(fix.accuracy) ? fix : { ...fix, accuracy: 50 };
  const needRoute = trip.update(t, s);
  const st = trip.state;
  // reroute: at most every 30 s (shared public server), none once arrived
  if (needRoute && !tripRouting && !st.arrived && Date.now() - st.routedAt > 30000) {
    tripRouting = true;
    try {
      await trip.fetchRoute({ lat: fix.lat, lon: fix.lon });
      trip.update(t, s); // project the current fix onto the new route
      if (liveMap && trip) {
        tripLine?.remove();
        tripLine = L.polyline(trip.state.route.coords.map(([lo, la]) => [la, lo]), { color: getComputedStyle(document.documentElement).getPropertyValue('--series-2').trim(), weight: 4, opacity: 0.8, dashArray: '6 6' }).addTo(liveMap);
        if (!recording) liveMap.fitBounds(tripLine.getBounds(), { padding: [20, 20] });
      }
    } catch { /* status shows routeErr and falls back to straight-line */ }
    tripRouting = false;
  }
  renderTrip();
}

// dashboard-heading shortcut: shows the live ETA so it's visible without scrolling
function renderTripQuick(st, best) {
  const q = $('tripQuick'), t = $('tripQuickText');
  if (!q || !t) return;
  if (!st) { t.textContent = 'Trip ETA'; q.removeAttribute('data-tone'); return; }
  const tone = { early: 'good', 'on-time': 'warning', late: 'critical' }[best?.state];
  t.textContent = st.arrived ? 'Arrived' : best ? `ETA ${fmtHM(best.eta)}${best.slackMin != null ? ` · ${best.slackMin >= 0 ? '+' : ''}${best.slackMin} min` : ''}` : 'ETA …';
  if (tone && !st.arrived) q.dataset.tone = tone; else q.removeAttribute('data-tone');
}

function renderTrip() {
  if (!trip) { renderTripQuick(null); return; }
  const st = trip.status();
  const best = st.paceEta || st.routeEta || st.straightEta;
  renderTripQuick(st, best);
  $('tripEta').textContent = st.arrived ? 'Arrived' : best ? fmtHM(best.eta) : '—';
  $('tripEtaKind').textContent = st.arrived ? '' : st.paceEta ? `at your pace (route time × ${st.paceEta.pace.toFixed(2)})`
    : st.routeEta ? 'route time, no live traffic' : st.straightEta ? 'straight-line estimate' : 'waiting for GPS…';
  $('tripTarget').textContent = st.targetT ? fmtHM(st.targetT) : '—';
  const pill = $('tripState');
  if (st.targetT && best && !st.arrived) {
    const map = { early: ['good', `${best.slackMin} min spare`], 'on-time': ['warning', 'On time'], late: ['critical', `${-best.slackMin} min late`] };
    const [cls, txt] = map[best.state];
    pill.hidden = false; pill.className = `status-pill ${cls}`; pill.textContent = txt;
  } else pill.hidden = true;
  $('tripRemain').textContent = st.remainingKm != null ? fmtDist(st.remainingKm) : '—';
  const need = best?.requiredKmh;
  $('tripNeed').textContent = st.targetT && !st.arrived
    ? (need == null ? 'target time has passed' : `need avg ${fmtSpeed(need)} ${speedUnit()}`) : '';
  $('tripSource').textContent = [
    st.source ? `Source: ${st.source}.` : '',
    st.routeErr ? `Routing unavailable (${st.routeErr}); using fallback.` : '',
  ].filter(Boolean).join(' ');
}
setInterval(renderTrip, 1000);

$('tripSet').addEventListener('click', openTripDialog);
$('tripQuick')?.addEventListener('click', () => {
  if (trip) $('tripCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
  else openTripDialog();
});
$('tripEdit').addEventListener('click', openTripDialog);
$('tripEnd').addEventListener('click', () => endTrip());
$('tripSearch').addEventListener('click', runTripSearch);
$('tripQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runTripSearch(); } });
$('tripStart').addEventListener('click', () => {
  if (!tripPick) return;
  const targetT = targetFromInput($('tripTime').value);
  $('tripDialog').close();
  if (trip && trip.state.dest.lat === tripPick.lat && trip.state.dest.lon === tripPick.lon) { trip.state.targetT = targetT; renderTrip(); return; }
  startTrip(tripPick, targetT);
});

// ---------------- YouTube Music player ----------------
// Four buttons: previous, play, pause, next. The playlist link is set once (saved), after
// which ▶ loads and plays it. Controls the player inside RideLens only: no web page can
// control the separate YouTube Music app.
function renderMusic(st) {
  if (st.notice !== undefined) { if (st.notice) $('ytMsg').textContent = st.notice; else if (/Skipping|Stopped/.test($('ytMsg').textContent)) $('ytMsg').textContent = ''; return; }
  $('ytTitle').textContent = st.title || '';
  for (const id of ['ytPlay', 'mfPlay']) $(id).classList.toggle('on', !!(st.playing || st.buffering));
  for (const id of ['ytPause', 'mfPause']) $(id).classList.toggle('on', !(st.playing || st.buffering));
}
function musicReady() { return !!settings.ytLink; }
// Floating controls hide while the Music card itself is on screen: they would duplicate its
// buttons and cover the YouTube player (YouTube's terms require it to stay unobstructed).
new IntersectionObserver(([e]) => { musicCardVisible = e.isIntersecting; refreshMusicFab(); }, { threshold: 0.15 }).observe($('musicCard'));
function refreshMusicFab() { $('musicFab').hidden = currentView !== 'live' || !musicReady() || musicCardVisible; }
function refreshMusicUi() {
  $('ytSetupLabel').textContent = musicReady() ? 'Change playlist' : 'Set your YouTube Music playlist';
  $('ytSetup').open = !musicReady();
  refreshMusicFab();
  if (!musicReady()) $('ytMsg').textContent = 'Paste a playlist link once below, then use the buttons.';
}
async function startMusic(link = settings.ytLink) {
  if (!link) { $('ytSetup').open = true; $('ytMsg').textContent = 'Paste a YouTube Music link below first.'; return; }
  $('ytFrameWrap').hidden = false;
  try {
    yt ??= createYouTubePlayer('ytPlayer', { onChange: renderMusic });
    if (!yt.loaded || link !== startMusic.current) { $('ytMsg').textContent = 'Loading…'; await yt.load(link); startMusic.current = link; $('ytMsg').textContent = ''; }
    yt.play();
  } catch (e) { $('ytMsg').textContent = e.message; if (!yt?.loaded) $('ytFrameWrap').hidden = true; }
}
$('ytLink').value = settings.ytLink || '';
$('ytLoad').addEventListener('click', () => {
  const link = $('ytLink').value.trim();
  if (!parseYouTubeLink(link)) { $('ytMsg').textContent = "That isn't a YouTube or YouTube Music link."; return; }
  settings.ytLink = link; saveSettings(); refreshMusicUi();
  startMusic(link);
});
$('ytLink').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('ytLoad').click(); } });
for (const id of ['ytPlay', 'mfPlay']) $(id).addEventListener('click', () => startMusic());
for (const id of ['ytPause', 'mfPause']) $(id).addEventListener('click', () => yt?.pause());
for (const id of ['ytNext', 'mfNext']) $(id).addEventListener('click', () => (yt?.loaded ? yt.next() : startMusic()));
for (const id of ['ytPrev', 'mfPrev']) $(id).addEventListener('click', () => (yt?.loaded ? yt.prev() : startMusic()));
refreshMusicUi();

// ---------------- dashcam ----------------
let dashcam = null, pendingLocks = [];
const DC_BITRATE = { 480: 1000000, 720: 2500000, 1080: 4500000 };
function dcOverlay() {
  const sn = analyzer.snapshot();
  const fresh = sn.fix && Date.now() - (sn.fix.t ?? 0) < 5000;
  const spd = fresh && sn.speedSrc !== 'none' ? `${fmtSpeed(sn.speedKmh)} ${speedUnit()}` : `— ${speedUnit()}`;
  return [`${stamp(Date.now())}  ·  ${spd}`, fresh ? `${sn.fix.lat.toFixed(5)}, ${sn.fix.lon.toFixed(5)}  ·  RideLens` : 'GPS —  ·  RideLens'];
}
function startDashcam() {
  if (dashcam || !camOn) return;
  const q = +settings.dcQuality || 720;
  dashcam = new Dashcam({ height: q, bitsPerSecond: DC_BITRATE[q], segmentMs: (+settings.dcSegmentSec || 60) * 1000, /* dcSegmentSec: test-only override */ getOverlay: dcOverlay, onSegment: saveSegment,
    onError: (e) => { $('dcStatus').textContent = `Error: ${e.message}`; } });
  if (!dashcam.supported) { $('dcStatus').textContent = 'This browser cannot record video'; dashcam = null; return; }
  try { dashcam.start($('camVideo')); } catch (e) { $('dcStatus').textContent = e.message; dashcam = null; return; }
  navigator.storage?.persist?.().catch(() => {});
  $('dcStatus').textContent = `● Recording ${dashcam.mime.startsWith('video/mp4') ? 'MP4' : 'WebM'}`;
}
function stopDashcam() { dashcam?.stop(); dashcam = null; $('dcStatus').textContent = settings.dashcam ? 'Starts with the camera' : 'Off'; }

async function saveSegment({ blob, start, end, mime }) {
  const clip = { id: uid(), start, end, mime, size: blob.size, name: fileName(start, mime), locked: false, incidents: [] };
  const sn = analyzer.snapshot();
  if (sn.fix) clip.endFix = { lat: sn.fix.lat, lon: sn.fix.lon };
  const tl = analyzer.timeline.filter((p) => p.t >= start && p.t <= end);
  if (tl.length) clip.maxSpeedKmh = Math.max(...tl.map((p) => p.v));
  for (const inc of pendingLocks) if (start <= inc.t + 30000 && end >= inc.t - 30000) { clip.locked = true; clip.incidents.push(inc.label); }
  pendingLocks = pendingLocks.filter((inc) => Date.now() < inc.t + 30000 + 70000);
  try {
    await db.putKey('clipData', clip.id, blob);
    await db.put('clips', clip);
  } catch (e) { $('dcStatus').textContent = `Storage full or blocked: ${e.message}`; }
  await enforceRetention();
  if (currentView === 'wrongside') renderClips();
}

async function enforceRetention() {
  const clips = await db.all('clips');
  let maxBytes = Infinity;
  try { const est = await navigator.storage.estimate(); maxBytes = Math.max(200e6, (est.quota || 0) * 0.5); } catch {}
  for (const id of retention(clips, Date.now(), { days: +settings.dcDays || 7, maxBytes })) {
    await db.del('clipData', id); await db.del('clips', id);
  }
}

// An incident: lock footage around it and store everything known at that moment.
async function recordIncident(type, info = {}, frames = null) {
  const t = info.t || Date.now();
  const sn = analyzer.snapshot();
  const label = { crash: 'Crash-level impact', fall: 'Bike fell over', brake: 'Emergency braking', wrongside: 'Wrong-side vehicle', manual: 'Manual capture' }[type] || type;
  const inc = {
    id: uid(), t, type, label,
    lat: sn.fix?.lat ?? null, lon: sn.fix?.lon ?? null, heading: sn.fix?.heading ?? null,
    ownSpeedKmh: sn.speedSrc !== 'none' ? Math.round(sn.speedKmh) : null,
    peakG: info.peakG ?? null, reportId: info.reportId ?? null,
    other: info.auto ? { type: info.auto.type, distanceM: info.auto.distanceM, closingKmh: info.auto.closingKmh, oncomingKmh: info.auto.oncomingKmh } : null,
  };
  pendingLocks.push({ t, label });
  const clips = await db.all('clips');
  for (const c of overlapping(clips, t)) { c.locked = true; c.incidents = [...new Set([...(c.incidents || []), label])]; await db.put('clips', c); }
  await db.put('incidents', inc);
  if (type !== 'wrongside' && type !== 'manual') {
    navigator.vibrate?.([200, 100, 200]);
    toast(`${label}: video locked${camOn ? ', reading vehicles in view…' : ''}`, 4000);
  }
  // other vehicle's type / colour / plate from the camera at that moment
  if (camOn && !frames) frames = await camera.burst().catch(() => null);
  if (frames?.length && type !== 'wrongside' && type !== 'manual') {
    analysisQueue = analysisQueue.then(async () => {
      const a = await analyzeEvidence(frames).catch(() => null);
      if (!a) return;
      const cur = await db.get('incidents', inc.id);
      await db.put('incidents', { ...cur, other: { ...(cur.other || {}), type: a.vehicle?.type ?? cur.other?.type ?? null, color: a.vehicle?.color ?? null, plate: a.plate?.value ?? null } , photo: frames.find((f) => f.key)?.blob || frames[0].blob });
      if (currentView === 'wrongside') renderClips();
    }).catch(() => {});
  }
  if (currentView === 'wrongside') renderClips();
}

async function renderClips() {
  const clips = (await db.all('clips')).sort((a, b) => b.start - a.start);
  const incidents = await db.all('incidents');
  const used = clips.reduce((a, c) => a + c.size, 0);
  let quotaTxt = '';
  try { const est = await navigator.storage.estimate(); quotaTxt = ` of about ${(est.quota / 1e9).toFixed(1)} GB this browser allows`; $('dcBar').style.width = `${Math.min(100, (used / (est.quota * 0.5)) * 100)}%`; } catch {}
  $('dcStorage').textContent = `${clips.length} files · ${(used / 1e6).toFixed(0)} MB${quotaTxt} · ${clips.filter((c) => c.locked).length} locked`;
  const byDay = new Map();
  for (const c of clips) { const d = stamp(c.start).slice(0, 10); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(c); }
  const incText = (c) => incidents.filter((i) => i.t >= c.start - 30000 && i.t <= c.end + 30000).map((i) =>
    `${esc(i.label)}${i.ownSpeedKmh != null ? ` · you ${fmtSpeed(i.ownSpeedKmh)} ${speedUnit()}` : ''}${i.peakG ? ` · ${i.peakG} g` : ''}${i.other?.type ? ` · ${esc(i.other.color ? `${i.other.color} ` : '')}${esc(i.other.type)}` : ''}${i.other?.closingKmh ? ` closing ${i.other.closingKmh} km/h` : ''}${i.other?.plate ? ` · ${esc(i.other.plate)}` : ''}`).join('<br>');
  $('dcList').innerHTML = clips.length ? [...byDay].map(([d, cs]) => `<div class="clip-day">${d}</div>` + cs.map((c) => `
    <div class="clip ${c.locked ? 'locked' : ''}" data-id="${c.id}">
      <span><b>${c.locked ? '🔒 ' : ''}${stamp(c.start).slice(11)}–${stamp(c.end).slice(11)}</b> <span class="muted">${(c.size / 1e6).toFixed(1)} MB${c.maxSpeedKmh != null ? ` · max ${fmtSpeed(c.maxSpeedKmh)} ${speedUnit()}` : ''}</span>
        ${c.locked ? `<span class="inc">${incText(c) || esc((c.incidents || []).join(', '))}</span>` : ''}</span>
      <span class="actions"><button class="ghost" data-a="play">Play</button><button class="ghost" data-a="save">Save</button><button class="ghost" data-a="lock">${c.locked ? 'Unlock' : 'Lock'}</button><button class="ghost" data-a="del" aria-label="Delete">✕</button></span>
    </div>`).join('')).join('') : '<p class="empty">No recordings yet. Start the camera with Dashcam on.</p>';
}
$('dcList').addEventListener('click', async (e) => {
  const a = e.target.closest('button[data-a]')?.dataset.a; const id = e.target.closest('.clip')?.dataset.id;
  if (!a || !id) return;
  const clip = await db.get('clips', id);
  if (a === 'lock') { clip.locked = !clip.locked; await db.put('clips', clip); return renderClips(); }
  if (a === 'del') { if (confirm(`Delete ${clip.name}?`)) { await db.del('clipData', id); await db.del('clips', id); renderClips(); } return; }
  const blob = await db.get('clipData', id);
  if (!blob) { toast('Video data missing'); return; }
  if (a === 'play') {
    const dlg = $('clipDialog'), url = URL.createObjectURL(blob);
    dlg.innerHTML = `<div class="sheet-body"><div class="card-head"><h3>${esc(clip.name)}</h3><button class="ghost" id="clipClose">Close</button></div><video class="clip-video" src="${url}" controls playsinline autoplay muted></video></div>`;
    $('clipClose').onclick = () => dlg.close();
    dlg.addEventListener('close', () => URL.revokeObjectURL(url), { once: true });
    dlg.showModal();
  }
  if (a === 'save') {
    const file = new File([blob], clip.name, { type: clip.mime });
    try {
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: clip.name });
      else download(clip.name, file);
    } catch { /* cancelled */ }
  }
});
const bindDc = (id, key, after) => { const el = $(id); if (el.type === 'checkbox') el.checked = settings[key] !== false; else el.value = settings[key];
  el.addEventListener('change', () => { settings[key] = el.type === 'checkbox' ? el.checked : el.value; saveSettings(); after?.(); }); };
bindDc('dcOn', 'dashcam', () => { if (settings.dashcam && camOn) startDashcam(); else stopDashcam(); });
bindDc('dcDays', 'dcDays', () => enforceRetention().then(renderClips));
bindDc('dcQuality', 'dcQuality', () => { if (dashcam) { stopDashcam(); startDashcam(); } });
$('dcStatus').textContent = settings.dashcam ? 'Starts with the camera' : 'Off';

// ---------------- capability check (real, per device) ----------------
async function renderCaps() {
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const perm = async (name) => { try { return (await navigator.permissions.query({ name })).state; } catch { return null; } };
  const geoPerm = await perm('geolocation'), camPerm = await perm('camera');
  const caps = [
    ['Secure page (HTTPS)', window.isSecureContext, window.isSecureContext ? '' : 'Sensors, camera and Bluetooth are blocked on non-HTTPS pages'],
    ['Motion sensors', 'DeviceMotionEvent' in window, ''],
    ['GPS', 'geolocation' in navigator && geoPerm !== 'denied', geoPerm === 'denied' ? 'Permission denied: allow location for this site in browser settings' : ''],
    ['Camera', !!navigator.mediaDevices?.getUserMedia && camPerm !== 'denied', camPerm === 'denied' ? 'Permission denied: allow camera for this site in browser settings' : ''],
    ['Bluetooth LE (OBD)', !!navigator.bluetooth, navigator.bluetooth ? '' : iOS ? 'Not available in any iPhone/iPad browser' : 'Not available in this browser (Chrome on Android supports it)'],
    ['Keep screen awake', 'wakeLock' in navigator, 'wakeLock' in navigator ? '' : 'Set Auto-Lock to "Never" in phone settings while riding'],
    ['Offline storage', 'indexedDB' in window, ''],
    ['Share to apps', !!navigator.share, ''],
  ];
  $('caps').innerHTML = caps.map(([n, ok, note]) => `<li class="${ok ? 'ok' : 'no'}"><span class="status-pill ${ok ? 'good' : ''}">${ok ? 'Yes' : 'No'}</span><span>${n}${note ? `<br><span class="muted">${note}</span>` : ''}</span></li>`).join('');
  const note = $('bleNote');
  if (!navigator.bluetooth) {
    note.hidden = false;
    note.textContent = iOS
      ? 'This browser cannot connect to Bluetooth adapters, and no iPhone browser can. Everything else (GPS, motion, camera, reports) works; engine data needs an Android phone running Chrome.'
      : 'This browser cannot connect to Bluetooth adapters. Open RideLens in Chrome on Android for engine data. Everything else works here.';
    $('bleBtn').disabled = true;
  }
}
renderCaps();
$('permBtn').addEventListener('click', async () => {
  const out = [];
  try { await requestMotionPermission(); out.push('motion ✓'); } catch (e) { out.push(`motion ✗ (${e.message})`); }
  await new Promise((res) => {
    if (!navigator.geolocation) { out.push('location ✗'); res(); return; }
    navigator.geolocation.getCurrentPosition(() => { out.push('location ✓'); res(); }, (e) => { out.push(`location ✗ (${e.message})`); res(); }, { enableHighAccuracy: true, timeout: 15000 });
  });
  try { const st = await navigator.mediaDevices.getUserMedia({ video: true }); st.getTracks().forEach((t) => t.stop()); out.push('camera ✓'); } catch (e) { out.push(`camera ✗ (${e.name})`); }
  toast(out.join(' · '), 5000); renderCaps();
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
