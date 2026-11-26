import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { MODULES } from '../public/js/build-id.js';

test('every app module is in the build list and the offline cache', async () => {
  const files = (await readdir('public/js')).filter((f) => f.endsWith('.js') && f !== 'cockpit.js');
  assert.deepEqual([...MODULES].sort(), files.sort(), 'build-id.js MODULES must list every file in public/js');
  const sw = await readFile('public/sw.js', 'utf8');
  for (const m of MODULES) assert.ok(sw.includes(`'js/${m}'`), `sw.js SHELL is missing js/${m}`);
});
