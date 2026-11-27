// Physics-flavoured ride simulator. Emits the same raw streams the real
// sensors produce (phone IMU in the phone's own frame, 1 Hz GPS, ~5 Hz OBD)
// so the whole pipeline can be demoed and tested without a motorcycle.
// It also keeps ground truth so tests can score the detectors.

const G = 9.80665;
const D2R = Math.PI / 180;

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSimulator({ startT = null, seed = 7, startLat = 12.9716, startLon = 77.5946, mountTiltDeg = 25, roughRoads = false, breakers = 'box', smallBumps = false, burst = 1, onImu: emitImu, onGps, onObd } = {}) {
  const rand = rng(seed);
  // burst > 1: deliver motion samples the way a busy browser page does (27 Nov 12:50 ride):
  // `burst` samples at a time, all stamped with the delivery time of the last one
  const queue = [];
  const onImu = burst <= 1 ? emitImu : (t, acc, g) => {
    queue.push([acc, g]);
    if (queue.length >= burst) { for (const [a2, g2] of queue.splice(0)) emitImu?.(t, a2, g2); }
  };
  const gauss = () => { // Box-Muller
    let u = 0, v = 0; while (!u) u = rand(); while (!v) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  // phone axes expressed in the bike frame (x fwd, y left, z up):
  // portrait on a handlebar mount, screen facing the rider, tilted back
  const th = mountTiltDeg * D2R;
  const PX = [0, -1, 0];
  const PY = [Math.sin(th), 0, Math.cos(th)];
  const PZ = [-Math.cos(th), 0, Math.sin(th)];
  const toPhone = (v) => ({
    x: v[0] * PX[0] + v[1] * PX[1] + v[2] * PX[2],
    y: v[0] * PY[0] + v[1] * PY[1] + v[2] * PY[2],
    z: v[0] * PZ[0] + v[1] * PZ[1] + v[2] * PZ[2],
  });

  const RATIOS = [120, 80, 60, 48, 40]; // rpm per km/h for gears 1..5
  const IDLE = 1300;
  const st = {
    t: startT ?? Date.now(), v: 0, a: 0, gear: 1, rpm: IDLE,
    clutch: null, // {t0, dur, from, to, rpm0}
    heading: 30, yaw: 0, yawUntil: 0, lean: 0,
    lat: startLat, lon: startLon, alt: 920,
    target: 0, targetUntil: 0, hardBrakeUntil: 0,
    impacts: [], nextImpact: 0, bumpAt: 0, jolts: [], nextJolt: 0, roughStretch: false,
    roughness: 0.4, roughUntil: 0,
    lastGps: 0, lastObd: 0, lastSlow: 0, coolant: 70,
  };
  const truth = { potholes: 0, bumps: 0, smallBumps: 0, roughStretches: 0, roughJolts: 0, hardBrakes: 0, shifts: 0, upshifts: 0, downshifts: 0, shiftMs: [], maxLean: 0 };

  function plan() {
    const opts = [25, 35, 45, 55, 65, 75, 85, 40, 30, 0];
    st.target = opts[Math.floor(rand() * opts.length)] / 3.6;
    st.targetUntil = st.t + (st.target === 0 ? 6000 : 9000 + rand() * 8000);
    if (st.v > 30 / 3.6 && rand() < 0.22) { // panic stop
      st.hardBrakeUntil = st.t + 900 + rand() * 600;
      st.target = 8 / 3.6;
      truth.hardBrakes++;
    }
  }

  function step(dt) {
    st.t += dt * 1000;
    const t = st.t;
    if (t > st.targetUntil) plan();
    if (t > st.roughUntil) {
      // optional broken-surface stretches: heavy vibration plus frequent small jolts that are
      // NOT potholes or speed breakers (what a handlebar-mounted phone sees on bad roads)
      st.roughStretch = roughRoads && rand() < 0.4;
      if (st.roughStretch) truth.roughStretches++;
      st.roughness = st.roughStretch ? 1.4 + rand() * 0.8 : 0.2 + rand() * 0.9;
      st.roughUntil = t + (st.roughStretch ? 25000 + rand() * 20000 : 8000 + rand() * 12000);
    }
    // a speed breaker ahead: the rider slows to ~15 km/h first (as riders do)
    if (st.bumpAt && t < st.bumpAt) { st.target = Math.min(st.target, 15 / 3.6); st.targetUntil = Math.max(st.targetUntil, st.bumpAt + 1500); }

    // --- longitudinal dynamics
    let a;
    if (t < st.hardBrakeUntil) a = -6.2;
    else if (st.clutch) a = -0.35;
    else a = Math.max(-2.4, Math.min(2.3, 0.6 * (st.target - st.v)));
    if (st.v <= 0 && a < 0) a = 0;
    st.a = a;
    st.v = Math.max(0, st.v + a * dt);
    const kmh = st.v * 3.6;

    // --- gearbox & clutch
    if (st.clutch) {
      const p = (t - st.clutch.t0) / st.clutch.dur;
      const rpmTarget = RATIOS[st.clutch.to - 1] * kmh;
      st.rpm = st.clutch.rpm0 + (Math.max(IDLE, rpmTarget) - st.clutch.rpm0) * Math.min(1, p);
      if (p >= 1) { st.gear = st.clutch.to; st.clutch = null; }
    } else if (kmh < 7) {
      st.gear = 1; st.rpm = Math.max(IDLE, RATIOS[0] * kmh);
    } else {
      st.rpm = RATIOS[st.gear - 1] * kmh;
      const up = st.rpm > 3900 && st.gear < 5 && a > 0;
      const down = st.rpm < 1950 && st.gear > 1;
      if (up || down) {
        const to = st.gear + (up ? 1 : -1);
        const dur = up ? 280 + rand() * 320 : 380 + rand() * 450;
        st.clutch = { t0: t, dur, from: st.gear, to, rpm0: st.rpm };
        truth.shifts++; truth[up ? 'upshifts' : 'downshifts']++; truth.shiftMs.push(dur);
      }
    }

    // --- steering / yaw (+ = right turn)
    if (t > st.yawUntil) {
      st.yaw = rand() < 0.45 ? (rand() < 0.5 ? -1 : 1) * (0.08 + rand() * 0.3) : 0;
      st.yawUntil = t + 2500 + rand() * 5000;
    }
    const yaw = st.v > 3 ? st.yaw : 0;
    st.heading = (st.heading + (yaw / D2R) * dt + 360) % 360;
    const leanTarget = Math.atan((st.v * yaw) / G);
    st.lean += (leanTarget - st.lean) * Math.min(1, dt / 0.3);
    truth.maxLean = Math.max(truth.maxLean, Math.abs(st.lean / D2R));

    // --- position & altitude
    const dN = st.v * dt * Math.cos(st.heading * D2R), dE = st.v * dt * Math.sin(st.heading * D2R);
    st.lat += dN / 111320;
    st.lon += dE / (111320 * Math.cos(st.lat * D2R));
    st.alt += Math.sin(t / 60000) * st.v * dt * 0.03;

    // --- road impacts
    const WHEELBASE = 1.45; // m: the rear wheel hits the same spot L/v later
    if (st.v > 5 && t > st.nextImpact && !st.bumpAt) {
      if (smallBumps && st.v > 9 && rand() < 0.3) { // a small hump or raised joint, taken at speed
        const sev = 0.8 + rand() * 0.4;
        st.impacts.push({ t0: t, kind: 'small', sev }, { t0: t + (WHEELBASE / st.v) * 1000, kind: 'small', sev: sev * 0.8 });
        truth.smallBumps++;
      } else if (rand() < 0.7) {
        const sev = 1.0 + rand() * 0.8;
        st.impacts.push({ t0: t, kind: 'pothole', sev }, { t0: t + (WHEELBASE / st.v) * 1000, kind: 'pothole', sev: sev * 0.7 });
        truth.potholes++;
      } else st.bumpAt = t + 6000; // breaker spotted ahead
      st.nextImpact = t + 9000 + rand() * 18000;
    }
    if (st.bumpAt && t >= st.bumpAt) {
      const sev = 0.8 + rand() * 0.6;
      st.impacts.push({ t0: t, kind: 'bump', sev }, { t0: t + (WHEELBASE / Math.max(st.v, 1)) * 1000, kind: 'bump', sev: sev * 0.7 });
      truth.bumps++; st.bumpAt = 0;
    }
    if (st.roughStretch && st.v > 3 && t > st.nextJolt) {
      const sign = rand() < 0.5 ? -1 : 1;
      st.jolts.push({ t0: t, a: sign * (0.5 + rand() * 0.6) * G, dur: 30 + rand() * 30 });
      truth.roughJolts++;
      st.nextJolt = t + 400 + rand() * 1600;
    }
    let zImp = 0;
    st.jolts = st.jolts.filter((j) => t - j.t0 < j.dur);
    for (const j of st.jolts) if (t >= j.t0) zImp += j.a;
    st.impacts = st.impacts.filter((im) => t - im.t0 < (im.kind === "bump" && breakers === "real" ? 650 : 400) || im.t0 > t);
    for (const im of st.impacts) {
      const e = t - im.t0;
      if (e < 0) continue;
      if (im.kind === 'pothole') {
        if (e < 60) zImp += -0.75 * G * im.sev;
        else if (e < 140) zImp += 1.5 * G * im.sev;
        else if (e < 220) zImp += -0.4 * G * im.sev;
      } else if (im.kind === 'small') {
        if (e < 40) zImp += 1.1 * G * im.sev;
        else if (e < 90) zImp += -0.45 * G * im.sev;
      } else if (breakers === 'real') {
        // as recorded on 27 Nov 13:52 at 19 km/h: the wheel climbs (~0.25 g for 300 ms), unloads
        // over the crest (~-0.9 g), then lands (~+0.5 g)
        if (e < 300) zImp += 0.28 * G * im.sev;
        else if (e < 420) zImp += -0.85 * G * im.sev;
        else if (e < 600) zImp += 0.55 * G * im.sev;
      } else {
        if (e < 110) zImp += 0.95 * G * im.sev;
        else if (e < 230) zImp += -0.55 * G * im.sev;
      }
    }

    // --- IMU in bike frame -> phone frame
    const lean = st.lean;
    const undul = Math.sin(t / 1000 * 2 * Math.PI * 1.4) * st.roughness * 0.8;
    const zRoad = gauss() * st.roughness * 0.7 + undul + zImp;
    const fBike = [
      a + gauss() * 0.25,
      gauss() * 0.25,
      G / Math.cos(lean) + zRoad,
    ];
    const w = st.v > 3 ? yaw : 0; // rad/s, + right turn
    const gyroBike = [gauss() * 0.01, -w * Math.sin(lean), -w * Math.cos(lean) + gauss() * 0.01];
    const acc = toPhone(fBike);
    const g = toPhone(gyroBike);
    onImu?.(t, acc, { x: g.x / D2R, y: g.y / D2R, z: g.z / D2R });

    // --- GPS 1 Hz
    if (t - st.lastGps >= 1000) {
      st.lastGps = t;
      const n = () => gauss() * 2.5 / 111320;
      onGps?.(t, {
        lat: st.lat + n(), lon: st.lon + n(), alt: st.alt + gauss() * 2,
        speed: Math.max(0, st.v + gauss() * 0.3), heading: st.v > 1 ? st.heading : null, accuracy: 5,
      });
    }
    // --- OBD ~5 Hz, slow PIDs every 2 s
    if (t - st.lastObd >= 200) {
      st.lastObd = t;
      const data = { rpm: Math.round((st.rpm + gauss() * 15) * 4) / 4, speed: Math.round(kmh) };
      data.throttle = Math.max(0, Math.min(100, (a > 0 ? 20 + a * 25 : 3) + gauss() * 2));
      if (t - st.lastSlow >= 2000) {
        st.lastSlow = t;
        st.coolant += ((st.v < 2 ? 102 : 88) - st.coolant) * 0.05;
        Object.assign(data, {
          coolant: Math.round(st.coolant), intake: 34, load: Math.round(data.throttle * 0.8),
          voltage: +(13.8 + gauss() * 0.1).toFixed(1),
        });
      }
      onObd?.(t, data);
    }
  }

  return { step, truth, state: st };
}
