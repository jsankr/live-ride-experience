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

// Time-of-day presets for bulk delete (local time, 24 h "HH:MM"; a range may wrap past midnight)
export const DAY_PARTS = {
  all: ['00:00', '24:00'], morning: ['05:00', '12:00'], afternoon: ['12:00', '17:00'],
  evening: ['17:00', '22:00'], night: ['22:00', '05:00'],
};
// Clips (or the part of them) recorded on `day` ("YYYY-MM-DD", local) whose start falls in
// [from, to). Locked (incident) clips are left out unless includeLocked is set.
export function clipsInRange(clips, { day = null, from = '00:00', to = '24:00', includeLocked = false } = {}) {
  const mins = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  const a = mins(from), b = mins(to);
  return clips.filter((c) => {
    if (c.locked && !includeLocked) return false;
    const st = stamp(c.start);
    if (day && st.slice(0, 10) !== day) return false;
    const m = mins(st.slice(11, 16));
    return a <= b ? m >= a && m < b : m >= a || m < b;
  }).map((c) => c.id);
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

// Subtitle sidecar: one cue per second with the stamp lines (time, speed, GPS). Players
// (VLC, QuickTime with the .srt beside the video, the in-app player via WebVTT) show it
// over the picture, without the phone redrawing every 4K frame to burn it in.
const ts = (ms, sep) => {
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s2 = Math.floor(ms / 1000) % 60, f = Math.floor(ms % 1000);
  return `${pad(h)}:${pad(m)}:${pad(s2)}${sep}${String(f).padStart(3, '0')}`;
};
export function toSrt(cues, endMs) { // cues: [{ t: ms from clip start, lines: [] }]
  return cues.map((c, i) => `${i + 1}\n${ts(c.t, ',')} --> ${ts(Math.min(cues[i + 1]?.t ?? endMs, endMs), ',')}\n${c.lines.join('\n')}\n`).join('\n');
}
export function srtToVtt(srt) {
  return `WEBVTT\n\n${srt.replace(/^\d+\n/gm, '').replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2')}`;
}

// ---------- recorder ----------
export class Dashcam {
  // burnIn: draw the stamp onto every frame (a canvas redraw per frame on the page's main
  // thread: at 4K that starved the wrong-side detector and the motion sensors on 27 Nov).
  // Default: record the camera itself and write the stamp as subtitles.
  constructor({ getOverlay, onSegment, onError, segmentMs = 60000, height = 720, fps = 20, bitsPerSecond = 2500000, burnIn = false }) {
    Object.assign(this, { getOverlay, onSegment, onError, segmentMs, height, fps, bitsPerSecond, burnIn });
    this.mime = pickMime((m) => window.MediaRecorder?.isTypeSupported(m));
    this.running = false;
  }

  get supported() { return !!window.MediaRecorder && !!this.mime && (!this.burnIn || !!HTMLCanvasElement.prototype.captureStream); }

  start(video) {
    if (this.running) return;
    if (!this.supported) throw new Error('This browser cannot record video');
    this.video = video;
    const src = video.srcObject;
    if (!this.burnIn && src?.getVideoTracks?.().length) {
      // the camera's own stream, encoded natively: no per-frame work for the page. A clone, so
      // stopping the dashcam never stops the camera (or the detector watching it).
      const track = src.getVideoTracks()[0].clone();
      this.stream = new MediaStream([track]);
      const st = track.getSettings?.() || {};
      this.width = st.width || video.videoWidth; this.height = st.height || video.videoHeight;
      this.running = true;
      this.cueTimer = setInterval(() => { const lines = this.getOverlay?.() || []; if (lines.length && this.segStart) this.cues.push({ t: Date.now() - this.segStart, lines }); }, 1000);
      this.nextSegment();
      return;
    }
    // Draw the camera plus a date/time/speed/GPS stamp onto a canvas and record that,
    // so every frame carries its own evidence of when and where.
    // `height` is the target for the shorter side (720p, 1080p, 2160p = 4K); never upscale,
    // so the file is honest about what the camera actually delivered.
    const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
    const k = Math.min(1, this.height / Math.min(vw, vh));
    const w = Math.round((vw * k) / 2) * 2, h = Math.round((vh * k) / 2) * 2;
    this.canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    this.width = w; this.height = h;
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
    const cues = this.cues = []; this.segStart = start;
    const first = this.getOverlay?.() || []; if (!this.burnIn && first.length) cues.push({ t: 0, lines: first });
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    rec.onstop = () => {
      const end = Date.now();
      if (chunks.length) this.onSegment?.({ blob: new Blob(chunks, { type: this.mime.split(';')[0] }), start, end, mime: this.mime.split(';')[0], srt: this.burnIn || !cues.length ? null : toSrt(cues, end - start) });
    };
    rec.onerror = (e) => this.onError?.(e.error || new Error('Recorder error'));
    rec.start(1000);
    this.rec = rec;
    // restart on a fresh recorder so every file is a complete, playable video on its own
    this.segTimer = setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); this.nextSegment(); }, this.segmentMs);
  }

  stop() {
    this.running = false;
    clearTimeout(this.segTimer); clearTimeout(this.drawTimer); clearInterval(this.cueTimer);
    if (this.rec?.state === 'recording') this.rec.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
  }
}
