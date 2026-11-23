// Hourly, modelled ambient air quality from Open-Meteo.
const fields = ['us_aqi', 'pm2_5', 'pm10', 'nitrogen_dioxide', 'ozone'];
export const airCell = ({ lat, lon }) => `${lat.toFixed(2)},${lon.toFixed(2)}`;
export const airCategory = (aqi) => !Number.isFinite(aqi) ? 'Unavailable'
  : aqi <= 50 ? 'Good' : aqi <= 100 ? 'Moderate'
    : aqi <= 150 ? 'Unhealthy for sensitive groups' : aqi <= 200 ? 'Unhealthy'
      : aqi <= 300 ? 'Very unhealthy' : 'Hazardous';

export async function loadAirQuality(cell, signal) {
  const [latitude, longitude] = cell.split(',');
  const params = new URLSearchParams({ latitude, longitude, current: fields.join(','), timezone: 'GMT' });
  const response = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?${params}`, { signal });
  if (!response.ok) throw new Error('Air-quality service unavailable.');
  const { current } = await response.json();
  const time = Date.parse(`${current?.time}Z`);
  if (!Number.isFinite(time) || !fields.some((field) => Number.isFinite(current[field]))) {
    throw new Error('Air-quality data unavailable for this location.');
  }
  return { time, ...Object.fromEntries(fields.map((field) => [field, Number.isFinite(current[field]) ? current[field] : null])) };
}
