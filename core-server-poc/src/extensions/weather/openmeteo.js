// Current conditions, UV and a 3-day forecast from Open-Meteo
// (https://open-meteo.com): free for non-commercial use, no API key, data
// under CC BY 4.0 (credited on the panel's About page).

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export async function fetchForecast({ lat, lon }) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat);
  url.searchParams.set("longitude", lon);
  url.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,precipitation,weather_code,is_day,uv_index"
  );
  url.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,sunrise,sunset"
  );
  url.searchParams.set("forecast_days", "3");
  url.searchParams.set("timezone", "auto");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const d = await res.json();
  const c = d.current ?? {};
  const days = (d.daily?.time ?? []).map((iso, i) => ({
    label: i === 0 ? "Today" : DAY[new Date(`${iso}T12:00:00`).getDay()],
    code: d.daily.weather_code[i],
    max: d.daily.temperature_2m_max[i],
    min: d.daily.temperature_2m_min[i],
    rain: d.daily.precipitation_probability_max[i],
    uvMax: d.daily.uv_index_max[i],
    // Local times ("2026-11-18T05:42", in the location's timezone) -> "05:42".
    sunrise: String(d.daily.sunrise?.[i] ?? "").slice(11, 16),
    sunset: String(d.daily.sunset?.[i] ?? "").slice(11, 16),
  }));
  return {
    at: Date.now(),
    now: {
      temp: c.temperature_2m,
      feels: c.apparent_temperature,
      humidity: c.relative_humidity_2m,
      wind: c.wind_speed_10m,
      precip: c.precipitation,
      code: c.weather_code,
      isDay: c.is_day === 1,
      uv: c.uv_index,
    },
    days,
  };
}
