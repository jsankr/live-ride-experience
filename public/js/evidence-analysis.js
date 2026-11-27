import { normalizePlate, ocrPlate, plateFromText } from './reports.js';
import { detectPlates, classifyHelmet, helmetVerdict, headBox } from './ai-models.js';

let model;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => {
      script.remove();
      reject(new Error('Analysis library timed out'));
    }, 12000);
    script.src = src;
    script.onload = () => { clearTimeout(timer); resolve(); };
    script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('Analysis library unavailable')); };
    document.head.append(script);
  });
}

export async function loadDetector() {
  model ??= (async () => {
    if (!window.tf) await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
    if (!window.cocoSsd) await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js');
    return window.cocoSsd.load({ base: 'lite_mobilenet_v2' });
  })().catch((error) => { model = null; throw error; });
  return model;
}

const labels = { motorcycle: 'Two-wheeler', car: 'Car', bus: 'Bus', truck: 'Truck / tempo', bicycle: 'Cycle' };
// hint: the auto-detection that triggered the capture ({ vehicleClass, box: normalised [x,y,w,h] }),
// so the photos are searched for THAT vehicle rather than whatever is biggest in view.
export function findSubjects(predictions, width, height, hint = null) {
  const near = (b) => {
    if (!hint?.box) return 1;
    const dx = (b[0] + b[2] / 2) / width - (hint.box[0] + hint.box[2] / 2), dy = (b[1] + b[3] / 2) / height - (hint.box[1] + hint.box[3] / 2);
    return 1 / (1 + 3 * Math.hypot(dx, dy));
  };
  const rank = ({ bbox, score, class: cls }) => score * Math.sqrt(bbox[2] * bbox[3] / (width * height))
    * (hint?.vehicleClass ? (cls === hint.vehicleClass ? 1.6 : 0.6) * near(bbox)
      : 1 / (1 + Math.abs((bbox[0] + bbox[2] / 2) / width - 0.5) + Math.abs((bbox[1] + bbox[3] / 2) / height - 0.5)));
  const vehicle = predictions.filter((p) => labels[p.class]).sort((a, b) => rank(b) - rank(a))[0];
  if (!vehicle) return null;
  const [x, y, w, h] = vehicle.bbox;
  const riders = ['motorcycle', 'bicycle'].includes(vehicle.class) ? predictions.filter((p) => {
    if (p.class !== 'person') return false;
    const [px, py, pw, ph] = p.bbox;
    return px + pw / 2 >= x && px + pw / 2 <= x + w && py < y + h && py + ph >= y && py + ph <= y + h * 1.25;
  }).sort((a, b) => b.bbox[2] * b.bbox[3] - a.bbox[2] * a.bbox[3]) : [];
  return { type: labels[vehicle.class], vehicleClass: vehicle.class, confidence: vehicle.score, rider: riders.length > 0, riders: riders.length,
    riderBox: riders[0]?.bbox ?? null, box: vehicle.bbox, rank: rank(vehicle) };
}

