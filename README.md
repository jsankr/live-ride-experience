# RideLens: live motorcycle ride analytics

A phone-first PWA (Progressive Web App) that captures every ride live and turns it into a coaching-grade report: potholes, bumps, road roughness, braking, acceleration, jerk, lean angle, g-force, altitude, gear and clutch timing, and engine temperatures. It also includes a **wrong-side vehicle reporter**, which captures photos, plate, location and time into a database.

## Screenshots

> **All readings below are simulated.** The app has no demo mode, so these were made by `scripts/screenshots.mjs`. It streams `test/simulator.js` (phone IMU, GPS and an OBD-II ECU) through the app's real sensor-fusion and event-detection code. The wrong-side "photos" are drawn placeholders stamped *SAMPLE IMAGE*. The simulator is deliberately rough (many potholes and hard brakes), so its ride scores are lower than a typical ride's. Regenerate with `node scripts/screenshots.mjs` (needs Playwright + Chromium).

<p align="center"><img src="docs/screenshots/overview-phone.png" alt="Phone: live dark, live light, ride history, wrong-side report" width="100%"></p>

### Live cockpit
Speed with an rpm arc, gear and clutch from OBD; lean angle and the G-G friction circle from gyro and GPS; coolant, throttle, altitude, distance, road comfort (ISO 2631 bands) and a live ride score; 30-second strip charts for road shock, braking/acceleration and rpm; an event feed and a live map.

| Desktop · dark | Desktop · light |
|---|---|
| <img src="docs/screenshots/live-desktop-dark.png" alt="Live view, desktop, dark"> | <img src="docs/screenshots/live-desktop-light.png" alt="Live view, desktop, light"> |

| Phone · dark | Phone · light | Phone · full page |
|---|---|---|
| <img src="docs/screenshots/live-phone-dark.png" alt="Live view, phone, dark" width="260"> | <img src="docs/screenshots/live-phone-light.png" alt="Live view, phone, light" width="260"> | <img src="docs/screenshots/live-phone-dark-full.png" alt="Live view, phone, full page" width="260"> |

### Ride report
Heuristic score and summary stats, insights, a route map coloured by road comfort with every event pinned, then speed, braking, roughness, elevation, lean, rpm and clutch-time charts, event breakdown, learned gear ratios and the full event log. Exports to JSON, CSV and GPX.

| Desktop | Phone |
|---|---|
| <img src="docs/screenshots/report-desktop-dark.png" alt="Ride report, desktop"> | <img src="docs/screenshots/report-phone-dark.png" alt="Ride report, phone" width="300"> |

### History, wrong-side reporter, setup
| Ride history | Wrong-side reports | Report sheet | Setup |
|---|---|---|---|
| <img src="docs/screenshots/history-phone-dark.png" alt="Ride history" width="200"> | <img src="docs/screenshots/wrongside-phone-dark.png" alt="Wrong-side reports" width="200"> | <img src="docs/screenshots/wrongside-report-sheet.png" alt="Wrong-side report sheet" width="200"> | <img src="docs/screenshots/setup-phone-dark.png" alt="Setup" width="200"> |

## Run it on your phone (no laptop)
RideLens runs entirely in the phone's browser. Rides and reports are stored on the phone (IndexedDB) and it keeps working offline once loaded.

