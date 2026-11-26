import React from 'react';
import { Cockpit } from './Cockpit.jsx';

export function Shell() {
  return <>
  <header className="topbar">
    <div className="brand"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M12 12 L17 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /><circle cx="12" cy="12" r="2" fill="currentColor" /></svg>RideLens</div>
    <div className="chips" id="chips">
      <span className="chip" data-src="gps"><i></i>GPS</span>
      <span className="chip" data-src="imu"><i></i>IMU</span>
      <span className="chip" data-src="obd"><i></i>OBD</span>
    </div>
    <button id="recBtn" className="rec" aria-pressed="false"><span className="rec-dot"></span><span id="recLabel">Start ride</span></button>
  </header>

  <main id="main-content">

    <section id="view-live" className="view active" aria-label="Live">
      <div className="banner" id="banner" hidden></div>
      <Cockpit />
      <article className="card trip-card" id="tripCard">
        <div className="trip-empty" id="tripEmpty">
          <div><h3>Trip</h3><p className="fine" style={{ margin: 0 }}>Set a destination and target arrival time to get a live ETA.</p></div>
          <button id="tripSet">Set destination</button>
        </div>
        <div className="trip-live" id="tripLive" hidden>
          <div className="trip-main">
            <div><span className="label">ETA</span><span className="trip-eta" id="tripEta">—</span><span className="hint" id="tripEtaKind"></span></div>
            <div><span className="label">Target</span><span className="trip-target" id="tripTarget">—</span><span className="status-pill" id="tripState" hidden></span></div>
            <div><span className="label">Remaining</span><span className="trip-target" id="tripRemain">—</span><span className="hint" id="tripNeed"></span></div>
          </div>
          <div className="trip-dest" id="tripDest"></div>
          <div className="row">
            <a className="btn ghost" id="tripWaze" target="_blank" rel="noopener">Navigate in Waze</a>
            <a className="btn ghost" id="tripGmaps" target="_blank" rel="noopener">Navigate in Google Maps</a>
            <button className="ghost" id="tripEdit">Edit</button>
            <button className="ghost" id="tripEnd">End trip</button>
          </div>
          <p className="fine" id="tripSource"></p>
        </div>
      </article>
      <article className="card music-card" id="musicCard">
        <div className="card-head"><h3>Music</h3><span className="yt-title" id="ytTitle"></span></div>
        <div className="yt-controls" id="ytControls">
          <button type="button" className="ghost yt-btn" id="ytPrev" aria-label="Previous song"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2.5v14H6zM20 5v14L9.5 12z" fill="currentColor" /></svg></button>
          <button type="button" className="yt-btn yt-play" id="ytPlay" aria-label="Play"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15L19.5 12z" fill="currentColor" /></svg></button>
          <button type="button" className="ghost yt-btn" id="ytPause" aria-label="Pause"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 5h4v14h-4zM13.5 5h4v14h-4z" fill="currentColor" /></svg></button>
          <button type="button" className="ghost yt-btn" id="ytNext" aria-label="Next song"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 5H18v14h-2.5zM4 5v14l10.5-7z" fill="currentColor" /></svg></button>
        </div>
        <p className="fine" id="ytMsg"></p>
        <div className="yt-frame" id="ytFrameWrap" hidden><div id="ytPlayer"></div></div>
        <details className="fine" id="ytSetup"><summary id="ytSetupLabel">Set your YouTube Music playlist</summary>
          <label>Paste a YouTube Music playlist, album or song link (Share → Copy link)
            <div className="row" style={{ margin: 0 }}><input id="ytLink" placeholder="https://music.youtube.com/playlist?list=…" autoComplete="off" style={{ flex: 1 }} /><button type="button" id="ytLoad">Save</button></div>
          </label>
          <p>Plays inside RideLens through YouTube's player, so no Premium is needed. Ads may play. Songs whose owners block outside playback are skipped. It stops if RideLens leaves the screen.</p>
        </details>
      </article>
      <div className="grid live-grid" id="rideDetails" hidden>
        <article className="card hero">
          <svg className="dial" viewBox="0 0 220 220" aria-hidden="true">
            <path id="rpmTrack" className="dial-track" />
            <path id="rpmArc" className="dial-arc" />
          </svg>
          <div className="hero-center">
            <div className="speed"><span id="speed">0</span><small>km/h</small></div>
            <div className="sub"><span id="rpm">— rpm</span></div>
          </div>
          <div className="gear-box"><span className="label">Gear</span><span id="gear" className="gear">N</span><span id="clutch" className="clutch" hidden>CLUTCH</span></div>
          <div className="speed-src" id="speedSrc">—</div>
        </article>

        <article className="card half">
          <h3>Lean angle</h3>
          <svg className="lean" viewBox="0 0 200 120" aria-hidden="true">
            <path d="M20 100 A80 80 0 0 1 180 100" className="dial-track" />
            <g id="leanBike" transform="rotate(0 100 100)">
              <line x1="100" y1="100" x2="100" y2="28" className="lean-needle" />
              <circle cx="100" cy="28" r="6" className="lean-head" />
            </g>
            <text x="22" y="116" className="tick">L</text><text x="172" y="116" className="tick">R</text>
          </svg>
          <div className="metric-row"><span className="big" id="lean">0°</span><span className="muted">max <b id="leanMaxL">0°</b>L · <b id="leanMaxR">0°</b>R</span></div>
        </article>

        <article className="card half">
          <h3>G-force</h3>
          <canvas id="gcircle" className="gcircle"></canvas>
          <div className="metric-row"><span className="big" id="gNow">0.00 g</span><span className="muted">peak <b id="gPeak">0.00 g</b></span></div>
        </article>

        <div className="tiles">
          <article className="tile" data-tile="coolant"><span className="tile-top"><span className="label">Coolant</span><span className="src obd" id="src-coolant">OBD</span></span><span className="val" id="coolant">—</span><span className="hint" id="coolantHint">engine temp</span></article>
          <article className="tile" data-tile="throttle"><span className="tile-top"><span className="label">Throttle</span><span className="src obd" id="src-throttle">OBD</span></span><span className="val" id="throttle">—</span><span className="meter"><i id="throttleBar"></i></span></article>
          <article className="tile" data-tile="alt"><span className="tile-top"><span className="label">Altitude</span><span className="src " id="src-alt">Phone</span></span><span className="val" id="alt">—</span><span className="hint" id="climb">↑0 ↓0 m</span></article>
          <article className="tile" data-tile="dist"><span className="tile-top"><span className="label">Distance</span><span className="src " id="src-dist">Phone</span></span><span className="val" id="dist">0.0 km</span><span className="hint" id="elapsed">0:00</span></article>
          <article className="tile" data-tile="rough"><span className="tile-top"><span className="label">Road</span><span className="src " id="src-rough">Phone</span></span><span className="val" id="rough">—</span><span className="status-pill" id="comfort">—</span></article>
          <article className="tile" data-tile="score"><span className="tile-top"><span className="label">Ride score</span><span className="src fused" id="src-score">Fused</span></span><span className="val" id="score">—</span><span className="hint" id="scoreHint">smooth · brake · shift</span></article>
        </div>

        <article className="card wide">
          <div className="card-head"><h3>Road shock</h3><span className="legend"><i style={{"background": "var(--series-1)"}}></i>m/s² <i className="dash" style={{"borderColor": "var(--status-serious)"}}></i>impact</span></div>
          <canvas id="chartVert" className="strip"></canvas>
        </article>
        <article className="card wide">
          <div className="card-head"><h3>Brake / accel</h3><span className="legend"><i style={{"background": "var(--series-2)"}}></i>g <i className="band"></i>hard</span></div>
          <canvas id="chartLong" className="strip"></canvas>
        </article>
        <article className="card wide">
          <div className="card-head"><h3>Engine &amp; clutch</h3><span className="legend"><i style={{"background": "var(--series-3)"}}></i>rpm <i className="dash" style={{"borderColor": "var(--status-warning)"}}></i>shift</span></div>
          <canvas id="chartRpm" className="strip"></canvas>
        </article>

        <article className="card feed-card">
          <div className="card-head"><h3>Events</h3><span className="muted" id="evCount">0</span></div>
          <ol className="feed" id="feed"><li className="empty">Events appear here as you ride.</li></ol>
        </article>
        <article className="card map-card">
          <div id="liveMap" className="map" tabIndex={-1} aria-label="Live route map"></div>
        </article>
      </div>
    </section>

    <section id="view-report" className="view" aria-label="Ride report">
      <div id="reportBody"><p className="empty pad">Finish a ride, or open one from History, to see its report.</p></div>
    </section>

    <section id="view-history" className="view" aria-label="History">
      <div className="section-head"><h2>Ride history</h2><button className="ghost" id="importBtn">Import JSON</button><input type="file" id="importFile" accept="application/json" hidden /></div>
      <article className="card hazard-card" id="hazardCard">
        <div className="card-head"><h3>Road hazard map · all rides</h3><span className="actions"><button className="ghost" id="hzGeo">GeoJSON</button><button className="ghost" id="hzCsv">CSV</button></span></div>
        <label className="check"><input type="checkbox" id="hzOld" /> <span>Include rides recorded with the old detector (before 25 Nov, 22:00 IST)</span></label>
        <p className="fine" id="hzOldNote"></p>
        <div id="hazardMap" className="map" style={{ minHeight: 320 }}></div>
        <p className="fine" id="hzSummary"></p>
        <ol className="hz-list" id="hzList"></ol>
        <p className="fine">Potholes and speed breakers from every saved ride, merged when they are within 15 m. A spot hit on several rides is more certain. Export GeoJSON or CSV (with Google Maps links) to attach to a municipal complaint.</p>
      </article>
      <div id="historyList" className="list"></div>
    </section>

    <section id="view-wrongside" className="view" aria-label="Wrong-side reports">
      <div className="grid ws-grid">
        <article className="card cam-card">
          <div className="card-head"><h3>Evidence camera</h3><button className="ghost" id="camToggle">Start camera</button></div>
          <div className="cam"><video id="camVideo" playsInline muted></video><canvas id="camOverlay" className="cam-overlay" aria-hidden="true"></canvas><div className="cam-off" id="camOff">Camera off. Start it before you ride and point the phone at the road ahead. RideLens then watches on its own: no tapping while riding.</div></div>
          <label className="check auto-row"><input type="checkbox" id="autoWatch" defaultChecked /> <span><b>Hands-free: auto-detect wrong-side vehicles</b><br /><span className="muted" id="autoStatus">Starts with the camera.</span></span></label>
          <p className="fine">When a vehicle comes toward you in your lane, RideLens saves a photo burst (including the 4 s before), then reads the vehicle type, colour, rider and number plate by itself. Detections are estimates from the camera image. Review them before sharing. The camera only works while RideLens is on screen.</p>
          <button className="capture" id="captureBtn" disabled>Capture wrong-side vehicle</button>
          <p className="fine">Optional shortcut: a Bluetooth remote sending <kbd>Enter</kbd>/<kbd>Space</kbd> also captures.</p>
        </article>
        <article className="card dashcam-card" id="dashcamCard">
          <div className="card-head"><h3>Dashcam</h3><span className="muted" id="dcStatus">Off</span></div>
          <label className="check"><input type="checkbox" id="dcOn" defaultChecked /> <span><b>Record video while the camera is on</b><br /><span className="muted">1-minute files with date, time, speed and GPS stamped on the picture. Older files are overwritten; incident footage is locked.</span></span></label>
          <div className="two">
            <label>Keep recordings for <select id="dcDays"><option value="1">1 day</option><option value="3">3 days</option><option value="5">5 days</option><option value="7">7 days</option></select></label>
            <label>Quality <select id="dcQuality"><option value="480">480p (~0.5 GB/hour)</option><option value="720">720p (~1.1 GB/hour)</option><option value="1080">1080p (~2 GB/hour)</option><option value="2160">4K (~7 GB/hour, if the camera allows)</option></select></label>
          </div>
          <div className="storage-bar" aria-hidden="true"><i id="dcBar"></i></div>
          <p className="fine" id="dcStorage"></p>
          <p className="fine">Incidents lock the footage 30 s before and after: crash-level impact, the bike falling over, emergency braking, a wrong-side vehicle, or the red camera button. Sensor incidents need <b>Start ride</b> to be on. Each incident stores time, GPS, your speed and heading, and the other vehicle's type, colour and plate when the camera can read them. Files stay in RideLens on this phone. Use <b>Save</b> to put one in Photos/Files, iCloud Drive, Google Drive or OneDrive.</p>
          <div id="dcList" className="list"></div>
        </article>
        <article className="card">
          <div className="card-head"><h3>Reports</h3>
            <span className="actions"><button className="ghost" id="wsCsv">CSV</button><button className="ghost" id="wsJson">JSON</button><button className="ghost" id="wsSync">Sync</button></span>
          </div>
          <div id="wsStats" className="ws-stats"></div>
          <div id="wsList" className="list"></div>
        </article>
        <article className="card wide map-card"><div id="wsMap" className="map"></div></article>
      </div>
    </section>

    <section id="view-setup" className="view" aria-label="Setup">
      <div className="grid setup-grid">
        <article className="card">
          <h3>This phone &amp; browser</h3>
          <p className="fine">Checked live on this device. Grey items are not offered by this browser.</p>
          <ul className="caps" id="caps"></ul>
          <div className="row"><button className="ghost" id="permBtn">Grant motion, location &amp; camera</button></div>
          <p className="fine">Browsers pause sensors when the screen turns off or you switch apps. During a ride keep RideLens open and in front. The app keeps the screen awake where the browser allows it.</p>
        </article>
        <article className="card">
          <h3>OBD-II adapter</h3>
          <p className="fine">Needs an ELM327-compatible adapter that uses <b>Bluetooth LE</b>. Classic-Bluetooth adapters cannot be reached from any browser.</p>
          <p className="fine" id="bleNote" hidden></p>
          <label>Protocol
            <select id="protocol" defaultValue="0">
              <option value="0">Auto-detect (recommended: the adapter probes the bike)</option>
              <option value="5">ISO 14230 KWP2000 fast init</option>
              <option value="4">ISO 14230 KWP2000 5-baud init</option>
              <option value="3">ISO 9141-2</option>
              <option value="6">ISO 15765 CAN 11-bit 500k</option>
            </select>
          </label>
          <div className="row"><button id="bleBtn">Connect Bluetooth LE</button><button className="ghost" id="obdStop">Disconnect</button></div>
          <details className="fine"><summary>Wi-Fi adapter (advanced)</summary>
            <p>Browsers cannot talk to Wi-Fi OBD adapters directly. This only works if the RideLens server runs on a device joined to the adapter's Wi-Fi.</p>
            <label>Wi-Fi bridge URL <input id="bridgeUrl" placeholder="ws://127.0.0.1:8080/obd?host=192.168.0.10&port=35000" /></label>
            <div className="row"><button className="ghost" id="wifiBtn">Connect via Wi-Fi bridge</button></div>
          </details>
          <pre className="log" id="obdLog"></pre>
        </article>
        <article className="card">
          <h3>Phone mount &amp; sensors</h3>
          <p className="fine">Mount the phone rigidly (vibration-damped mount). Orientation does not matter: RideLens learns "up" when you are stationary and "forward" from your first few speed changes.</p>
          <label>Lean left/right direction
            <select id="invertYaw"><option value="">Automatic (learned from GPS turns)</option><option value="normal">Force normal</option><option value="invert">Force inverted</option></select>
          </label>
          <label>Traffic drives on the <select id="keepSide"><option value="left">left (India, UK, Australia…)</option><option value="right">right (USA, Europe…)</option></select></label>
          <label className="check"><input type="checkbox" id="rawLog" /> <span>Keep raw sensor data with each ride (about 10 MB per hour). Lets a ride be re-analysed later when detection improves, and helps tune pothole detection for your bike.</span></label>
          <label>Units <select id="units"><option value="metric">km/h, °C, m</option><option value="imperial">mph, °F, ft</option></select></label>
          <label>Theme <select id="theme"><option value="">System</option><option value="dark">Dark</option><option value="light">Light</option></select></label>
        </article>
        <article className="card">
          <h3>Report server (optional)</h3>
          <p className="fine">Not needed: rides and reports are stored on this phone. Only set this if you run the RideLens server somewhere to collect reports centrally.</p>
          <label>Server URL <input id="serverUrl" placeholder="https://your-server:8080" /></label>
          <label>API token <input id="serverToken" type="password" autoComplete="off" /></label>
          <div className="row"><button className="ghost" id="testServer">Test connection</button><span id="serverStatus" className="muted"></span></div>
        </article>
      </div>
    </section>
  </main>

  {/* Floating trip shortcut: fixed position, so it can never push the one-screen cockpit down.
      Its text is filled in by app.js (live ETA); React never changes it after mount. */}
  <div className="music-fab" id="musicFab" hidden role="group" aria-label="Music controls">
    <button type="button" id="mfPrev" aria-label="Previous song"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2.5v14H6zM20 5v14L9.5 12z" fill="currentColor" /></svg></button>
    <button type="button" id="mfPlay" aria-label="Play"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15L19.5 12z" fill="currentColor" /></svg></button>
    <button type="button" id="mfPause" aria-label="Pause"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 5h4v14h-4zM13.5 5h4v14h-4z" fill="currentColor" /></svg></button>
    <button type="button" id="mfNext" aria-label="Next song"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 5H18v14h-2.5zM4 5v14l10.5-7z" fill="currentColor" /></svg></button>
  </div>
  <button id="tripQuick" className="trip-fab" aria-controls="tripCard"><span aria-hidden="true">⏱</span><span id="tripQuickText">Trip ETA</span></button>
  <button id="fab" className="fab" title="Report wrong-side vehicle" aria-label="Report wrong-side vehicle">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /><circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
  </button>

  <nav className="tabbar" id="tabbar" aria-label="RideLens">
    <button data-view="live" className="active" aria-current="page"><svg viewBox="0 0 24 24"><path d="M4 16a8 8 0 1 1 16 0" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M12 16l4-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>Live</button>
    <button data-view="report"><svg viewBox="0 0 24 24"><path d="M5 19V9M10 19V5M15 19v-7M20 19v-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>Report</button>
    <button data-view="history"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M12 8v4l3 2" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" /></svg>History</button>
    <button data-view="wrongside"><svg viewBox="0 0 24 24"><path d="M12 3l9 16H3z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /><path d="M12 10v4M12 16.5v.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>Wrong-side</button>
    <button data-view="setup"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>Setup</button>
  </nav>

  <dialog id="reportDialog" className="sheet"></dialog>
  <dialog id="clipDialog" className="sheet"></dialog>
  <dialog id="tripDialog" className="sheet">
    <form method="dialog" className="sheet-body" id="tripForm">
      <div className="card-head"><h3>Destination</h3><button className="ghost" value="cancel" formNoValidate>Close</button></div>
      <label>Search a place, or paste: GPS coordinates · a Plus Code (e.g. WHX8+2G Bengaluru) · a Google Maps / Waze link · a what3words address
        <div className="row" style={{ margin: 0 }}><input id="tripQuery" placeholder="e.g. Nandi Hills" autoComplete="off" style={{ flex: 1 }} /><button type="button" className="ghost" id="tripSearch">Search</button></div>
      </label>
      <ul className="results" id="tripResults"></ul>
      <p className="fine" id="tripPicked">No destination chosen.</p>
      <p className="fine" style={{ margin: '4px 0' }}>Or <b>tap the map</b> to drop a pin exactly where you are going:</p>
      <div id="tripMap" className="trip-map"></div>
      <details className="fine"><summary>what3words key (optional)</summary>
        <label>what3words API key <input id="w3wKey" type="password" autoComplete="off" placeholder="from developer.what3words.com" /></label>
        <p>what3words requires a key for converting 3-word addresses to coordinates. It is stored only on this phone. Without a key, use a Plus Code or a dropped pin instead.</p>
      </details>
      <label>Target arrival time (optional) <input type="time" id="tripTime" /></label>
      <div className="row"><button type="button" id="tripStart" disabled>Start trip</button></div>
      <p className="fine">Place search: OpenStreetMap Nominatim. Route and drive time: OSRM on OpenStreetMap data, without live traffic. Waze and Google Maps do not let other apps read their live ETA, so RideLens computes its own and can open either app for turn-by-turn navigation.</p>
      <p className="fine"><b>Note:</b> opening Waze or Google Maps moves RideLens to the background, where browsers pause its sensors, so ride capture stops. On Android, split screen may keep RideLens visible alongside the map.</p>
    </form>
  </dialog>
  <div id="toast" className="toast" role="status" aria-live="polite"></div>

  </>;
}
