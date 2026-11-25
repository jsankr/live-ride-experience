import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CoolantThermometer, Speedometer } from './RideGauges.jsx';
import { useNoise, useWeather } from './useConditions.js';
import { meterStatus, roadStatuses, weatherLabel, windDirection } from './conditions.js';

let cockpitState = { view: 'live', route: [], timeline: [] };
function subscribe(listener) {
  function receive(event) {
    cockpitState = event.detail;
    listener();
  }
  window.addEventListener('ridelens:cockpit', receive);
  return () => window.removeEventListener('ridelens:cockpit', receive);
}
function readCockpit() {
  return cockpitState;
}

const icons = { route: '◇', speed: '◷', rain: '◈', visibility: '◎', wind: '≋', sound: '∿', weather: '◐' };
const number = (value, digits = 0) => Number.isFinite(value) ? value.toFixed(digits) : '—';
const convert = (value, factor, offset = 0) => Number.isFinite(value) ? value * factor + offset : null;

function Metric({ kind, label, value, unit, detail, status }) {
  return <article className={`cockpit-metric glass metric-${kind}`} data-tone={status?.tone}>
    <div className="metric-title"><span aria-hidden="true">{icons[kind]}</span>{label}</div>
    <div className="metric-value">{value}{unit && <small>{unit}</small>}</div>
    {(status?.label || detail) && <div className="metric-caption" title={detail}>{status?.label || detail}</div>}
  </article>;
}

function Plot({ values, min = 0, max, kind = 'speed' }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    function draw() {
      const { clientWidth: width, clientHeight: height } = canvas;
      if (!width || !height) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      const ctx = canvas.getContext('2d');
      ctx.scale(ratio, ratio);
      ctx.strokeStyle = getComputedStyle(canvas).getPropertyValue('--glass-edge');
      for (const y of [0.23, 0.5, 0.77]) {
        ctx.beginPath(); ctx.moveTo(0, height * y); ctx.lineTo(width, height * y); ctx.stroke();
      }
      if (values.length < 2) return;
      const accent = getComputedStyle(canvas).getPropertyValue(kind === 'noise' ? '--cockpit-violet' : '--cockpit-aqua').trim();
      const pin = (value) => height - 4 - ((value - min) / (max - min)) * (height - 8);
      const points = values.map((value, i) => [i * width / (values.length - 1), pin(value)]);
      ctx.beginPath();
      points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
      ctx.lineJoin = 'round';
      ctx.lineWidth = 2;
      ctx.strokeStyle = accent;
      ctx.stroke();
      ctx.lineTo(width, height); ctx.lineTo(0, height); ctx.closePath();
      const fill = ctx.createLinearGradient(0, 0, 0, height);
      fill.addColorStop(0, `${accent}65`);
      fill.addColorStop(1, `${accent}00`);
      ctx.fillStyle = fill;
      ctx.fill();
    }
    const resize = new ResizeObserver(draw);
    resize.observe(canvas);
    draw();
    return () => resize.disconnect();
  }, [values, min, max, kind]);
  return <canvas className="cockpit-plot" ref={ref} aria-hidden="true" />;
}

