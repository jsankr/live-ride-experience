import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colourName, vehicleColour, votePlates } from '../public/js/evidence-analysis.js';

const fill = (n, rgb) => Array.from({ length: n }, () => rgb);

test('vehicle colour: painted colour wins over black trim, tyres and glass', () => {
  assert.equal(colourName(140, 30, 50), 'Maroon'); assert.equal(colourName(220, 30, 40), 'Red');
  assert.equal(colourName(30, 30, 30), 'Black'); assert.equal(colourName(235, 235, 232), 'White');
  // the 26 Nov R15: maroon fairing, black screen and trim, grey floor in view
  assert.equal(vehicleColour([...fill(30, [140, 35, 55]), ...fill(35, [25, 25, 28]), ...fill(35, [150, 150, 148])]), 'Maroon and black');
  assert.equal(vehicleColour([...fill(60, [30, 60, 170]), ...fill(40, [140, 140, 140])]), 'Blue');
  assert.equal(vehicleColour([...fill(70, [240, 240, 238]), ...fill(30, [20, 20, 20])]), 'White');
  assert.equal(vehicleColour([...fill(30, [240, 240, 238]), ...fill(35, [20, 20, 20]), ...fill(35, [150, 150, 150])]), null, 'no clear answer: leave it empty');
});

test('plate voting: the same valid registration twice beats one confident read', () => {
  const v = votePlates([
    { value: 'TN11AH1895', confidence: 19, detector: 0.76, frame: 0 },
    { value: 'TN18E1895', confidence: 60, detector: 0.76, frame: 0 },
    { value: 'TN11AH1895', confidence: 47, detector: 0.76, frame: 2 },
  ]);
  assert.equal(v.value, 'TN11AH1895'); assert.equal(v.votes, 2); assert.equal(v.framesRead, 2); assert.equal(v.accepted, true);
  assert.equal(votePlates([{ value: 'TN010195', confidence: 18, detector: null, frame: 0 }]).accepted, false, 'one weak read is only a suggestion');
  assert.equal(votePlates([]), null);
});

// ---- plate text model (27 Nov 2026 frames) ----
import { ctcDecode } from '../public/js/ai-models.js';
import { votePlates as vote2 } from '../public/js/evidence-analysis.js';
import { plateFromText as pft } from '../public/js/reports.js';
test('CTC decode collapses repeats, skips blanks, keeps a repeat split by a blank', () => {
  const dict = ['', '9', 'T', 'N'];
  const steps = [2, 2, 3, 0, 1, 1, 0, 1]; // T T N _ 9 9 _ 9  -> "TN99"
  const scores = new Float32Array(steps.length * 4);
  steps.forEach((c, t) => { scores[t * 4 + c] = 0.9; });
  assert.deepEqual(ctcDecode(scores, steps.length, 4, dict).text, 'TN99');
});
test('a 0 in the series position is a D (series never uses O)', () => {
  assert.equal(pft('TN19809993'), 'TN19BD9993');
  assert.equal(pft('TN 19 BD 9993'), 'TN19BD9993');
});
test('plate-model reads need two agreeing reads that beat every other reading', () => {
  const r = (value, confidence) => ({ value, confidence, frame: 0, detector: 0.7, engine: 'plate-ocr' });
  assert.equal(vote2([r('TN19D9993', 95)]).accepted, false, 'one confident read is not enough');
  assert.equal(vote2([r('TN19BD9993', 90), r('TN19BD9993', 80)]).accepted, true);
  assert.equal(vote2([r('TN19BD9993', 90), r('TN19BD9993', 80), r('TN19D9993', 85), r('TN19D9993', 70)]).accepted, false, 'a tie is not accepted');
});
