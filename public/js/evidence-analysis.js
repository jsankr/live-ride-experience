import { normalizePlate, ocrPlate } from './reports.js';

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
export function findSubjects(predictions, width, height) {
  const rank = ({ bbox: [x, y, w, h], score }) => score * Math.sqrt(w * h / (width * height))
    / (1 + Math.abs((x + w / 2) / width - 0.5) + Math.abs((y + h / 2) / height - 0.5));
  const vehicle = predictions.filter((p) => labels[p.class]).sort((a, b) => rank(b) - rank(a))[0];
  if (!vehicle) return null;
  const [x, y, w, h] = vehicle.bbox;
  const rider = ['motorcycle', 'bicycle'].includes(vehicle.class) && predictions.some((p) => {
    if (p.class !== 'person') return false;
    const [px, py, pw, ph] = p.bbox;
    return px + pw / 2 >= x && px + pw / 2 <= x + w && py < y + h && py + ph >= y && py + ph <= y + h * 1.25;
  });
  return { type: labels[vehicle.class], confidence: vehicle.score, rider: Boolean(rider), box: vehicle.bbox, rank: rank(vehicle) };
}

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

function bodyColour(image, [x, y, w, h]) {
  // Sample both sides of the vehicle body, away from the plate and windscreen.
  const votes = new Map();
  for (const side of [0.14, 0.66]) {
    const canvas = imageRegion(image, [x + side * w, y + 0.40 * h, 0.20 * w, 0.33 * h], 24, 24);
    const { data } = canvas.getContext('2d').getImageData(0, 0, 24, 24);
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = data.subarray(i, i + 3);
      const hi = Math.max(r, g, b), lo = Math.min(r, g, b), delta = hi - lo;
      let name = hi < 70 ? 'Black' : hi > 205 ? 'White' : 'Gray';
      if (hi >= 70 && delta > 32 && delta / hi > 0.26) {
        const hue = 60 * (hi === r ? (g - b) / delta : hi === g ? 2 + (b - r) / delta : 4 + (r - g) / delta);
        const angle = (hue + 360) % 360;
        name = angle < 20 || angle >= 345 ? 'Red' : angle < 48 ? (hi < 150 ? 'Brown' : 'Orange')
          : angle < 70 ? 'Yellow' : angle < 165 ? 'Green' : angle < 265 ? 'Blue' : angle < 305 ? 'Purple' : 'Pink';
      }
      votes.set(name, (votes.get(name) || 0) + 1);
    }
  }
  const [name, count] = [...votes].sort((a, b) => b[1] - a[1])[0];
  return count >= 0.55 * 1152 ? name : null;
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
  const lines = result.text.toUpperCase().split(/\n/).map((line) => line.replace(/[^A-Z0-9]/g, '')).filter(Boolean);
  const candidates = [lines.join(''), ...lines];
  for (const text of candidates) {
    const match = normalizePlate(text);
    if (match.valid) return { value: match.plate, confidence: result.confidence };
  }
  return null;
}

async function recognizeRegion(image, box, onProgress, segmentation = '11') {
  const [,, w, h] = box;
  const canvas = imageRegion(image, box, Math.min(1200, Math.max(540, w)), Math.min(1000, Math.max(64, Math.round(Math.min(1200, Math.max(540, w)) * h / w))));
  const ctx = canvas.getContext('2d');
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let sum = 0;
  for (let i = 0; i < pixels.data.length; i += 4) {
    const gray = 0.299 * pixels.data[i] + 0.587 * pixels.data[i + 1] + 0.114 * pixels.data[i + 2];
    pixels.data[i] = gray;
    sum += gray;
  }
  const mean = sum / (pixels.data.length / 4);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const gray = (pixels.data[i] - mean) * 1.65 + 128;
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = gray;
  }
  ctx.putImageData(pixels, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return ocrPlate(blob, onProgress, segmentation);
}

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

export async function analyzeEvidence(photos, onProgress) {
  const frames = photos.map((photo, index) => ({ ...photo, index }))
    .sort((a, b) => (b.sharpness ?? 0) - (a.sharpness ?? 0)).slice(0, 4);
  const regions = [];
  let unavailable = false;
  try {
    const detector = await loadDetector();
    for (const photo of frames) {
      const image = await createImageBitmap(photo.blob);
      try {
        const result = findSubjects(await detector.detect(image, 12, 0.45), image.width, image.height);
        if (result) regions.push({ ...result, frame: photo.index, color: bodyColour(image, result.box) });
      } finally { image.close(); }
    }
  } catch { unavailable = true; }
  regions.sort((a, b) => b.rank * (b.rider ? 1.3 : 1) - a.rank * (a.rider ? 1.3 : 1));
  const top = regions[0];
  let plate = null;
  try {
    const targets = (regions.length ? regions : frames.map(({ index }) => ({ frame: index }))).slice(0, 3);
    for (const target of targets) {
      const image = await createImageBitmap(photos[target.frame].blob);
      try {
        const [x, y, w, h] = target.box || [0, 0, image.width, image.height];
        const crops = target.box
          ? [[x + w * 0.23, y + h * 0.54, w * 0.54, h * 0.39], [x + w * 0.08, y + h * 0.36, w * 0.84, h * 0.64]]
          : [[x, y, w, h]];
        const precise = target.box ? likelyPlateRegions(image, target.box) : [];
        for (const crop of [...precise, ...crops]) {
          const mode = precise.includes(crop) ? '7' : '11';
          const candidate = plateCandidate(await recognizeRegion(image, crop, onProgress, mode));
          if (candidate && (!plate || candidate.confidence > plate.confidence)) plate = { ...candidate, frame: target.frame };
          if (plate?.confidence >= 85) break;
        }
      } finally { image.close(); }
      if (plate?.confidence >= 85) break;
    }
  } catch { unavailable = true; }
  const vehicle = top && { type: top.type, confidence: top.confidence, color: top.color, rider: top.rider, frame: top.frame };
  return { vehicle: vehicle ?? null, plate, status: unavailable ? 'partial' : 'complete' };
}
