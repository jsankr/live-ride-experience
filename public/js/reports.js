// Wrong-side rider/driver evidence capture.
// Keeps a rolling pre-roll of JPEG frames so the moment *before* the tap is saved too:
// by the time a rider reacts, the vehicle is often already past.
import { db, uid } from './db.js';

// Indian registration formats: standard (KA 01 AB 1234), older/no-series (DL 3C 1234 → DL3C1234),
// and Bharat series (22 BH 1234 AA). Validation is advisory, never blocking.
const PLATE_RES = [
  /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$/,
  /^\d{2}BH\d{4}[A-Z]{1,2}$/,
];
export function normalizePlate(s) {
  const p = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    .replace(/^([A-Z]{2})O(\d)/, (_, st, d) => `${st}0${d}`); // common OCR slip: O for 0 after state code
  return { plate: p, valid: PLATE_RES.some((re) => re.test(p)) };
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

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.canvas = document.createElement('canvas');
    this.timer = setInterval(() => this.grab().then((b) => {
      if (!b) return;
      this.ring.push({ t: Date.now(), blob: b });
      while (this.ring.length > 8) this.ring.shift(); // ~4 s pre-roll at 2 fps
    }), 500);
  }

  grab(quality = 0.72) {
    const v = this.video;
    if (!v.videoWidth) return Promise.resolve(null);
    this.canvas.width = v.videoWidth; this.canvas.height = v.videoHeight;
    this.canvas.getContext('2d').drawImage(v, 0, 0);
    return new Promise((r) => this.canvas.toBlob(r, 'image/jpeg', quality));
  }

  // pre-roll + the sharpest-possible current frame + 3 post frames
  async burst() {
    const pre = this.ring.slice(-6);
    const now = await this.grab(0.9);
    const post = [];
    for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 400)); const b = await this.grab(0.85); if (b) post.push({ t: Date.now(), blob: b }); }
    return [...pre, ...(now ? [{ t: Date.now(), blob: now, key: true }] : []), ...post];
  }

  stop() {
    clearInterval(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null; this.ring = [];
  }
}

export async function saveReport({ frames, snapshot, rideId }) {
  const fix = snapshot?.fix;
  const report = {
    id: uid(), t: Date.now(), rideId: rideId || null,
    lat: fix?.lat ?? null, lon: fix?.lon ?? null, accuracy: fix?.accuracy ?? null,
    heading: fix?.heading ?? null, mySpeedKmh: snapshot ? Math.round(snapshot.speedKmh) : null,
    photos: frames.map((f) => ({ t: f.t, blob: f.blob, key: !!f.key })),
    keyPhoto: Math.max(0, frames.findIndex((f) => f.key)),
    vehicleType: '', plate: '', plateValid: false, color: '', notes: '',
    violation: 'wrong-side', status: 'new', synced: false,
  };
  await db.put('reports', report);
  return report;
}

let tesseractWorker;
export async function ocrPlate(blob, onProgress) {
  if (!window.Tesseract) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
      s.onload = res; s.onerror = () => rej(new Error('Could not load OCR engine (offline?)'));
      document.head.appendChild(s);
    });
  }
  if (!tesseractWorker) {
    tesseractWorker = await window.Tesseract.createWorker('eng', 1, { logger: (m) => onProgress?.(m) });
    await tesseractWorker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ' });
  }
  const { data } = await tesseractWorker.recognize(blob);
  return { text: data.text, plates: findPlates(data.text), confidence: data.confidence };
}

const blobToDataUrl = (b) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });

export async function reportToJson(r, { photos = 'key' } = {}) {
  const pick = photos === 'all' ? r.photos : r.photos.filter((_, i) => i === r.keyPhoto);
  return {
    ...r,
    photos: await Promise.all(pick.map(async (p) => ({ t: p.t, key: p.key, dataUrl: await blobToDataUrl(p.blob) }))),
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
  r.synced = true; await db.put('reports', r);
  return res.json();
}
