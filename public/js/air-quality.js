// CPCB National AQI concentration breakpoints. CO is mg/m³; the rest are µg/m³.
// Source: https://cpcb.nic.in/National-Air-Quality-Index/
const indexLimits = [0, 50, 100, 200, 300, 400];
const pollutants = {
  pm2_5: { label: 'PM₂.₅', hours: 24, limits: [0, 30, 60, 90, 120, 250] },
  pm10: { label: 'PM₁₀', hours: 24, limits: [0, 50, 100, 250, 350, 430] },
  nitrogen_dioxide: { label: 'NO₂', hours: 24, limits: [0, 40, 80, 180, 280, 400] },
  sulphur_dioxide: { label: 'SO₂', hours: 24, limits: [0, 40, 80, 380, 800, 1600] },
  ozone: { label: 'O₃', hours: 8, limits: [0, 50, 100, 168, 208, 748] },
  carbon_monoxide: { label: 'CO', hours: 8, limits: [0, 1, 2, 10, 17, 34], scale: 0.001 },
};

export const airCell = ({ lat, lon }) => `${lat.toFixed(2)},${lon.toFixed(2)}`;
export function airCategory(aqi) {
  if (!Number.isFinite(aqi)) return { label: 'Unavailable', tone: 'neutral' };
  if (aqi <= 50) return { label: 'Good', tone: 'good' };
  if (aqi <= 100) return { label: 'Satisfactory', tone: 'good' };
  if (aqi <= 200) return { label: 'Moderate', tone: 'caution' };
  if (aqi <= 300) return { label: 'Poor', tone: 'danger' };
  if (aqi <= 400) return { label: 'Very poor', tone: 'danger' };
  return { label: 'Severe', tone: 'danger' };
}

function subIndex(value, limits) {
  if (value === 0) return 0;
  const last = limits.length - 1;
  const upper = limits.findIndex((limit, i) => i > 0 && value <= limit);
  const i = upper === -1 ? last : upper;
  const interpolated = indexLimits[i - 1]
    + (value - limits[i - 1]) * (indexLimits[i] - indexLimits[i - 1]) / (limits[i] - limits[i - 1]);
  return Math.min(500, Math.max(indexLimits[i - 1] + 1, Math.round(interpolated), upper === -1 ? 401 : 0));
}

export function calculateIndianAqi(hourly, time) {
  const hour = time.slice(0, 13) + ':00';
  const end = hourly?.time?.indexOf(hour) ?? -1;
  const usable = Object.entries(pollutants).map(([key, { label, hours, limits, scale = 1 }]) => {
    if (end < 0) return null;
    const samples = hourly[key]?.slice(Math.max(0, end - hours + 1), end + 1)
      .filter((value) => Number.isFinite(value) && value >= 0) ?? [];
    if (samples.length < (hours === 24 ? 16 : 8)) return null;
    const mean = samples.reduce((sum, value) => sum + value, 0) * scale / samples.length;
    return { key, label, hours, value: Number(mean.toFixed(scale === 1 ? 1 : 2)), unit: scale === 1 ? 'µg/m³' : 'mg/m³', index: subIndex(mean, limits) };
  }).filter(Boolean);
  const enough = usable.length >= 3 && usable.some(({ key }) => key === 'pm2_5' || key === 'pm10');
  return { india_aqi: enough ? Math.max(...usable.map(({ index }) => index)) : null, pollutants: usable };
}

export async function loadAirQuality(cell, signal) {
  const [latitude, longitude] = cell.split(',');
  const fields = Object.keys(pollutants).join(',');
  const params = new URLSearchParams({
    latitude, longitude, current: fields, hourly: fields, timezone: 'GMT', past_days: '1', forecast_days: '1',
  });
  const response = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?${params}`, { signal });
  if (!response.ok) throw new Error('Air-quality service unavailable.');
  const { current, hourly } = await response.json();
  const time = Date.parse(`${current?.time}Z`);
  if (!Number.isFinite(time)) throw new Error('Air-quality data unavailable for this location.');
  return { time, ...calculateIndianAqi(hourly, current.time) };
}
