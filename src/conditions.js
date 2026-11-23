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
