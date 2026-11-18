import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Catalog, type ConfigEntry, type ConfigMeta } from "../lib/api";
import { ago } from "../components/bits";
import { Icon, PageHead } from "../components/icons";

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
      <PageHead title="Configs" sub="Menus you can edit, preview and send to a panel">
        <form
          className="row new-config"
          onSubmit={(e) => {
            e.preventDefault();
            if (newName.trim()) create.mutate({ name: newName.trim() });
          }}
        >
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New config name" aria-label="New config name" />
          <button type="submit" disabled={!newName.trim()}><Icon name="plus" size={16} /> New</button>
        </form>
      </PageHead>
      {create.error && <p className="error small">{String(create.error.message)}</p>}

      <div className="cards">
        {configs.data?.map((c) => (
          <div key={c.id} className="card config-card">
            <Link to={`/configs/${c.id}`} className="card-head">
              <div className="card-title">
                <strong>{c.name}</strong>
                <span className="muted small">{c.description || "No description"}</span>
              </div>
              <span className="badge">v{c.version}</span>
            </Link>
            <p className="muted small meta">{c.items} menu items · edited {ago(c.updatedAt)}</p>
            <div className="card-actions">
              <Link to={`/configs/${c.id}`} className="button"><Icon name="edit" size={16} /> Open</Link>
              <span className="grow" />
              <button className="icon-only" title="Duplicate" aria-label="Duplicate" onClick={() => create.mutate({ name: `${c.name} copy`, from: c.id })}>
                <Icon name="copy" />
              </button>
              <button
                className="icon-only danger"
                title="Delete"
                aria-label="Delete"
                onClick={() => {
                  if (confirm(`Delete "${c.name}"? This can't be undone.`)) remove.mutate(c.id);
                }}
              >
                <Icon name="trash" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
