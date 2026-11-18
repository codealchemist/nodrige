// Where "home" is, for the weather extension.
//
//   1. WEATHER_ADDRESS in .env, if set: looked up once with OpenStreetMap's
//      Nominatim geocoder and cached in data/weather-location.json (so the
//      address is sent at most once per change, and Nominatim's 1 request/s
//      policy is never an issue).
//   2. Otherwise the home location from the linked Tuya / Smart Life account.
//
// Coordinates are rounded to 2 decimals (~1 km) before any weather service
// sees them: plenty for forecasts and alert areas, and not an exact address.
import fs from "node:fs";
import path from "node:path";
import { tuyaHomeLocation } from "../menu-tasks/tuya.js";

const CACHE = path.resolve("data/weather-location.json");
const round2 = (x) => Math.round(Number(x) * 100) / 100;

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE, "utf8"));
  } catch {
    return null;
  }
}

async function geocode(address, logger) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", address);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  // Nominatim asks for an identifying User-Agent; a generic client name.
  const res = await fetch(url, { headers: { "User-Agent": "nodrige-core/0.1 (weather)" } });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const hits = await res.json();
  if (!hits.length) throw new Error("address not found");
  const h = hits[0];
  logger.log(`[weather] address resolved to ${round2(h.lat)}, ${round2(h.lon)}`);
  return { lat: Number(h.lat), lon: Number(h.lon), name: String(h.name || h.display_name || "Home").split(",")[0] };
}

// { lat, lon, name, source } with lat/lon rounded; throws if nothing works.
export async function resolveLocation(logger = console) {
  const address = (process.env.WEATHER_ADDRESS || "").trim();
  if (address) {
    const cached = readCache();
    let loc = cached?.address === address ? cached : null;
    if (!loc) {
      loc = { address, ...(await geocode(address, logger)) };
      fs.mkdirSync(path.dirname(CACHE), { recursive: true });
      fs.writeFileSync(CACHE, JSON.stringify(loc, null, 2));
    }
    return { lat: round2(loc.lat), lon: round2(loc.lon), name: loc.name, source: "WEATHER_ADDRESS" };
  }
  const home = await tuyaHomeLocation();
  if (home) return { lat: round2(home.lat), lon: round2(home.lon), name: home.name, source: "Tuya home" };
  throw new Error("no location: set WEATHER_ADDRESS in .env or link a Tuya account with a home location");
}
