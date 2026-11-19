// Integrations the Core uses for panel buttons: ids, secrets and options,
// saved on the Core (data/integrations.json) and applied without a restart.
// Secrets are write-only: the Core says whether one is set, never what it is.
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { PageHead } from "../components/icons";

type Field = {
  key: string;
  label: string;
  type: "text" | "secret" | "select" | "url";
  required?: boolean;
  help?: string;
  options?: { value: string; label: string }[];
  default?: string;
  source: "console" | "env" | null;
  set: boolean;
  value?: string;
  hint?: string;
};
type Integration = {
  id: string;
  label: string;
  description: string;
  docsUrl?: string;
  fields: Field[];
  status: {
    state: "ok" | "configured" | "missing";
    message: string;
    connected?: boolean;
    redirectUri?: string;
    user?: { name: string; product?: string };
  };
};

export function SettingsPage() {
  const list = useQuery({ queryKey: ["integrations"], queryFn: () => api<Integration[]>("/integrations") });
  return (
    <section>
      <PageHead title="Settings" sub="Accounts and keys the Core uses for panel buttons. Saved on the Core; changes apply right away." />
      {list.isLoading && <p className="muted">Loading…</p>}
      {list.error && <p className="error">{String(list.error)}</p>}
      <div className="settings-list">
        {list.data?.map((i) => <IntegrationCard key={i.id} integration={i} />)}
      </div>
    </section>
  );
}

const PILL: Record<Integration["status"]["state"], string> = { ok: "on", configured: "info", missing: "unknown" };

function IntegrationCard({ integration: i }: { integration: Integration }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string | null>>({});
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const dirty = Object.keys(draft).length > 0;

  const save = useMutation({
    mutationFn: () => api<Integration & { changed: string[] }>(`/integrations/${i.id}`, { method: "PUT", body: JSON.stringify({ values: draft }) }),
    onSuccess: () => {
      setDraft({});
      setTest(null);
      qc.invalidateQueries({ queryKey: ["integrations"] });
      qc.invalidateQueries({ queryKey: ["catalog"] });  // e.g. Tuya scenes for the builder
    },
  });
  const check = useMutation({
    mutationFn: () => api<{ ok: boolean; message: string }>(`/integrations/${i.id}/test`, { method: "POST" }),
    onSuccess: (r) => {
      setTest(r);
      qc.invalidateQueries({ queryKey: ["integrations"] });
    },
  });

  const edit = (key: string, v: string | null) => setDraft((d) => ({ ...d, [key]: v }));
  const unedit = (key: string) =>
    setDraft((d) => {
      const { [key]: _, ...rest } = d;
      return rest;
    });

  return (
    <div className="card integration">
      <div className="card-head">
        <div className="card-title">
          <strong>{i.label}</strong>
          <span className="muted small wrap-text">{i.description}</span>
        </div>
        <span className={`state-pill ${PILL[i.status.state]}`}>
          <span className="live-dot" />
          {i.status.message}
        </span>
      </div>

      <form
        className="fields"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) save.mutate();
        }}
      >
        {i.fields.map((f) => (
          <FieldRow key={f.key} field={f} draft={draft[f.key]} edited={f.key in draft} onEdit={(v) => edit(f.key, v)} onUndo={() => unedit(f.key)} />
        ))}

        {i.id === "spotify" && i.status.redirectUri && <SpotifyConnect status={i.status} />}

        <div className="card-actions">
          <button type="submit" disabled={!dirty || save.isPending}>{save.isPending ? "Saving…" : "Save"}</button>
          {dirty && <button type="button" className="link" onClick={() => setDraft({})}>Discard</button>}
          <span className="grow" />
          {i.docsUrl && (
            <a className="text-link small" href={i.docsUrl} target="_blank" rel="noreferrer">Open {i.label.split(" ")[0]} console ↗</a>
          )}
          <button type="button" className="secondary" disabled={dirty || check.isPending} onClick={() => check.mutate()} title={dirty ? "Save first" : "Try it for real"}>
            {check.isPending ? "Testing…" : "Test"}
          </button>
        </div>
        {save.error && <p className="error small">{String(save.error.message)}</p>}
        {test && <p className={`small test-result ${test.ok ? "ok" : "error"}`}>{test.ok ? "✓" : "✗"} {test.message}</p>}
      </form>
    </div>
  );
}

