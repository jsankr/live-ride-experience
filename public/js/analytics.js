import { createSpeedFilter } from './gps-speed.js';
// RideLens analytics engine.
// Pure, dependency-free and DOM-free so it runs identically in the browser
// and in Node (see test/analytics.test.mjs).
//
// Inputs (all timestamps are epoch milliseconds):
//   pushImu(t, acc, gyro)  acc = accelerationIncludingGravity {x,y,z} m/s^2 in the
//                          phone's frame; gyro = rotation rate {x,y,z} deg/s (optional)
//   pushGps(t, fix)        {lat, lon, alt, speed m/s|null, heading deg|null, accuracy m}
//   pushObd(t, data)       {rpm, speed km/h, coolant °C, intake °C, throttle %, load %,
//                          ambient °C, oil °C, voltage V} - any subset
//
// The phone can be mounted at any angle. The engine learns the mount on the fly:
//   * "up" comes from a gravity low-pass that freezes while the bike is accelerating
//   * "forward" is learned by correlating horizontal acceleration with dv/dt from
//     OBD/GPS speed
// Lean angle is NOT observable from the accelerometer on a motorcycle (in a
// coordinated turn the resultant force stays in the bike's plane), so it is
// computed from speed x yaw-rate: lean = atan(v * omega / g).

export const G = 9.80665;

export const DEFAULTS = {
  gravityTau: 3.0,          // s, low-pass for gravity estimate
  gravityFreeze: 0.08 * G,  // freeze gravity while smoothed horizontal accel exceeds this
  longTau: 0.15,            // s, smoothing for longitudinal accel
  jerkTau: 0.1,             // s, smoothing for jerk
  roughWindow: 2.0,         // s, RMS window for vertical vibration
  // Road impacts are judged against the CURRENT road's background vibration, so a rough
  // road (or a shaky handlebar mount) does not turn every jolt into an event.
  impactK: 4.0,             // a jolt must exceed this many times the background RMS...
  impactMinG: 0.5,          // ...and this absolute level (g)
  potholeDipG: 0.35,        // pothole: the wheel drops first, a dip at least this deep (g)...
  potholeDipWindowMs: 200,  // ...within this long before the slam
  bumpDecelKmh: 4,          // speed breaker: compression first, after slowing by this much...
  bumpSlowKmh: 20,          // ...or when already this slow
  bumpMinMs: 60,            // ...and the compression lasted this long (80 ms missed real breakers at 60 samples/s)
  bumpClimbG: 0.15,         // breaker: the front wheel's climb before the crest, at least this (g, 100 ms mean)...
  bumpClimbMs: 450,         // ...within this long before the crest unload
  bumpMaxKmh: 30,           // ...and taken no faster than this (nobody crosses a breaker at 55)
  smallBumpRearK: 0.5,      // small bump taken at speed: rear wheel's hit at least this × the front's...
  smallBumpProminence: 6,   // ...and the front hit this many × the road's background vibration
  potholeMinSpeed: 3,       // m/s
  impactMinGapM: 10,        // at most one pothole/bump per this distance
  wheelbaseM: 1.45,         // front then rear wheel hit the same spot this far apart (T120 ≈ 1.45 m)
  requireRearHit: true,     // confirm every pothole/breaker by the rear wheel's repeat hit
  roughCount: 3,            // this many unexplained jolts within roughWindowMs = a rough stretch
  roughWindowMs: 10000,
  hardBrake: 0.35 * G,      // m/s^2
  emergencyBrake: 0.6 * G,
  hardAccel: 0.35 * G,
  eventMinMs: 300,
  gearTol: 0.07,            // relative tolerance to match a gear ratio
  clutchMinMs: 120,
  clutchMaxMs: 4000,
  overheatC: 105,
  crashG: 4.0,              // total linear acceleration (g) treated as a crash-level impact...
  crashConfirmMs: 6000,     // ...but only if, within this time, the bike nearly stops or falls over:
  crashStopKmh: 10,         // a handlebar-mounted phone sees 4-6 g spikes at speed from vibration alone
  longConfirmKmh: 4,        // hard brake / acceleration must change GPS/OBD speed by at least this
  fallAngleDeg: 55,         // phone's measured 'down' tilted this far from the learned upright...
  fallMs: 1500,             // ...for this long = bike on its side
  mountLearnWeight: 10,     // evidence needed before trusting the learned forward axis
  // Gyro sign conventions differ between browsers (e.g. iOS vs Android). By default the
  // sign is learned from GPS heading changes; set true/false only to force it.
  invertYaw: null,
};

// ISO 2631-1 Annex C comfort reactions (overall vibration, m/s^2 r.m.s.).
// Our RMS is not frequency-weighted, so treat the label as indicative.
// Six ISO bands share four status colours; only 'Comfortable' is green, so a
// green pill or map segment always means the same thing. The map legend is
// built from this table (comfortLegend) so the two cannot drift apart.
export const COMFORT = [
  [0.315, 'Comfortable', 'good'],
  [0.63, 'A little uncomfortable', 'warning'],
  [1.0, 'Fairly uncomfortable', 'serious'],
  [1.6, 'Uncomfortable', 'serious'],
  [2.5, 'Very uncomfortable', 'critical'],
  [Infinity, 'Extremely uncomfortable', 'critical'],
];

// One legend row per colour: [status, label, upper limit in m/s^2 or Infinity]
export function comfortLegend() {
  const rows = [];
  for (const [lim, label, status] of COMFORT) {
    const last = rows[rows.length - 1];
    if (last && last[0] === status) { last[1] = `${last[1].split(' / ')[0]} / ${label.toLowerCase()}`; last[2] = lim; }
    else rows.push([status, label, lim]);
  }
  return rows;
}

