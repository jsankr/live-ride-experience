import { ocrPlate } from './reports.js';

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
  return { type: labels[vehicle.class], confidence: vehicle.score, rider: Boolean(rider), rank: rank(vehicle) };
}

export async function analyzeEvidence(photos) {
  const photoIds = photos.map((photo, index) => ({ ...photo, index }))
    .sort((a, b) => b.sharpness - a.sharpness).slice(0, 4);
  const classify = async () => {
    const detector = await loadDetector();
    let best = null;
    for (const photo of photoIds) {
      const bitmap = await createImageBitmap(photo.blob);
      try {
        const result = findSubjects(await detector.detect(bitmap, 12, 0.5), bitmap.width, bitmap.height);
        if (result) {
          const rank = result.rank * (result.rider ? 1.3 : 1);
          if (!best || rank > best.rank) best = { ...result, rank, frame: photo.index };
        }
      } finally { bitmap.close(); }
    }
    if (!best) return null;
    const { rank, ...result } = best;
    return result;
  };
  const readPlate = async () => {
    let best = null;
    for (const photo of photoIds.slice(0, 3)) {
      const result = await ocrPlate(photo.blob);
      // Require the complete recognised line to match, rather than trusting partial text.
      const possible = result.text.toUpperCase().split(/\n/).map((line) => line.replace(/[^A-Z0-9]/g, ''));
      const match = result.plates.find((plate) => possible.includes(plate));
      if (match && result.confidence >= 60 && (!best || result.confidence > best.confidence)) {
        best = { value: match, confidence: result.confidence, frame: photo.index };
      }
    }
    return best;
  };
  const [vehicle, plate] = await Promise.allSettled([classify(), readPlate()]);
  return {
    vehicle: vehicle.value ?? null, plate: plate.value ?? null,
    status: vehicle.status === 'rejected' || plate.status === 'rejected' ? 'partial' : 'complete',
  };
}