function FieldRow({
  field: f,
  draft,
  edited,
  onEdit,
  onUndo,
}: {
  field: Field;
  draft: string | null | undefined;
  edited: boolean;
  onEdit: (v: string | null) => void;
  onUndo: () => void;
}) {
  const id = `f-${f.key}`;
  const clearing = edited && draft === null;
  const source =
    clearing ? <span className="badge outdated">will be cleared</span>
    : f.source === "console" ? <span className="badge">saved here</span>
    : f.source === "env" ? <span className="badge" title="Set in the Core's .env file. A value saved here takes precedence.">from .env</span>
    : null;

  let input;
  if (f.type === "select") {
    input = (
      <select id={id} value={edited ? draft ?? "" : f.value || f.default || ""} onChange={(e) => onEdit(e.target.value)}>
        {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  } else if (f.type === "secret") {
    input = (
      <input
        id={id}
        type="password"
        autoComplete="new-password"
        spellCheck={false}
        value={edited ? draft ?? "" : ""}
        placeholder={f.set ? `${f.hint}  (set; type to replace)` : "Not set"}
        onChange={(e) => (e.target.value ? onEdit(e.target.value) : onUndo())}
      />
    );
  } else {
    input = (
      <input
        id={id}
        type={f.type === "url" ? "url" : "text"}
        spellCheck={false}
        value={edited ? draft ?? "" : f.value ?? ""}
        placeholder={f.required ? "Required" : "Optional"}
        onChange={(e) => (e.target.value === (f.value ?? "") ? onUndo() : onEdit(e.target.value))}
      />
    );
  }

  return (
    <div className="field-row">
      <label htmlFor={id} className="field-label">
        {f.label}
        {f.required && !f.set && <span className="req"> *</span>}
        {source}
      </label>
      <div className="field-input">
        {input}
        {f.source === "console" && !clearing && (
          <button type="button" className="link small" onClick={() => onEdit(null)} title={f.type === "secret" ? "Remove the saved value" : "Remove the saved value (falls back to .env)"}>
            Clear
          </button>
        )}
        {edited && (
          <button type="button" className="link small" onClick={onUndo}>Undo</button>
        )}
      </div>
      {f.help && <span className="field-help">{f.help}</span>}
    </div>
  );
}

function SpotifyConnect({ status }: { status: Integration["status"] }) {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const justConnected = params.get("spotify") === "connected";
  useEffect(() => {
    if (!justConnected) return;
    qc.invalidateQueries({ queryKey: ["integrations"] });
    const t = setTimeout(() => setParams({}, { replace: true }), 5000);
    return () => clearTimeout(t);
  }, [justConnected]);

  const connect = useMutation({
    mutationFn: () =>
      api<{ url: string }>("/spotify/connect", { method: "POST", body: JSON.stringify({ returnTo: `${location.origin}${location.pathname}` }) }),
    onSuccess: ({ url }) => location.assign(url),
  });
  const disconnect = useMutation({
    mutationFn: () => api("/spotify/disconnect", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["integrations"] }),
  });

  return (
    <div className="sub-panel">
      <div className="field-row">
        <span className="field-label">Redirect URI</span>
        <code className="copy">{status.redirectUri}</code>
        <span className="field-help">Add this exact address to your Spotify app's Redirect URIs.</span>
      </div>
      <div className="row">
        {status.connected ? (
          <>
            <span className="small">Signed in{status.user ? ` as ${status.user.name}` : ""}.</span>
            <span className="grow" />
            <button type="button" className="secondary" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>Disconnect</button>
          </>
        ) : (
          <>
            <span className="small muted">Then sign in so the Core can act on your account.</span>
            <span className="grow" />
            <button type="button" onClick={() => connect.mutate()} disabled={connect.isPending}>
              {connect.isPending ? "Opening Spotify…" : "Connect Spotify"}
            </button>
          </>
        )}
      </div>
      {justConnected && status.connected && <p className="ok small">Connected. The panel's Spotify buttons work now.</p>}
      {status.connected && status.user?.product && status.user.product !== "premium" && (
        <p className="small warn-text">Skipping songs needs Spotify Premium; liking works on any account.</p>
      )}
      {connect.error && <p className="error small">{String(connect.error.message)}</p>}
    </div>
  );
}
