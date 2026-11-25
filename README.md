# RideLens: live motorcycle ride analytics

A phone-first PWA (Progressive Web App) that captures every ride live and turns it into a coaching-grade report: potholes, bumps, road roughness, braking, acceleration, jerk, lean angle, g-force, altitude, gear and clutch timing, and engine temperatures. It also includes a **wrong-side vehicle reporter**, which captures photos, plate, location and time into a database.

## Live dashboard

[Open RideLens on GitHub Pages](https://jsankr.github.io/live-ride-experience/)

The green cockpit displays a live speedometer, OBD coolant thermometer, distance, lean, ride score, weather, a route preview, and sound levels in one compact view. The speedometer follows the selected metric or imperial units. Fresh OBD data supplies coolant and RPM, and the thermometer highlights the app’s existing overheat threshold. Toggle between flat and angled views of the recorded GPS trace, or open **Route map** for the interactive street map. The telemetry chart switches between speed and road shock. **Ride details** opens the OBD gauges, G-force, braking charts, and event feed.

| Desktop cockpit | Phone cockpit |
| --- | --- |
| <img src="docs/screenshots/cockpit-desktop.png" alt="Green desktop RideLens cockpit with a speedometer, coolant thermometer, GPS route, and telemetry charts" width="720"> | <img src="docs/screenshots/cockpit-phone.png" alt="Green phone cockpit with speed and coolant gauges, readings, and charts above the navigation" width="280"> |

Screenshots use the ride simulator, fixed weather and air-quality responses, and Chromium’s test microphone. The app reads your device and forecast provider in normal use.

### Weather and sound

- **Get weather** requests local conditions from [Open-Meteo](https://open-meteo.com/) using coordinates rounded to two decimal places. It shows current temperature, weather status, precipitation, wind direction and gusts, plus hourly rain probability and visibility. Once enabled, it refreshes during a ride while the cockpit is visible. **Clear weather** clears the forecast and stops automatic requests.
- **Enable mic** tracks the current and peak relative sound levels and a 30-second trend. Readings are in dBFS, relative to the microphone’s recording range. Wind, mounting, and device gain affect the readings. Calibrated dB SPL/dBA and regulatory noise limits require a sound-level meter. RideLens never saves or uploads the audio. Monitoring stops when you leave the cockpit or background the app.

Open **Live → Road conditions → Track air quality** to see an estimated India AQI and colour-coded pollutant readings. The calculation applies CPCB breakpoints to Open-Meteo/CAMS 24-hour particulate, nitrogen dioxide and sulphur dioxide means, plus 8-hour ozone and carbon monoxide means. No local station feed, lead or ammonia is used. A recent estimate for the capture area is included in evidence reports. See the [CPCB National AQI](https://cpcb.nic.in/National-Air-Quality-Index/).

Green marks lower readings, yellow marks caution, and red marks elevated risk. Ride score colours describe the app's heuristic. Weather colours are dashboard cues based on forecast wind, visibility, precipitation and conditions. Open **Uncalibrated · Add dBA** to enter a calibrated sound-level meter reading. Above 90 dBA is red, 85–90 dBA is yellow, and below 85 dBA is green. Exposure risk also depends on duration.

### Ride reports

Ride reports include a road-comfort map with clustered events, a heuristic score, speed, braking, roughness, elevation, lean, engine and clutch charts, and a full event log. Export JSON, CSV, or GPX. Saved rides and wrong-side reports are available from the bottom navigation.

## Run it on your phone (no laptop)
RideLens runs entirely in the phone's browser. Rides and reports are stored on the phone (IndexedDB) and the ride tools keep working offline once loaded. Weather updates and uncached basemap tiles need a network connection.

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

The browser matrix reflects published Web Bluetooth support. Automated browser checks run in Chromium, including phone-size viewports.

### Developer use (optional)
```
npm ci
npm start            # builds the React app, then starts the optional report DB and Wi-Fi OBD bridge on localhost:8080
npm test             # detectors, OBD parser, report API, and Wi-Fi bridge
npx playwright install chromium
npm run test:browser
```

Use Node 22.5 or later. Run `npm run build` for the static production app in `public/`. To regenerate the dashboard screenshots after building, run `RIDELENS_SCREENSHOTS=docs/screenshots npm run test:browser`. Set `CHROMIUM_PATH` to use an existing Chromium executable.

## Trip: target time and live ETA
Tap the floating **⏱ Trip ETA** button (bottom-left, opposite the red camera button) (or **Set destination** in the Trip card below it). Search for a place, or paste coordinates or a Google Maps/Waze link, then optionally set a target arrival time. Once a trip is running, that button shows the live ETA and minutes spare (+) or late (−). Tap it to jump to the full Trip card.

The Trip card shows:
- **ETA**, the target time, minutes spare or late, the remaining distance, and the average speed needed to make the target.
- Where the ETA comes from:
  - **Route time**: [OSRM](https://project-osrm.org/) on OpenStreetMap data. It has **no live traffic** and uses a car profile.
  - **At your pace**: once you've covered about 2 minutes of route, the remaining route time is scaled by how this trip has actually gone so far.
  - **Straight-line estimate**: if the routing server can't be reached, the app uses straight-line distance ÷ your average moving speed, and labels it that way.
- The app re-routes when you're more than 80 m off the route for 15 s, at most every 30 s.
- **Navigate in Waze / Google Maps** buttons hand the destination to those apps ([Waze deep links](https://developers.google.com/waze/deeplinks), Google Maps URLs with `travelmode=two-wheeler`).
  - **Waze and Google Maps do not let other apps read their live ETA**, so their numbers can't appear inside RideLens.
  - Opening either app sends RideLens to the background, where browsers pause its sensors.

## Hands-free wrong-side detection
Turn on the camera in **Wrong-side** with the phone facing the road. With **Hands-free** ticked (the default), RideLens watches by itself.

How a vehicle gets flagged:
- **Detection**: about 2 checks per second, alternating the full frame with a 2× zoom on the centre of the road. A lightweight COCO-SSD detector runs in the browser.
- **Distance**: estimated from the vehicle's apparent width and a typical real width for its class.
- **Speed**: the vehicle's own speed toward you is its closing speed minus your GPS speed. That way traffic you're catching up to, and parked vehicles, don't count.
- **Lane**: worked out from its sideways offset in metres. With keep-left traffic, which you set in Setup, a vehicle approaching at or left of your line is on the wrong side.
- **Trigger**: when such a vehicle is within 30 m, RideLens saves the photo burst, including the 4 s before. It then reads vehicle type, colour, rider and number plate automatically, and the report is tagged **AUTO** with the measurements behind it.

Limits:
- **Estimates only.** Every number is an estimate. Review reports before sharing them.
- **Only on screen.** The camera works only while RideLens is on screen.
- **Detection range** depends on the phone's speed. In CI-like headless Chromium without a GPU, a car was first detected at about 15 m.
- **No real-road testing.** The decision logic is tested on synthetic geometry, plus an end-to-end browser test with a real car photo approaching in the frame. It has not been validated on real roads.

## Potholes, speed breakers and rough stretches
Road events are judged against the vibration of the road you are on *right now*. A jolt must be 4× the running background (and ≥ 0.5 g), so a rough road or a shaky handlebar mount doesn't turn every bump into an event.
- **Pothole**: the wheel **drops first** (a dip of at least 0.35 g before the biggest compression), then slams.
- **Speed breaker**: **compression first**, lasting at least 80 ms, after you slowed by ≥ 4 km/h (or below 20 km/h).
- **Rear-wheel confirmation**: both must repeat when the rear wheel reaches the same spot, one wheelbase later (1.45 m, about a T120). Random jolts don't repeat on cue.
- **Rough stretch**: three or more unexplained jolts within 10 s are logged as one stretch (start, end, length, peak), drawn as a line on the map. They're not counted as potholes. Inside a rough stretch, a pothole must also hit 1.25× harder than the jolts around it.
- **No double counting**: at most one event per 10 m.

On simulated rides: smooth roads count potholes and breakers within ±1. Rough roads with 300–460 random jolts per ride keep potholes within ±25%, never over-count breakers, and find rough stretches within ±40%. **These are simulations, not real roads.** Turn on *Keep raw sensor data* in Setup to re-analyse rides later, and to share real data for tuning.

**Maps:** the ride report map filters All / Potholes / Breakers / Rough. *History → Road hazard map* merges potholes and breakers from all rides (within 15 m), marks spots hit on more than one ride, lists the worst with Google Maps links, and exports GeoJSON/CSV.

## Dashcam
**Wrong-side → Start camera** with **Dashcam** on (the default) records the road continuously.
- **Files:** 1-minute files named `RideLens_YYYY-MM-DD_HH-MM-SS.mp4`. They're MP4 on iPhone Safari and recent Chrome; Firefox can only make `.webm`.
- **Stamp:** every frame shows date, time, speed and GPS.
- **Retention:** recordings are kept for 1, 3, 5 (default) or 7 days, then overwritten. The oldest are also removed early if the browser's storage allowance runs low.
- **Quality and space:** 480p is about 0.5 GB/hour, 720p about 1.1 GB/hour, 1080p about 2 GB/hour, and 4K (default) about 7 GB/hour. These are estimates from the bitrates used. 4K is requested from the camera, and the card shows the resolution actually delivered: phone browsers often give web pages no more than 1080p.
- **Incidents** lock the footage from 30 s before to 30 s after, and those clips are never overwritten. Triggers:
  - crash-level impact (≥ 4 g);
  - the bike lying on its side for 1.5 s;
  - emergency braking (≥ 0.6 g);
  - a wrong-side vehicle;
  - the red camera button.

  Each incident stores the time, GPS, your speed and heading, and (when the camera can read them) the other vehicle's type, colour, number plate and closing speed. The sensor triggers (impact, fall, braking) need **Start ride**.
- **Saving a copy:** each clip's **Save** button opens the phone's share sheet: Save Video / Save to Files, iCloud Drive, Google Drive, OneDrive. A web app can't write into Photos or cloud folders by itself. Automatic cloud upload would need your own Google/Microsoft app registration; iCloud has no public upload API.
- **Limit:** like every camera feature, recording stops whenever RideLens isn't on screen.

## Precise destinations
Besides place search, the Trip dialog accepts:
- **GPS coordinates**, decimal or degrees-minutes-seconds;
- **Plus Codes** as shown in Google Maps (full codes, or short codes plus a town, e.g. `WHX8+2G Bengaluru`), decoded offline with no key;
- a **dropped pin**: tap the map;
- Google Maps and Waze links;
- **what3words** addresses, which need your what3words API key.

## Music while riding (YouTube Music)
Four buttons: **previous · play · pause · next**. They're on the Music card, and float at the bottom of the Live screen, so you don't need to scroll.
- **Set up once:** under the buttons, paste a YouTube Music playlist, album or song link (Share → Copy link) and tap **Save**. After that, ▶ alone starts it.
- **What plays:** your saved link, inside RideLens, through YouTube's official player. No Premium needed; ads may play. Songs whose owners block outside playback are skipped automatically.
- **When it stops:** if RideLens leaves the screen.
- **What the buttons can't do:** they control music inside RideLens only. No web app can control the separate YouTube Music app. For that, use your helmet headset or lock-screen controls.

## Background running: what's possible
- **In the web app**: browsers stop sensors, GPS and the camera for pages that aren't on screen, and no website can override that. RideLens keeps the screen awake. If you switch away mid-ride, the ride report logs a **Recording paused** event with its exact duration instead of inventing data for the gap.
- **iPhone, even as a native app**: iOS allows background GPS, but never background camera use.
- **Android native app**: a foreground service could keep GPS, sensors and the camera running behind other apps.

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

Start the rear camera before riding and use **Capture wrong-side vehicle**, the camera shortcut, or a Bluetooth remote to save a burst. RideLens saves the original frames around the trigger, selects a sharp preview, and records the timestamp and available GPS fix and accuracy. On-device analysis samples the detected vehicle body for colour, highlights a frame with a possible rider, and runs OCR on enlarged vehicle crops. Strong results fill empty report fields. Open a saved report to review them or choose **Reanalyse photos**. If the plate is small in the original frame, choose **Select plate area**, drag around the full plate, then tap **Read plate**. Models download on first use. Camera quality, distance, lighting, and motion affect which details are readable. Capture and local storage work when analysis is unavailable. JSON export includes the full photo burst and analysis metadata.

- Capture retains up to four seconds of pre-roll, the trigger frame, and three follow-ups. Plate entry checks common Indian formats, including `KA01AB1234`, `DL3C1234`, and Bharat Series. You can also run OCR on a frame manually.
- Reports are stored locally in IndexedDB. They are synced to the server's SQLite DB (`/api/reports`, `/api/plates` for repeat offenders) only when you choose. Export to CSV/JSON, or use **Share to authorities** (Web Share with photo + maps link).

**Privacy & legal**: this stores images of people and number plates. Share them only with traffic police or official grievance channels, never publicly. Set `API_TOKEN` on the server, and check your local data-protection law (in India, the DPDP Act 2023) before running a shared database.

## Server
`PORT`, `DATA_DIR`, `API_TOKEN`, `TLS_CERT`, `TLS_KEY`, `OBD_ALLOW_ANY_HOST`. The OBD bridge only dials private LAN addresses by default.

## Layout
```
src/               React app shell, ride dashboard, and weather and microphone hooks
public/            Static PWA output, ride analytics modules, and offline service worker
  js/analytics.js  sensor-fusion + event detection (pure; runs in Node tests)
  js/obd.js        ELM327 driver (BLE + WebSocket transports)
  js/reports.js    evidence camera, plate validation/OCR, export, sync
  js/charts.js     canvas strip charts, friction circle, SVG report charts
  js/app.js        UI
server/server.mjs  static + REST + SQLite + Wi-Fi OBD bridge
scripts/build.mjs       generates the committed static bundle for GitHub Pages
scripts/cockpit-browser.mjs  exercises the dashboard and captures the README screenshots
test/              node:test suites + simulator.js (test-only ground truth)
```

## Known limits
- **All accuracy figures come from simulation, not real riding.** Detector thresholds are tuned on simulated data. Calibrate them against a few real rides on your bike (`DEFAULTS` in `analytics.js`).
- The ride score and its weights are a heuristic I chose, not an industry standard.
- Clutch-time resolution is limited by the OBD poll rate. At an estimated ~5 rpm samples/s that is roughly ±100–200 ms; check your adapter's real rate in the OBD log.
- Wrong-way detection is manual (you tap). Automatic detection would need an on-device vehicle detector and lane geometry.