// a JPEG of part of an image, at most maxSide pixels on its longer side
async function cropJpeg(image, box, maxSide, quality = 0.85) {
  const [x, y, w, h] = [Math.max(0, box[0]), Math.max(0, box[1]), Math.min(image.width - Math.max(0, box[0]), box[2]), Math.min(image.height - Math.max(0, box[1]), box[3])];
  if (w < 4 || h < 4) return null;
  const k = Math.min(maxSide / Math.max(w, h), 3); // small crops are enlarged (up to 3x) so they stay readable
  const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(image, x, y, w, h, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
}
const pad = ([x, y, w, h], f) => [x - w * f, y - h * f, w * (1 + 2 * f), h * (1 + 2 * f)];

function imageRegion(image, box, width, height) {
  const canvas = document.createElement('canvas');
  const x = Math.max(0, Math.min(image.width - 1, Math.floor(box[0])));
  const y = Math.max(0, Math.min(image.height - 1, Math.floor(box[1])));
  const w = Math.max(1, Math.min(image.width - x, Math.ceil(box[0] + box[2]) - x));
  const h = Math.max(1, Math.min(image.height - y, Math.ceil(box[1] + box[3]) - y));
  canvas.width = width;
  canvas.height = height || Math.max(1, Math.round(width * h / w));
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(image, x, y, w, h, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// ---- vehicle colour ----
// One pixel's colour name.
export function colourName(r, g, b) {
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b), delta = hi - lo;
  if (hi < 55) return 'Black';
  if (delta < 28 || delta / hi < 0.22) return hi > 200 ? 'White' : hi > 140 ? 'Silver' : hi < 85 ? 'Black' : 'Gray';
  const hue = (60 * (hi === r ? (g - b) / delta : hi === g ? 2 + (b - r) / delta : 4 + (r - g) / delta) + 360) % 360;
  if (hue < 18 || hue >= 335) return hi < 150 ? 'Maroon' : 'Red';
  if (hue < 45) return hi < 150 ? 'Brown' : 'Orange';
  if (hue < 70) return 'Yellow';
  if (hue < 165) return 'Green';
  if (hue < 255) return 'Blue';
  if (hue < 300) return 'Purple';
  return 'Pink';
}
// Paint colour from pixels sampled on the vehicle body. Vehicles are mostly one painted
// colour plus black trim, tyres and glass, so a painted colour wins once it covers a fifth
// of the samples; otherwise the commonest neutral (white, silver, gray, black) is used.
export function vehicleColour(pixels) {
  if (!pixels.length) return null;
  const votes = new Map();
  for (const [r, g, b] of pixels) { const n = colourName(r, g, b); votes.set(n, (votes.get(n) || 0) + 1); }
  const share = (n) => (votes.get(n) || 0) / pixels.length;
  const reds = share('Red') + share('Maroon');
  const painted = [['Red', reds], ...['Orange', 'Brown', 'Yellow', 'Green', 'Blue', 'Purple', 'Pink'].map((n) => [n, share(n)])].sort((a, b) => b[1] - a[1])[0];
  if (painted[1] >= 0.2) {
    const name = painted[0] === 'Red' && share('Maroon') > share('Red') ? 'Maroon' : painted[0];
    return share('Black') >= 0.25 ? `${name} and black` : name;
  }
  const neutral = ['White', 'Silver', 'Gray', 'Black'].map((n) => [n, share(n)]).sort((a, b) => b[1] - a[1])[0];
  return neutral[1] >= 0.4 ? neutral[0] : null;
}
// Sample the middle of the vehicle (away from road, wheels and background at the box edges),
// skipping the number plate.
function bodyColour(image, [x, y, w, h], skip = null) {
  const region = [x + w * 0.22, y + h * 0.22, w * 0.56, h * 0.5];
  const canvas = imageRegion(image, region, 48, 48);
  const { data } = canvas.getContext('2d').getImageData(0, 0, 48, 48);
  const px = [];
  for (let i = 0; i < 48 * 48; i++) {
    if (skip) {
      const gx = region[0] + ((i % 48) + 0.5) * region[2] / 48, gy = region[1] + (Math.floor(i / 48) + 0.5) * region[3] / 48;
      if (gx >= skip[0] && gx <= skip[0] + skip[2] && gy >= skip[1] && gy <= skip[1] + skip[3]) continue;
    }
    px.push([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);
  }
  return vehicleColour(px);
}

// ---- plate voting across frames ----
// reads: [{ value, confidence (OCR 0-100), detector (0-1|null), frame }]. The same valid
// registration read in two or more frames is far more trustworthy than one high OCR score.
export function votePlates(reads) {
  if (!reads.length) return null;
  const by = new Map();
  for (const r of reads) {
    const g = by.get(r.value) || { value: r.value, votes: 0, confidence: 0, detector: null, frame: r.frame };
    g.votes++;
    if (r.confidence > g.confidence) { g.confidence = r.confidence; g.frame = r.frame; }
    g.detector = Math.max(g.detector ?? 0, r.detector ?? 0) || g.detector;
    by.set(r.value, g);
  }
  const best = [...by.values()].sort((a, b) => b.votes - a.votes || b.confidence - a.confidence)[0];
  const frames = new Set(reads.map((r) => r.frame)).size;
  // accepted = good enough to fill the registration field by itself (always reviewable)
  const accepted = best.confidence >= 75 || best.votes >= 2 || ((best.detector ?? 0) >= 0.6 && best.confidence >= 30);
  return { ...best, framesRead: frames, accepted };
}

function likelyPlateRegions(image, [x, y, w, h]) {
  const lower = [x, y + h * 0.4, w, h * 0.6];
  const width = 240;
  const height = 120;
  const canvas = imageRegion(image, lower, width, height);
  const { data } = canvas.getContext('2d').getImageData(0, 0, width, height);
  const mask = new Uint8Array(width * height);
  const pending = new Int32Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    const [r, g, b] = data.subarray(i * 4, i * 4 + 3);
    mask[i] = 0.3 * r + 0.59 * g + 0.11 * b > 150 ? 1 : 0;
  }
  const candidates = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    mask[i] = 0;
    pending[0] = i;
    let size = 1, left = width, right = 0, top = height, bottom = 0;
    for (let j = 0; j < size; j++) {
      const p = pending[j], px = p % width, py = Math.floor(p / width);
      left = Math.min(left, px); right = Math.max(right, px);
      top = Math.min(top, py); bottom = Math.max(bottom, py);
      const adjacent = [px > 0 ? p - 1 : -1, px + 1 < width ? p + 1 : -1, p - width, p + width];
      for (const next of adjacent) {
        if (mask[next]) { mask[next] = 0; pending[size++] = next; }
      }
    }
    const bw = right - left + 1, bh = bottom - top + 1;
    const aspect = (bw * w / width) / (bh * lower[3] / height);
    const fill = size / (bw * bh);
    if (bw < 16 || bw > width * 0.7 || bh < 5 || bh > height * 0.55 || aspect < 1.15 || aspect > 8 || fill < 0.35) continue;
    const box = [x + (left - bw * 0.05) * w / width, lower[1] + (top - bh * 0.12) * lower[3] / height,
      bw * 1.10 * w / width, bh * 1.24 * lower[3] / height];
    const center = Math.abs((left + bw / 2) / width - 0.5);
    candidates.push({ box, score: fill * Math.sqrt(bw * bh) / (1 + center * 4) });
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, 2).map(({ box }) => box);
}

function plateCandidate(result) {
  const plate = plateFromText(result.text);
  return plate ? { value: plate, confidence: result.confidence } : null;
}

// OCR one image region. plain: greyscale only; binarize: Otsu black/white. A white border
// is added because Tesseract reads text touching the image edge badly.
async function recognizeRegion(image, box, onProgress, segmentation = '11', binarize = false, contrast = !binarize) {
  const [,, w, h] = box;
  const width = Math.min(1200, Math.max(900, w)), height = Math.min(1000, Math.max(64, Math.round(width * h / w))), B = 30;
  const src = imageRegion(image, box, width, height);
  const canvas = document.createElement('canvas'); canvas.width = width + 2 * B; canvas.height = height + 2 * B;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(src, B, B);
  const pixels = ctx.getImageData(B, B, width, height), n = width * height, gray = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) { gray[i] = 0.299 * pixels.data[i * 4] + 0.587 * pixels.data[i * 4 + 1] + 0.114 * pixels.data[i * 4 + 2]; sum += gray[i]; }
  const mean = sum / n;
  let cut = mean;
  if (binarize) { // Otsu threshold
    const hist = new Array(256).fill(0);
    for (const g of gray) hist[Math.min(255, Math.max(0, Math.round(g)))]++;
    let sumAll = 0; for (let t = 0; t < 256; t++) sumAll += t * hist[t];
    let wB = 0, sumB = 0, best = -1;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB || wB === n) continue;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sumAll - sumB) / (n - wB), v = wB * (n - wB) * (mB - mF) ** 2;
      if (v > best) { best = v; cut = t; }
    }
  }
  for (let i = 0; i < n; i++) {
    const v = binarize ? (gray[i] > cut ? 255 : 0) : contrast ? (gray[i] - mean) * 1.65 + 128 : gray[i];
    pixels.data[i * 4] = pixels.data[i * 4 + 1] = pixels.data[i * 4 + 2] = v;
  }
  ctx.putImageData(pixels, B, B);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return ocrPlate(blob, onProgress, segmentation);
}

