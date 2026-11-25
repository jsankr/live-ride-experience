// Dashcam: continuous ride video in short segments, kept on the phone for N days and
// overwritten after that; segments around an incident are locked and never overwritten.
//
// Browser facts this is built around:
//  * MediaRecorder makes MP4 on Safari (iOS) and recent Chrome; Firefox only makes WebM.
//  * The camera stops whenever RideLens is not on screen (all browsers; iOS for any app).
//  * A web page cannot write into Photos/Files on its own: clips are stored in the app's
//    own storage and exported per clip through the share/save sheet.

// ---------- pure helpers (unit-tested) ----------
export const MIME_PREFERENCE = [
  'video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4',
  'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm',
];
export function pickMime(isSupported) {
  return MIME_PREFERENCE.find((m) => { try { return isSupported(m); } catch { return false; } }) || '';
}
export const extFor = (mime) => (/mp4/.test(mime) ? 'mp4' : 'webm');

const pad = (n) => String(n).padStart(2, '0');
export function stamp(t) { // local date-time, e.g. 2026-11-25 14:30:05
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export function fileName(t, mime, tag = '') {
  return `RideLens_${stamp(t).replace(' ', '_').replace(/:/g, '-')}${tag ? `_${tag}` : ''}.${extFor(mime)}`;
}

// Which clips to delete: unlocked clips older than `days`, then (if over the byte budget)
// the oldest unlocked clips until under it. Locked clips are never deleted here.
export function retention(clips, now, { days = 7, maxBytes = Infinity } = {}) {
  const cutoff = now - days * 86400000;
  const del = new Set(clips.filter((c) => !c.locked && c.end < cutoff).map((c) => c.id));
  let total = clips.filter((c) => !del.has(c.id)).reduce((a, c) => a + (c.size || 0), 0);
  for (const c of [...clips].filter((c) => !c.locked && !del.has(c.id)).sort((a, b) => a.start - b.start)) {
    if (total <= maxBytes) break;
    del.add(c.id); total -= c.size || 0;
  }
  return [...del];
}

// Clips overlapping [t - before, t + after] (ms) are the incident's footage.
export const overlapping = (clips, t, before = 30000, after = 30000) =>
  clips.filter((c) => c.start <= t + after && c.end >= t - before);

// ---------- recorder ----------
export class Dashcam {
  constructor({ getOverlay, onSegment, onError, segmentMs = 60000, height = 720, fps = 24, bitsPerSecond = 2500000 }) {
    Object.assign(this, { getOverlay, onSegment, onError, segmentMs, height, fps, bitsPerSecond });
    this.mime = pickMime((m) => window.MediaRecorder?.isTypeSupported(m));
    this.running = false;
  }

  get supported() { return !!window.MediaRecorder && !!this.mime && !!HTMLCanvasElement.prototype.captureStream; }

  start(video) {
    if (this.running) return;
    if (!this.supported) throw new Error('This browser cannot record video');
    this.video = video;
    // Draw the camera plus a date/time/speed/GPS stamp onto a canvas and record that,
    // so every frame carries its own evidence of when and where.
    const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
    const h = Math.min(this.height, vh), w = Math.round((vw / vh) * h / 2) * 2;
    this.canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    this.ctx = this.canvas.getContext('2d');
    this.stream = this.canvas.captureStream(this.fps);
    this.running = true;
    const draw = () => {
      if (!this.running) return;
      this.ctx.drawImage(video, 0, 0, w, h);
      const lines = this.getOverlay?.() || [];
      if (lines.length) {
        const fs = Math.round(h / 28);
        this.ctx.font = `600 ${fs}px system-ui, sans-serif`;
        const lh = fs * 1.3, boxW = Math.max(...lines.map((l) => this.ctx.measureText(l).width)) + fs;
        this.ctx.fillStyle = 'rgba(0,0,0,.55)';
        this.ctx.fillRect(0, h - lh * lines.length - fs * 0.4, boxW, lh * lines.length + fs * 0.4);
        this.ctx.fillStyle = '#fff';
        lines.forEach((l, i) => this.ctx.fillText(l, fs / 2, h - lh * (lines.length - i - 1) - fs * 0.55));
      }
      this.drawTimer = setTimeout(draw, 1000 / this.fps);
    };
    draw();
    this.nextSegment();
  }

  nextSegment() {
    if (!this.running) return;
    const rec = new MediaRecorder(this.stream, { mimeType: this.mime, videoBitsPerSecond: this.bitsPerSecond });
    const chunks = [], start = Date.now();
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    rec.onstop = () => {
      const end = Date.now();
      if (chunks.length) this.onSegment?.({ blob: new Blob(chunks, { type: this.mime.split(';')[0] }), start, end, mime: this.mime.split(';')[0] });
    };
    rec.onerror = (e) => this.onError?.(e.error || new Error('Recorder error'));
    rec.start(1000);
    this.rec = rec;
    // restart on a fresh recorder so every file is a complete, playable video on its own
    this.segTimer = setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); this.nextSegment(); }, this.segmentMs);
  }

  stop() {
    this.running = false;
    clearTimeout(this.segTimer); clearTimeout(this.drawTimer);
    if (this.rec?.state === 'recording') this.rec.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
  }
}
