import { airCategory, airCell, loadAirQuality } from './air-quality.js';
import { startGps } from './sensors.js';

const fresh = (fix, t) => fix && Math.abs(fix.t - t) <= 15000;

export function setupEvidenceLocation(getRideFix) {
  const toggle = document.getElementById('airToggle');
  const status = document.getElementById('airStatus');
  const stats = document.getElementById('airStats');
  let camera = false, tracking = false, fix, stopWatch, reading, request, lastAttempt = 0;

  function bestFix(t) {
    return [fix, getRideFix()].filter((point) => fresh(point, t)).sort((a, b) => b.t - a.t)[0] ?? null;
  }

  async function refresh(point) {
    if (!tracking || !point || request || document.hidden) return;
    const cell = airCell(point);
    if (Date.now() - lastAttempt < (reading?.cell === cell ? 600000 : 60000)) return;
    lastAttempt = Date.now();
    const controller = new AbortController();
    request = controller;
    const timer = setTimeout(() => controller.abort(), 10000);
    status.textContent = 'Updating air quality…';
    try {
      const data = await loadAirQuality(cell, controller.signal);
      if (request !== controller) return;
      reading = { ...data, cell };
      status.textContent = `${airCategory(data.us_aqi)} · Estimate for ${new Date(data.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
      const rows = [['US AQI', data.us_aqi], ['PM₂.₅', data.pm2_5], ['PM₁₀', data.pm10], ['NO₂', data.nitrogen_dioxide], ['Ozone', data.ozone]];
      stats.innerHTML = rows.map(([label, value], i) => `<span><b>${value == null ? '—' : Math.round(value)}</b>${label}${i ? ' µg/m³' : ''}</span>`).join('');
      stats.hidden = false;
    } catch {
      if (request === controller) status.textContent = reading ? 'Update unavailable. Showing the last estimate.' : 'Air quality unavailable. Retrying when online.';
    } finally {
      clearTimeout(timer);
      if (request === controller) request = null;
    }
  }

  function updateWatch() {
    if (!camera && !tracking) {
      stopWatch?.();
      stopWatch = null;
      fix = null;
      return;
    }
    if (stopWatch) return;
    try {
      stopWatch = startGps((t, point) => {
        fix = { ...point, t };
        refresh(fix);
      }, (error) => {
        if (tracking && !reading) status.textContent = error.code === 1 ? 'Allow location access to track air quality.' : 'Waiting for GPS.';
      });
    } catch { if (tracking) status.textContent = 'Location unavailable in this browser.'; }
  }

  setInterval(() => {
    if (tracking) refresh(bestFix(Date.now()) ?? (fix?.t > Date.now() - 15 * 60000 ? fix : null));
  }, 60000);

  toggle.addEventListener('click', () => {
    tracking = !tracking;
    toggle.textContent = tracking ? 'Stop tracking' : 'Track air quality';
    toggle.setAttribute('aria-pressed', String(tracking));
    if (tracking) {
      status.textContent = 'Waiting for GPS…';
      lastAttempt = 0;
      refresh(bestFix(Date.now()));
    } else {
      request?.abort();
      request = null;
      reading = null;
      stats.hidden = true;
      status.textContent = 'Hourly estimate. Tracking shares approximate coordinates.';
    }
    updateWatch();
  });

  return {
    camera(on) { camera = on; updateWatch(); },
    snapshot: () => reading,
    fixAt(t) {
      const recent = bestFix(t);
      if (recent || !navigator.geolocation) return Promise.resolve(recent);
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 3500);
        navigator.geolocation.getCurrentPosition(({ coords, timestamp }) => {
          clearTimeout(timer);
          const point = { lat: coords.latitude, lon: coords.longitude, accuracy: coords.accuracy, heading: coords.heading, t: timestamp };
          resolve(fresh(point, t) ? point : null);
        }, () => { clearTimeout(timer); resolve(null); }, { enableHighAccuracy: true, timeout: 3000, maximumAge: 5000 });
      });
    },
  };
}
