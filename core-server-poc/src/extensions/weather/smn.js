// Official weather alerts from Argentina's Servicio Meteorológico Nacional,
// via its public CAP (Common Alerting Protocol) feed: an RSS list of alert
// documents, each with an event, severity, expiry, instructions and the
// polygon of the area it covers. No API key.
//
// Only alerts whose polygon contains our location, that haven't expired and
// aren't cancellations are kept. Alert documents are fetched once each
// (cached by URL); feed entries older than 2 days (the timestamp is in the
// file name) are not fetched at all.

const FEED = "https://ssl.smn.gob.ar/CAP/AR.php";
const MAX_AGE_MS = 48 * 3600_000;

const capCache = new Map(); // url -> parsed alert (or null if unusable)

// SMN publishes two CAP flavours: short-term "avisos" with a `cap:` prefix,
// and zone "alertas" in the default namespace with XML character references.
const decode = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const tag = (x, name) => {
  const m = x.match(new RegExp(`<(?:cap:)?${name}>([\\s\\S]*?)</(?:cap:)?${name}>`));
  return m ? decode(m[1].trim()) : "";
};

function parseCap(xml, url) {
  const polygons = [...xml.matchAll(/<(?:cap:)?polygon>([\s\S]*?)<\/(?:cap:)?polygon>/g)].map((m) =>
    m[1]
      .trim()
      .split(/\s+/)
      .map((pair) => pair.split(",").map(Number))
      .filter((p) => p.length === 2 && p.every(Number.isFinite))
  );
  const headline = tag(xml, "headline");
  const severity = tag(xml, "severity");
  // SMN headlines say the colour ("AVISO NARANJA ..."); severity is the fallback.
  const level = /ROJ[OA]/i.test(headline) ? 3
    : /NARANJA/i.test(headline) ? 2
    : /AMARILL[OA]/i.test(headline) ? 1
    : severity === "Extreme" ? 3 : severity === "Severe" ? 2 : 1;
  const identifier = tag(xml, "identifier");
  return {
    identifier,
    // Superseded alerts (an Update/Cancel lists them in <references>).
    replaces: [...tag(xml, "references").matchAll(/urn:oid:[0-9.]+/g)].map((m) => m[0]),
    id: identifier.replace(/^urn:oid:2\.49\.0\.1\.32\.0\./, "").replace(/\./g, "").slice(-12),
    url,
    msgType: tag(xml, "msgType"),
    event: tag(xml, "event"),
    headline,
    description: tag(xml, "description"),
    instruction: tag(xml, "instruction"),
    level,
    onset: Date.parse(tag(xml, "onset")) || 0,
    expires: Date.parse(tag(xml, "expires")) || 0,
    areaDesc: tag(xml, "areaDesc"),
    polygons,
  };
}

// Ray casting; CAP polygon points are "lat,lon".
function inside(lat, lon, poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

// Publication time from the file name: ".../2026_11_18_1938_cap_es.xml" or
// ".../CAP_20261118202706_...xml" (Argentina time).
function feedTime(url) {
  let m = url.match(/(\d{4})_(\d{2})_(\d{2})_(\d{2})(\d{2})_cap/);
  if (!m) m = url.match(/CAP_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})\d{2}_/);
  return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00-03:00`) : 0;
}

// Active alerts for (lat, lon), most severe first.
export async function fetchAlerts({ lat, lon }, logger = console) {
  const res = await fetch(FEED);
  if (!res.ok) throw new Error(`SMN feed HTTP ${res.status}`);
  const rss = await res.text();
  const urls = [...new Set([...rss.matchAll(/<link>(https:[^<]+\/feeds\/CAP\/[^<]+\.xml)<\/link>/g)].map((m) => m[1]))];
  const now = Date.now();
  for (const url of urls) {
    if (capCache.has(url) || now - feedTime(url) > MAX_AGE_MS) continue;
    try {
      const r = await fetch(url);
      capCache.set(url, r.ok ? parseCap(await r.text(), url) : null);
    } catch (err) {
      logger.log(`[weather] SMN alert ${url} failed: ${err.message}`);
    }
  }
  for (const url of capCache.keys()) if (!urls.includes(url)) capCache.delete(url);  // left the feed

  const all = [...capCache.values()].filter(Boolean);
  const superseded = new Set(all.flatMap((a) => a.replaces));
  return all
    .filter((a) => !superseded.has(a.identifier) && a.msgType !== "Cancel" && a.expires > now)
    .filter((a) => a.polygons.some((p) => inside(lat, lon, p)))
    .sort((a, b) => b.level - a.level || a.expires - b.expires);
}
