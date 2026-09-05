export interface WeatherData {
  temperature: number;
  weatherCode: number;
  humidity: number;
  windSpeed: number;
  dayName: string;
}

export interface WeatherCondition {
  text: string;
  icon: string;
}

interface OpenMeteoCurrent {
  temperature_2m?: unknown;
  weather_code?: unknown;
  relative_humidity_2m?: unknown;
  wind_speed_10m?: unknown;
}

interface OpenMeteoDaily {
  temperature_2m_max?: unknown;
  weather_code?: unknown;
  time?: unknown;
}

const CONDITIONS: Readonly<Record<number, WeatherCondition>> = {
  0: { text: 'Clear', icon: 'sun' },
  1: { text: 'Mostly Clear', icon: 'sun' },
  2: { text: 'Partly Cloudy', icon: 'cloud-sun' },
  3: { text: 'Cloudy', icon: 'cloud' },
  45: { text: 'Foggy', icon: 'fog' },
  48: { text: 'Icy Fog', icon: 'fog' },
  51: { text: 'Light Drizzle', icon: 'drizzle' },
  53: { text: 'Drizzle', icon: 'drizzle' },
  55: { text: 'Heavy Drizzle', icon: 'drizzle' },
  56: { text: 'Freezing Drizzle', icon: 'drizzle' },
  57: { text: 'Heavy Freezing Drizzle', icon: 'drizzle' },
  61: { text: 'Light Rain', icon: 'rain' },
  63: { text: 'Rain', icon: 'rain' },
  65: { text: 'Heavy Rain', icon: 'rain' },
  66: { text: 'Freezing Rain', icon: 'rain' },
  67: { text: 'Heavy Freezing Rain', icon: 'rain' },
  71: { text: 'Light Snow', icon: 'snow' },
  73: { text: 'Snow', icon: 'snow' },
  75: { text: 'Heavy Snow', icon: 'snow' },
  77: { text: 'Snow Grains', icon: 'snow' },
  80: { text: 'Light Showers', icon: 'rain' },
  81: { text: 'Showers', icon: 'rain' },
  82: { text: 'Heavy Showers', icon: 'rain' },
  85: { text: 'Snow Showers', icon: 'snow' },
  86: { text: 'Heavy Snow Showers', icon: 'snow' },
  95: { text: 'Thunderstorm', icon: 'thunder' },
  96: { text: 'Thunderstorm + Hail', icon: 'thunder' },
  99: { text: 'Heavy Thunderstorm', icon: 'thunder' },
};

export function weatherCondition(code: number): WeatherCondition {
  return CONDITIONS[code] ?? { text: 'Unknown', icon: 'cloud' };
}

