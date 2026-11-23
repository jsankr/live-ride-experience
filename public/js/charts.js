// Small, dependency-free chart kit. Canvas for the 50 Hz live views, SVG for reports.
// Colours come from CSS custom properties so light/dark themes stay in one place.

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

// Rolling strip chart. series: [{key, color: '--series-1', label}]
export class StripChart {
  constructor(canvas, { series, windowMs = 30000, min = -1, max = 1, unit = '', bands = [] }) {
    Object.assign(this, { canvas, series, windowMs, min, max, unit, bands });
    this.data = []; this.marks = [];
  }
  push(t, values) {
    this.data.push({ t, ...values });
    const cut = t - this.windowMs - 1000;
    while (this.data.length && this.data[0].t < cut) this.data.shift();
    while (this.marks.length && this.marks[0].t < cut) this.marks.shift();
  }
  mark(t, label, status) { this.marks.push({ t, label, status }); }
  draw() {
    const { ctx, w, h } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);
    if (!this.data.length) return;
    const tEnd = this.data[this.data.length - 1].t, tStart = tEnd - this.windowMs;
    const X = (t) => ((t - tStart) / this.windowMs) * w;
    const Y = (v) => h - 4 - ((v - this.min) / (this.max - this.min)) * (h - 8);
    // threshold bands
    for (const b of this.bands) {
      ctx.fillStyle = css(b.color); ctx.globalAlpha = 0.12;
      const y1 = Y(Math.min(this.max, b.to)), y0 = Y(Math.max(this.min, b.from));
      ctx.fillRect(0, y1, w, y0 - y1); ctx.globalAlpha = 1;
    }
    // grid
    ctx.strokeStyle = css('--grid'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, Y(0) + 0.5); ctx.lineTo(w, Y(0) + 0.5); ctx.stroke();
    for (let s = 5000; s < this.windowMs; s += 5000) {
      const x = Math.round(X(tEnd - s)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    // event markers
    for (const m of this.marks) {
      const x = X(m.t);
      ctx.strokeStyle = css(`--status-${m.status || 'warning'}`); ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); ctx.setLineDash([]);
    }
    // series
    for (const s of this.series) {
      ctx.strokeStyle = css(s.color); ctx.lineWidth = 2; ctx.lineJoin = 'round';
      ctx.beginPath(); let started = false;
      for (const d of this.data) {
        const v = d[s.key];
        if (v == null) { started = false; continue; }
        const x = X(d.t), y = Y(Math.max(this.min, Math.min(this.max, v)));
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
}

// G-G (friction circle) diagram with a fading trail. x = lateral, y = longitudinal.
export class FrictionCircle {
  constructor(canvas, { maxG = 1 } = {}) { this.canvas = canvas; this.maxG = maxG; this.trail = []; }
  push(lat, long) { this.trail.push({ lat, long }); if (this.trail.length > 120) this.trail.shift(); }
  draw() {
    const { ctx, w, h } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 14;
    if (R <= 4) return; // hidden view
    ctx.strokeStyle = css('--grid'); ctx.lineWidth = 1;
    for (const f of [0.25, 0.5, 0.75, 1]) { ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, Math.PI * 2); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
    ctx.fillStyle = css('--text-muted'); ctx.font = '10px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('ACCEL', cx, cy - R - 3); ctx.fillText('BRAKE', cx, cy + R + 11);
    ctx.fillText(`${(this.maxG * 0.5).toFixed(1)}g`, cx + R * 0.5, cy - 3);
    const P = (p) => [cx + (p.lat / this.maxG) * R, cy - (p.long / this.maxG) * R];
    const col = css('--series-1');
    this.trail.forEach((p, i) => {
      const [x, y] = P(p);
      ctx.globalAlpha = (i / this.trail.length) * 0.6;
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
    });
    ctx.globalAlpha = 1;
    const last = this.trail[this.trail.length - 1];
    if (last) {
      const [x, y] = P(last);
      ctx.fillStyle = col; ctx.strokeStyle = css('--surface-1'); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }
}

// ---------- SVG report charts ----------
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e); return e;
};
const fmtTime = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function niceTicks(min, max, n = 4) {
  const span = max - min || 1;
  const step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  const out = []; for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

// Bin a time series into n equal-time buckets: [{t, mean, min, max, n}].
// Pure (no DOM) so it is unit-tested. Empty buckets are dropped.
export function downsample(pts, key, n, t0 = pts[0]?.t, t1 = pts[pts.length - 1]?.t) {
  if (!pts.length || n < 1) return [];
  const span = (t1 - t0) || 1, out = new Array(n);
  for (const p of pts) {
    const v = p[key]; if (v == null) continue;
    const i = Math.min(n - 1, Math.max(0, Math.floor(((p.t - t0) / span) * n)));
    const b = out[i] || (out[i] = { t: 0, sum: 0, min: Infinity, max: -Infinity, n: 0 });
    b.t += p.t; b.sum += v; b.n++; if (v < b.min) b.min = v; if (v > b.max) b.max = v;
  }
  return out.filter(Boolean).map((b) => ({ t: b.t / b.n, mean: b.sum / b.n, min: b.min, max: b.max, n: b.n }));
}

// Single-series line/area chart over ride time with crosshair tooltip.
// Long rides are binned to ~1 bucket per 3 px: the line is the bucket mean and a
// soft band shows the min–max range, so peaks stay visible without a barcode.
// markers: [{t, label, status}] are drawn as a tick strip under the plot.
export function lineChart(container, { data, key, color = '--series-1', unit = '', area = false, height = 160, min, max, markers = [], fmt = (v) => v.toFixed(0), zero = false, band = true }) {
  container.innerHTML = '';
  const raw = data.filter((d) => d[key] != null);
  if (raw.length < 2) { container.innerHTML = '<p class="empty">Not enough data for this chart.</p>'; return; }
  const W = container.clientWidth || 600, rug = markers.length ? 10 : 0, H = height + rug, L = 40, R = 10, T = 10, B = 22 + rug;
  const t0 = data[0].t, t1 = data[data.length - 1].t;
  const buckets = Math.max(20, Math.floor((W - L - R) / 3));
  const binned = raw.length > buckets;
  const pts = binned ? downsample(raw, key, buckets, t0, t1) : raw.map((p) => ({ t: p.t, mean: p[key], min: p[key], max: p[key], n: 1 }));
  let lo = min ?? Math.min(...pts.map((p) => (band ? p.min : p.mean))), hi = max ?? Math.max(...pts.map((p) => (band ? p.max : p.mean)));
  if (zero) lo = Math.min(lo, 0);
  if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.08; if (min == null) lo -= pad; if (max == null) hi += pad;
  const X = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R);
  const Yc = (v) => T + (1 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (H - T - B);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img', class: 'chart' }, container);
  for (const v of niceTicks(lo, hi)) {
    el('line', { x1: L, x2: W - R, y1: Yc(v), y2: Yc(v), class: 'grid' }, svg);
    el('text', { x: L - 6, y: Yc(v) + 3, class: 'tick', 'text-anchor': 'end' }, svg).textContent = fmt(v);
  }
  const span = t1 - t0, tickStep = [60e3, 120e3, 300e3, 600e3, 900e3, 1800e3].find((s) => span / s <= 6) || 3600e3;
  for (let t = 0; t <= span; t += tickStep) el('text', { x: X(t0 + t), y: H - 6, class: 'tick', 'text-anchor': 'middle' }, svg).textContent = fmtTime(t);
  // event tick strip (rug) between plot and time axis
  if (rug) {
    const y = H - B + 4;
    for (const m of markers) el('line', { x1: X(m.t), x2: X(m.t), y1: y, y2: y + rug - 2, class: `rug status-${m.status || 'warning'}` }, svg);
  }
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Yc(p.mean).toFixed(1)}`).join('');
  if (band && binned) {
    const up = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Yc(p.max).toFixed(1)}`).join('');
    const dn = pts.slice().reverse().map((p) => `L${X(p.t).toFixed(1)},${Yc(p.min).toFixed(1)}`).join('');
    el('path', { d: `${up}${dn}Z`, fill: `var(${color})`, opacity: 0.22, class: 'range-band' }, svg);
  } else if (area) {
    el('path', { d: `${line}L${X(pts[pts.length - 1].t)},${Yc(Math.max(lo, 0))}L${X(pts[0].t)},${Yc(Math.max(lo, 0))}Z`, fill: `var(${color})`, opacity: 0.16 }, svg);
  }
  el('path', { d: line, fill: 'none', stroke: `var(${color})`, 'stroke-width': 2, 'stroke-linejoin': 'round' }, svg);
  // hover layer
  const cross = el('line', { y1: T, y2: H - B, class: 'crosshair', visibility: 'hidden' }, svg);
  const dot = el('circle', { r: 4, fill: `var(${color})`, stroke: 'var(--surface-1)', 'stroke-width': 2, visibility: 'hidden' }, svg);
  const tip = document.createElement('div'); tip.className = 'tooltip'; tip.hidden = true; container.appendChild(tip);
  const hit = el('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'transparent' }, svg);
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * W;
    const t = t0 + ((x - L) / (W - L - R)) * (t1 - t0);
    let best = pts[0]; for (const p of pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    const px = X(best.t), py = Yc(best.mean);
    cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('visibility', 'visible');
    tip.hidden = false;
    const range = binned && best.max - best.min > 1e-9 ? `<span>range ${fmt(best.min)} … ${fmt(best.max)}${unit}</span>` : '';
    tip.innerHTML = `<b>${binned ? 'avg ' : ''}${fmt(best.mean)}${unit}</b>${range}<span>${fmtTime(best.t - t0)}</span>`;
    const left = (px / W) * r.width;
    tip.style.left = `${Math.min(r.width - 130, Math.max(0, left + 10))}px`; tip.style.top = `${(py / H) * r.height - 10}px`;
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); });
}