function Route({ track, onDetails }) {
  const [angled, setAngled] = useState(true);
  const canvas = useRef(null);
  useEffect(() => {
    const ctx = canvas.current.getContext('2d');
    const { width, height } = canvas.current;
    ctx.clearRect(0, 0, width, height);
    if (track.length < 2) return;
    const lon0 = track[0].lon;
    const cos = Math.cos(track[0].lat * Math.PI / 180);
    const xy = track.map(({ lat, lon }) => [(((lon - lon0) + 540) % 360 - 180) * cos, -lat]);
    const xs = xy.map(([x]) => x);
    const ys = xy.map(([, y]) => y);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const dx = Math.max(...xs) - x0;
    const dy = Math.max(...ys) - y0;
    const scale = Math.min((width - 110) / (dx || 1e-9), (height - 94) / (dy || 1e-9));
    const points = xy.map(([x, y]) => [(x - x0 - dx / 2) * scale + width / 2, (y - y0 - dy / 2) * scale + height / 2]);
    ctx.beginPath();
    points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.lineWidth = 5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = '#c4f585'; ctx.shadowColor = '#8be566'; ctx.shadowBlur = 12; ctx.stroke();
    const [x, y] = points.at(-1);
    ctx.beginPath(); ctx.arc(x, y, 8, 0, 2 * Math.PI);
    ctx.fillStyle = '#f2ffda'; ctx.fill();
  }, [track]);
  return <section className="cockpit-route glass" aria-label="Ride route">
    <div className="panel-heading">
      <div><h2>Ride route</h2><p>{track.length < 2 ? 'Waiting for a recorded GPS track' : 'Recorded GPS trace · north up in flat view'}</p></div>
      <div className="route-controls">
        <button className="cockpit-link" onClick={onDetails}>Route map</button>
        <button className="cockpit-control" type="button" aria-label="Toggle route perspective" aria-pressed={angled} onClick={() => setAngled(!angled)}>{angled ? '3D' : 'Flat'}</button>
      </div>
    </div>
    <div className={`route-stage ${angled ? 'route-angled' : ''}`} aria-hidden="true">
      <div className="route-plane"><canvas width="670" height="360" ref={canvas} /></div>
    </div>
  </section>;
}

// The shared location controller updates the readings used by evidence reports.
const AirQuality = React.memo(function AirQuality() {
  return <section className="cockpit-air" aria-labelledby="airHeading">
    <div className="panel-heading">
      <div><h2 id="airHeading">Air pollution</h2><p id="airStatus" role="status">Hourly estimate · uses approximate location</p></div>
      <button className="cockpit-control" id="airToggle" aria-pressed="false">Track air quality</button>
    </div>
    <div className="air-readings" id="airStats" hidden />
  </section>;
});