export function weatherIconSvg(icon: string, size: number, color: string): string {
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.3;
  const rays = (
    angles: readonly number[], offsetX = 0, offsetY = 0, scale = 1,
    innerGap = 4, outerGap = 10, strokeWidth = 2,
  ) =>
    angles.map((angle) => {
      const rad = (angle * Math.PI) / 180;
      const x1 = cx + offsetX + Math.cos(rad) * (r * scale + innerGap);
      const y1 = cy + offsetY + Math.sin(rad) * (r * scale + innerGap);
      const x2 = cx + offsetX + Math.cos(rad) * (r * scale + outerGap);
      const y2 = cy + offsetY + Math.sin(rad) * (r * scale + outerGap);
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${strokeWidth}"/>`;
    }).join('');

  const cloud = () => `
    <ellipse cx="${cx - 5}" cy="${cy + 5}" rx="${r * 0.8}" ry="${r * 0.6}" fill="${color}"/>
    <ellipse cx="${cx + 8}" cy="${cy + 5}" rx="${r * 0.7}" ry="${r * 0.5}" fill="${color}"/>
    <ellipse cx="${cx}" cy="${cy - 2}" rx="${r}" ry="${r * 0.7}" fill="${color}"/>`;
  const layeredCloud = (offsetY: number) => `
    <ellipse cx="${cx - 5}" cy="${cy + offsetY + 5}" rx="${r * 0.7}" ry="${r * 0.5}" fill="${color}"/>
    <ellipse cx="${cx + 6}" cy="${cy + offsetY + 5}" rx="${r * 0.6}" ry="${r * 0.45}" fill="${color}"/>
    <ellipse cx="${cx}" cy="${cy + offsetY}" rx="${r * 0.85}" ry="${r * 0.6}" fill="${color}"/>`;

  switch (icon) {
    case 'sun':
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>${rays([0, 45, 90, 135, 180, 225, 270, 315])}`;
    case 'cloud': return cloud();
    case 'cloud-sun':
      return `<circle cx="${cx + 10}" cy="${cy - 8}" r="${r * 0.5}" fill="${color}"/>${rays([0, 60, 120, 180, 240, 300], 10, -8, 0.5, 3, 7, 1.5)}${layeredCloud(2)}`;
    case 'rain':
      return `${layeredCloud(-10)}<line x1="${cx - 8}" y1="${cy + 5}" x2="${cx - 12}" y2="${cy + 15}" stroke="${color}" stroke-width="2"/><line x1="${cx}" y1="${cy + 5}" x2="${cx - 4}" y2="${cy + 15}" stroke="${color}" stroke-width="2"/><line x1="${cx + 8}" y1="${cy + 5}" x2="${cx + 4}" y2="${cy + 15}" stroke="${color}" stroke-width="2"/>`;
    case 'drizzle':
      return `${layeredCloud(-10)}<circle cx="${cx - 6}" cy="${cy + 8}" r="2" fill="${color}"/><circle cx="${cx + 2}" cy="${cy + 12}" r="2" fill="${color}"/><circle cx="${cx + 8}" cy="${cy + 6}" r="2" fill="${color}"/>`;
    case 'snow':
      return `${layeredCloud(-10)}<text x="${cx - 8}" y="${cy + 12}" font-size="12" font-family="sans-serif" fill="${color}">*</text><text x="${cx}" y="${cy + 16}" font-size="12" font-family="sans-serif" fill="${color}">*</text><text x="${cx + 8}" y="${cy + 10}" font-size="12" font-family="sans-serif" fill="${color}">*</text>`;
    case 'thunder':
      return `${layeredCloud(-13)}<path d="M ${cx - 2} ${cy} L ${cx + 5} ${cy} L ${cx} ${cy + 8} L ${cx + 8} ${cy + 8} L ${cx - 3} ${cy + 20} L ${cx} ${cy + 10} L ${cx - 6} ${cy + 10} Z" fill="${color}"/>`;
    case 'fog':
      return `<line x1="${cx - 15}" y1="${cy - 8}" x2="${cx + 15}" y2="${cy - 8}" stroke="${color}" stroke-width="3" stroke-linecap="round"/><line x1="${cx - 12}" y1="${cy}" x2="${cx + 12}" y2="${cy}" stroke="${color}" stroke-width="3" stroke-linecap="round"/><line x1="${cx - 15}" y1="${cy + 8}" x2="${cx + 15}" y2="${cy + 8}" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`;
    default:
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="2"/>`;
  }
}

function numericAt(value: unknown, index: number): number | null {
  if (!Array.isArray(value)) return null;
  const item = value[index];
  return typeof item === 'number' && Number.isFinite(item) ? item : null;
}

function stringAt(value: unknown, index: number): string | null {
  if (!Array.isArray(value)) return null;
  const item = value[index];
  return typeof item === 'string' ? item : null;
}

export async function fetchWeatherData(
  latitude: number,
  longitude: number,
  forecastDay: number,
  forecastTime: string,
): Promise<WeatherData | null> {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
    !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
    !Number.isSafeInteger(forecastDay) || forecastDay < 0 || forecastDay > 14) return null;

  const params = new URLSearchParams({
    latitude: String(latitude), longitude: String(longitude), timezone: 'auto',
    current: 'temperature_2m,weather_code,relative_humidity_2m,wind_speed_10m',
    daily: 'temperature_2m_max,weather_code', forecast_days: String(Math.max(1, forecastDay + 1)),
  });
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
    signal: AbortSignal.timeout(8_000), headers: { Accept: 'application/json', 'User-Agent': 'Inker/1.0' },
  });
  if (!response.ok) return null;
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const { current, daily } = data as { current?: OpenMeteoCurrent; daily?: OpenMeteoDaily };
  const useForecast = forecastDay > 0 || forecastTime !== 'current';
  const currentTemperature = typeof current?.temperature_2m === 'number' ? current.temperature_2m : null;
  const currentCode = typeof current?.weather_code === 'number' ? current.weather_code : null;
  const temperature = useForecast ? numericAt(daily?.temperature_2m_max, forecastDay) : currentTemperature;
  const weatherCode = useForecast ? numericAt(daily?.weather_code, forecastDay) : currentCode;
  if (temperature === null || weatherCode === null) return null;
  const dateValue = stringAt(daily?.time, forecastDay);
  const date = dateValue ? new Date(`${dateValue}T12:00:00Z`) : new Date();
  const humidity = typeof current?.relative_humidity_2m === 'number' && Number.isFinite(current.relative_humidity_2m)
    ? current.relative_humidity_2m : 0;
  const windSpeed = typeof current?.wind_speed_10m === 'number' && Number.isFinite(current.wind_speed_10m)
    ? current.wind_speed_10m : 0;
  return {
    temperature: Math.round(temperature), weatherCode,
    humidity, windSpeed: Math.round(windSpeed),
    dayName: new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(date),
  };
}
