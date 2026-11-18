import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Catalog, type ConfigEntry, type ConfigMeta } from "../lib/api";
import { ago } from "../components/bits";

export function ConfigsPage() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const configs = useQuery({ queryKey: ["configs"], queryFn: () => api<ConfigMeta[]>("/configs") });
  const [newName, setNewName] = useState("");

  const create = useMutation({
    mutationFn: async (body: { name: string; from?: string }) => {
      if (body.from) return api<ConfigEntry>("/configs", { method: "POST", body: JSON.stringify(body) });
      const catalog = await api<Catalog>("/catalog");
      const config = catalog.defaultConfig ?? { menu: [] };
      return api<ConfigEntry>("/configs", { method: "POST", body: JSON.stringify({ name: body.name, config }) });
    },
    onSuccess: (entry) => {
      qc.invalidateQueries({ queryKey: ["configs"] });
      nav(`/configs/${entry.id}`);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/configs/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["configs"] }),
  });

  return (
    <section>
      <h1>Configs</h1>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (newName.trim()) create.mutate({ name: newName.trim() });
        }}
      >
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New config name" />
        <button type="submit" disabled={!newName.trim()}>New from default</button>
      </form>
      {create.error && <p className="error small">{String(create.error.message)}</p>}

      <div className="cards">
        {configs.data?.map((c) => (
          <div key={c.id} className="card">
            <Link to={`/configs/${c.id}`}><strong>{c.name}</strong> <span className="badge">v{c.version}</span></Link>
            <p className="muted small">{c.description || "No description"}</p>
            <p className="small">{c.items} menu items · edited {ago(c.updatedAt)}</p>
            <div className="row">
              <Link to={`/configs/${c.id}`} className="button">Open</Link>
              <button className="secondary" onClick={() => create.mutate({ name: `${c.name} copy`, from: c.id })}>Duplicate</button>
              <button
                className="danger"
                onClick={() => {
                  if (confirm(`Delete "${c.name}"? This can't be undone.`)) remove.mutate(c.id);
                }}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