// Horizontal bar chart: items [{label, value, color?}]
export function barChart(container, items, { unit = '', color = '--series-1' } = {}) {
  container.innerHTML = '';
  const max = Math.max(1, ...items.map((i) => i.value));
  const wrap = document.createElement('div'); wrap.className = 'bars';
  for (const it of items) {
    const row = document.createElement('div'); row.className = 'bar-row';
    row.innerHTML = `<span class="bar-label">${it.label}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(it.value / max) * 100}%;background:var(${it.color || color})"></span></span>
      <span class="bar-value">${it.value}${unit}</span>`;
    row.title = `${it.label}: ${it.value}${unit}`;
    wrap.appendChild(row);
  }
  container.appendChild(wrap);
}

// Vertical histogram: values bucketed by `step`
export function histogram(container, values, { step = 100, unit = '', color = '--series-2', height = 140 } = {}) {
  container.innerHTML = '';
  if (!values.length) { container.innerHTML = '<p class="empty">No data yet.</p>'; return; }
  const lo = Math.floor(Math.min(...values) / step) * step, hi = Math.ceil((Math.max(...values) + 1) / step) * step;
  const bins = []; for (let b = lo; b < hi; b += step) bins.push({ from: b, n: 0 });
  values.forEach((v) => { bins[Math.min(bins.length - 1, Math.floor((v - lo) / step))].n++; });
  const W = container.clientWidth || 400, H = height, L = 28, B = 22, T = 8;
  const max = Math.max(...bins.map((b) => b.n));
  const bw = (W - L - 4) / bins.length;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, class: 'chart' }, container);
  for (const v of niceTicks(0, max, 3)) {
    const y = T + (1 - v / max) * (H - T - B);
    el('line', { x1: L, x2: W, y1: y, y2: y, class: 'grid' }, svg);
    el('text', { x: L - 5, y: y + 3, class: 'tick', 'text-anchor': 'end' }, svg).textContent = v;
  }
  const tip = document.createElement('div'); tip.className = 'tooltip'; tip.hidden = true; container.appendChild(tip);
  bins.forEach((b, i) => {
    const h = (b.n / max) * (H - T - B);
    const x = L + i * bw + 1;
    const r = el('rect', { x, y: H - B - h, width: Math.max(1, bw - 2), height: Math.max(0, h), rx: 3, fill: `var(${color})` }, svg);
    const hit = el('rect', { x: L + i * bw, y: T, width: bw, height: H - T - B, fill: 'transparent' }, svg);
    hit.addEventListener('pointerenter', () => {
      tip.hidden = false; tip.innerHTML = `<b>${b.n}</b><span>${b.from}–${b.from + step}${unit}</span>`;
      const cr = svg.getBoundingClientRect();
      tip.style.left = `${(x / W) * cr.width}px`; tip.style.top = `${((H - B - h) / H) * cr.height - 34}px`;
      r.setAttribute('opacity', 0.8);
    });
    hit.addEventListener('pointerleave', () => { tip.hidden = true; r.setAttribute('opacity', 1); });
    if (i % Math.ceil(bins.length / 6) === 0) el('text', { x: x + bw / 2, y: H - 6, class: 'tick', 'text-anchor': 'middle' }, svg).textContent = b.from;
  });
}