// Preprocessing variants tried on a detected plate. Chosen on a real photo (TN 11 AH 1895,
// 26 Nov): no single one is reliable, but the correct plate came out of most of them while
// each wrong read appeared once, so the reads vote. [inset of the detected box, psm, mode]
const PLATE_VARIANTS = [[-0.06, '11', 'plain'], [0.04, '11', 'plain'], [0.04, '6', 'plain'], [0.04, '7', 'plain'], [0, '11', 'otsu']];

export async function readPlateCrop(blob, region, onProgress) {
  const bitmap = await createImageBitmap(blob);
  try {
    const box = region.map((value, i) => value * (i % 2 ? bitmap.height : bitmap.width));
    for (const mode of ['7', '11']) {
      const result = plateCandidate(await recognizeRegion(bitmap, box, onProgress, mode));
      if (result) return result;
    }
    return null;
  } finally { bitmap.close(); }
}

// Things the camera cannot judge reliably from a moving motorcycle; listed in the report
// so nobody assumes they were checked.
export const NOT_ASSESSED = [
  ['Seat belt', 'Not checked: through a windscreen at road distance, a phone camera cannot see a belt reliably, and no tested model exists for this view.'],
  ['Rear-view mirrors', 'Not checked: no public model detects two-wheeler mirrors; check the snapshot yourself.'],
];

