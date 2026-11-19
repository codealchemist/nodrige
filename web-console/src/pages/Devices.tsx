import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type ConfigMeta, type Device } from "../lib/api";
import { useLive } from "../lib/live";
import { ago, SentConfig, StatePill } from "../components/bits";
import { Icon, PageHead } from "../components/icons";

export function DevicesPage() {
  const devices = useQuery({ queryKey: ["devices"], queryFn: () => api<Device[]>("/devices"), refetchInterval: 15000 });
  const configs = useQuery({ queryKey: ["configs"], queryFn: () => api<ConfigMeta[]>("/configs") });
  const live = useLive();
  const online = devices.data?.filter((d) => (live.status[d.id] ?? d.status)?.state === "online").length ?? 0;

  return (
    <section>
      <PageHead
        title="Devices"
        sub={devices.data ? `${devices.data.length} panel${devices.data.length === 1 ? "" : "s"} · ${online} online` : undefined}
      />
      {devices.isLoading && <p className="muted">Loading…</p>}
      {devices.error && <p className="error">{String(devices.error)}</p>}
      {devices.data?.length === 0 && (
        <div className="empty-state">
          <Icon name="devices" size={32} />
          <p>No devices yet.</p>
          <p className="muted small">Pair a panel and it shows up here once it connects to the Core.</p>
        </div>
      )}
      <div className="cards">
        {devices.data?.map((d) => {
          const st = live.status[d.id] ?? d.status;
          return (
            <Link key={d.id} to={`/devices/${d.id}`} className="card device-card">
              <div className="card-head">
                <div className="card-title">
                  <strong>{d.name}</strong>
                  {d.name !== d.id && <span className="mono muted small">{d.id}</span>}
                </div>
                <StatePill state={st?.state} />
              </div>
              <dl>
                <dt>Config</dt>
                <dd><SentConfig device={d} configs={configs.data} /></dd>
                <dt>IP</dt>
                <dd className="mono">{st?.ip ?? "–"}</dd>
                <dt>Firmware</dt>
                <dd>{st?.fw ?? "–"}</dd>
                {st?.state === "offline" && d.lastSeen && (
                  <>
                    <dt>Last seen</dt>
                    <dd>{ago(d.lastSeen)}</dd>
                  </>
                )}
              </dl>
              <span className="card-go"><Icon name="chevronRight" /></span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