function Weather({ weather, imperial }) {
  const { data, status, message } = weather;
  const conditions = roadStatuses(data);
  const busy = status === 'loading' || status === 'locating';
  const tempUnit = imperial ? '°F' : '°C';
  const temp = number(convert(data?.temperature_2m, imperial ? 1.8 : 1, imperial ? 32 : 0));
  const weatherWind = number(convert(data?.wind_speed_10m, imperial ? 0.621371 : 1));
  const gust = number(convert(data?.wind_gusts_10m, imperial ? 0.621371 : 1));
  const speedUnit = imperial ? 'mph' : 'km/h';
  const visibility = number(convert(data?.visibility, imperial ? 0.000621371 : 0.001), 1);
  const rain = number(convert(data?.precipitation, imperial ? 1 / 25.4 : 1), imperial ? 2 : 1);
  const time = data?.time ? new Date(`${data.time}Z`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;

  return <section className="cockpit-conditions glass" aria-label="Local weather">
    <div className="panel-heading">
      <div><h2>Road conditions</h2><p role="status">{message || (busy ? (status === 'locating' ? 'Finding location…' : 'Updating weather…') : time ? `Forecast for ${time}` : 'Approximate location shared with Open-Meteo')}</p></div>
      <button className="cockpit-control" disabled={busy} onClick={weather.locate}>{data ? 'Refresh' : 'Get weather'}</button>
    </div>
    <div className="condition-grid">
      <Metric kind="weather" status={conditions.weather} label="Weather" value={temp} unit={tempUnit} detail={data ? weatherLabel(data.weather_code) : 'Location needed'} />
      <Metric kind="visibility" status={conditions.visibility} label="Visibility" value={visibility} unit={imperial ? 'mi' : 'km'} detail="Hourly forecast" />
      <Metric kind="rain" status={conditions.rain} label="Rain chance" value={number(data?.probability)} unit="%" detail={Number.isFinite(data?.precipitation) ? `${rain} ${imperial ? 'in' : 'mm'} precipitation` : 'Hourly forecast'} />
      <Metric kind="wind" status={conditions.wind && { tone: conditions.wind.tone }} label="Wind" value={weatherWind} unit={speedUnit} detail={data ? `${windDirection(data.wind_direction_10m)} · Gusts ${gust} ${speedUnit}${conditions.wind && conditions.wind.tone !== 'good' ? ` · ${conditions.wind.label}` : ''}` : 'At 10 m above ground'} />
    </div>
    <div className="weather-attribution">
      <a href="https://open-meteo.com/en/docs/air-quality-api" target="_blank" rel="noreferrer">Open-Meteo / CAMS</a>
      {status !== 'idle' && <button className="cockpit-link" onClick={weather.clear}>Clear weather</button>}
    </div>
    <AirQuality />
  </section>;
}

function Noise({ noise }) {
  const dialog = useRef(null);
  const [meter, setMeter] = useState(null);
  const band = meterStatus(meter?.value);
  const active = noise.status === 'active';
  const pending = noise.status === 'pending';
  return <section className="cockpit-noise glass" data-tone={band?.tone} aria-label="Ambient noise">
    <div className="panel-heading">
      <div><h2>Ambient noise</h2><p role="status">{noise.message || (pending ? 'Requesting microphone…' : active ? 'Microphone · relative level' : noise.history.length ? 'Mic off · last session' : 'Microphone off')}</p></div>
      <button className="cockpit-control" onClick={active || pending ? noise.disable : noise.start}>{active ? 'Stop' : pending ? 'Cancel' : 'Enable mic'}</button>
    </div>
    <div className="noise-level"><strong>{number(noise.level)}<small>dBFS</small></strong><span>{noise.peak == null ? 'Peak —' : `Peak ${number(noise.peak)} dBFS`}</span></div>
    <Plot values={noise.history} min={-90} max={0} kind="noise" />
    <button className="cockpit-link noise-meter" onClick={() => dialog.current.showModal()}>
      {meter ? `${meter.value} dBA · ${band.label} · Meter` : 'Uncalibrated · Add dBA'}
    </button>
    <dialog ref={dialog} className="sheet" aria-labelledby="noiseMeterTitle">
      <form className="sheet-body" onSubmit={(event) => {
        event.preventDefault();
        const value = new FormData(event.currentTarget).get('soundLevel');
        setMeter(value === '' ? null : { value: Number(value) });
        dialog.current.close();
      }}>
        <h2 id="noiseMeterTitle">Sound-level meter</h2>
        <p>The phone shows relative dBFS. Enter a dBA reading from a calibrated meter to highlight readings above 90 dBA. Exposure risk also depends on duration. No audio is saved.</p>
        <label>Meter reading (dBA)<input key={meter?.value} name="soundLevel" type="number" min="0" max="180" step="0.1" defaultValue={meter?.value ?? ''} /></label>
        <div className="row">
          <button type="submit">Apply reading</button>
          <button type="button" className="ghost" onClick={() => dialog.current.close()}>Cancel</button>
        </div>
      </form>
    </dialog>
  </section>;
}

export function Cockpit() {
  const ride = useSyncExternalStore(subscribe, readCockpit);
  const [details, setDetails] = useState(false);
  const [trend, setTrend] = useState('speed');
  const liveView = ride.view === 'live';
  const { snap, imperial, recording } = ride;
  const speedUnit = imperial ? 'mph' : 'km/h';
  const distanceUnit = imperial ? 'mi' : 'km';
  const distanceFactor = imperial ? 0.621371 : 1;
  const weather = useWeather(recording ? snap?.fix : null, liveView);
  const noise = useNoise(liveView);
  const series = ride.timeline.map((point) => trend === 'speed' ? point.v * distanceFactor : point.vert);
  const trendMax = Math.max(trend === 'speed' ? (imperial ? 40 : 60) : 2, ...series);
  const score = snap?.t && recording ? snap.scores.overall : null;
  const scoreStatus = !Number.isFinite(score) ? null : score >= 75 ? { tone: 'good', label: 'High score' }
    : score >= 50 ? { tone: 'caution', label: 'Fair score' } : { tone: 'danger', label: 'Low score' };
  const elapsed = Math.max(0, Math.floor((snap?.elapsedMs ?? 0) / 1000));
  const elapsedLabel = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  const speed = snap?.speedSrc && snap.speedSrc !== 'none' ? snap.speedKmh * distanceFactor : null;

  function toggleDetails(open, focusMap = false) {
    const panel = document.getElementById('rideDetails');
    panel.hidden = !open;
    setDetails(open);
    if (open) {
      window.dispatchEvent(new Event('ridelens:map-visible'));
      if (focusMap) {
        const map = document.getElementById('liveMap');
        map.focus({ preventScroll: true });
        map.scrollIntoView({ block: 'center' });
      }
    }
  }

  return <div className="cockpit">
    <div className="cockpit-heading">
      <div><h1>Ride dashboard</h1><p>{recording ? `Recording · ${elapsedLabel}` : 'Ready for your next ride'}</p></div>
      <div className="heading-actions">
        {/* Text is filled in by app.js (trip ETA); React never changes it after mount. */}
        <button className="cockpit-control trip-quick" id="tripQuick" aria-controls="tripCard"><span id="tripQuickText">Trip ETA</span></button>
        <button className="cockpit-control detail-toggle" aria-controls="rideDetails" aria-expanded={details} onClick={() => toggleDetails(!details)}>{details ? 'Hide ride details' : 'Ride details'}</button>
      </div>
    </div>
    <div className="ride-metrics">
      <Speedometer speed={speed} unit={speedUnit} imperial={imperial}
        source={speed == null ? null : snap.speedSrc.toUpperCase()} rpm={snap?.obd.fresh ? snap.obd.rpm : null} />
      <CoolantThermometer coolant={snap?.obd.coolant} imperial={imperial} obdFresh={snap?.obd.fresh} />
      <dl className="glass ride-summary">
        <div><dt>Distance</dt><dd>{snap?.fix ? number(snap.distanceKm * distanceFactor, 1) : '—'} <small>{distanceUnit}</small></dd></div>
        <div><dt>Lean</dt><dd>{snap?.t && recording ? number(Math.abs(snap.lean)) : '—'}°{snap?.lean > 1 ? ' R' : snap?.lean < -1 ? ' L' : ''}</dd></div>
        <div data-tone={scoreStatus?.tone}><dt>Ride score</dt><dd title={scoreStatus?.label}>{number(score)}<small>/100</small></dd></div>
      </dl>
    </div>
    <div className="cockpit-panels">
      <Route track={ride.route} onDetails={() => toggleDetails(true, true)} />
      <Weather weather={weather} imperial={imperial} />
      <section className="cockpit-trend glass" aria-label="Recent ride telemetry">
        <div className="panel-heading">
          <div><h2>Telemetry trend</h2><p>Last 30 s · {trend === 'speed' ? speedUnit : 'm/s²'}</p></div>
          <div className="trend-controls" role="group" aria-label="Telemetry metric">
            <button className="cockpit-control" aria-pressed={trend === 'speed'} onClick={() => setTrend('speed')}>Speed</button>
            <button className="cockpit-control" aria-pressed={trend === 'road'} onClick={() => setTrend('road')}>Road</button>
          </div>
        </div>
        <Plot values={series} max={trendMax} />
        <p className="trend-note">{series.length > 1 ? `Range ${number(Math.min(...series), 1)}–${number(Math.max(...series), 1)} ${trend === 'speed' ? speedUnit : 'm/s²'}` : 'Waiting for ride samples'}</p>
      </section>
      <Noise noise={noise} />
    </div>
  </div>;
}
