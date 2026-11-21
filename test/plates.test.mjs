import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlate, findPlates, reportsToCsv } from '../public/js/reports.js';

test('normalises and validates Indian registration numbers', () => {
  assert.deepEqual(normalizePlate('ka 01 ab 1234'), { plate: 'KA01AB1234', valid: true });
  assert.deepEqual(normalizePlate('DL-3C-1234'), { plate: 'DL3C1234', valid: true });
  assert.deepEqual(normalizePlate('22 BH 1234 AA'), { plate: '22BH1234AA', valid: true });
  assert.equal(normalizePlate('MHO2 CD 5678').plate, 'MH02CD5678');
  assert.equal(normalizePlate('HELLO').valid, false);
});

test('pulls plate candidates out of noisy OCR text', () => {
  const p = findPlates('IND\n KA 05 MN 4321 \n~~');
  assert.equal(p[0], 'KA05MN4321');
});

test('csv export escapes quotes', () => {
  const csv = reportsToCsv([{ id: '1', t: 0, notes: 'said "hi"', plate: 'KA01AB1234' }]);
  assert.match(csv, /"said ""hi"""/);
});
