// On-device AI models for wrong-side evidence, run with ONNX Runtime Web (WebAssembly).
// They run only on the few photos saved for each detection, never continuously, so
// they add no heat while riding.
//
//  * Number-plate detector: YOLOv9-t 384 from ankandrew/open-image-models (MIT licence),
//    mirror huggingface.co/wide-video/open-image-models-v0.5.1. Output [N, 7] =
//    [batch, x1, y1, x2, y2, class, score] in the 384x384 letterboxed input.
//  * Helmet classifier: EfficientNet-B0 "helmet_v5" from huggingface.co/vivekvar/helmet-v5
//    (Apache-2.0), trained on Indian traffic-camera rider crops. Input 224x224 RGB with
//    ImageNet normalisation; logits [helmet, no_helmet]. Its validation accuracy was 81 %
//    on traffic-camera views, so every result is shown as a suggestion with its probability.
//
// Files live in ./models/ next to the app; the runtime comes from jsDelivr.

const ORT_VERSION = '1.20.1';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const MODEL_DIR = new URL('../models/', import.meta.url);

let ortPromise;
function loadOrt() {
  ortPromise ??= new Promise((resolve, reject) => {
    if (window.ort) { resolve(window.ort); return; }
    const s = document.createElement('script');
    const timer = setTimeout(() => { s.remove(); reject(new Error('AI runtime timed out')); }, 20000);
    s.src = `${ORT_BASE}ort.wasm.min.js`;
    s.onload = () => {
      clearTimeout(timer);
      const ort = window.ort;
      ort.env.wasm.wasmPaths = ORT_BASE;
      ort.env.wasm.numThreads = 1; // no cross-origin isolation on GitHub Pages; also keeps the phone cooler
      resolve(ort);
    };
    s.onerror = () => { clearTimeout(timer); s.remove(); reject(new Error('AI runtime unavailable (offline?)')); };
    document.head.append(s);
  }).catch((e) => { ortPromise = null; throw e; });
  return ortPromise;
}

const sessions = {};
async function session(name, file, externalData) {
  sessions[name] ??= (async () => {
    const ort = await loadOrt();
    const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    if (externalData) opts.externalData = [{ path: externalData, data: new URL(externalData, MODEL_DIR).href }];
    return ort.InferenceSession.create(new URL(file, MODEL_DIR).href, opts);
  })().catch((e) => { sessions[name] = null; throw e; });
  return sessions[name];
}

function canvasOf(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

// [x, y, w, h] of `image` drawn into a size x size square with grey padding (letterbox)
function letterbox(image, box, size) {
  const [x, y, w, h] = box;
  const k = size / Math.max(w, h);
  const dw = w * k, dh = h * k, ox = (size - dw) / 2, oy = (size - dh) / 2;
  const c = canvasOf(size, size), g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = 'rgb(114,114,114)'; g.fillRect(0, 0, size, size);
  g.drawImage(image, x, y, w, h, ox, oy, dw, dh);
  return { canvas: c, k, ox, oy };
}

function toTensor(ort, canvas, size, mean = null, std = null) {
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, size, size);
  const n = size * size, f = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = data[i * 4 + c] / 255;
      f[c * n + i] = mean ? (v - mean[c]) / std[c] : v;
    }
  }
  return new ort.Tensor('float32', f, [1, 3, size, size]);
}

const clampBox = (image, [x, y, w, h]) => {
  const x0 = Math.max(0, x), y0 = Math.max(0, y);
  return [x0, y0, Math.max(1, Math.min(image.width, x + w) - x0), Math.max(1, Math.min(image.height, y + h) - y0)];
};

// Number plates inside `region` (default: whole image). Returns boxes in image pixels, best first.
export async function detectPlates(image, region = [0, 0, image.width, image.height], minScore = 0.35) {
  const ort = await loadOrt();
  const s = await session('plate', 'plate-yolov9t-384.onnx');
  const box = clampBox(image, region);
  const { canvas, k, ox, oy } = letterbox(image, box, 384);
  const out = (await s.run({ [s.inputNames[0]]: toTensor(ort, canvas, 384) }))[s.outputNames[0]];
  const rows = out.dims[0], cols = out.dims[1] || 7, d = out.data, plates = [];
  for (let r = 0; r < rows; r++) {
    const [, x1, y1, x2, y2, , score] = Array.from(d.subarray(r * cols, r * cols + 7));
    if (score < minScore) continue;
    plates.push({ score, box: [box[0] + (x1 - ox) / k, box[1] + (y1 - oy) / k, (x2 - x1) / k, (y2 - y1) / k] });
  }
  return plates.sort((a, b) => b.score - a.score);
}

// Helmet on a rider's head crop: { pNoHelmet, label }
export async function classifyHelmet(image, headBox) {
  const ort = await loadOrt();
  const s = await session('helmet', 'helmet_v5.onnx', 'helmet_v5.onnx.data');
  const [x, y, w, h] = clampBox(image, headBox);
  const c = canvasOf(224, 224);
  c.getContext('2d', { willReadFrequently: true }).drawImage(image, x, y, w, h, 0, 0, 224, 224);
  const out = (await s.run({ [s.inputNames[0]]: toTensor(ort, c, 224, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]) }))[s.outputNames[0]];
  const [a, b] = out.data;
  const m = Math.max(a, b), ea = Math.exp(a - m), eb = Math.exp(b - m);
  const pNoHelmet = eb / (ea + eb);
  return { pNoHelmet: +pNoHelmet.toFixed(2), label: pNoHelmet >= 0.5 ? 'no_helmet' : 'helmet' };
}

// Combine several frames' helmet scores into one verdict a person can act on.
export function helmetVerdict(scores) {
  if (!scores.length) return { verdict: 'not seen', p: null, frames: 0 };
  const p = scores.reduce((s, x) => s + x.pNoHelmet, 0) / scores.length;
  const verdict = p >= 0.7 ? 'no helmet' : p <= 0.3 ? 'helmet' : 'unclear';
  return { verdict, p: +p.toFixed(2), frames: scores.length };
}

// The rider's head: top of the person box, squared up and padded a little.
export function headBox([x, y, w, h]) {
  const side = Math.max(w * 0.75, h * 0.28);
  return [x + w / 2 - side / 2, y - side * 0.08, side, side];
}

export async function warmUp() { await Promise.all([session('plate', 'plate-yolov9t-384.onnx'), session('helmet', 'helmet_v5.onnx', 'helmet_v5.onnx.data')]); }
