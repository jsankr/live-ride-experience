// Navigation layer of the full-screen camera HUD (see nav.js for the logic and data sources).
// Runs only while the full-screen camera is open. Battery: one GPS watch, map tiles for a
// 132 px square, OSM breakers fetched once per route/area, traffic every 2 min with a key.
import {
  nextManeuver, turnText, turnIcon, fmtAhead, createTurnPrompter, hazardsAhead, createHazardAlerter, hazardLabel,
  osmBreakers, bboxAround, mergeSpots, probesAhead, tomtomFlow, worstTraffic, dist, bearing, eventsAhead,
} from './nav.js';
import { startGps } from './sensors.js';
import { createSpeedFilter } from './gps-speed.js';

const ARROW = {
  straight: 'M12 21V5M6 11l6-6 6 6',
  left: 'M18 21v-7a4 4 0 0 0-4-4H5M10 5 5 10l5 5',
  right: 'M6 21v-7a4 4 0 0 1 4-4h9M14 5l5 5-5 5',
  'slight-left': 'M15 21v-6L8 7M8 13V7h6',
  'slight-right': 'M9 21v-6l7-8M16 13V7h-6',
  'sharp-left': 'M17 4v9a3 3 0 0 1-3 3H6M10 11l-5 5 5 5',
  'sharp-right': 'M7 4v9a3 3 0 0 0 3 3h8M14 11l5 5-5 5',
  uturn: 'M16 21V9a5 5 0 0 0-10 0v4M2 10l4 4 4-4',
  roundabout: 'M12 21v-6M12 15a4 4 0 1 0-4-4M8 11V6M5 9l3-3 3 3',
  arrive: 'M12 22s7-7 7-12a7 7 0 0 0-14 0c0 5 7 12 7 12zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
};
const svg = (d, stroke = 'currentColor') => `<svg viewBox="0 0 24 24"><path d="${d}" fill="none" stroke="${stroke}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const BUMP_ICON = svg('M2 18h20M5 18c2-6 12-6 14 0M12 6v4M9 3h6', '#111');
const INCIDENT_ICON = svg('M12 3 2 20h20L12 3zM12 10v4M12 17h.01', '#fff');
const POTHOLE_ICON = svg('M2 14h6l2 4h4l2-4h6M7 9h.01M12 7h.01M17 9h.01', '#111');

export function createNavHud({ L, $, getTrip, getOwnSpots, settings, imperial, fmtHM, fmtDist }) {
  let map = null, tiles = null, routeLine = null, spotLayer = null, stopGps = null, timer = null;
  let fix = null, heading = null, speedKmh = 0, routeRef = null;
  let osm = [], osmKey = '', spots = [], ownLoaded = 0;
  let traffic = null, trafficAt = 0, trafficBusy = false;
  let hazardShown = null, hazardTimer = null;
  const prompt = createTurnPrompter();
  const speedFilter = createSpeedFilter(); // 0 km/h when standing still, not GPS wander
  const alert = createHazardAlerter();
  // accidents, closures and road works need more warning than a pothole: ~20 s, never under 250 m
  const incidentAlert = createHazardAlerter({ seconds: 20, minM: 250 });
  const jamSaid = new Set();

  const say = (text, priority = false) => {
    if (!text || settings.navVoice === false || !window.speechSynthesis) return;
    try {
      if (priority) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = navigator.language?.startsWith('en') ? navigator.language : 'en-IN';
      u.rate = 1.05;
      speechSynthesis.speak(u);
    } catch { /* no speech on this browser */ }
  };

  function ensureMap() {
    if (map || !L) return;
    map = L.map($('hudMap'), { zoomControl: false, attributionControl: true, dragging: false, touchZoom: false, scrollWheelZoom: false,
      doubleClickZoom: false, boxZoom: false, keyboard: false, inertia: false, fadeAnimation: false, zoomAnimation: false, markerZoomAnimation: false });
    map.attributionControl.setPrefix(false);
    tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap', keepBuffer: 1 }).addTo(map);
    spotLayer = L.layerGroup().addTo(map);
    map.setView([13.0827, 80.2707], 16);
  }

  async function refreshSpots(force = false) {
    if (force || Date.now() - ownLoaded > 5 * 60000) {
      ownLoaded = Date.now();
      try { spots = mergeSpots(await getOwnSpots(), osm); } catch { spots = mergeSpots([], osm); }
      drawSpots();
    }
  }
  function drawSpots() {
    if (!spotLayer) return;
    spotLayer.clearLayers();
    for (const s of spots) {
      if (fix && dist(fix, s) > 3000) continue;
      L.marker([s.lat, s.lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: '', html: `<div class="hud-hz-dot ${s.type}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }) }).addTo(spotLayer);
    }
  }
  // OpenStreetMap breakers: along the trip's route (up to 60 km), else 2.5 km around us
  async function refreshOsm(route) {
    let key, bbox;
    if (route && route.cum.at(-1) <= 60000) { bbox = bboxAround(route.coords.map(([lon, lat]) => ({ lat, lon })), 60); key = `r${bbox.map((v) => v.toFixed(2)).join(',')}`; } // stable across 3-minute re-routes
    else if (fix) { key = `a${(fix.lat * 50).toFixed(0)}|${(fix.lon * 50).toFixed(0)}`; bbox = bboxAround([fix], 2500); }
    if (!key || key === osmKey) return;
    osmKey = key;
    try { osm = await osmBreakers(bbox); await refreshSpots(true); } catch { osmKey = ''; /* offline or busy: retried on the next change */ }
  }

  async function refreshTraffic(route, travelled) {
    if (!settings.tomtomKey || !route || route.live || travelled == null || trafficBusy || Date.now() - trafficAt < 120000) return;
    trafficBusy = true; trafficAt = Date.now();
    try {
      const samples = [];
      for (const p of probesAhead(route, travelled)) {
        try { samples.push({ ...(await tomtomFlow(p, settings.tomtomKey)), ahead: p.ahead, at: travelled + p.ahead }); }
        catch (e) { if (/rejected/.test(e.message)) { traffic = { error: 'Traffic key rejected' }; return; } }
      }
      const w = worstTraffic(samples);
      traffic = w ? { ...w, at: w.ahead + travelled } : samples.length ? null : { error: 'Traffic unavailable' };
    } finally { trafficBusy = false; }
  }

  function onFix(t, f) {
    if (!(f.accuracy < 80)) { speedFilter(t, f); return; } // still let it see the fix, it ignores vague ones
    const prev = fix;
    const v = speedFilter(t, f).speed;
    speedKmh = v * 3.6;
    // heading only while moving (a standing phone's heading wanders)
    if (Number.isFinite(f.heading) && f.heading >= 0 && v > 1.5) heading = f.heading;
    else if (prev && dist(prev, f) > 6 && v > 1.5) heading = bearing(prev, f);
    fix = { ...f, t };
    update();
  }

  function update() {
    if (!map || !fix) return;
    const z = speedKmh < 25 ? 17 : speedKmh < 55 ? 16 : 15;
    map.setView([fix.lat, fix.lon], z, { animate: false });
    if (heading != null) $('hudMap').style.transform = `rotate(${-heading}deg)`;

    const trip = getTrip();
    const route = trip?.state.route?.cum ? trip.state.route : null;
    const st = trip?.status();
    const travelled = st?.travelledM ?? null;
    if (route !== routeRef) {
      routeRef = route;
      routeLine?.remove(); routeLine = null;
      if (route) routeLine = L.polyline(route.coords.map(([lo, la]) => [la, lo]), { color: '#2a8cff', weight: 6, opacity: 0.9, interactive: false }).addTo(map);
      traffic = null; trafficAt = 0;
    }
    refreshOsm(route); refreshSpots();

    // next turn
    const next = route && travelled != null && !st.arrived ? nextManeuver(route.maneuvers || [], travelled) : null;
    $('hudTurn').hidden = !next;
    if (next) {
      $('hudTurnIcon').innerHTML = svg(ARROW[turnIcon(next)] || ARROW.straight);
      $('hudTurnDist').textContent = fmtAhead(next.inM, imperial());
      $('hudTurnName').textContent = next.name || turnText(next);
      say(prompt(next, speedKmh));
    }
    // ETA
    const best = st && (st.paceEta || st.routeEta || st.straightEta);
    $('hudEta').hidden = !(trip && (best || st?.arrived));
    if (trip) {
      $('hudEtaTime').textContent = st.arrived ? 'Arrived' : best ? fmtHM(best.eta) : '';
      const mins = best ? Math.max(0, Math.round((best.eta - Date.now()) / 60000)) : null;
      $('hudEtaRest').textContent = st.arrived ? '' : [st.remainingKm != null ? fmtDist(st.remainingKm) : '', mins != null ? (mins < 1 ? '<1 min' : `${mins} min`) : ''].filter(Boolean).join(' · ');
    }
    // traffic ahead (a slow stretch we have already ridden through is dropped and re-checked)
    if (traffic && !traffic.error && travelled != null && traffic.at - travelled < -50) { traffic = null; trafficAt = 0; }
    refreshTraffic(route, travelled);
    const tr = $('hudTraffic');
    if (route?.live && travelled != null) { // TomTom route: the traffic events on it
      const evs = eventsAhead(route, travelled);
      const e = evs[0];
      tr.hidden = !!st.arrived; tr.removeAttribute('data-level');
      if (!e) { tr.dataset.level = 'free'; tr.textContent = 'Traffic clear to destination'; }
      else {
        tr.dataset.level = e.kind === 'jam' ? (e.magnitude >= 3 || e.speedKmh <= 10 ? 'jam' : e.magnitude >= 2 ? 'heavy' : 'slow') : 'heavy';
        const where = e.inM <= 30 ? 'here' : `in ${fmtAhead(e.inM, imperial())}`;
        tr.textContent = `${e.label} ${where}${e.speedKmh != null && e.kind === 'jam' ? ` · ${e.speedKmh} km/h` : ''}${e.delayS >= 60 ? ` · +${Math.round(e.delayS / 60)} min` : ''}${evs.length > 1 ? ` (+${evs.length - 1} more)` : ''}`;
        if (e.kind === 'jam' && e.magnitude >= 2 && e.inM <= 1000 && !jamSaid.has(e.id)) { jamSaid.add(e.id); say(`Heavy traffic ahead, ${fmtAhead(e.inM, imperial())}`); }
      }
    }
    const show = trip && !st.arrived && traffic && !route?.live;
    if (!route?.live) tr.hidden = !show;
    if (show) {
      if (traffic.error) { tr.textContent = traffic.error; tr.removeAttribute('data-level'); }
      else {
        const inM = traffic.at - (travelled ?? 0);
        tr.dataset.level = traffic.level;
        tr.textContent = traffic.level === 'free' ? 'Traffic clear ahead'
          : inM <= 50 ? `${traffic.label} traffic · ${traffic.currentKmh} km/h`
          : `${traffic.label} traffic in ${fmtAhead(inM, imperial())} · ${traffic.currentKmh} km/h`;
      }
    }
    // accidents, closures, road works on the live route: earlier warning than potholes
    const incidents = route?.live && travelled != null ? eventsAhead(route, travelled, 3000).filter((e) => e.alert)
      .map((e) => ({ spot: { type: 'incident', label: e.label, lat: e.lat, lon: e.lon, kind: e.kind }, ahead: e.inM })) : [];
    const inc = incidentAlert(incidents, speedKmh);
    // potholes and breakers coming up
    const ahead = [...hazardsAhead(spots, { fix, heading, route, travelled, lookM: 800 }), ...incidents].sort((a, b) => a.ahead - b.ahead);
    const fresh = inc || alert(ahead.filter((h) => h.spot.type !== 'incident'), speedKmh);
    if (fresh) {
      hazardShown = fresh.spot;
      navigator.vibrate?.([120, 60, 120]);
      say(`${hazardLabel(fresh.spot)} ahead, ${fmtAhead(fresh.ahead, imperial())}`, true);
    }
    // same spot by type and place (incident entries are rebuilt on every update)
    const cur = hazardShown && ahead.find((h) => h.spot.type === hazardShown.type && h.spot.lat === hazardShown.lat && h.spot.lon === hazardShown.lon);
    const box = $('hudHazard');
    if (cur) {
      box.hidden = false; box.className = `hud-hazard ${cur.spot.type}`;
      $('hudHazardIcon').innerHTML = cur.spot.type === 'incident' ? INCIDENT_ICON : cur.spot.type === 'pothole' ? POTHOLE_ICON : BUMP_ICON;
      $('hudHazardText').textContent = hazardLabel(cur.spot) + (cur.spot.type === 'incident' || cur.spot.source === 'osm' ? '' : cur.spot.rides > 1 ? ` · hit on ${cur.spot.rides} rides` : '');
      $('hudHazardDist').textContent = fmtAhead(cur.ahead, imperial());
      clearTimeout(hazardTimer); hazardTimer = setTimeout(() => { box.hidden = true; hazardShown = null; }, 6000);
    } else if (hazardShown) { box.hidden = true; hazardShown = null; } // passed it
  }

  return {
    // our speed from the navigation GPS, when no ride is being recorded to supply it
    get speedKmh() { return fix && Date.now() - fix.t < 5000 ? speedKmh : null; },
    get fix() { return fix && Date.now() - fix.t < 5000 ? fix : null; },
    start() {
      if (settings.navHud === false || stopGps) return;
      $('hudNav').hidden = false;
      ensureMap();
      requestAnimationFrame(() => map?.invalidateSize());
      refreshSpots(true);
      try { stopGps = startGps(onFix, () => {}); } catch { /* no geolocation */ }
      timer = setInterval(update, 1000); // ETA and countdowns tick between GPS fixes
    },
    stop() {
      stopGps?.(); stopGps = null; clearInterval(timer); timer = null;
      $('hudNav').hidden = true; $('hudHazard').hidden = true; hazardShown = null;
      try { window.speechSynthesis?.cancel(); } catch {}
    },
  };
}
