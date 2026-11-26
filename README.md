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

**End of every ride: two report files.** *Report → Ride reports* makes two small, self-contained HTML files that open on any phone or computer, offline:
1. **Road report:** how the road was, then every pothole, speed breaker, rough stretch and hard brake with time, severity, speed and a Google Maps link. It also has a route sketch, and notes on anything that makes the numbers less certain (a shaking mount, recording gaps).
2. **Wrong-side report:** every vehicle that came at you on the wrong side. Each one has:
   - the evidence photo, stamped with date, time, GPS and your speed;
   - vehicle, rider, head and number-plate snapshots;
   - the plate, colour and type, and the measured direction and speed;
   - the helmet estimate for two-wheelers.

   It is made for submitting to traffic police. *Wrong-side → Police report* makes the same file for all reports.

**Storage SOP (Setup → Compact storage, on by default):**
- When an evidence report has been analysed, only its key photo and the snapshots are kept.
- When a ride ends, plain dashcam video of that ride is deleted. Locked incident clips (crash, fall, emergency braking, wrong-side, manual capture) are kept.
- Raw sensor logging stays off unless you turn it on.

**Removing false events:** in a ride report's *Event log*, tap **Remove false events**. Tick events that weren't real (a manhole, an expansion joint, a false crash alert), or choose a type and a time window and tap *Select matching*. **Remove** asks once. The ride's counts, the hazard map and the road report are then recalculated, and the report notes how many events you removed.

**Deleting wrong-side reports:** *Camera → Reports → Select to delete*. Tick reports, or pick a day, a time and *which reports*:
- automatic with no plate read;
- automatic with no vehicle found in the photos;
- not reviewed yet, dismissed, or captured by hand;
- a vehicle type.

Each option shows how many reports match. Deleted reports also come off their ride's wrong-side count.

**Re-analyse** on a saved ride redoes potholes, breakers, rough stretches, hard braking/acceleration, crash and fall with the current rules (it needs the raw sensor log).

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
Turn on the camera in **Wrong-side** with the phone facing the road. It opens **full screen**: the live picture fills the phone, and everything is drawn over it on a transparent heads-up display.
- **Status:** dashcam REC, watch status, GPS, clock, speed, and this ride's wrong-side / pothole / breaker counts.
- **Buttons:** Exit, Auto-detect, Voice, Dashcam, and Start/Stop ride. There is no tap-to-capture while riding: capture is fully automatic. *Capture now (when parked)* on the Camera card remains for use off the bike.
- **Discreet (Setup, on by default):** vehicles get camera-style focus brackets with no labels, counters say "captures" and alerts say "✓ Saved". People nearby can't tell what is being recorded. The tab is called **Camera**.
- **Auto zoom and focus on each detection:**
  1. **Optical zoom** toward the vehicle (up to 3×), where the phone exposes zoom to web pages. Phones zoom only the centre, so the level keeps the whole vehicle in view. Detection pauses for that second.
  2. **Focus** moved onto the vehicle (Chrome on Android).
  3. A **full-resolution burst**; zoom and focus then return to normal.
  4. A 4-second **zoom preview** of the vehicle on the HUD.

  iPhone browsers have no focus control and may have no zoom control. There, the digital crop from the full-resolution frames is the zoom.
- **Voice commands (Setup → Voice commands):**
  - Screens: "camera", "live", "report", "history", "setup".
  - Controls: "start ride", "stop ride", "full screen", "exit full screen", "camera on/off", "dashcam on/off".
  - Optional wake word: "RideLens report".
  - The listener restarts itself. It uses the browser's speech recognition: Chrome on Android, or Safari with Dictation enabled. Wind noise at speed makes it unreliable without a helmet headset microphone.

With **Hands-free** ticked, RideLens watches by itself.

