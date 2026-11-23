import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';

const data = await mkdtemp(join(tmpdir(), 'ridelens-browser-'));
const screenshots = process.env.RIDELENS_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });
const server = spawn(process.execPath, ['--input-type=module', '-e', "import { createServer } from './server/server.mjs'; const server = createServer().listen(0, () => console.log('Server listening on ' + server.address().port));"], {
  env: { ...process.env, PORT: '0', DATA_DIR: data }, stdio: ['ignore', 'pipe', 'inherit'],
});
let browser;

// A short changing tone supplies deterministic test input to Chromium's fake microphone.
function microphoneFixture() {
  const rate = 16000;
  const length = rate * 4;
  const wave = Buffer.alloc(44 + length * 2);
  wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4);
  wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(rate, 24); wave.writeUInt32LE(rate * 2, 28);
  wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
  wave.write('data', 36); wave.writeUInt32LE(length * 2, 40);
  for (let sample = 0; sample < length; sample++) {
    const t = sample / rate;
    const gain = Math.pow(10, (-34 + 13 * Math.sin(t * 4.5)) / 20);
    wave.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 350 * t) * gain * 32767), 44 + sample * 2);
  }
  return wave;
}

function mockAirQuality(context) {
  return context.route('https://air-quality-api.open-meteo.com/**', (route) => {
    const params = new URL(route.request().url()).searchParams;
    assert.match(params.get('latitude'), /^-?\d+\.\d{2}$/);
    const now = Date.now() - Date.now() % 3600000;
    const time = Array.from({ length: 24 }, (_, i) => new Date(now - (23 - i) * 3600000).toISOString().slice(0, 16));
    const fixture = { pm2_5: 100, pm10: 75, nitrogen_dioxide: 9, ozone: 120, carbon_monoxide: 365, sulphur_dioxide: 8 };
    const hourly = Object.fromEntries(Object.entries(fixture).map(([key, value]) => [key, Array(24).fill(value)]));
    return route.fulfill({ json: { current: { time: time.at(-1), ...fixture }, hourly: { time, ...hourly } } });
  });
}

