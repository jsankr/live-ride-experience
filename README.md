# RideLens: live motorcycle ride analytics

A phone-first PWA (Progressive Web App) that captures every ride live and turns it into a coaching-grade report: potholes, bumps, road roughness, braking, acceleration, jerk, lean angle, g-force, altitude, gear and clutch timing, and engine temperatures. It also includes a **wrong-side vehicle reporter**, which captures photos, plate, location and time into a database.

```
npm start            # http://localhost:8080 (zero dependencies, Node ≥ 22.5)
npm test             # 19 tests: detectors vs simulator ground truth, OBD parser, server, Wi-Fi bridge
open http://localhost:8080/?demo   # simulated ride, no bike needed
```

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

The phone can be mounted at **any angle**. "Up" comes from gravity while the speed is steady, and "forward" is learned from your first speed changes. On the simulator this is verified to > 0.95 alignment.

## Hardware: read this before buying an adapter
- **Use an ELM327 _Bluetooth LE_ adapter** (e.g. Vgate iCar Pro BLE, Veepeak BLE+, OBDLink CX). Browsers can't reach classic-Bluetooth (SPP) dongles.
- **Web Bluetooth works on Chrome/Edge for Android and desktop, not on iPhone.** On iOS you get phone-sensor analytics only (no OBD).
- **Wi-Fi ELM327**: browsers can't open raw TCP sockets, so `server/server.mjs` bridges them at `/obd`. The bridge must run on a device on the adapter's Wi-Fi, such as the phone itself via Termux. BLE is simpler.
- **Motorcycle diagnostic plugs are brand-specific** (often a 4- or 6-pin K-line). You need the matching cable to a 16-pin J1962 socket. Most BS6/Euro 5 bikes speak ISO 14230 KWP2000 (Setup → protocol "5"). Many bikes expose only some PIDs, and some none on the generic protocol.
- Sensors need HTTPS on a phone (`localhost` is exempt). Set `TLS_CERT` / `TLS_KEY`, or host the `public/` folder on any HTTPS static host.

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
  js/simulator.js  physics-flavoured ride simulator with ground truth
  js/obd.js        ELM327 driver (BLE + WebSocket transports)
  js/reports.js    evidence camera, plate validation/OCR, export, sync
  js/charts.js     canvas strip charts, friction circle, SVG report charts
  js/app.js        UI
server/server.mjs  static + REST + SQLite + Wi-Fi OBD bridge
test/              node:test suites
```

## Known limits
- Detector thresholds are tuned on simulated data. Calibrate them against a few real rides on your bike (`DEFAULTS` in `analytics.js`).
- Clutch-time resolution is limited by the OBD poll rate: K-line ELM327 gives ~5 rpm samples/s, so ±100–200 ms.
- Wrong-way detection is manual (you tap). Automatic detection would need an on-device vehicle detector and lane geometry.