**Keep-left India (the default):** only vehicles **coming toward you on your left** count, i.e. between you and the kerb, or dead ahead (≤ 0.2 m right of your line). Oncoming traffic on your right is legitimate and ignored. Switch to keep-right in Setup if needed.
- **What it looks at:** only your side of the picture (the left 62%, from the kerb to just past the centre). Everything else is simply recorded by the dashcam, with no live analysis.
- **How it decides:** distance comes from the vehicle's apparent width. Its own speed toward you is its closing speed minus your GPS speed, so parked vehicles and traffic you're catching up to don't count.
- **Only vehicles driving toward you (front view):** the vehicle must close in faster than you are moving, by at least 12 km/h and by a quarter of your own speed. That margin covers the ±25 % error of distance-from-width. A same-direction vehicle you overtake shows its rear and closes slower than your speed, so it never counts.
- **Strict evidence:** the vehicle must be seen at least 3 times over 0.6 s, approaching steadily (distances on a straight line, R² ≥ 0.6), 4–30 m away, and not cut off by the picture edge. GPS speed is required: without it, oncoming and slower traffic look the same, so nothing is flagged. Your 26 Nov ride raised 75 alerts in 25 km under the old rules; 8 of them meet these.
- **When it triggers:** it fires within 30 m. The burst capture includes the 4 s before, and vehicle type, colour and plate are read automatically. The report is tagged **AUTO**.
- **Heat:**
  - check rate: every 1.2 s when stopped, 0.5 s when moving, 0.3 s while a vehicle is near on your side;
  - never faster than 2× the time a check takes, so a hot, throttled phone automatically does less;
  - dashcam stamp drawn at 20 fps; pre-roll frame every 0.7 s.
