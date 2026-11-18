import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type ConfigMeta, type Device } from "../lib/api";
import { useLive } from "../lib/live";
import { ago, SentConfig, StateDot } from "../components/bits";

export function DevicesPage() {
  const devices = useQuery({ queryKey: ["devices"], queryFn: () => api<Device[]>("/devices"), refetchInterval: 15000 });
  const configs = useQuery({ queryKey: ["configs"], queryFn: () => api<ConfigMeta[]>("/configs") });
  const live = useLive();

  return (
    <section>
      <h1>Devices</h1>
      {devices.isLoading && <p className="muted">Loading…</p>}
      {devices.error && <p className="error">{String(devices.error)}</p>}
      {devices.data?.length === 0 && <p className="muted">No devices yet. Pair a panel and it appears here once it connects.</p>}
      <div className="cards">
        {devices.data?.map((d) => {
          const st = live.status[d.id] ?? d.status;
          return (
            <Link key={d.id} to={`/devices/${d.id}`} className="card device">
              <div className="row">
                <StateDot state={st?.state} />
                <strong>{d.name}</strong>
              </div>
              <div className="muted small">{d.id}</div>
              <dl>
                <dt>Status</dt>
                <dd>{st?.state ?? "unknown"}{st?.state === "offline" && d.lastSeen ? `, last seen ${ago(d.lastSeen)}` : ""}</dd>
                <dt>IP</dt>
                <dd>{st?.ip ?? "–"}</dd>
                <dt>Config</dt>
                <dd>
                  <SentConfig device={d} configs={configs.data} />
                </dd>
                <dt>Firmware</dt>
                <dd>{st?.fw ?? "–"}</dd>
              </dl>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