// options.allFrames: analyse every photo instead of the five sharpest ("Reanalyse all frames")
export async function analyzeEvidence(photos, onProgress, hint = null, { allFrames = false } = {}) {
  const say = (status) => onProgress?.({ status });
  const frames = photos.map((photo, index) => ({ ...photo, index }))
    .sort((a, b) => (b.sharpness ?? 0) - (a.sharpness ?? 0)).slice(0, allFrames ? photos.length : 5);
  const regions = [];
  let unavailable = false;
  try {
    const detector = await loadDetector();
    for (const [n, photo] of frames.entries()) {
      say(`Finding the vehicle: photo ${n + 1} of ${frames.length}…`);
      const image = await createImageBitmap(photo.blob);
      try {
        const result = findSubjects(await detector.detect(image, 15, 0.35), image.width, image.height, hint);
        if (result) regions.push({ ...result, frame: photo.index });
      } finally { image.close(); }
    }
  } catch { unavailable = true; }
  regions.sort((a, b) => b.rank * (b.rider ? 1.3 : 1) - a.rank * (a.rider ? 1.3 : 1));
  const top = regions[0];

  // 1. number plate, in every analysed frame: the detector runs on the whole photo (it was
  // trained on road scenes; a tight crop makes the plate too big for it) and, for small
  // distant vehicles, on the vehicle enlarged. Plates inside the vehicle win; each is read
  // by OCR and the frames vote.
  const reads = [];
  let plateCrop = null, plateModel = 'ok';
  const targets = (regions.length ? regions : frames.map(({ index }) => ({ frame: index }))).slice(0, allFrames ? 99 : 4);
  for (const [n, target] of targets.entries()) {
    say(`Reading the number plate: photo ${n + 1} of ${targets.length}…`);
    const image = await createImageBitmap(photos[target.frame].blob);
    try {
      let found = [];
      try {
        found = await detectPlates(image);
        if (target.box && target.box[2] * target.box[3] < 0.25 * image.width * image.height) found.push(...await detectPlates(image, pad(target.box, 0.15)));
      } catch { plateModel = 'unavailable'; }
      const inside = (b) => !target.box || (b[0] + b[2] / 2 >= target.box[0] && b[0] + b[2] / 2 <= target.box[0] + target.box[2] && b[1] + b[3] / 2 >= target.box[1] && b[1] + b[3] / 2 <= target.box[1] + target.box[3] * 1.05);
      found = found.filter((pl) => inside(pl.box)).sort((a, b) => b.score - a.score);
      if (found.length && target.box) target.plateBox = found[0].box;
      for (const pl of found.slice(0, 1)) {
        if (!plateCrop || pl.score > plateCrop.score) plateCrop = { score: pl.score, frame: target.frame, blob: await cropJpeg(image, pad(pl.box, 0.06), 480, 0.92) };
        try {
          const here = [];
          for (const [inset, mode, kind] of PLATE_VARIANTS) {
            const crop = pad(pl.box, -inset); // negative inset = a little margin around the plate
            const candidate = plateCandidate(await recognizeRegion(image, crop, onProgress, mode, kind === 'otsu', false));
            if (!candidate) continue;
            here.push(candidate.value);
            reads.push({ ...candidate, frame: target.frame, detector: +pl.score.toFixed(2) });
            if (here.filter((v) => v === candidate.value).length >= 2 && !allFrames) break; // two agreeing reads in this frame are enough
          }
        } catch { unavailable = true; }
      }
      // fallback when the plate model is unavailable or found nothing: older brightness heuristics
      if (!found.length && !reads.length) {
        try {
          const [x, y, w, h] = target.box || [0, 0, image.width, image.height];
          const precise = target.box ? likelyPlateRegions(image, target.box) : [];
          const broad = target.box ? [[x + w * 0.23, y + h * 0.54, w * 0.54, h * 0.39], [x + w * 0.08, y + h * 0.36, w * 0.84, h * 0.64]] : [[x, y, w, h]];
          for (const crop of [...precise, ...broad]) {
            const candidate = plateCandidate(await recognizeRegion(image, crop, onProgress, precise.includes(crop) ? '7' : '11'));
            if (candidate) { reads.push({ ...candidate, frame: target.frame, detector: null }); if (candidate.confidence >= 85) break; }
          }
        } catch { unavailable = true; }
      }
      // colour from the body, now that the plate's position is known
      if (target.box) target.color = bodyColour(image, target.box, target.plateBox);
    } finally { image.close(); }
    const v = votePlates(reads);
    if (!allFrames && v && v.confidence >= 85 && v.votes >= 1 && n >= 1) break;
  }
  const plate = votePlates(reads);
  // colour: the most common answer over the frames
  const colours = regions.map((r) => r.color).filter(Boolean);
  const colour = colours.length ? [...colours.reduce((m, c) => m.set(c, (m.get(c) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1])[0][0] : null;
  if (top) top.color = colour;

  // 2. rider and helmet (two-wheelers): head crop of the rider on the matched vehicle, every frame it is seen
  const helmetScores = [];
  let helmetModel = 'ok';
  const twoWheeler = top && ['motorcycle', 'bicycle'].includes(top.vehicleClass);
  if (twoWheeler) {
    for (const r of regions.filter((x) => x.riderBox && x.vehicleClass === top.vehicleClass).slice(0, 4)) {
      const image = await createImageBitmap(photos[r.frame].blob);
      try { helmetScores.push(await classifyHelmet(image, headBox(r.riderBox))); } catch { helmetModel = 'unavailable'; } finally { image.close(); }
    }
  }

  // 3. snapshots kept for the report: vehicle, rider (person + vehicle), plate
  const crops = {};
  if (top) {
    const image = await createImageBitmap(photos[top.frame].blob);
    try {
      crops.vehicle = await cropJpeg(image, pad(top.box, 0.1), 720);
      const withRider = regions.find((x) => x.frame === top.frame && x.riderBox) || (top.riderBox ? top : null);
      if (withRider) {
        const [vx, vy, vw, vh] = withRider.box, [px, py, pw, ph] = withRider.riderBox;
        const x0 = Math.min(vx, px), y0 = Math.min(vy, py);
        crops.rider = await cropJpeg(image, pad([x0, y0, Math.max(vx + vw, px + pw) - x0, Math.max(vy + vh, py + ph) - y0], 0.08), 720);
        crops.head = await cropJpeg(image, headBox(withRider.riderBox), 320);
      }
    } finally { image.close(); }
  }
  if (plateCrop?.blob) crops.plate = plateCrop.blob;

  const vehicle = top && { type: top.type, vehicleClass: top.vehicleClass, confidence: top.confidence, color: top.color, rider: top.rider, riders: top.riders, frame: top.frame };
  return {
    vehicle: vehicle ?? null, plate,
    plateBox: plateCrop ? { score: +plateCrop.score.toFixed(2), frame: plateCrop.frame } : null,
    helmet: twoWheeler ? { ...helmetVerdict(helmetScores), model: helmetModel } : null,
    crops, models: { plate: plateModel, helmet: twoWheeler ? helmetModel : 'not needed' },
    notAssessed: NOT_ASSESSED.map(([item, why]) => ({ item, why })),
    status: unavailable || plateModel !== 'ok' ? 'partial' : 'complete',
  };
}