- **Evidence analysis (once per detection, on the saved photos only, so no extra heat while riding):**
  - **Focus and zoom:** the camera focus is moved onto the vehicle where the browser allows it (Chrome on Android). iPhone browsers give web pages no focus control, so the camera's own autofocus is used there. Frames after the trigger are kept at full camera resolution, and the vehicle, rider and plate are cropped from them (digital zoom).
  - **Number plate:** found by a YOLOv9-t plate detector ([open-image-models](https://github.com/ankandrew/open-image-models), MIT), then read by OCR on just that strip and checked against Indian formats.
  - **Helmet (two-wheelers):** the EfficientNet-B0 `helmet_v5` classifier ([vivekvar/helmet-v5](https://huggingface.co/vivekvar/helmet-v5), Apache-2.0, trained on Indian traffic-camera crops; 81 % validation accuracy) on the rider's head, averaged over the frames. It's shown as *likely helmet / likely no helmet / unclear* with its probability.
  - **Not assessed:** seat belts (not visible through a windscreen at road distance, and no tested model exists for this view) and mirrors (no public model). The report says so instead of guessing.
  - **How it runs:** the models are in `public/models/` (24 MB). They are downloaded once and cached on the phone, and run with ONNX Runtime Web.
- **Limit:** catching fast vehicles needs several checks per second. On this project's CPU-only test machine (~1 check/s), a car closing at 29 km/h was captured and one at 43 km/h was missed. On a phone using its graphics chip it should be several times faster, but that's **unmeasured**.

## Potholes, speed breakers and rough stretches
Road events are judged against the vibration of the road you are on *right now*. A jolt must be 4× the running background (and ≥ 0.5 g), so a rough road or a shaky handlebar mount doesn't turn every bump into an event.
- **Pothole**: the wheel **drops first** (a dip of at least 0.35 g before the biggest compression), then slams.
- **Speed breaker**: **compression first**, lasting at least 80 ms, after you slowed by ≥ 4 km/h (or below 20 km/h).
- **Rear-wheel confirmation**: both must repeat when the rear wheel reaches the same spot, one wheelbase later (1.45 m, about a T120). Random jolts don't repeat on cue.
- **Rough stretch**: three or more unexplained jolts within 10 s are logged as one stretch (start, end, length, peak), drawn as a line on the map. They're not counted as potholes. Inside a rough stretch, a pothole must also hit 1.25× harder than the jolts around it.
- **No double counting**: at most one event per 10 m.

On simulated rides: smooth roads count potholes and breakers within ±1. Rough roads with 300–460 random jolts per ride keep potholes within ±25%, never over-count breakers, and find rough stretches within ±40%. **These are simulations, not real roads.** Turn on *Keep raw sensor data* in Setup to re-analyse rides later, and to share real data for tuning.

**Maps:** the ride report map filters All / Potholes / Breakers / Rough. *History → Road hazard map* merges potholes and breakers from all rides (within 15 m), marks spots hit on more than one ride, lists the worst with Google Maps links, and exports GeoJSON/CSV. Rides recorded with the old detector (before 25 Nov 2026, 22:00 IST) are left off the map unless you tick *Include rides recorded with the old detector*.

**Hard braking and acceleration** must show in the GPS/OBD speed too: the speed has to change by ≥ 4 km/h (and by half of what the accelerometer implies) within 2.5 s. Otherwise it was handlebar vibration.

**Mount shake:** the report warns when the phone shakes more than 1 m/s² even on the smoothest quarter of the ride. A firm mount reads about 0.3–0.6. The 26 Nov ride read 1.4, which makes pothole counts unreliable; use a vibration-damped mount.

A pothole's dip must come within 0.2 s before the slam. An earlier dip is fork dive from braking for a speed breaker, which had made breakers count as potholes.

## Dashcam
**Wrong-side → Start camera** with **Dashcam** on (the default) records the road continuously.
- **Files:** 1-minute files named `RideLens_YYYY-MM-DD_HH-MM-SS.mp4`. They're MP4 on iPhone Safari and recent Chrome; Firefox can only make `.webm`.
- **Stamp:** every frame shows date, time, speed and GPS.
- **Retention:** recordings are kept for 1, 3, 5 (default) or 7 days, then overwritten. The oldest are also removed early if the browser's storage allowance runs low.
- **Quality and space:** 480p is about 0.5 GB/hour, 720p about 1.1 GB/hour, 1080p about 2 GB/hour, and 4K (default) about 7 GB/hour. These are estimates from the bitrates used. 4K is requested from the camera, and the card shows the resolution actually delivered: phone browsers often give web pages no more than 1080p.
- **Incidents** lock the footage from 30 s before to 30 s after, and those clips are never overwritten. Triggers:
  - crash-level impact (≥ 4 g, **and** within 6 s the bike nearly stops or falls over: a handlebar phone sees 4–6 g spikes at speed from vibration alone, as all 30 'crashes' on the 26 Nov ride were);
  - the bike lying on its side for 1.5 s;
  - emergency braking (≥ 0.6 g);
  - a wrong-side vehicle;
  - the red camera button.

  Each incident stores the time, GPS, your speed and heading, and (when the camera can read them) the other vehicle's type, colour, number plate and closing speed. The sensor triggers (impact, fall, braking) need **Start ride**.
- **Saving a copy:** each clip's **Save** button opens the phone's share sheet: Save Video / Save to Files, iCloud Drive, Google Drive, OneDrive. A web app can't write into Photos or cloud folders by itself. Automatic cloud upload would need your own Google/Microsoft app registration; iCloud has no public upload API.
- **Bulk delete:** tap **Select to delete**, then do either of these:
  - pick a day and a time (whole day, morning 05–12, afternoon 12–17, evening 17–22, night 22–05, or a custom from–to) and tap **Select this range**;
  - tick whole days or single clips while scrolling.

  Locked incident clips are left out unless you tick *Also select locked incident clips*. Delete asks once, on the page.
- **Delete by lock reason:** *Which clips* chooses between plain video, all clips, or only clips locked for one reason (e.g. *Locked: Crash-level impact*), with a count for each. That clears footage locked by false alarms without touching real incidents.
- **Limit:** like every camera feature, recording stops whenever RideLens isn't on screen.

## Saved and recent destinations
No typing for regular rides:
- **Remembered:** every trip destination is remembered. Picks within 120 m of each other merge into one place, which keeps its trip count and the arrival time you usually set.
- **Trip card:** **Set destination** shows the top three places as one-tap chips that start the trip straight away, with your usual target time.
- **Destination dialog:**
  - the full list: ★ saved places first, then recent trips, then places where your saved rides ended;
  - each with distance from you, how often and when you last went;
  - **tap** to choose, **Go** to start at once, **☆** to save with a name (Home, Office…), **✕** to forget a recent one.
- **Limits:** places you are already at (within 300 m) aren't suggested. Recent places are capped at 15; saved places are kept until you unstar them.
- **Voice:** "go to office" or "RideLens take me to home" starts a trip to the saved place with that name.
- **Storage:** stored only on this phone.

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