try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timed out')), 8000);
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited (${code})`)); });
    server.stdout.on('data', (chunk) => {
      const match = String(chunk).match(/Server listening on (\d+)/i) || String(chunk).match(/localhost:(\d+)/);
      if (match?.[1] && match[1] !== '0') { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const base = `http://localhost:${port}/`;
  const microphone = join(data, "mic.wav");
  await writeFile(microphone, microphoneFixture());
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${microphone}`],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, colorScheme: 'dark',
    geolocation: { latitude: 12.9716, longitude: 77.5946 }, permissions: ['geolocation', 'microphone'],
    serviceWorkers: 'block',
  });
  await mockAirQuality(context);
  await context.addInitScript(() => {
    // The fixture supplies ride fixes while one-shot geolocation still drives weather.
    Geolocation.prototype.watchPosition = () => 1;
    Geolocation.prototype.clearWatch = () => {};
  });
  await context.route(/https:\/\/(?:fonts\.|[^/]*tile\.openstreetmap\.org)/, (route) => route.abort());
  const original = await readFile(new URL('../public/js/app.js', import.meta.url), 'utf8');
  await context.route('**/js/app.js', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: original + '\nwindow.rideHarness = { feedImu, feedGps, feedObd };',
  }));
  const simulator = await readFile(new URL('../test/simulator.js', import.meta.url), 'utf8');
  await context.route('**/__sim.js', (route) => route.fulfill({ contentType: 'text/javascript', body: simulator }));
  let requests = 0;
  let failNext = true;
  await context.route('https://api.open-meteo.com/v1/forecast?*', (route) => {
    requests++;
    const { searchParams } = new URL(route.request().url());
    for (const key of ['latitude', 'longitude']) assert.match(searchParams.get(key), /^-?\d+\.\d{2}$/);
    if (failNext) { failNext = false; return route.fulfill({ status: 503 }); }
    const time = '2026-11-23T09:15';
    return route.fulfill({ json: {
      current: { time, temperature_2m: 23.5, weather_code: 2, precipitation: 0.2, wind_speed_10m: 14, wind_direction_10m: 225, wind_gusts_10m: 27 },
      hourly: { time: ['2026-11-23T09:00'], visibility: [12600], precipitation_probability: [20] },
    } });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => !!window.rideHarness);
  assert.equal(requests, 0);
  await page.getByRole('button', { name: 'Get weather' }).click();
  await page.getByText('Forecast unavailable.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Get weather' }).click();
  await page.getByText('Partly cloudy').waitFor();
  assert.equal(requests, 2);
  await page.getByText('SW · Gusts 27 km/h').waitFor();
  await page.getByRole('button', { name: 'Toggle route perspective' }).click();
  assert.equal(await page.getByRole('button', { name: 'Toggle route perspective' }).getAttribute('aria-pressed'), 'false');
  await page.getByRole('button', { name: 'Toggle route perspective' }).press('Space');
  assert.equal(await page.getByRole('button', { name: 'Toggle route perspective' }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: 'Route map' }).click();
  await page.locator('#liveMap').waitFor();
  await page.getByRole('button', { name: 'Hide ride details' }).click();

  await page.getByRole('button', { name: 'Start ride' }).click();
  await page.evaluate(async () => {
    const { createSimulator } = await import('/__sim.js');
    const harness = window.rideHarness;
    const sim = createSimulator({
      seed: 7, startLat: 12.9716, startLon: 77.5946,
      onGps: harness.feedGps, onImu: harness.feedImu, onObd: harness.feedObd,
    });
    const end = Date.now();
    sim.state.t = end - 18 * 60000;
    while (sim.state.t < end) sim.step(0.02);
  });
  await page.getByRole('button', { name: 'Track air quality' }).click();
  await page.getByText('Poor · Estimate', { exact: false }).waitFor();
  assert.equal(await page.locator('#airStatus').getAttribute('data-tone'), 'danger');
  assert.equal(await page.locator('.metric-visibility').last().getAttribute('data-tone'), 'good');
  await page.getByText('Recorded GPS trace', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Road', exact: true }).click();
  await page.getByText('Last 30 s · m/s²').waitFor();
  await page.getByRole('button', { name: 'Speed', exact: true }).click();
  await page.getByRole('button', { name: 'Enable mic' }).click();
  await page.getByText(/Peak -?\d+ dBFS/).waitFor();
  await page.waitForTimeout(2500); // five half-second microphone samples
  for (const [width, height] of [[320, 700], [375, 812], [390, 844], [768, 1024], [1024, 768], [1440, 900], [844, 390]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `horizontal overflow at ${width} × ${height}`);
    if (height >= 812) {
      const bottom = await page.locator('.cockpit').evaluate((element) => element.getBoundingClientRect().bottom);
      const navTop = await page.locator('#tabbar').evaluate((element) => element.getBoundingClientRect().top);
      assert.ok(bottom <= navTop, `cockpit exceeds the viewport at ${width} × ${height} (${bottom} > ${navTop})`);
    }
    if (screenshots && [390, 1440].includes(width)) {
      await page.screenshot({ path: join(screenshots, `cockpit-${width === 390 ? 'phone' : 'desktop'}.png`), animations: 'disabled' });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Uncalibrated · Add dBA' }).click();
  await page.getByLabel('Meter reading (dBA)').fill('90');
  await page.getByRole('button', { name: 'Apply reading' }).click();
  assert.equal(await page.locator('.cockpit-noise').getAttribute('data-tone'), 'caution');
  await page.getByRole('button', { name: '90 dBA · Elevated · Meter' }).click();
  await page.getByLabel('Meter reading (dBA)').fill('90.1');
  await page.getByRole('button', { name: 'Apply reading' }).click();
  assert.equal(await page.locator('.cockpit-noise').getAttribute('data-tone'), 'danger');
  await page.getByRole('navigation', { name: 'RideLens' }).getByRole('button', { name: 'Setup' }).click();
  await page.locator('#units').selectOption('imperial');
  await page.locator('#theme').selectOption('light');
  await page.getByRole('navigation', { name: 'RideLens' }).getByRole('button', { name: 'Live' }).click();
  await page.getByRole('button', { name: 'Enable mic' }).waitFor();
  await page.getByText('SW · Gusts 17 mph').waitFor();
  await page.getByRole('button', { name: 'Clear weather' }).click();
  await page.getByText('Location needed').waitFor();
  await page.locator('#recBtn').click();
  await page.locator('#view-report.active #reportBody h2').first().waitFor();
  await page.getByRole('navigation', { name: 'RideLens' }).getByRole('button', { name: 'History' }).click();
  await page.locator('#historyList .item').first().waitFor();
  assert.deepEqual(errors, []);

  const evidence = await browser.newContext({
    viewport: { width: 390, height: 844 }, geolocation: { latitude: 12.9716, longitude: 77.5946 },
    permissions: ['camera', 'geolocation'], serviceWorkers: 'block', acceptDownloads: true,
  });
  await mockAirQuality(evidence);
  await evidence.addInitScript(() => {
    window.tf = {};
    window.cocoSsd = { load: async () => ({ detect: async () => [
      { class: 'motorcycle', score: 0.93, bbox: [100, 180, 240, 160] },
      { class: 'person', score: 0.88, bbox: [160, 90, 70, 132] },
    ] }) };
    window.Tesseract = { createWorker: async () => ({
      setParameters: async () => {},
      recognize: async (blob) => {
        if (blob.type !== 'image/png') throw new Error('Expected a processed OCR region');
        return { data: { text: 'KA 01 AB 1234', confidence: 95 } };
      },
    }) };
  });
  const evidencePage = await evidence.newPage();
  evidencePage.on('pageerror', (error) => errors.push(error.message));
  await evidencePage.goto(base);
  await evidencePage.getByRole('region', { name: 'Air pollution' }).getByRole('button', { name: 'Track air quality' }).click();
  await evidencePage.getByText('Poor · Estimate', { exact: false }).waitFor();
  await evidencePage.getByRole('button', { name: 'Wrong-side', exact: true }).click();
  assert.equal(await evidencePage.getByRole('region', { name: 'Air pollution' }).count(), 0);
  await evidencePage.getByRole('button', { name: 'Start camera' }).click();
  await evidencePage.getByRole('button', { name: 'Capture wrong-side vehicle' }).click();
  await evidencePage.waitForFunction(async () => {
    const { db } = await import('/js/db.js');
    return (await db.all('reports')).some((report) => report.analysis?.status === 'complete');
  });
  await evidencePage.locator('#wsList .item').first().click();
  await evidencePage.getByText('Air at capture · India AQI 233', { exact: false }).waitFor();
  assert.equal(await evidencePage.locator('#rpType').inputValue(), 'Two-wheeler');
  assert.equal(await evidencePage.locator('#rpPlate').inputValue(), 'KA01AB1234');
  const color = await evidencePage.evaluate(async () => {
    const { analyzeEvidence } = await import('/js/evidence-analysis.js');
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#c81818';
    ctx.fillRect(0, 0, 640, 480);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg'));
    return (await analyzeEvidence([{ blob }])).vehicle.color;
  });
  assert.equal(color, 'Red');
  await evidencePage.locator('#rpPlate').fill('');
  await evidencePage.getByRole('button', { name: 'Select plate area' }).click();
  const bounds = await evidencePage.locator('#rpMain').boundingBox();
  await evidencePage.mouse.move(bounds.x + bounds.width * 0.37, bounds.y + bounds.height * 0.46);
  await evidencePage.mouse.down();
  await evidencePage.mouse.move(bounds.x + bounds.width * 0.63, bounds.y + bounds.height * 0.55, { steps: 5 });
  await evidencePage.mouse.up();
  await evidencePage.getByText('Plate area selected. Tap Read plate.').waitFor();
  await evidencePage.getByRole('button', { name: 'Read plate' }).click();
  await evidencePage.getByText('Filled plate. Review and tap Save.').waitFor();
  await evidencePage.getByRole('button', { name: 'Save', exact: true }).click();
  const report = await evidencePage.evaluate(async () => {
    const { db } = await import('/js/db.js');
    const [saved] = await db.all('reports');
    return { ...saved, photos: saved.photos.map(({ blob }) => blob.size) };
  });
  assert.equal(report.plate, 'KA01AB1234');
  assert.equal(report.vehicleType, 'Two-wheeler');
  assert.equal(report.analysis.vehicle.rider, true);
  assert.equal(report.lat, 12.9716);
  assert.ok(report.gpsTime);
  assert.ok(report.photos.length >= 4 && report.photos.every((size) => size > 0));
  await evidencePage.getByRole('button', { name: 'Stop camera' }).click();
  await evidencePage.getByRole('button', { name: 'Live', exact: true }).click();
  await evidencePage.getByRole('button', { name: 'Stop tracking' }).click();
  assert.equal(await evidencePage.locator('#airStats').isHidden(), true);
  assert.deepEqual(errors, []);

  const offline = await browser.newContext();
  await offline.route('https://**/*', (route) => route.abort());
  const offlinePage = await offline.newPage();
  await offlinePage.goto(base);
  await offlinePage.evaluate(() => navigator.serviceWorker.ready);
  await offlinePage.waitForFunction(() => !!navigator.serviceWorker.controller);
  await offline.setOffline(true);
  await offlinePage.reload();
  await offlinePage.getByRole('heading', { name: 'Ride dashboard' }).waitFor();
  await offlinePage.getByRole('navigation', { name: 'RideLens' }).getByRole('button', { name: 'Setup' }).click();
  await offlinePage.getByRole('heading', { name: 'OBD-II adapter' }).waitFor();
  console.log('Cockpit browser checks passed, including seven viewports, air quality, evidence capture and offline reload.');
} finally {
  await browser?.close();
  if (server.exitCode == null && !server.killed) { server.kill(); await once(server, 'exit'); }
  await rm(data, { recursive: true, force: true });
}
