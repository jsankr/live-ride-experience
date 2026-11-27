// Wrong-side rider/driver evidence capture.
// Keeps a rolling pre-roll of JPEG frames so the moment *before* the tap is saved too:
// by the time a rider reacts, the vehicle is often already past.
import { db, uid } from './db.js';

// Indian registration formats: standard (KA 01 AB 1234), older/no-series (DL 3C 1234 → DL3C1234),
// and Bharat series (22 BH 1234 AA). Validation is advisory, never blocking.
// State/UT codes in use (MoRTH): a real plate starts with one of these.
export const STATE_CODES = new Set('AN AP AR AS BR CG CH DD DL DN GA GJ HP HR JH JK KA KL LA LD MH ML MN MP MZ NL OD OR PB PY RJ SK TN TR TS UK UP WB'.split(' '));
const PLATE_RES = [
  /^([A-Z]{2})(\d{2})[A-Z]{0,3}\d{4}$/,  // district is two digits (KA 01 …)
  /^(DL)(\d)[A-Z]{1,3}\d{4}$/,          // Delhi's older one-digit districts (DL 3C …)
  /^\d{2}BH\d{4}[A-Z]{1,2}$/,           // Bharat series
];
export function normalizePlate(s) {
  const p = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    .replace(/^([A-Z]{2})O(\d)/, (_, st, d) => `${st}0${d}`); // common OCR slip: O for 0 after state code
  const valid = PLATE_RES.some((re) => { const m = p.match(re); return m && (!m[1] || STATE_CODES.has(m[1])); });
  return { plate: p, valid };
}
// Indian plates: 2 state letters, 1-2 district digits, 0-3 series letters, 4 digits (or BH).
// Fix the usual OCR mix-ups by position: a letter where a digit must be, and the reverse.
const TO_DIGIT = { O: '0', D: '0', Q: '0', I: '1', L: '1', T: '1', Z: '2', S: '5', B: '8', G: '6' };
const TO_LETTER = { 0: 'O', 1: 'I', 2: 'Z', 5: 'S', 8: 'B', 6: 'G' };
export function fixPlateChars(p) {
  const m = p.match(/^([A-Z0-9]{2})([A-Z0-9]{2})([A-Z0-9]{0,3})([A-Z0-9]{4})$/); // state, district, series, number
  if (!m) return p;
  const asL = (x) => x.replace(/[0-9]/g, (c) => TO_LETTER[c] || c), asD = (x) => x.replace(/[A-Z]/g, (c) => TO_DIGIT[c] || c);
  // series letters never use I or O (CMVR), so a 0 read there is a D (TN19BD9993 read as TN19B09993)
  const asSeries = (x) => x.replace(/[0-9]/g, (c) => (c === '0' ? 'D' : TO_LETTER[c] || c));
  return asL(m[1]) + asD(m[2]) + asSeries(m[3]) + asD(m[4]);
}
// Best registration in OCR text. Bolts, dots and the IND hologram split a plate into pieces
// with junk between them, so pieces are combined in order (skipping junk) until a valid
// registration appears; fewer skipped pieces win.
export function plateFromText(text) {
  const tokens = String(text || '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean).slice(0, 12);
  let best = null;
  const n = tokens.length;
  const consider = (idx) => {
    const raw = idx.map((i) => tokens[i]).join('');
    if (raw.length < 8 || raw.length > 11) return;
    const fixed = fixPlateChars(raw);
    const changes = [...raw].filter((ch, i) => fixed[i] !== ch).length;
    for (const cand of changes <= 2 ? [raw, fixed] : [raw]) {
      const r = normalizePlate(cand);
      if (!r.valid) continue;
      const skipped = idx[idx.length - 1] - idx[0] + 1 - idx.length;
      // single characters are usually bolts, dots or hologram bits read as letters
      const singles = idx.filter((i) => tokens[i].length === 1).length;
      const score = skipped + singles * 2 + (cand === raw ? 0 : changes);
      if (!best || score < best.score) best = { plate: r.plate, score };
    }
  };
  for (let a = 0; a < n; a++) {
    consider([a]);
    for (let b = a + 1; b < n; b++) {
      consider([a, b]);
      for (let c = b + 1; c < n; c++) {
        consider([a, b, c]);
        for (let d = c + 1; d < n; d++) consider([a, b, c, d]);
      }
    }
  }
  return best?.plate ?? null;
}

export function findPlates(text) {
  const cands = String(text || '').toUpperCase().replace(/[^A-Z0-9\n ]/g, ' ').split(/\n/)
    .flatMap((line) => {
      const compact = line.replace(/\s+/g, '');
      const out = [];
      for (let i = 0; i < compact.length; i++) for (let L = 8; L <= 11; L++) {
        const n = normalizePlate(compact.slice(i, i + L));
        if (n.valid) out.push(n.plate);
      }
      return out;
    });
  return [...new Set(cands)].sort((a, b) => b.length - a.length);
}

export class EvidenceCamera {
  constructor(video) { this.video = video; this.ring = []; this.stream = null; this.timer = null; }

  async start({ width = 1920, height = 1080 } = {}) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: width }, height: { ideal: height } }, audio: false,
    });
    const track = this.stream.getVideoTracks()[0];
    if (track?.getCapabilities?.().focusMode?.includes('continuous')) {
      track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    }
    this.video.srcObject = this.stream;
    await this.video.play();
    this.canvas = document.createElement('canvas');
    this.detail = document.createElement('canvas');
    this.detail.width = 96; this.detail.height = 54;
    const stream = this.stream;
    this.timer = setInterval(async () => {
      const frame = await this.grab();
      if (!frame || this.stream !== stream) return;
      this.ring.push(frame);
      while (this.ring.length > 6) this.ring.shift(); // ~4 s pre-roll
    }, 700); // a frame every 0.7 s: less JPEG work (heat) than every 0.5 s
  }

  // Point the camera's focus at a spot (0..1 of the picture) where the browser allows it
  // (Chrome on Android). iPhone browsers expose no focus control: the camera keeps its own
  // continuous autofocus there. Returns true when the focus was moved.
  async focusAt(nx, ny) {
    const track = this.stream?.getVideoTracks()[0];
    const caps = track?.getCapabilities?.() || {};
    const advanced = {};
    if (caps.pointsOfInterest !== undefined || 'pointsOfInterest' in caps) advanced.pointsOfInterest = [{ x: nx, y: ny }];
    if (caps.focusMode?.includes('single-shot')) advanced.focusMode = 'single-shot';
    else if (caps.focusMode?.includes('continuous')) advanced.focusMode = 'continuous';
    if (!Object.keys(advanced).length) return false;
    try {
      await track.applyConstraints({ advanced: [advanced] });
      clearTimeout(this.refocus);
      this.refocus = setTimeout(() => { if (caps.focusMode?.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {}); }, 2500);
      return !!advanced.pointsOfInterest;
    } catch { return false; }
  }

  // Optical zoom toward a detected vehicle where the camera allows it (some Android phones;
  // iPhone Safari offers zoom only on recent iOS versions). Phone zoom always crops the CENTRE,
  // so the level is chosen to keep the whole vehicle in view. Returns { zoom, restore } or null.
  async zoomFor([bx, by, bw, bh]) {
    const track = this.stream?.getVideoTracks()[0];
    const caps = track?.getCapabilities?.() || {};
    if (!caps.zoom?.max || caps.zoom.max <= 1) return null;
    const before = track.getSettings?.().zoom ?? caps.zoom.min ?? 1;
    const reach = Math.max(Math.abs(bx - 0.5), Math.abs(bx + bw - 0.5), Math.abs(by - 0.5), Math.abs(by + bh - 0.5));
    const z = Math.min(caps.zoom.max, 3, 0.48 / Math.max(reach, 0.05));
    if (z < 1.25) return null; // vehicle too close to the edge for centre zoom to help
    try {
      await track.applyConstraints({ advanced: [{ zoom: z }] });
      return { zoom: +z.toFixed(2), restore: () => track.applyConstraints({ advanced: [{ zoom: before }] }).catch(() => {}) };
    } catch { return null; }
  }

  grab(quality = 0.78, maxSide = 1920) {
    const v = this.video;
    if (!this.stream || !v.videoWidth) return Promise.resolve(null);
    const t = Date.now();
    const size = Math.min(1, maxSide / v.videoWidth, maxSide / v.videoHeight);
    const width = Math.round(v.videoWidth * size);
    const height = Math.round(v.videoHeight * size);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width; this.canvas.height = height;
    }
    this.canvas.getContext('2d').drawImage(v, 0, 0, width, height);
    const detail = this.detail.getContext('2d', { willReadFrequently: true });
    detail.drawImage(v, v.videoWidth * 0.15, v.videoHeight * 0.15, v.videoWidth * 0.7, v.videoHeight * 0.7, 0, 0, 96, 54);
    const { data } = detail.getImageData(0, 0, 96, 54);
    let sharpness = 0;
    for (let y = 1; y < 54; y++) for (let x = 1; x < 96; x++) {
      const i = (y * 96 + x) * 4 + 1;
      sharpness += (data[i] - data[i - 4]) ** 2 + (data[i] - data[i - 384]) ** 2;
    }
    return new Promise((resolve) => this.canvas.toBlob((blob) => resolve(blob ? { blob, t, sharpness } : null), 'image/jpeg', quality));
  }

  // full camera resolution for the frames after the trigger: crops of a distant vehicle,
  // its rider and plate come from these, so every pixel counts (digital zoom)
  async burst() {
    const frames = this.ring.filter((frame) => Date.now() - frame.t <= 4250);
    const now = await this.grab(0.92, 4096);
    if (now) frames.push(now);
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const frame = await this.grab(0.9, 4096);
      if (frame) frames.push(frame);
    }
    const best = frames.reduce((sharpest, frame) => !sharpest || frame.sharpness >= sharpest.sharpness ? frame : sharpest, null);
    return frames.map((frame) => ({ ...frame, key: frame === best }));
  }

  stop() {
    clearInterval(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.video.srcObject = null;
    this.stream = null; this.ring = [];
  }
}