export function comfortClass(rms) {
  for (const [lim, label, status] of COMFORT) if (rms < lim) return { label, status };
  return { label: 'Extremely uncomfortable', status: 'critical' };
}

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = (a) => Math.hypot(a.x, a.y, a.z);
const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const unit = (a) => { const n = norm(a) || 1; return scale(a, 1 / n); };
const ema = (prev, x, dt, tau) => (prev == null ? x : prev + (x - prev) * (1 - Math.exp(-dt / tau)));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const D2R = Math.PI / 180;

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * D2R, dLon = (lon2 - lon1) * D2R;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function angleDiff(a, b) { // degrees, result in (-180, 180]
  let d = a - b;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}

export function createAnalyzer(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const speedFilter = createSpeedFilter();
  const s = {
    startT: null, lastImuT: null, rawImuTs: [],
    gravity: null, up: null,
    fwdAcc: { x: 0, y: 0, z: 0 }, fwdWeight: 0, fwd: null,
    longRaw: 0, long: 0, lat: 0, prevLong: null, jerk: 0,
    jerkSq: 0, jerkN: 0,
    vert: 0, vertBase: null, vertBuf: [], roughRms: 0, roughSqSum: 0, roughN: 0,
    yawRate: 0, gyroYaw: null, gyroYawT: 0, lean: 0, maxLeanL: 0, maxLeanR: 0,
    gpsYaw: null, gpsYawT: 0, gyroSum: 0, gyroN: 0, yawCorr: 0,
    yawSign: options.invertYaw == null ? 0 : options.invertYaw ? -1 : 1, // 0 = not learned yet
    // speed
    speed: 0, speedSrc: 'none', speedHist: [], refAccel: null, refAccelT: 0, obdSpeedT: 0,
    maxSpeed: 0, speedSum: 0, speedN: 0,
    // position
    fix: null, lastTrackT: 0, distance: 0, alt: null, altRef: null, ascent: 0, descent: 0,
    minAlt: Infinity, maxAlt: -Infinity,
    // events
    events: [], pendingImpact: null, lastImpactT: 0,
    longEvent: null,
    // obd
    obd: {}, obdT: 0, ratioBuf: [], gears: [], gear: null, engaged: false,
    clutch: null, shifts: [], clutchMs: 0, movingMs: 0, lastOverheatT: 0,
    // series
    track: [], timeline: [], lastTimelineT: 0,
    maxCoolant: null, peakG: 0,
  };

  function emit(type, t, extra = {}) {
    const ev = {
      id: `${type}-${t}-${s.events.length}`,
      type, t,
      lat: s.fix?.lat ?? null, lon: s.fix?.lon ?? null,
      speedKmh: +(s.speed * 3.6).toFixed(1),
      ...extra,
    };
    s.events.push(ev);
    listeners.forEach((fn) => fn(ev));
    return ev;
  }
  const listeners = new Set();

  // ---------- speed & reference acceleration ----------
  function pushSpeed(t, v, src) {
    if (src === 'gps' && t - s.obdSpeedT < 2000) return; // prefer OBD
    if (src === 'obd') s.obdSpeedT = t;
    s.speed = v; s.speedSrc = src;
    s.speedHist.push({ t, v });
    while (s.speedHist.length > 2 && t - s.speedHist[0].t > 1500) s.speedHist.shift();
    const first = s.speedHist[0];
    if (t - first.t >= 400) {
      s.refAccel = (v - first.v) / ((t - first.t) / 1000);
      s.refAccelT = t;
    }
    if (v > s.maxSpeed) s.maxSpeed = v;
    if (v > 1) { s.speedSum += v; s.speedN++; }
  }

  // ---------- IMU ----------
  // A busy page (camera + 4K dashcam) gets its motion events in bursts: on the 27 Nov 12:50
  // ride ~8 samples at a time shared one timestamp, 7 deliveries a second. Impact timing (the
  // rear wheel's repeat, how long a breaker compresses) then collapses to zero. The sensor
  // itself kept its rate (60/s), so a burst is spread back out at that rate.
  function sensorTime(raw) {
    const rb = s.rawImuTs;
    rb.push(raw);
    while (rb.length > 2 && raw - rb[0] > 2000) rb.shift();
    const iv = rb.length > 10 && raw > rb[0] ? clamp((raw - rb[0]) / (rb.length - 1), 4, 50) : 16.7;
    s.imuN = (s.imuN || 0) + 1;
    if (s.lastImuT != null && raw - s.lastImuT < 0.5 * iv) { s.imuSpread = (s.imuSpread || 0) + 1; return Math.min(s.lastImuT + iv, raw + 1000); }
    return raw;
  }

  function pushImu(tRaw, acc, gyro) {
    const t = sensorTime(tRaw);
    if (s.startT == null) s.startT = t;
    const dt = s.lastImuT == null ? 0.02 : clamp((t - s.lastImuT) / 1000, 0.001, 0.2);
    s.lastImuT = t;

    // 1. gravity / up vector
    // Only adapt "up" while the bike is not accelerating, otherwise sustained
    // throttle/braking tilts the estimate and leaks into every other channel.
    // A lean is fine: the resultant stays on the bike's own vertical axis.
    if (!s.gravity) { s.gravity = { ...acc }; s.accSmooth = { ...acc }; }
    s.accSmooth = add(s.accSmooth, scale(sub(acc, s.accSmooth), 1 - Math.exp(-dt / 0.5)));
    const upNow = unit(s.gravity);
    const linS = sub(s.accSmooth, s.gravity);
    const linSH = norm(sub(linS, scale(upNow, dot(linS, upNow))));
    // With a speed reference (OBD/GPS) trust it: steady speed => update.
    // Without one, fall back to "smoothed horizontal accel is small".
    const refLive = s.refAccel != null && t - s.refAccelT < 1500;
    const steady = refLive ? Math.abs(s.refAccel) < 0.5 : linSH < cfg.gravityFreeze;
    const warmup = t - s.startT < 3000;
    if (warmup || (steady && s.tiltSince == null)) {
      const k = 1 - Math.exp(-dt / (warmup ? 0.5 : cfg.gravityTau));
      s.gravity = add(s.gravity, scale(sub(s.accSmooth, s.gravity), k));
    }
    s.up = unit(s.gravity);
    const lin = sub(acc, s.gravity);
    const vertRaw = dot(lin, s.up);
    const horiz = sub(lin, scale(s.up, vertRaw));
    // high-pass: in a lean the load factor adds a slow +g(1/cos(lean)-1) offset
    s.vertBase = ema(s.vertBase, vertRaw, dt, 0.6);
    const vert = vertRaw - s.vertBase;
    s.vert = vert;

    // 2. learn forward axis from reference acceleration
    const refFresh = s.refAccel != null && t - s.refAccelT < 1500;
    if (refFresh && Math.abs(s.refAccel) > 0.8 && norm(horiz) > 0.5) {
      const w = Math.min(Math.abs(s.refAccel), 4);
      s.fwdAcc = add(s.fwdAcc, scale(horiz, Math.sign(s.refAccel) * w));
      s.fwdWeight += w * dt;
      const proj = sub(s.fwdAcc, scale(s.up, dot(s.fwdAcc, s.up)));
      if (norm(proj) > 0) s.fwd = unit(proj);
    }

    // 3. longitudinal / lateral components
    let longRaw;
    if (s.fwd && s.fwdWeight > cfg.mountLearnWeight) {
      longRaw = dot(horiz, s.fwd);
      s.lat = norm(sub(horiz, scale(s.fwd, longRaw)));
    } else {
      longRaw = refFresh ? s.refAccel : 0;
      s.lat = 0;
    }
    s.longRaw = longRaw;
    s.long = ema(s.long, longRaw, dt, cfg.longTau);
    if (s.prevLong != null) {
      const j = (s.long - s.prevLong) / dt;
      s.jerk = ema(s.jerk, j, dt, cfg.jerkTau);
      if (s.speed > 2) { s.jerkSq += s.jerk * s.jerk; s.jerkN++; }
    }
    s.prevLong = s.long;
    const gTotal = Math.hypot(s.long, s.speed * s.yawRate) / G;
    if (s.speed > 2 && gTotal > s.peakG) s.peakG = gTotal;

    // 4. yaw rate & lean angle
    if (gyro && (gyro.x || gyro.y || gyro.z)) {
      const w = scale(gyro, D2R);
      const raw = -dot(w, s.up);
      s.gyroSum += raw; s.gyroN++;
      s.gyroYaw = raw * (s.yawSign || 1); s.gyroYawT = t; // + = right turn once sign is known
    }
    // The phone is fixed to the bike, so the gyro measures yaw about the *bike's*
    // up axis: w_meas = w * cos(lean). With tan(lean) = v*w/g this gives
    // v*w_meas/g = sin(lean)  ->  lean = asin(v*w_meas/g). GPS yaw is world-frame -> atan.
    // until the gyro's sign is learned, fall back to GPS heading rate (slower but sign-safe)
    const useGyro = s.yawSign !== 0 && s.gyroYaw != null && t - s.gyroYawT < 500;
    const yaw = useGyro ? s.gyroYaw : s.gpsYaw != null && t - s.gpsYawT < 3000 ? s.gpsYaw : 0;
    s.yawRate = ema(s.yawRate, yaw, dt, 0.25);
    const m = (s.speed * s.yawRate) / G;
    const leanTarget = s.speed > 2 ? (useGyro ? Math.asin(clamp(m, -1, 1)) : Math.atan(m)) / D2R : 0;
    s.lean = ema(s.lean, clamp(leanTarget, -65, 65), dt, 0.2);
    if (s.speed > 3) {
      if (s.lean < s.maxLeanL) s.maxLeanL = s.lean;
      if (s.lean > s.maxLeanR) s.maxLeanR = s.lean;
    }

    // 5. road roughness (RMS vertical over window)
    s.vertBuf.push({ t, v: vert });
    s.roughSqSum += vert * vert;
    while (s.vertBuf.length && t - s.vertBuf[0].t > cfg.roughWindow * 1000) {
      const o = s.vertBuf.shift(); s.roughSqSum -= o.v * o.v;
    }
    s.roughRms = Math.sqrt(Math.max(0, s.roughSqSum) / Math.max(1, s.vertBuf.length));

    // 6. potholes & bumps
    cfg.onVert?.(t, vert, s.speed);
    detectImpact(t, vert, dt);
    detectCrash(t, lin);
    // 7. braking / acceleration
    detectLong(t);
    // 8. timeline sample at 2 Hz
    if (t - s.lastTimelineT >= 500) { s.lastTimelineT = t; sampleTimeline(t); }
  }

  // Crash-level impact and fall detection, used by the dashcam to lock footage.
  // A phone fixed to the bike sees gravity along the bike's own vertical even in a lean,
  // so a large, sustained tilt of measured gravity away from the learned 'up' means the
  // bike is lying on its side.
  function detectCrash(t, lin) {
    const g = norm(lin) / G;
    const pc = s.pendingCrash;
    if (pc) {
      pc.peakG = Math.max(pc.peakG, g);
      // confirmed when the bike (nearly) stops, or falls over (see below), soon after the hit
      if (s.speedSrc !== 'none' && s.speed * 3.6 <= cfg.crashStopKmh && t - pc.t > 1000) {
        s.pendingCrash = null;
        emit('crash', pc.t, { severity: 'critical', peakG: +pc.peakG.toFixed(1), fromKmh: pc.fromKmh, confirmedBy: 'stopped' });
      } else if (t - pc.t > cfg.crashConfirmMs) { s.pendingCrash = null; s.rejectedCrashes = (s.rejectedCrashes || 0) + 1; }
    }
    if (g >= cfg.crashG && !s.pendingCrash && t - (s.lastCrashT || 0) > 10000) {
      s.lastCrashT = t;
      const fromKmh = s.speedSrc !== 'none' ? Math.round(s.speed * 3.6) : null;
      // already (nearly) stationary, e.g. hit while waiting at a signal: no stop to wait for
      if (fromKmh != null && fromKmh <= cfg.crashStopKmh) emit('crash', t, { severity: 'critical', peakG: +g.toFixed(1), fromKmh, confirmedBy: 'stationary' });
      else s.pendingCrash = { t, peakG: g, fromKmh };
    }
    if (!s.up || !s.accSmooth || t - s.startT < 5000) return;
    const cos = dot(unit(s.accSmooth), s.up);
    const angle = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
    if (angle >= cfg.fallAngleDeg) {
      s.tiltSince ??= t;
      if (!s.fallFired && t - s.tiltSince >= cfg.fallMs) {
        s.fallFired = true;
        const pc = s.pendingCrash;
        if (pc) { s.pendingCrash = null; emit('crash', pc.t, { severity: 'critical', peakG: +pc.peakG.toFixed(1), fromKmh: pc.fromKmh, confirmedBy: 'fall' }); }
        emit('fall', s.tiltSince, { severity: 'critical', tiltDeg: Math.round(angle) });
      }
    } else { s.tiltSince = null; s.fallFired = false; }
  }

  function detectImpact(t, vert, dt) {
    // background vibration: slow RMS of the vertical signal, frozen during an impact
    if (!s.pendingImpact) s.bgSq = s.bgSq == null ? vert * vert : s.bgSq + (vert * vert - s.bgSq) * (1 - Math.exp(-dt / 6));
    const bg = Math.sqrt(s.bgSq || 0);
    const p = s.pendingImpact;
    if (p) {
      p.samples.push({ t, v: vert });
      if (t >= p.deadline) { s.pendingImpact = null; classifyImpact(p); }
      return;
    }
    closeRoughPatch(t);
    if (s.speed < cfg.potholeMinSpeed) return;
    if (Math.abs(vert) < Math.max(cfg.impactMinG * G, cfg.impactK * bg)) return;
    if (t - (s.lastTriggerT || 0) < 300) return;
    s.lastTriggerT = t;
    // wait long enough to also see the rear wheel reach the same spot
    const rearMs = (cfg.wheelbaseM / Math.max(s.speed, 1)) * 1000;
    s.pendingImpact = {
      t, bg, rearMs, deadline: t + Math.min(1500, Math.max(400, rearMs * 1.35 + 250)),
      samples: s.vertBuf.filter((b) => t - b.t <= 700).map((b) => ({ t: b.t, v: b.v })),
    };
  }

  function speedKmhAgo(t, fromMs, toMs) { // highest speed seen fromMs..toMs before t (1 Hz track)
    let v = null;
    for (let i = s.track.length - 1; i >= 0; i--) {
      const age = t - s.track[i].t;
      if (age > fromMs) break;
      if (age >= toMs) v = Math.max(v ?? 0, s.track[i].v);
    }
    return v;
  }

  function classifyImpact(p) {
    const all = p.samples;
    const smp = all.filter((x) => x.t >= p.t - 300 && x.t <= p.t + 400); // the front-wheel hit
    let iMin = 0, iMax = 0;
    smp.forEach((x, i) => { if (x.v < smp[iMin].v) iMin = i; if (x.v > smp[iMax].v) iMax = i; });
    const minV = smp[iMin].v, maxV = smp[iMax].v;
    const bg = Math.max(p.bg, 0.05 * G);
    const p2pG = (maxV - minV) / G;
    const prominence = Math.max(-minV, maxV) / bg;
    const nowKmh = s.speed * 3.6;
    // did the rear wheel hit the same spot one wheelbase later? (random jolts don't repeat on cue)
    const tPeak = smp[iMax].t;
    const rear = all.filter((x) => x.t >= tPeak + 0.65 * p.rearMs && x.t <= tPeak + 1.35 * p.rearMs);
    const rearPeak = rear.length ? Math.max(...rear.map((x) => Math.abs(x.v))) : 0;
    const rearHit = rearPeak >= Math.max(0.3 * maxV, 2.5 * bg);
    const jolts = (s.jolts || []).filter((x) => p.t - x < cfg.roughWindowMs);
    const onRough = jolts.length >= cfg.roughCount - 1;
    // on a rough stretch an event must also stand out above the jolts this road keeps making
    s.joltPeaks = (s.joltPeaks || []).filter((x) => p.t - x.t < 30000);
    const joltMax = s.joltPeaks.length ? Math.max(...s.joltPeaks.map((x) => x.g)) : 0;
    const unexplained = () => { // a jolt that isn't a pothole or breaker: evidence of a rough stretch
      s.joltPeaks.push({ t: p.t, g: Math.max(-minV, maxV) / G });
      s.jolts = [...jolts, p.t];
      if (s.jolts.length >= cfg.roughCount) {
        s.rough ??= { t0: s.jolts[0], lat: s.fix?.lat ?? null, lon: s.fix?.lon ?? null, peakG: 0, jolts: 0 };
        s.rough.jolts = s.jolts.length > s.rough.jolts ? s.rough.jolts + 1 : s.rough.jolts + 1;
        s.rough.peakG = Math.max(s.rough.peakG, p2pG); s.rough.lastT = p.t;
      }
    };
    // pothole = the wheel drops BEFORE the big compression; rebound and the rear wheel's hit
    // come after the spike, so only the part before the peak counts as the drop
    // ...and only IMMEDIATELY before it (a wheel crosses a hole in tens of ms): an earlier dip is
    // fork dive from braking for a speed breaker, which made breakers look like potholes
    let minBefore = 0, tDip = null;
    for (let i = 0; i < iMax; i++) if (smp[iMax].t - smp[i].t <= cfg.potholeDipWindowMs && smp[i].v < minBefore) { minBefore = smp[i].v; tDip = smp[i].t; }
    const dipLevel = Math.max(cfg.potholeDipG * G, 2.5 * bg);
    const dip = -minBefore >= dipLevel;
    // A speed breaker seen by the front wheel: it CLIMBS (a sustained compression), unloads over
    // the crest, then lands. The crest's unload looks like a pothole's drop, so a ride on 27 Nov
    // logged breakers as potholes. A pothole drops out of level road: nothing climbs first.
    let climb = 0;
    if (tDip != null) {
      const pre = all.filter((x) => x.t >= tDip - cfg.bumpClimbMs && x.t <= tDip - 40);
      for (let i = 0; i < pre.length; i++) {
        let sum = 0, n = 0;
        for (let j = i; j < pre.length && pre[j].t - pre[i].t <= 100; j++) { sum += pre[j].v; n++; }
        if (n >= 3) climb = Math.max(climb, sum / n);
      }
    }
    const climbed = climb >= Math.max(cfg.bumpClimbG * G, bg);
    // compression first: how long the compression lasted (a ramp takes time to climb; a sharp
    // ridge or rut does not) and whether the rider slowed for it
    let dur = 0;
    for (let i = iMax; i >= 0 && smp[i].v > 0.4 * maxV; i--) dur = smp[iMax].t - smp[i].t;
    for (let i = iMax; i < smp.length && smp[i].v > 0.4 * maxV; i++) dur += i > iMax ? smp[i].t - smp[i - 1].t : 0;
    const before = speedKmhAgo(p.t, 8000, 1500);
    const slowed = before != null && before - nowKmh >= cfg.bumpDecelKmh;
    const slowFor = slowed || nowKmh <= cfg.bumpSlowKmh; // riders slow down for breakers
    const quiet = jolts.length === 0; // no unexplained jolt in the last 10 s: not a rough patch starting
    // the rear wheel's hit on a bump is a compression too (a random jolt is either sign)
    const rearK = (rear.length ? Math.max(...rear.map((x) => x.v)) : 0) / Math.max(maxV, 1e-6);
    let kind = null;
    if (dip) kind = slowFor && climbed && nowKmh <= cfg.bumpMaxKmh && quiet ? 'bump' : 'pothole';
    // (after recent jolts the old, stricter 80 ms: random jolts there are 30-60 ms long)
    else if (slowFor && dur >= (quiet ? cfg.bumpMinMs : 80)) kind = 'bump';
    // a small hump, raised joint or rumble strip taken without slowing: a clean compression on
    // level road, repeated by the rear wheel about as hard (random jolts do not repeat on cue)
    else if (quiet && rearHit && rearK >= cfg.smallBumpRearK && rearK <= 1 / cfg.smallBumpRearK && prominence >= cfg.smallBumpProminence) kind = 'bump';
    const shape = kind;
    // on a rough stretch, the shape alone is not enough: require the rear-wheel repeat
    if (kind && !rearHit && (onRough || cfg.requireRearHit)) kind = null;
    if (kind === 'pothole' && onRough && maxV / G < 1.25 * joltMax) kind = null; // breakers have slow-down + duration instead
    cfg.onClassify?.({ t: p.t, minBeforeG: minBefore / G, maxG: maxV / G, bgG: bg / G, dip, climbG: climb / G, shape, kind, rearHit, rearK, onRough, kmh: nowKmh, before, slowed, dur, p2pG, prominence });
    if (!kind) { unexplained(); return; }
    if (s.lastImpactPos && s.fix) {
      const d = haversine(s.lastImpactPos.lat, s.lastImpactPos.lon, s.fix.lat, s.fix.lon);
      if (d < cfg.impactMinGapM && p.t - s.lastImpactT < 10000) return;
    }
    s.lastImpactT = p.t;
    if (s.fix) s.lastImpactPos = { lat: s.fix.lat, lon: s.fix.lon };
    const severity = p2pG < 1.2 ? 'minor' : p2pG < 2.0 ? 'moderate' : 'severe';
    // breaker: the rider slowed for it; small: a hump, joint or strip taken at speed
    emit(kind, p.t, { severity, ...(kind === 'bump' ? { form: slowFor && nowKmh <= cfg.bumpMaxKmh ? 'breaker' : 'small' } : {}), peakG: +(Math.max(-minV, maxV) / G).toFixed(2), p2pG: +p2pG.toFixed(2), prominence: +prominence.toFixed(1) });
  }

  function closeRoughPatch(t) {
    const r = s.rough;
    if (!r || t - r.lastT < cfg.roughWindowMs) return;
    s.rough = null;
    const startPt = s.track.find((q) => q.t >= r.t0) || null;
    const endPt = [...s.track].reverse().find((q) => q.t <= r.lastT) || null;
    const lengthM = startPt && endPt ? Math.round(haversine(startPt.lat, startPt.lon, endPt.lat, endPt.lon)) : null;
    emit('rough', r.t0, {
      severity: r.peakG >= 2 ? 'serious' : 'warning', endT: r.lastT, jolts: r.jolts, peakG: +r.peakG.toFixed(2), lengthM,
      lat: startPt?.lat ?? r.lat, lon: startPt?.lon ?? r.lon, endLat: endPt?.lat ?? null, endLon: endPt?.lon ?? null,
    });
  }

  // A candidate hard brake/acceleration is held until the speed source has caught up
  // (GPS lags ~1 s), then kept only if the speed really changed: handlebar vibration
  // alone can push the accelerometer past 0.35 g without the bike slowing at all.
  function confirmLong(t) {
    while (s.pendingLong.length && t >= s.pendingLong[0].due) {
      const c = s.pendingLong.shift();
      const change = c.kind === 'brake' ? c.v0 - c.vMin : c.vMax - c.v0; // m/s
      const expected = 0.6 * Math.abs(c.peak) * (c.dur / 1000); // m/s if the peak were held at 60 %
      if (s.speedSrc === 'none' || change * 3.6 >= Math.max(cfg.longConfirmKmh, 0.5 * expected * 3.6)) {
        emit(c.kind, c.t0, c.kind === 'brake' ? {
          severity: Math.abs(c.peak) >= cfg.emergencyBrake ? 'severe' : 'moderate',
          peakG: +(Math.abs(c.peak) / G).toFixed(2), durationMs: c.dur,
          fromKmh: +(c.v0 * 3.6).toFixed(1), toKmh: +(c.vMin * 3.6).toFixed(1),
        } : {
          severity: Math.abs(c.peak) / G > 0.5 ? 'severe' : 'moderate', peakG: +(Math.abs(c.peak) / G).toFixed(2), durationMs: c.dur,
          fromKmh: +(c.v0 * 3.6).toFixed(1), toKmh: +(c.vMax * 3.6).toFixed(1),
        });
      } else s.rejectedLong = (s.rejectedLong || 0) + 1;
    }
    for (const c of s.pendingLong) { c.vMin = Math.min(c.vMin, s.speed); c.vMax = Math.max(c.vMax, s.speed); }
  }

  function detectLong(t) {
    s.pendingLong ||= [];
    confirmLong(t);
    const a = s.long;
    const e = s.longEvent;
    if (!e) {
      if (s.speed < 2) return;
      if (a <= -cfg.hardBrake) s.longEvent = { kind: 'brake', t0: t, peak: a, v0: s.speed };
      else if (a >= cfg.hardAccel) s.longEvent = { kind: 'accel', t0: t, peak: a, v0: s.speed };
      return;
    }
    if (e.kind === 'brake') e.peak = Math.min(e.peak, a); else e.peak = Math.max(e.peak, a);
    const ended = e.kind === 'brake' ? a > -cfg.hardBrake * 0.6 : a < cfg.hardAccel * 0.6;
    if (!ended) return;
    const dur = t - e.t0;
    s.longEvent = null;
    if (dur < cfg.eventMinMs) return;
    // speed before the event: the oldest recent sample (GPS lags, so look back ~1.5 s)
    const v0 = Math.max(e.v0, s.speedHist[0]?.v ?? e.v0);
    const vb = e.kind === 'brake' ? v0 : Math.min(e.v0, s.speedHist[0]?.v ?? e.v0);
    s.pendingLong.push({ kind: e.kind, t0: e.t0, peak: e.peak, dur, v0: vb, vMin: s.speed, vMax: s.speed, due: t + 2500 });
  }

  // ---------- GPS ----------
  function pushGps(t, fix) {
    if (s.startT == null) s.startT = t;
    const prev = s.fix;
    // Safari reports -1 / NaN for "unknown" speed and heading; normalise to null
    // Speed and distance only from real travel: standing still, GPS wander reads 0 km/h and
    // adds no distance (see gps-speed.js). Safari's -1 / NaN "unknown" values are handled there.
    const sf = speedFilter(t, fix);
    const speed = sf.speed;
    fix = { ...fix, heading: Number.isFinite(fix.heading) && fix.heading >= 0 ? fix.heading : null };
    if (prev && !sf.jump) s.distance += sf.stepM;
    let heading = fix.heading;
    if ((heading == null || Number.isNaN(heading)) && prev) {
      const y = Math.sin((fix.lon - prev.lon) * D2R) * Math.cos(fix.lat * D2R);
      const x = Math.cos(prev.lat * D2R) * Math.sin(fix.lat * D2R)
        - Math.sin(prev.lat * D2R) * Math.cos(fix.lat * D2R) * Math.cos((fix.lon - prev.lon) * D2R);
      heading = (Math.atan2(y, x) / D2R + 360) % 360;
    }
    if (prev && prev.heading != null && heading != null && (speed ?? 0) > 3) {
      const dts = (t - prev.t) / 1000;
      // + yaw = turning right (heading grows clockwise); + lean = leaning right
      if (dts > 0) { s.gpsYaw = angleDiff(heading, prev.heading) * D2R / dts; s.gpsYawT = t; }
      // learn the gyro sign: correlate mean gyro yaw over this GPS interval with GPS yaw
      if (dts > 0 && s.gyroN > 5 && Math.abs(s.gpsYaw) > 0.05 && cfg.invertYaw == null) {
        s.yawCorr += (s.gyroSum / s.gyroN) * s.gpsYaw;
        if (Math.abs(s.yawCorr) > 0.05) s.yawSign = s.yawCorr > 0 ? 1 : -1;
      }
    }
    s.gyroSum = 0; s.gyroN = 0;
    s.fix = { ...fix, heading, t };
    pushSpeed(t, speed, 'gps');

    if (fix.alt != null && (fix.altitudeAccuracy == null || fix.altitudeAccuracy < 30)) {
      s.alt = s.alt == null ? fix.alt : s.alt + (fix.alt - s.alt) * 0.2;
      if (s.altRef == null) s.altRef = s.alt;
      const d = s.alt - s.altRef;
      if (d > 3) { s.ascent += d; s.altRef = s.alt; } else if (d < -3) { s.descent -= d; s.altRef = s.alt; }
      s.minAlt = Math.min(s.minAlt, s.alt); s.maxAlt = Math.max(s.maxAlt, s.alt);
    }
    if (t - s.lastTrackT >= 1000) {
      s.lastTrackT = t;
      s.track.push({
        t, lat: fix.lat, lon: fix.lon, alt: s.alt != null ? +s.alt.toFixed(1) : null,
        v: +(s.speed * 3.6).toFixed(1), rough: +s.roughRms.toFixed(2), lean: +s.lean.toFixed(1),
      });
    }
  }

  // ---------- OBD ----------
  function pushObd(t, data) {
    if (s.startT == null) s.startT = t;
    Object.assign(s.obd, data); s.obdT = t;
    if (data.speed != null) pushSpeed(t, data.speed / 3.6, 'obd');
    if (data.coolant != null) {
      s.maxCoolant = Math.max(s.maxCoolant ?? -Infinity, data.coolant);
      if (data.coolant >= cfg.overheatC && t - s.lastOverheatT > 60000) {
        s.lastOverheatT = t;
        emit('overheat', t, { severity: 'severe', coolant: data.coolant });
      }
    }
    if (data.rpm != null) inferGear(t, data.rpm);
  }

  function matchGear(ratio) {
    let best = null;
    for (let i = 0; i < s.gears.length; i++) {
      const err = Math.abs(ratio - s.gears[i].ratio) / s.gears[i].ratio;
      if (err < cfg.gearTol && (!best || err < best.err)) best = { i, err };
    }
    return best;
  }
  function gearNumber(i) { // gear 1 = highest rpm/speed ratio
    const order = [...s.gears].map((g, idx) => ({ r: g.ratio, idx })).sort((a, b) => b.r - a.r);
    return order.findIndex((o) => o.idx === i) + 1;
  }

  function inferGear(t, rpm) {
    const kmh = s.speed * 3.6;
    const dt = s.prevObdT ? Math.min(1000, t - s.prevObdT) : 0;
    s.prevObdT = t;
    if (kmh < 6 || rpm < 600) { s.ratioBuf = []; s.gear = kmh < 1 ? null : s.gear; s.engaged = false; s.clutch = null; return; }
    s.movingMs += dt;
    const ratio = rpm / kmh;
    s.ratioBuf.push(ratio);
    if (s.ratioBuf.length > 6) s.ratioBuf.shift();

    // learn gear clusters from stable ratios
    if (s.ratioBuf.length >= 5 && rpm > 1200) {
      const m = s.ratioBuf.reduce((a, b) => a + b, 0) / s.ratioBuf.length;
      const sd = Math.sqrt(s.ratioBuf.reduce((a, b) => a + (b - m) ** 2, 0) / s.ratioBuf.length);
      if (sd / m < 0.025) {
        const hit = matchGear(m);
        if (hit) {
          const g = s.gears[hit.i];
          g.n = Math.min(g.n + 1, 200);
          g.ratio += (m - g.ratio) / g.n;
        } else if (s.gears.length < 6) {
          s.gears.push({ ratio: m, n: 1 });
        }
      }
    }

    const hit = matchGear(ratio);
    const engaged = !!hit;
    if (engaged) {
      const gnum = gearNumber(hit.i);
      if (s.clutch) {
        const dur = t - s.clutch.t0;
        if (dur >= cfg.clutchMinMs && dur <= cfg.clutchMaxMs) {
          const from = s.clutch.from, to = gnum;
          const kind = from == null ? 'engage' : to > from ? 'upshift' : to < from ? 'downshift' : 'clutch';
          const ev = emit('shift', s.clutch.t0, { kind, from, to, durationMs: dur, severity: 'info' });
          s.shifts.push(ev);
        } else if (dur > cfg.clutchMaxMs) {
          emit('coast', s.clutch.t0, { durationMs: dur, severity: 'minor', note: 'Coasting with clutch in / neutral' });
        }
        s.clutch = null;
      }
      s.gear = gnum;
    } else if (s.gears.length && !s.clutch) {
      s.clutch = { t0: t, from: s.gear };
    }
    if (!engaged && s.gears.length) s.clutchMs += dt;
    s.engaged = engaged;
  }

  // ---------- series ----------
  function sampleTimeline(t) {
    s.timeline.push({
      t,
      v: +(s.speed * 3.6).toFixed(1),
      long: +(s.long / G).toFixed(3),
      lat: +((s.speed * s.yawRate) / G).toFixed(3),
      vert: +(s.roughRms).toFixed(3),
      jerk: +s.jerk.toFixed(2),
      lean: +s.lean.toFixed(1),
      rpm: s.obd.rpm != null && t - s.obdT < 3000 ? Math.round(s.obd.rpm) : null,
      gear: s.engaged ? s.gear : null,
      clutch: !!s.clutch,
      thr: s.obd.throttle != null ? Math.round(s.obd.throttle) : null,
      cool: s.obd.coolant ?? null,
      alt: s.alt != null ? +s.alt.toFixed(1) : null,
    });
  }

  // ---------- outputs ----------
  function snapshot() {
    const comfort = comfortClass(s.roughRms);
    return {
      t: s.lastImuT ?? s.fix?.t ?? null,
      speedKmh: s.speed * 3.6, speedSrc: s.speedSrc,
      longG: s.long / G,
      // A leaned bike feels ~0 sideways force in its own frame, so the phone can't
      // measure cornering g directly. Use the ground-frame value v*omega/g (signed, + = right).
      latG: (s.speed * s.yawRate) / G, vertMs2: s.vert, jerk: s.jerk,
      lean: s.lean, yawRate: s.yawRate,
      roughRms: s.roughRms, comfort,
      fix: s.fix, alt: s.alt, ascent: s.ascent, descent: s.descent,
      distanceKm: s.distance / 1000,
      elapsedMs: s.startT != null ? (s.lastImuT ?? s.fix?.t ?? s.startT) - s.startT : 0,
      obd: { ...s.obd, fresh: Date.now() - s.obdT < 3000 },
      gear: s.engaged ? s.gear : null, clutchIn: !!s.clutch, gearsLearned: s.gears.length,
      mountLearned: !!(s.fwd && s.fwdWeight > cfg.mountLearnWeight),
      yawSignLearned: s.yawSign !== 0,
      scores: scores(),
    };
  }

  function scores() {
    const km = Math.max(s.distance / 1000, 0.5);
    const jerkRms = s.jerkN ? Math.sqrt(s.jerkSq / s.jerkN) : 0;
    const count = (type, sev) => s.events.filter((e) => e.type === type && (!sev || e.severity === sev)).length;
    const smooth = clamp(100 - jerkRms * 12, 0, 100);
    // hard brakes per 10 km, emergency stops count double: 1 -> 85, 3 -> 61, 10 -> 19
    const brakeRate = ((count('brake') + count('brake', 'severe')) / km) * 10;
    const braking = 100 * Math.exp(-brakeRate / 6);
    const shiftTimes = s.shifts.filter((e) => e.kind === 'upshift' || e.kind === 'downshift').map((e) => e.durationMs);
    const avgShift = shiftTimes.length ? shiftTimes.reduce((a, b) => a + b, 0) / shiftTimes.length : null;
    const shifting = avgShift == null ? null : clamp(100 - Math.max(0, avgShift - 400) / 12, 0, 100);
    const parts = [[smooth, 0.4], [braking, 0.4], [shifting, 0.2]].filter(([v]) => v != null);
    const wsum = parts.reduce((a, [, w]) => a + w, 0);
    const overall = parts.reduce((a, [v, w]) => a + v * w, 0) / wsum;
    return {
      overall: Math.round(overall), smooth: Math.round(smooth), braking: Math.round(braking),
      shifting: shifting == null ? null : Math.round(shifting), jerkRms: +jerkRms.toFixed(2),
      avgShiftMs: avgShift == null ? null : Math.round(avgShift),
    };
  }

  function summary() {
    const count = (type) => s.events.filter((e) => e.type === type).length;
    const roughVals = s.track.map((p) => p.rough);
    return {
      startT: s.startT, endT: s.lastImuT ?? s.fix?.t ?? s.startT,
      distanceKm: +(s.distance / 1000).toFixed(2),
      maxSpeedKmh: +(s.maxSpeed * 3.6).toFixed(1),
      avgSpeedKmh: s.speedN ? +((s.speedSum / s.speedN) * 3.6).toFixed(1) : 0,
      ascent: Math.round(s.ascent), descent: Math.round(s.descent),
      minAlt: Number.isFinite(s.minAlt) ? Math.round(s.minAlt) : null,
      maxAlt: Number.isFinite(s.maxAlt) ? Math.round(s.maxAlt) : null,
      maxLeanLeft: +Math.abs(s.maxLeanL).toFixed(1), maxLeanRight: +s.maxLeanR.toFixed(1),
      peakG: +s.peakG.toFixed(2),
      potholes: count('pothole'), bumps: count('bump'), roughStretches: count('rough'), hardBrakes: count('brake'),
      hardAccels: count('accel'), shifts: s.shifts.length,
      clutchPct: s.movingMs ? +((s.clutchMs / s.movingMs) * 100).toFixed(1) : null,
      gearRatios: [...s.gears].sort((a, b) => b.ratio - a.ratio).map((g) => +g.ratio.toFixed(1)),
      maxCoolant: s.maxCoolant,
      // vibration the phone sees while moving: a loose or undamped mount reads > ~1 m/s² even
      // on good roads, which hides real potholes among mount shake
      // share of motion samples that arrived bunched (page too busy): high values mean the phone
      // could not keep up with camera + dashcam + detector
      imuBunchedPct: s.imuN ? Math.round((100 * (s.imuSpread || 0)) / s.imuN) : null,
      mountShake: (() => { const v = s.track.filter((p) => p.v > 15).map((p) => p.rough).sort((a, b) => a - b); return v.length > 20 ? +v[Math.floor(v.length * 0.25)].toFixed(2) : null; })(),
      avgRoughness: roughVals.length ? +(roughVals.reduce((a, b) => a + b, 0) / roughVals.length).toFixed(2) : null,
      scores: scores(),
    };
  }

  return {
    pushImu, pushGps, pushObd,
    snapshot, summary,
    get events() { return s.events; },
    get track() { return s.track; },
    get timeline() { return s.timeline; },
    get shifts() { return s.shifts; },
    get gears() { return [...s.gears].sort((a, b) => b.ratio - a.ratio); },
    get mount() { return { up: s.up, fwd: s.fwd, fwdWeight: s.fwdWeight }; },
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
