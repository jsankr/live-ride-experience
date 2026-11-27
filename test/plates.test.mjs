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

import { plateFromText, fixPlateChars } from '../public/js/reports.js';
test('plate text from real OCR output: pieces split by bolts and dots are recombined', () => {
  // Tesseract output on the 26 Nov photo of TN 11 AH 1895 (dots and bolts between the groups)
  assert.equal(plateFromText('TN 11AH\n\nA J\n\n1895\n'), 'TN11AH1895');
  assert.equal(plateFromText('TN 11AH\n\n1895 1\n'), 'TN11AH1895');
  assert.equal(plateFromText('TN 11 AH 1B95'), 'TN11AH1895', 'B read for 8 in the number part');
  assert.equal(plateFromText('KA O1 AB I234'), 'KA01AB1234');
  assert.equal(plateFromText('114\nH 1895 7\n'), null, 'no state code: not a plate');
  assert.equal(plateFromText('XX 11 AB 1234'), null, 'unknown state code');
  assert.equal(fixPlateChars('TN11AH1B95'), 'TN11AH1895');
});