export async function saveReport({ frames, snapshot, rideId, capturedAt = Date.now(), airQuality = null }) {
  const fix = snapshot?.fix;
  const report = {
    id: uid(), t: capturedAt, rideId: rideId || null,
    lat: fix?.lat ?? null, lon: fix?.lon ?? null, accuracy: fix?.accuracy ?? null,
    gpsTime: fix?.t ?? null, airQuality, analysis: { status: 'pending' },
    heading: fix?.heading ?? null, mySpeedKmh: Number.isFinite(snapshot?.speedKmh) ? Math.round(snapshot.speedKmh) : null,
    // subjectBox: where the tracked vehicle is in this photo (0..1), when the watcher followed it
    photos: frames.map((f) => ({ t: f.t, blob: f.blob, key: !!f.key, ...(f.subjectBox ? { subjectBox: f.subjectBox, distanceM: f.distanceM, subject: true } : {}), ...(f.frameBox ? { frameBox: f.frameBox } : {}) })),
    keyPhoto: Math.max(0, frames.findIndex((f) => f.key)),
    vehicleType: '', plate: '', plateValid: false, color: '', notes: '',
    violation: 'wrong-side', status: 'new', synced: false,
  };
  await db.put('reports', report);
  return report;
}

let tesseractWorker, ocrProgress;
let ocrQueue = Promise.resolve();
export function ocrPlate(blob, onProgress, segmentation = '11') {
  const job = ocrQueue.then(async () => {
    ocrProgress = onProgress;
    try {
      if (!window.Tesseract) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          const fail = () => { clearTimeout(timer); script.remove(); reject(new Error('Could not load OCR engine')); };
          const timer = setTimeout(fail, 12000);
          script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
          script.onload = () => { clearTimeout(timer); resolve(); };
          script.onerror = fail;
          document.head.append(script);
        });
      }
      if (!tesseractWorker) {
        const worker = await window.Tesseract.createWorker('eng', 1, { logger: (message) => ocrProgress?.(message) });
        await worker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ' });
        tesseractWorker = worker;
      }
      await tesseractWorker.setParameters({ tessedit_pageseg_mode: segmentation });
      const { data } = await tesseractWorker.recognize(blob);
      return { text: data.text, plates: findPlates(data.text), confidence: data.confidence };
    } finally { ocrProgress = null; }
  });
  ocrQueue = job.catch(() => {});
  return job;
}

