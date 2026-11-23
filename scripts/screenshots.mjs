// Screenshot harness (dev only; needs Playwright + Chromium): node scripts/screenshots.mjs [outDir]
// ALL READINGS ARE SIMULATED. Wrong-side photos are drawn placeholders stamped "SAMPLE IMAGE".
// Screenshot harness: drives the real RideLens UI with test/simulator.js.
// The only change to the app is a harness-only hook appended to app.js at serve time,
// exposing the same feed functions the real sensor/OBD plumbing calls.
import { createRequire } from 'node:module'; const { chromium } = createRequire(import.meta.url)('playwright');
import { readFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';

import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const OUT = process.argv[2] || `${REPO}/docs/screenshots`;
mkdirSync(OUT, { recursive: true });
const PORT = 8099;
const server = spawn('node', ['server/server.mjs'], { cwd: REPO, env: { ...process.env, PORT: String(PORT), DATA_DIR: `${tmpdir()}/ridelens-shots-${process.pid}` }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1200));
const BASE = `http://localhost:${PORT}/`;

const HOOK = `
;window.__h = { feedImu, feedGps, feedObd, startRide, stopRide, show,
  setElm: (v) => { elm = v; }, get analyzer() { return analyzer; }, get recording() { return recording; },
  renderHistory, renderReports };`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'en-IN', timezoneId: 'Asia/Kolkata' });
await ctx.addInitScript(() => {
  // no real GPS in the harness: the simulator supplies fixes through feedGps
  Geolocation.prototype.watchPosition = () => 1;
  Geolocation.prototype.clearWatch = () => {};
  try { localStorage.setItem('ridelens.settings', JSON.stringify({ theme: 'dark', units: 'metric' })); } catch {}
});
await ctx.route('**/js/app.js', async (route) => {
  const res = await route.fetch();
  route.fulfill({ response: res, body: (await res.text()) + HOOK, headers: { ...res.headers(), 'content-type': 'text/javascript' } });
});
await ctx.route('**/__sim.js', (route) => route.fulfill({ body: readFileSync(`${REPO}/test/simulator.js`, 'utf8'), contentType: 'text/javascript' }));
await ctx.route('**/sw.js', (route) => route.fulfill({ status: 404, body: '' }));

const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.goto(BASE);
await page.waitForFunction(() => window.__h);

// helpers inside the page
await page.evaluate(() => {
  window.__sim = async ({ seed, minutes, endAt, startLat = 12.9716, startLon = 77.5946, keepRunning = false, obd = true }) => {
    const { createSimulator } = await import('/__sim.js');
    const h = window.__h;
    h.setElm(obd ? { close() {} } : null);
    await h.startRide();
    const sim = createSimulator({ seed, startLat, startLon,
      onImu: (t, a, g) => h.feedImu(t, a, g), onGps: (t, f) => h.feedGps(t, f), onObd: obd ? (t, d) => h.feedObd(t, d) : null });
    sim.state.t = endAt - minutes * 60000;
    const dt = 0.02;
    while (sim.state.t < endAt) { for (let i = 0; i < 3000 && sim.state.t < endAt; i++) sim.step(dt); await new Promise((r) => setTimeout(r)); }
    if (keepRunning) { window.__live = setInterval(() => { while (sim.state.t < Date.now()) sim.step(dt); }, 16); }
    return sim.truth;
  };
});

const DAY = 86400000, now = Date.now();
// past rides for History (different days, lengths, seeds)
for (const [seed, minutes, daysAgo] of [[11, 22, 6], [23, 14, 4], [5, 31, 2], [41, 9, 1]]) {
  await page.evaluate(async (a) => { await window.__sim(a); await window.__h.stopRide(); }, { seed, minutes, endAt: now - daysAgo * DAY + 9 * 3600000 });
}

