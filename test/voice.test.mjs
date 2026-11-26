import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../public/js/voice.js';

test('voice: spoken phrases map to screens and controls', () => {
  const cases = {
    'show me the camera': 'view:camera', 'Dashcam': 'view:camera', 'open recordings': 'view:camera',
    'live': 'view:live', 'go to dashboard': 'view:live', 'report': 'view:report', 'Reports please': 'view:report',
    'history': 'view:history', 'settings': 'view:setup', 'set up': 'view:setup',
    'start the ride': 'start ride', 'stop ride': 'stop ride', 'end the recording': 'stop ride',
    'full screen': 'full screen', 'fullscreen': 'full screen', 'exit full screen': 'exit full screen',
    'camera on': 'camera on', 'stop the camera': 'camera off', 'dashcam off': 'dashcam off', 'dash cam on': 'dashcam on',
  };
  for (const [said, want] of Object.entries(cases)) assert.equal(parseCommand(said), want, said);
  assert.equal(parseCommand('how far is the petrol bunk'), null, 'chatter is ignored');
  assert.equal(parseCommand(''), null);
});

test('voice: with the wake word on, only "RideLens …" phrases count', () => {
  assert.equal(parseCommand('report', { requireWake: true }), null);
  assert.equal(parseCommand('RideLens report', { requireWake: true }), 'view:report');
  assert.equal(parseCommand('ride lens, start ride', { requireWake: true }), 'start ride');
  assert.equal(parseCommand('RideLens start camera', { requireWake: true }), 'camera on');
  assert.equal(parseCommand('RideLens start camera'), 'camera on', 'wake word is fine when not required');
  assert.equal(parseCommand('Ride Lens open camera'), 'full screen');
});
