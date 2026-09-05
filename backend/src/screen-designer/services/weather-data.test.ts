import { afterEach, describe, expect, mock, test } from 'bun:test';
import { fetchWeatherData, weatherCondition, weatherIconSvg } from './weather-data';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('weather data boundary', () => {
  test('maps WMO conditions and renders every supported icon without invalid geometry', () => {
    expect(weatherCondition(0)).toEqual({ text: 'Clear', icon: 'sun' });
    expect(weatherCondition(95)).toEqual({ text: 'Thunderstorm', icon: 'thunder' });
    expect(weatherCondition(999)).toEqual({ text: 'Unknown', icon: 'cloud' });

    for (const icon of ['sun', 'cloud', 'cloud-sun', 'rain', 'drizzle', 'snow', 'thunder', 'fog']) {
      const svg = weatherIconSvg(icon, 48, '#123456');
      expect(svg).toContain('#123456');
      expect(svg).not.toContain('NaN');
      expect(svg).not.toContain('undefined');
    }
  });

  test('rejects invalid coordinates before network access', async () => {
    const request = mock(async () => new Response('{}'));
    globalThis.fetch = request as unknown as typeof fetch;

    expect(await fetchWeatherData(91, 10, 0, 'current')).toBeNull();
    expect(await fetchWeatherData(10, 181, 0, 'current')).toBeNull();
    expect(await fetchWeatherData(10, 10, 15, 'current')).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  test('projects only the typed Open-Meteo fields used by rendering', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({
      current: {
        temperature_2m: 12.6,
        weather_code: 2,
        relative_humidity_2m: 78,
        wind_speed_10m: 9.7,
      },
      daily: {
        temperature_2m_max: [15, 18.4],
        weather_code: [1, 61],
        time: ['2026-09-05', '2026-09-06'],
      },
    }), { status: 200 })) as unknown as typeof fetch;

    expect(await fetchWeatherData(52.5, 13.4, 1, 'day')).toEqual({
      temperature: 18,
      weatherCode: 61,
      humidity: 78,
      windSpeed: 10,
      dayName: 'Sunday',
    });
  });

  test('fails closed for malformed provider values', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({
      current: { temperature_2m: '12', weather_code: 1 },
      daily: { temperature_2m_max: {}, weather_code: [1] },
    }), { status: 200 })) as unknown as typeof fetch;

    expect(await fetchWeatherData(52.5, 13.4, 0, 'current')).toBeNull();
  });
});