// wrong-side reports with clearly-labelled illustrative photos
await page.evaluate(async () => {
  const { db, uid } = await import('/js/db.js');
  const track = window.__h.analyzer.track;
  const photo = async (veh, plate, hue) => {
    const c = document.createElement('canvas'); c.width = 960; c.height = 540; const g = c.getContext('2d');
    const sky = g.createLinearGradient(0, 0, 0, 540); sky.addColorStop(0, '#9db8cf'); sky.addColorStop(0.45, '#d9e2e8'); sky.addColorStop(0.46, '#5b5d60'); sky.addColorStop(1, '#3b3c3e');
    g.fillStyle = sky; g.fillRect(0, 0, 960, 540);
    g.fillStyle = '#e8e6df'; for (let i = 0; i < 6; i++) g.fillRect(470 - i * 4, 300 + i * 40, 20 + i * 8, 22);
    g.fillStyle = `hsl(${hue} 45% 45%)`; g.beginPath(); g.roundRect(300, 250, 360, 200, 28); g.fill();
    g.fillStyle = '#20262c'; g.beginPath(); g.roundRect(340, 270, 280, 80, 14); g.fill();
    g.fillStyle = '#111'; g.fillRect(320, 440, 60, 30); g.fillRect(580, 440, 60, 30);
    g.fillStyle = '#fffbe6'; g.fillRect(320, 380, 60, 24); g.fillRect(580, 380, 60, 24);
    g.fillStyle = '#f6d94a'; g.fillRect(400, 400, 160, 36); g.strokeStyle = '#000'; g.lineWidth = 3; g.strokeRect(400, 400, 160, 36);
    g.fillStyle = '#000'; g.font = 'bold 22px monospace'; g.textAlign = 'center'; g.fillText(plate, 480, 426);
    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, 0, 960, 40); g.fillStyle = '#fff'; g.font = '600 18px system-ui'; g.textAlign = 'left';
    g.fillText(`SAMPLE IMAGE · illustrative ${veh.toLowerCase()} · not a real capture`, 16, 27);
    return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  };
  const reps = [
    ['Car', 'KA01AB1234', 210, 'verified', 'white'], ['Two-wheeler', 'KA05MN4421', 10, 'new', 'red'],
    ['Auto-rickshaw', 'KA01AB1234', 50, 'submitted to police', 'yellow'], ['Car', '', 120, 'new', 'grey'],
  ];
  for (const [i, [veh, plate, hue, status, color]] of reps.entries()) {
    const p = track[Math.floor((track.length * (i + 1)) / 5)] || {};
    const blobs = [];
    for (let k = 0; k < 4; k++) blobs.push(await photo(veh, plate || '— — — —', hue + k * 2));
    await db.put('reports', { id: uid(), t: Date.now() - (i + 1) * 3.1 * 86400000, rideId: null, lat: p.lat ?? null, lon: p.lon ?? null, accuracy: 6, heading: null, mySpeedKmh: 38 + i * 7,
      photos: blobs.map((b, k) => ({ t: Date.now(), blob: b, key: k === 1 })), keyPhoto: 1,
      vehicleType: veh, plate, plateValid: !!plate, color, notes: '', violation: 'wrong-side', status, synced: status !== 'new' });
  }
});

// the live ride: 26 simulated minutes, then keep streaming in real time
await page.evaluate(async (a) => { await window.__sim(a); }, { seed: 7, minutes: 26, endAt: Date.now(), keepRunning: true });
await page.evaluate(() => window.__h.show('live'));
await page.waitForTimeout(32000); // fill the 30 s strip charts
const niceMoment = () => page.waitForFunction(() => { const s = window.__h.analyzer.snapshot(); return s.speedKmh > 40 && Math.abs(s.lean) > 10 && s.obd.fresh && s.gear; }, null, { timeout: 90000, polling: 100 }).catch(() => console.warn('no ideal moment; shooting anyway'));

const shot = async (name, opts = {}) => {
  // full-page captures: fixed chrome (tab bar, FAB) would be painted mid-page, so hide it for those only
  if (opts.fullPage) await page.addStyleTag({ content: '.tabbar,.fab{display:none!important}', }).then((h) => h.evaluate((el) => el.id = '__hide'));
  await page.screenshot({ path: `${OUT}/${name}.png`, ...opts });
  if (opts.fullPage) await page.evaluate(() => document.getElementById('__hide')?.remove());
};
await niceMoment(); await shot('live-phone-dark');
await shot('live-phone-dark-full', { fullPage: true });
await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(600);
await niceMoment(); await shot('live-desktop-dark');
await page.evaluate(() => { const s = document.getElementById('theme'); s.value = 'light'; s.dispatchEvent(new Event('change', { bubbles: true })); s.dispatchEvent(new Event('input', { bubbles: true })); });
await page.waitForTimeout(800); await niceMoment(); await shot('live-desktop-light');
await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(600);
await niceMoment(); await shot('live-phone-light');
await page.evaluate(() => { const s = document.getElementById('theme'); s.value = 'dark'; s.dispatchEvent(new Event('change', { bubbles: true })); s.dispatchEvent(new Event('input', { bubbles: true })); });

// finish the ride -> report
await page.evaluate(async () => { clearInterval(window.__live); await window.__h.stopRide(); });
await page.waitForTimeout(2500);
await shot('report-phone-dark', { fullPage: true });
await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(1500);
await shot('report-desktop-dark', { fullPage: true });
await page.setViewportSize({ width: 390, height: 844 });

await page.evaluate(() => window.__h.show('history')); await page.waitForTimeout(800);
await shot('history-phone-dark');
await page.evaluate(() => window.__h.show('wrongside')); await page.waitForTimeout(2500);
await shot('wrongside-phone-dark', { fullPage: true });
await page.locator('#wsList .item').first().click(); await page.waitForTimeout(800);
await shot('wrongside-report-sheet');
await page.keyboard.press('Escape');
await page.evaluate(() => window.__h.show('setup')); await page.waitForTimeout(800);
await shot('setup-phone-dark', { fullPage: true });

// phone-only ride (no OBD adapter): shows what a rider without an adapter sees
await page.evaluate(async (a) => { await window.__sim(a); }, { seed: 19, minutes: 12, endAt: Date.now(), keepRunning: true, obd: false });
await page.evaluate(() => window.__h.show('live'));
await page.waitForTimeout(32000);
await page.waitForFunction(() => { const s = window.__h.analyzer.snapshot(); return s.speedKmh > 35 && Math.abs(s.lean) > 8; }, null, { timeout: 90000, polling: 100 }).catch(() => {});
await shot('live-phone-no-obd');
await page.evaluate(async () => { clearInterval(window.__live); });

await browser.close(); server.kill();
console.log('done');
