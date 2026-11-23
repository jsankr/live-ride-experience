const weatherUrl = 'https://api.open-meteo.com/v1/forecast';
const currentFields = ['temperature_2m', 'weather_code', 'precipitation', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m'];
const compass = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export function weatherLabel(code) {
  if (!Number.isFinite(code)) return 'Unknown conditions';
  if (code === 0) return 'Clear sky';
  if (code < 3) return 'Partly cloudy';
  if (code === 3) return 'Overcast';
  if (code <= 48) return 'Fog';
  if (code <= 57) return 'Drizzle';
  if (code <= 67) return 'Rain';
  if (code <= 77) return 'Snow';
  if (code <= 82) return 'Rain showers';
  if (code <= 86) return 'Snow showers';
  return 'Thunderstorms';
}

export function windDirection(degrees) {
  return Number.isFinite(degrees) ? compass[(Math.round(degrees / 45) + 8) % 8] : '—';
}

export function locationCell({ lat, lon }) {
  return [lat.toFixed(2), lon.toFixed(2)].join(',');
}

export async function loadWeather(cell, signal) {
  const [latitude, longitude] = cell.split(',');
  const params = new URLSearchParams({
    latitude, longitude, current: currentFields.join(','),
    hourly: 'visibility,precipitation_probability', forecast_days: '2', timezone: 'GMT',
  });
  const response = await fetch(`${weatherUrl}?${params}`, { signal });
  if (!response.ok) throw new Error('Forecast request failed');
  const { current, hourly } = await response.json();
  if (!current?.time) throw new Error('Forecast has no current conditions');
  const slot = hourly?.time?.indexOf(`${current.time.slice(0, 13)}:00`) ?? -1;
  return {
    ...current,
    visibility: hourly?.visibility?.[slot] ?? null,
    probability: hourly?.precipitation_probability?.[slot] ?? null,
  };
}

export function relativeLevel(samples) {
  const meanSquare = samples.reduce((sum, sample) => sum + sample ** 2, 0) / samples.length;
  return Math.max(-90, Math.min(0, 10 * Math.log10(meanSquare || 1e-9)));
}

function highRisk(value, caution, danger, labels) {
  if (!Number.isFinite(value)) return null;
  const band = value >= danger ? 2 : value >= caution ? 1 : 0;
  return { tone: ['good', 'caution', 'danger'][band], label: labels[band] };
}

export function roadStatuses(data) {
  const { weather_code: code, visibility, precipitation, probability, wind_speed_10m: wind, wind_gusts_10m: gust } = data ?? {};
  const storm = code >= 95 || [56, 57, 66, 67].includes(code);
  const rain = storm || precipitation >= 2.5
    ? { tone: 'danger', label: storm ? 'Storm / freezing rain' : 'Heavy precipitation' }
    : highRisk(Math.max(probability ?? -Infinity, precipitation > 0 ? 30 : -Infinity), 30, Infinity, ['Low chance', 'Rain caution']);
  return {
    weather: Number.isFinite(code) ? { tone: storm ? 'danger' : code >= 45 ? 'caution' : 'good' } : null,
    visibility: highRisk(Number.isFinite(visibility) ? -visibility : null, -5000, -1000, ['Clear visibility', 'Reduced visibility', 'Very low visibility']),
    rain,
    wind: highRisk(Math.max(wind ?? -Infinity, gust ?? -Infinity), 35, 60, ['Light / moderate', 'Strong wind', 'High wind']),
  };
}

export function meterStatus(value) {
  if (!Number.isFinite(value)) return null;
  if (value > 90) return { tone: 'danger', label: 'Above 90 dBA' };
  if (value >= 85) return { tone: 'caution', label: 'Elevated' };
  return { tone: 'good', label: 'Below 85 dBA' };
}
