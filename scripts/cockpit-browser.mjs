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
  console.log('Cockpit browser checks passed, including seven viewports and offline reload.');
} finally {
  await browser?.close();
  if (server.exitCode == null && !server.killed) { server.kill(); await once(server, 'exit'); }
  await rm(data, { recursive: true, force: true });
}
