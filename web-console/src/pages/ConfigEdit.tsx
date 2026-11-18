// Phase 1 editor: name, description and the config as JSON, validated live
// against the Core's schema. The visual builder and device preview (phase
// 2-3) replace the JSON box as the main way to edit.
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ConfigEntry, type Device } from "../lib/api";

export function ConfigEditPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const entry = useQuery({ queryKey: ["config", id], queryFn: () => api<ConfigEntry>(`/configs/${id}`) });
  const devices = useQuery({ queryKey: ["devices"], queryFn: () => api<Device[]>("/devices") });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [text, setText] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [target, setTarget] = useState("");

  useEffect(() => {
    if (!entry.data) return;
    setName(entry.data.name);
    setDescription(entry.data.description);
    setText(JSON.stringify(entry.data.config, null, 2));
    setErrors(entry.data.errors);
  }, [entry.data]);

  // Validate as you type (debounced).
  useEffect(() => {
    const t = setTimeout(async () => {
      let config;
      try {
        config = JSON.parse(text || "{}");
        setParseError(null);
      } catch (e) {
        setParseError((e as Error).message);
        return;
      }
      const r = await api<{ errors: string[] }>("/configs/validate", { method: "POST", body: JSON.stringify({ config }) });
      setErrors(r.errors);
    }, 400);
    return () => clearTimeout(t);
  }, [text]);

  const save = useMutation({
    mutationFn: () =>
      api<ConfigEntry>(`/configs/${id}`, { method: "PUT", body: JSON.stringify({ name, description, config: JSON.parse(text) }) }),
    onSuccess: (e) => {
      qc.setQueryData(["config", id], e);
      qc.invalidateQueries({ queryKey: ["configs"] });
    },
  });
  const send = useMutation({
    mutationFn: async () => {
      await save.mutateAsync();
      return api<{ configVersion: number; libraryVersion: number }>(`/configs/${id}/send`, { method: "POST", body: JSON.stringify({ deviceId: target }) });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["devices"] }),
  });

  if (entry.isLoading) return <p className="muted">Loading…</p>;
  if (entry.error) return <p className="error">{String(entry.error)}</p>;
  const valid = !parseError && errors.length === 0;

  return (
    <section>
      <h1>{name || "Config"} <span className="badge">v{entry.data?.version}</span></h1>
      <div className="form">
        <label>Name <input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Description <input value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <label className="grow">
          Config (JSON) <span className="muted small">— the visual builder is coming next</span>
          <textarea spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <div className={valid ? "ok small" : "error small"}>
          {parseError ? `JSON: ${parseError}` : errors.length ? <ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul> : "Valid"}
        </div>
        <div className="row">
          <button onClick={() => save.mutate()} disabled={!!parseError || save.isPending}>{save.isPending ? "Saving…" : "Save"}</button>
          {save.isSuccess && <span className="ok small">Saved as v{save.data.version}</span>}
          <span className="grow" />
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Send to…</option>
            {devices.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <button onClick={() => send.mutate()} disabled={!target || !valid || send.isPending}>
            {send.isPending ? "Sending…" : "Save and send"}
          </button>
        </div>
        {send.isSuccess && <p className="ok small">Sent v{send.data.libraryVersion} (delivery #{send.data.configVersion}).</p>}
        {send.error && <p className="error small">{String(send.error.message)}</p>}
      </div>
    </section>
  );
}