1. **Host it once over HTTPS** (phones only allow sensors, camera and Bluetooth on HTTPS pages). `.github/workflows/pages.yml` publishes `public/` to GitHub Pages on every push to `main`:
   - Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
   - GitHub Pages on a *private* repo requires a paid GitHub plan; on the free plan the repo must be public. Your ride data is never in the repo.
   - Your URL: `https://<user>.github.io/live-ride-experience/` (this repo: **https://jsankr.github.io/live-ride-experience/**)
   - **Seeing this README instead of the app?** Pages is still set to *Deploy from a branch*, which renders the repo root with Jekyll. Switch the Source to *GitHub Actions* and re-run **Actions → Test and publish**. Until then, the root `index.html` redirects to `public/`, so the app still opens.
2. Open the URL on the phone → **Setup** → *Grant motion, location & camera*. The *This phone & browser* card shows what works on that exact device.
3. Optional: add to home screen (Chrome: ⋮ → *Add to Home screen*; Safari: Share → *Add to Home Screen*).
4. Mount the phone, tap **Start ride**, keep the screen on and RideLens in front.

### What each browser can do
| | Chrome (Android) | Firefox (Android) | Safari / any iPhone browser |
|---|---|---|---|
| GPS, motion sensors, lean, potholes, braking, maps, reports | ✓ | ✓ | ✓ (asks for Motion permission) |
| Wrong-side camera capture | ✓ | ✓ | ✓ |
| **OBD-II over Bluetooth LE** (rpm, gear, clutch, coolant) | ✓ | ✗ no Web Bluetooth | ✗ no Web Bluetooth |

These are browser-engine limits, not app limits. Engine data needs **Chrome on Android**. Every browser stops delivering sensor data when the screen is off or the app is in the background.

The browser matrix above comes from published Web Bluetooth support; the app itself has been tested only in Chromium (including iPhone-size emulation), not on a physical phone or in Firefox/Safari engines.

### Developer use (optional)
```
npm start            # local server on http://localhost:8080 (Node ≥ 22.5), also the optional report DB + Wi-Fi OBD bridge
npm test             # 21 tests: detectors vs simulator ground truth, OBD parser, server, Wi-Fi bridge
```

**No synthetic data in the app.** Every number on screen comes from your phone's sensors or the bike's ECU. There is no demo or sample mode. The ride simulator lives in `test/` only and is used solely to score the detectors in automated tests.

## What gets measured, and from which sensor

| Metric | Source | How |
|---|---|---|
| Potholes vs speed bumps | Phone accelerometer | Vertical shock > 0.6 g. A **drop first** means a pothole, a **lift first** means a bump. Severity comes from peak-to-peak g. Each one is GPS-tagged. |
| Road roughness / comfort | Accelerometer | 2 s RMS of high-passed vertical acceleration, mapped to ISO 2631-1 comfort bands (indicative: not frequency-weighted). |
| Hard braking / acceleration | Accelerometer + speed | Longitudinal axis is learned automatically. Hard at 0.35 g, emergency at 0.6 g. Logs the speed drop and duration. |
| Jerk / smoothness | Accelerometer | d(accel)/dt, RMS over the ride → smoothness score. |
| Lean angle | Gyro + speed | `asin(v·ω/g)`. The accelerometer **cannot** see lean on a bike (the resultant force stays in the bike's plane). |
| Cornering g | Gyro + speed | `v·ω/g`, ground frame. Drives the G-G friction circle. |
| Speed, RPM, throttle, load, coolant/oil/intake temps, battery V | **OBD-II** (ELM327) | Mode 01 PIDs. Supported PIDs are probed first. |
| Gear & **clutch time** | OBD rpm ÷ speed | Gear ratios are learned as clusters. A mismatch with every cluster means the clutch is in. Each shift's clutch time is in ms. Long mismatches are flagged as clutch-in coasting. |
| Altitude, climb/descent | GPS | Smoothed, with 3 m hysteresis. Browsers do not expose the barometer. |
| Overheating | OBD coolant | Alert at ≥ 105 °C. |

The phone can be mounted at **any angle**. "Up" comes from gravity while the speed is steady, and "forward" is learned from your first speed changes. In simulation tests this reaches > 0.95 alignment. It has not yet been measured on a real bike.

## Hardware: read this before buying an adapter
- **Use an ELM327 _Bluetooth LE_ adapter** (e.g. Vgate iCar Pro BLE, Veepeak BLE+, OBDLink CX). Browsers can't reach classic-Bluetooth (SPP) dongles.
- **Web Bluetooth works on Chrome/Edge for Android and desktop, not on iPhone.** On iOS you get phone-sensor analytics only (no OBD).
- **Wi-Fi ELM327**: browsers can't open raw TCP sockets, so `server/server.mjs` bridges them at `/obd`. The bridge must run on a device on the adapter's Wi-Fi, such as the phone itself via Termux. BLE is simpler.
- **Motorcycle diagnostic plugs are brand-specific** (often a 4- or 6-pin K-line). You need the matching cable to a 16-pin J1962 socket. Most BS6/Euro 5 bikes speak ISO 14230 KWP2000 (Setup → protocol "5"). Many bikes expose only some PIDs, and some none on the generic protocol.
- Sensors need HTTPS on a phone (`localhost` is exempt). Set `TLS_CERT` / `TLS_KEY`, or host the `public/` folder on any HTTPS static host.

## Triumph Bonneville T120 (2016+, liquid-cooled 1200)
What is verified, and what isn't:
- **Engine**: 1200 cc, 270° parallel twin, liquid-cooled ([Wikipedia](https://en.wikipedia.org/wiki/Triumph_Bonneville_T120_1200)).
- **Diagnostic port**: owners report it **under the seat, near the battery, behind a rubber cover** ([TriumphRat](https://www.triumphrat.net/threads/diagnostic-port.733874/)). **Unverified for 2018 specifically:**
  - Whether it is a standard 16-pin socket or needs an adapter cable. A 2015 T100 owner reports a 16-pin socket ([Triumph Trophy forum](https://www.triumph-trophy.com/index.php?topic=5140.0)), but adapter cables are also sold for the T100/T120 ([eBay listing](https://www.ebay.ca/itm/275195881620)).
  - **Look at your bike before buying anything.**
- **Coolant temperature over OBD**: a 2020 T120 owner reads it with a generic OBD reader ([TriumphRat](https://www.triumphrat.net/threads/2020-bonneville-t120-high-coolant-temp-p0117-severity-of-the-problem.971421/)). The T120 has no temperature gauge ([TriumphRat](https://www.triumphrat.net/threads/t120-temp-gauge.779482/)), so this is the most useful OBD channel on this bike. The same thread notes a constant 127 °C reading can mean an open-circuit sensor. Treat that as a sensor fault, not real heat.
- **Protocol**: not confirmed by any source found. Leave Setup → Protocol on **Auto-detect**. The app logs which PIDs the ECU reports as supported (`0100` bitmap) and polls only those, so you see exactly what your bike provides.
- **Adapters**: TuneECU documents that Triumph *reprogramming* over Bluetooth requires specific adapters (OBDLink LX/MX/MX+) ([TuneECU PDF](https://tuneecu.net/TuneECU_Android/Basics_Android_Version.pdf)). RideLens only *reads* data, but those OBDLink units are Classic Bluetooth. For this app, pick a **BLE** adapter (e.g. OBDLink CX).

## Wrong-side reporter
- A 4-second rolling pre-roll of frames is kept, so one tap saves the moment *before* you reacted, plus a sharp frame and 3 follow-ups.
- Plate entry is checked against Indian formats (`KA01AB1234`, `DL3C1234`, BH series). Optional OCR (Tesseract.js, loaded on demand) suggests the plate. **Expect to type it yourself most of the time.**
- Reports are stored locally in IndexedDB. They are synced to the server's SQLite DB (`/api/reports`, `/api/plates` for repeat offenders) only when you choose. Export to CSV/JSON, or use **Share to authorities** (Web Share with photo + maps link).
- Trigger with a Bluetooth remote that sends Enter/Space, so you don't have to touch the screen.

**Privacy & legal**: this stores images of people and number plates. Share them only with traffic police or official grievance channels, never publicly. Set `API_TOKEN` on the server, and check your local data-protection law (in India, the DPDP Act 2023) before running a shared database.

## Server
`PORT`, `DATA_DIR`, `API_TOKEN`, `TLS_CERT`, `TLS_KEY`, `OBD_ALLOW_ANY_HOST`. The OBD bridge only dials private LAN addresses by default.

## Layout
```
public/            PWA (vanilla ES modules, no build step)
  js/analytics.js  sensor-fusion + event detection (pure; runs in Node tests)
  js/obd.js        ELM327 driver (BLE + WebSocket transports)
  js/reports.js    evidence camera, plate validation/OCR, export, sync
  js/charts.js     canvas strip charts, friction circle, SVG report charts
  js/app.js        UI
server/server.mjs  static + REST + SQLite + Wi-Fi OBD bridge
scripts/screenshots.mjs  regenerates docs/screenshots/ from the simulator (dev only)
test/              node:test suites + simulator.js (test-only ground truth)
```

## Known limits
- **All accuracy figures come from simulation, not real riding.** Detector thresholds are tuned on simulated data. Calibrate them against a few real rides on your bike (`DEFAULTS` in `analytics.js`).
- The ride score and its weights are a heuristic I chose, not an industry standard.
- Clutch-time resolution is limited by the OBD poll rate. At an estimated ~5 rpm samples/s that is roughly ±100–200 ms; check your adapter's real rate in the OBD log.
- Wrong-way detection is manual (you tap). Automatic detection would need an on-device vehicle detector and lane geometry.
