import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type ConfigMeta, type Device } from "../lib/api";
import { useLive } from "../lib/live";
import { ago, ResultBadge, SentConfig, StatePill } from "../components/bits";
import { Icon } from "../components/icons";

export function DevicePage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const devices = useQuery({ queryKey: ["devices"], queryFn: () => api<Device[]>("/devices"), refetchInterval: 15000 });
  const configs = useQuery({ queryKey: ["configs"], queryFn: () => api<ConfigMeta[]>("/configs") });
  const live = useLive();
  const d = devices.data?.find((x) => x.id === id);
  const st = live.status[id] ?? d?.status;
  const [pick, setPick] = useState("");
  const [name, setName] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: (libraryId: string) =>
      api<{ configVersion: number; libraryVersion: number }>(`/configs/${libraryId}/send`, { method: "POST", body: JSON.stringify({ deviceId: id }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["devices"] }),
  });
  const rename = useMutation({
    mutationFn: (n: string) => api<Device>(`/devices/${id}`, { method: "PATCH", body: JSON.stringify({ name: n }) }),
    onSuccess: () => {
      setName(null);
      qc.invalidateQueries({ queryKey: ["devices"] });
    },
  });

  if (devices.isLoading) return <p className="muted">Loading…</p>;
  if (!d) return <p className="error">Unknown device {id}</p>;
  const results = live.results[id] ?? [];
  const sendErrors = send.error instanceof ApiError ? ((send.error.body as { errors?: string[] })?.errors ?? []) : [];

  return (
    <section>
      <Link to="/devices" className="back-link"><Icon name="chevronLeft" size={16} /> Devices</Link>
      <header className="page-head">
        <div className="page-title">
          {name === null ? (
            <h1>
              {d.name}
              <button className="icon-only subtle" onClick={() => setName(d.name)} title="Rename" aria-label="Rename"><Icon name="edit" size={16} /></button>
            </h1>
          ) : (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                rename.mutate(name);
              }}
            >
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="Device name" />
              <button type="submit">Save</button>
              <button type="button" className="secondary" onClick={() => setName(null)}>Cancel</button>
            </form>
          )}
          {d.name !== d.id && <p className="sub mono">{d.id}</p>}
        </div>
        <div className="page-actions"><StatePill state={st?.state} /></div>
      </header>

      <div className="cards">
        <div className="card">
          <h2>Status</h2>
          <dl>
            <dt>State</dt>
            <dd>{st?.state ?? "unknown"}</dd>
            <dt>Since</dt>
            <dd>{ago(st?.at)}</dd>
            <dt>IP</dt>
            <dd>{st?.ip ?? "–"}</dd>
            <dt>Firmware</dt>
            <dd>{st?.fw ?? "–"}</dd>
            <dt>First seen</dt>
            <dd>{ago(d.firstSeen)}</dd>
          </dl>
        </div>

        <div className="card">
          <h2>Config</h2>
          <dl>
            <dt>Running</dt>
            <dd><SentConfig device={d} configs={configs.data} /></dd>
            <dt>Sent</dt>
            <dd>{d.sentConfig ? ago(d.sentConfig.at) : "–"}</dd>
            <dt>Delivery</dt>
            <dd title="The device's own counter: it only accepts increasing numbers">
              #{st?.configVersion ?? d.configVersion ?? "?"}
            </dd>
          </dl>
          <form
            className="row send-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (pick) send.mutate(pick);
            }}
          >
            <select value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Choose a config…</option>
              {configs.data?.map((c) => (
                <option key={c.id} value={c.id}>{c.name} v{c.version}</option>
              ))}
            </select>
            <button type="submit" disabled={!pick || send.isPending}><Icon name="send" size={16} /> {send.isPending ? "Sending…" : "Send"}</button>
          </form>
          {send.isSuccess && <p className="ok small">Sent (delivery #{send.data.configVersion}). The panel applies it and restarts; the result shows below.</p>}
          {send.error && <p className="error small">{String(send.error.message)}</p>}
          {sendErrors.length > 0 && <ul className="error small">{sendErrors.map((e) => <li key={e}>{e}</li>)}</ul>}
        </div>

        <div className="card wide">
          <h2>Config results</h2>
          {results.length === 0 && !d.lastConfigResult && <p className="muted small">Nothing reported yet.</p>}
          <div className="table-scroll">
          <table>
            <tbody>
              {results.map((r) => (
                <tr key={r.receivedAt}>
                  <td>{ago(r.receivedAt)}</td>
                  <td>#{r.configVersion}</td>
                  <td><ResultBadge status={r.status} /></td>
                  <td className="small wrap">{r.errors?.join("; ")}</td>
                </tr>
              ))}
              {results.length === 0 && d.lastConfigResult && (
                <tr>
                  <td>{ago(d.lastConfigResult.at)}</td>
                  <td>#{d.lastConfigResult.configVersion}</td>
                  <td><ResultBadge status={d.lastConfigResult.status} /></td>
                  <td className="small wrap">{d.lastConfigResult.errors.join("; ")}</td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        </div>
      </div>
    </section>
  );
}
