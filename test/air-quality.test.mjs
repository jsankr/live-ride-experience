import { test } from 'node:test';
import assert from 'node:assert/strict';
import { airCategory, calculateIndianAqi } from '../public/js/air-quality.js';
import { meterStatus, roadStatuses } from '../src/conditions.js';

const time = Array.from({ length: 24 }, (_, hour) => `2026-11-23T${String(hour).padStart(2, '0')}:00`);
const samples = (n) => Array(24).fill(n);

test('India AQI uses trailing pollutant means and the maximum valid sub-index', () => {
  const hourly = { time, pm2_5: samples(100), pm10: samples(75), carbon_monoxide: samples(1000) };
  const result = calculateIndianAqi(hourly, '2026-11-23T23:15');
  assert.equal(result.india_aqi, 233);
  assert.equal(result.pollutants.find(({ key }) => key === 'carbon_monoxide').index, 50);
  assert.equal(airCategory(result.india_aqi).tone, 'danger');
  assert.equal(calculateIndianAqi(hourly, time[6]).india_aqi, null);
  assert.equal(calculateIndianAqi({ ...hourly, pm10: undefined }, time.at(-1)).india_aqi, null);
});

test('status bands distinguish absent readings, clear conditions and elevated readings', () => {
  assert.equal(meterStatus(null), null);
  assert.equal(meterStatus(84.9).tone, 'good');
  assert.equal(meterStatus(90).tone, 'caution');
  assert.equal(meterStatus(90.1).tone, 'danger');
  assert.equal(roadStatuses({ visibility: 800 }).visibility.tone, 'danger');
  assert.equal(roadStatuses({ wind_gusts_10m: 40 }).wind.tone, 'caution');
  assert.equal(roadStatuses({ weather_code: 0 }).weather.tone, 'good');
});