const blobToDataUrl = (b) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });

export async function reportToJson(r, { photos = 'key' } = {}) {
  const pick = r.photos.map((photo, index) => ({ ...photo, key: index === r.keyPhoto, index }))
    .filter((photo) => photos === 'all' || photo.key);
  return {
    ...r,
    photos: await Promise.all(pick.map(async (p) => ({ t: p.t, key: p.key, index: p.index, dataUrl: await blobToDataUrl(p.blob) }))),
  };
}

export function reportsToCsv(list) {
  const cols = ['id', 'time', 'lat', 'lon', 'accuracy_m', 'heading', 'my_speed_kmh', 'violation', 'vehicle_type', 'plate', 'plate_valid', 'color', 'notes', 'status'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = list.map((r) => [r.id, new Date(r.t).toISOString(), r.lat, r.lon, r.accuracy, r.heading, r.mySpeedKmh, r.violation, r.vehicleType, r.plate, r.plateValid, r.color, r.notes, r.status].map(esc).join(','));
  return [cols.join(','), ...rows].join('\n');
}

export async function syncReport(r, { serverUrl, token }) {
  const body = await reportToJson(r, { photos: 'all' });
  const res = await fetch(`${serverUrl.replace(/\/$/, '')}/api/reports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Server said ${res.status}: ${await res.text()}`);
  await db.updateReport(r.id, (current) => current.analysis?.status === r.analysis?.status ? { ...current, synced: true } : current);
  return res.json();
}
