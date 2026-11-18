// Weather Extension — the panel's Weather page and weather alerts.
//
// Location: the Tuya home's, or WEATHER_ADDRESS from .env (./location.js).
// Data: Open-Meteo for current conditions, UV and a 3-day forecast (every
// 15 min); SMN Argentina's CAP feed for official alerts covering that
// location (every 5 min).
//
// Panel side (tasks on `messages`, replies/pushes on `cmd`):
//   task "weather"        -> task_result with a compact snapshot (below)
//   task "weather-alert"  -> task_result with one alert's headline and
//                            instructions (payload.id)
//   push "weather_alert"  -> the active alert list, whenever it changes;
//                            `new` lists ids the panel hasn't been told of
//
// Text sent to the panel is ASCII only: its fonts have no accented letters.
import { resolveLocation } from "./location.js";
import { fetchForecast } from "./openmeteo.js";
import { fetchAlerts } from "./smn.js";

const FORECAST_MS = 15 * 60_000;
const ALERTS_MS = 5 * 60_000;

let location = null;
let forecast = null;
let alerts = [];
const panels = new Set();
let timers = [];

const ascii = (s, max = 200) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

// Brief alert list for the panel; minutes left instead of clock times (the
// panel has no wall clock).
const brief = () =>
  alerts.slice(0, 3).map((a) => ({
    id: a.id,
    lv: a.level,
    ev: ascii(a.event, 40),
    st: a.onset ? Math.max(0, Math.round((a.onset - Date.now()) / 60_000)) : 0,  // minutes until it starts
    min: Math.max(0, Math.round((a.expires - Date.now()) / 60_000)),             // minutes until it ends
  }));

function snapshot() {
  if (!forecast) return { status: "error", message: location ? "No weather data yet" : "No location set" };
  const n = forecast.now;
  return {
    status: "ok",
    message: `${Math.round(n.temp)} C`,
    loc: ascii(location?.name ?? "", 20),
    age: Math.round((Date.now() - forecast.at) / 60_000),
    // Whole degrees: the panel shows them large, and tenths aren't meaningful.
    now: { t: Math.round(n.temp), f: Math.round(n.feels), h: n.humidity, w: Math.round(n.wind), p: r1(n.precip), c: n.code, d: n.isDay ? 1 : 0 },
    today: { x: Math.round(forecast.days[0]?.max), n: Math.round(forecast.days[0]?.min), r: forecast.days[0]?.rain ?? 0 },
    sun: { r: forecast.days[0]?.sunrise ?? "", s: forecast.days[0]?.sunset ?? "" },
    uv: { n: r1(n.uv), m: r1(forecast.days[0]?.uvMax) },
    days: forecast.days.map((d) => [d.label, d.code, Math.round(d.max), Math.round(d.min), d.rain]),
    alerts: brief(),
  };
}

async function refreshForecast(ctx) {
  try {
    forecast = await fetchForecast(location);
  } catch (err) {
    ctx.logger.log(`[weather] forecast failed: ${err.message}`);
  }
}

async function refreshAlerts(ctx, { push = true } = {}) {
  try {
    const before = new Set(alerts.map((a) => a.id));
    alerts = await fetchAlerts(location, ctx.logger);
    const fresh = alerts.filter((a) => !before.has(a.id)).map((a) => a.id);
    const changed = fresh.length > 0 || alerts.length !== before.size;
    if (changed) {
      ctx.logger.log(`[weather] alerts for ${location.name}: ${alerts.map((a) => `${a.event} (L${a.level})`).join(", ") || "none"}`);
      if (push) {
        for (const clientId of panels) {
          await ctx.commands.dispatch({
            clientId,
            componentId: "weather",
            action: "weather_alert",
            value: String(alerts.length),
            alerts: brief(),
            new: fresh,
          });
        }
      }
    }
  } catch (err) {
    ctx.logger.log(`[weather] alerts failed: ${err.message}`);
  }
}

export default {
  manifest: {
    id: "weather",
    version: "0.1.0",
    displayName: "Weather",
    permissions: { stateRead: true, commandDispatch: true },
    entryPoint: "src/extensions/weather/index.js",
  },

  async onEnable(ctx) {
    try {
      location = await resolveLocation(ctx.logger);
      ctx.logger.log(`[weather] location from ${location.source}: ${location.name} (${location.lat}, ${location.lon})`);
    } catch (err) {
      ctx.logger.log(`[weather] disabled: ${err.message}`);
      return;
    }
    await refreshForecast(ctx);
    await refreshAlerts(ctx, { push: false });
    timers = [
      setInterval(() => refreshForecast(ctx), FORECAST_MS),
      setInterval(() => refreshAlerts(ctx), ALERTS_MS),
    ];
    timers.forEach((t) => t.unref?.());
  },

  async onDisable() {
    timers.forEach(clearInterval);
    timers = [];
  },

  async onStateChanged(event, ctx) {
    if (event.eventType !== "task") return;
    const { taskId, payload = {} } = event.metadata ?? {};
    if (taskId !== "weather" && taskId !== "weather-alert") return;
    panels.add(event.clientId);

    let result;
    if (taskId === "weather") {
      // Stale (e.g. the Core was asleep)? Refresh before answering.
      if (location && (!forecast || Date.now() - forecast.at > FORECAST_MS)) await refreshForecast(ctx);
      result = snapshot();
    } else {
      const a = alerts.find((x) => x.id === payload.id);
      result = a
        ? { status: "ok", message: ascii(a.event, 40), lv: a.level, head: ascii(a.headline, 160), text: ascii(a.instruction || a.description, 420), area: ascii(a.areaDesc, 120) }
        : { status: "error", message: "Alert no longer active" };
    }
    await ctx.commands.dispatch({
      clientId: event.clientId,
      componentId: event.componentId,
      action: "task_result",
      value: result.status,
      correlationId: event.value,
      result,
    });
  },
};
