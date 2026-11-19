// Device health: live telemetry (CPU, memory, uptime, Wi-Fi, battery, chip
// temperature). While this is on screen the device is asked for a reading
// every 2 s; otherwise it sends one every 30 s.
import { useEffect, useRef, useState } from "react";
import { api, type Telemetry } from "../lib/api";

const kb = (b: number) => `${Math.round(b / 1024)} KB`;

export function uptime(s: number) {
  const d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60;
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(s % 60)}s`;
}

function signal(rssi: number) {
  if (rssi >= -55) return "excellent";
  if (rssi >= -67) return "good";
  if (rssi >= -75) return "fair";
  return "weak";
}

function batteryPct(mv: number) {
  return Math.max(0, Math.min(100, Math.round(((mv - 3300) * 100) / (4150 - 3300))));
}

export function Health({ deviceId, telemetry: t, online }: { deviceId: string; telemetry?: Telemetry; online: boolean }) {
  // Fast updates while this card is open; renewed before the device's lease ends.
  useEffect(() => {
    if (!online) return;
    const ask = () => api(`/devices/${deviceId}/diag`, { method: "POST", body: JSON.stringify({ action: "telemetry", seconds: 120 }) }).catch(() => {});
    ask();
    const id = setInterval(ask, 100_000);
    return () => clearInterval(id);
  }, [deviceId, online]);

  // CPU history for the sparkline: one point per reading, last 2 minutes.
  const [cpu, setCpu] = useState<{ at: number; v: number }[]>([]);
  const lastAt = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!t || t.at === lastAt.current || t.cpu === undefined) return;
    lastAt.current = t.at;
    setCpu((h) => [...h, { at: Date.parse(t.at), v: t.cpu! }].slice(-60));
  }, [t?.at]);

  // Uptime ticks between readings.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (!t) {
    return (
      <div className="card health">
        <h2>Health</h2>
        <p className="muted small">{online ? "Waiting for the first reading…" : "No readings: the device is offline."}</p>
      </div>
    );
  }
  const age = (Date.now() - Date.parse(t.at)) / 1000;
  const stale = !online || age > 90;
  const up = t.up + (stale ? 0 : age);
  const used = t.heap.size - t.heap.free;

  return (
    <div className={`card wide health ${stale ? "stale" : ""}`}>
      <div className="card-head">
        <h2>Health</h2>
        <span className="muted small">{stale ? `last reading ${Math.round(age)} s ago` : "live"}</span>
      </div>
      <div className="stats">
        <div className="stat cpu-stat">
          <span className="stat-label">CPU</span>
          <span className="stat-value">{t.cpu !== undefined ? `${t.cpu.toFixed(0)}%` : "–"}</span>
          <span className="stat-sub">{t.mhz ? `${t.mhz} MHz · ` : ""}{t.tasks ?? "?"} tasks</span>
          <Sparkline points={cpu} />
        </div>
        <div className="stat">
          <span className="stat-label">Memory</span>
          <span className="stat-value">{kb(t.heap.free)} <small>free</small></span>
          <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={t.heap.size} aria-valuenow={used} aria-label="Heap used">
            <span style={{ width: `${(used / t.heap.size) * 100}%` }} />
            <i style={{ left: `${((t.heap.size - t.heap.min) / t.heap.size) * 100}%` }} title={`Peak use: ${kb(t.heap.size - t.heap.min)}`} />
          </div>
          <span className="stat-sub">{kb(used)} of {kb(t.heap.size)} used · low {kb(t.heap.min)} · largest block {kb(t.heap.largest)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Uptime</span>
          <span className="stat-value">{uptime(up)}</span>
          <span className="stat-sub">screen: {t.screen ?? "?"}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Wi-Fi</span>
          <span className="stat-value">{t.rssi !== undefined ? <>{t.rssi} <small>dBm</small></> : "–"}</span>
          <span className="stat-sub">{t.rssi !== undefined ? signal(t.rssi) : "not connected"}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Battery</span>
          <span className="stat-value">{t.batt ? <>{(t.batt / 1000).toFixed(2)} <small>V</small></> : "–"}</span>
          <span className="stat-sub">{t.batt ? (t.batt >= 4150 ? "full, or no battery" : `about ${batteryPct(t.batt)}%`) : "no battery"}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Chip temp</span>
          <span className="stat-value">{t.temp !== undefined ? <>{t.temp.toFixed(0)} <small>°C</small></> : "–"}</span>
          <span className="stat-sub">internal sensor, ±5 °C</span>
        </div>
      </div>
    </div>
  );
}

// CPU over the last readings: one 2px line on a fixed 0–100% scale, with a
// hover crosshair and tooltip.
function Sparkline({ points }: { points: { at: number; v: number }[] }) {
  const W = 220, H = 44;
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) return <div className="spark-empty small muted">collecting…</div>;
  const t0 = points[0].at, t1 = points[points.length - 1].at;
  const x = (at: number) => (t1 === t0 ? W : ((at - t0) / (t1 - t0)) * W);
  const y = (v: number) => H - 2 - (v / 100) * (H - 4);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(p.at).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const h = hover !== null ? points[hover] : null;
  return (
    <div className="spark">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        aria-label={`CPU, last ${points.length} readings`}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const at = t0 + ((e.clientX - r.left) / r.width) * (t1 - t0);
          let best = 0;
          points.forEach((p, i) => Math.abs(p.at - at) < Math.abs(points[best].at - at) && (best = i));
          setHover(best);
        }}
        onPointerLeave={() => setHover(null)}
      >
        <line x1="0" x2={W} y1={y(50)} y2={y(50)} className="spark-grid" />
        <path d={d} className="spark-line" vectorEffect="non-scaling-stroke" />
        {h && <line x1={x(h.at)} x2={x(h.at)} y1="0" y2={H} className="spark-cross" vectorEffect="non-scaling-stroke" />}
      </svg>
      {h && (
        <span className="spark-tip" style={{ left: `${(x(h.at) / W) * 100}%` }}>
          {h.v.toFixed(0)}% · {Math.round((t1 - h.at) / 1000)} s ago
        </span>
      )}
    </div>
  );
}
