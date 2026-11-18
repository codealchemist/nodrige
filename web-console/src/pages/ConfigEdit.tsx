// Config editor: the visual builder (menu tree, item properties, live
// device preview) and a raw JSON tab, both editing the same config. Checked
// against the Core's schema as you edit; errors jump to their item.
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Icon } from "../components/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Catalog, type ConfigEntry, type Device, type MenuNode, type PanelConfig } from "../lib/api";
import { Tree } from "../builder/Tree";
import { Properties } from "../builder/Properties";
import { Preview } from "../preview/Preview";
import {
  getNode, indentNode, insertNode, moveNode, newNode, outdentNode, pathFromPointer, removeNode, uniqueId, updateNode, type Path,
} from "../builder/menuTree";

export function ConfigEditPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const entry = useQuery({ queryKey: ["config", id], queryFn: () => api<ConfigEntry>(`/configs/${id}`) });
  const devices = useQuery({ queryKey: ["devices"], queryFn: () => api<Device[]>("/devices") });
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: () => api<Catalog>("/catalog"), staleTime: 60_000 });

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [config, setConfig] = useState<PanelConfig>({ menu: [] });
  const [saved, setSaved] = useState("");          // JSON of the last saved state, for "unsaved changes"
  const [tab, setTab] = useState<"builder" | "json">("builder");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [selected, setSelected] = useState<Path | null>(null);
  const [addType, setAddType] = useState<MenuNode["type"]>("task");
  const [target, setTarget] = useState("");

  useEffect(() => {
    if (!entry.data) return;
    setName(entry.data.name);
    setDescription(entry.data.description);
    setConfig(entry.data.config);
    setSaved(JSON.stringify({ n: entry.data.name, d: entry.data.description, c: entry.data.config }));
    setErrors(entry.data.errors);
  }, [entry.data]);

  // JSON tab mirrors the config while you're on it.
  useEffect(() => {
    if (tab === "json") setJsonText(JSON.stringify(config, null, 2));
  }, [tab]);

  // Validate on every change (debounced).
  useEffect(() => {
    const t = setTimeout(async () => {
      const r = await api<{ errors: string[] }>("/configs/validate", { method: "POST", body: JSON.stringify({ config }) });
      setErrors(r.errors);
    }, 350);
    return () => clearTimeout(t);
  }, [config]);

  const dirty = saved !== JSON.stringify({ n: name, d: description, c: config });
  const menu = config.menu;
  const setMenu = (m: MenuNode[]) => setConfig({ ...config, menu: m });
  const node = selected ? getNode(menu, selected) : undefined;

  const errorPaths = useMemo(() => {
    const s = new Set<string>();
    for (const e of errors) {
      const p = pathFromPointer(e.split(":")[0]);
      if (p) s.add(p.join("."));
    }
    return s;
  }, [errors]);

  const save = useMutation({
    mutationFn: () => api<ConfigEntry>(`/configs/${id}`, { method: "PUT", body: JSON.stringify({ name, description, config }) }),
    onSuccess: (e) => {
      qc.setQueryData(["config", id], e);
      qc.invalidateQueries({ queryKey: ["configs"] });
    },
  });
  const send = useMutation({
    mutationFn: async () => {
      if (dirty) await save.mutateAsync();
      return api<{ configVersion: number; libraryVersion: number }>(`/configs/${id}/send`, { method: "POST", body: JSON.stringify({ deviceId: target }) });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["devices"] }),
  });

  // --- Tree actions ---
  const add = () => {
    const n = newNode(menu, addType);
    // After the selection (inside it if it's a folder), else at the end.
    let at: Path;
    const sel = selected ? getNode(menu, selected) : undefined;
    if (sel?.type === "folder" && !sel.binding) at = [...selected!, sel.children?.length ?? 0];
    else if (selected) at = [...selected.slice(0, -1), selected[selected.length - 1] + 1];
    else at = [menu.length];
    setMenu(insertNode(menu, at, n));
    setSelected(at);
  };
  const act = (fn: (m: MenuNode[], p: Path) => [MenuNode[], Path]) => {
    if (!selected) return;
    const [m, p] = fn(menu, selected);
    setMenu(m);
    setSelected(p);
  };
  const del = () => {
    if (!selected || !node) return;
    if (node.type === "folder" && (node.children?.length ?? 0) > 0 && !confirm(`Delete "${node.label}" and its ${node.children!.length} items?`)) return;
    setMenu(removeNode(menu, selected));
    setSelected(null);
  };

  if (entry.isLoading) return <p className="muted">Loading…</p>;
  if (entry.error) return <p className="error">{String(entry.error)}</p>;
  const valid = errors.length === 0 && !jsonError;

  return (
    <section className="editor">
      <Link to="/configs" className="back-link"><Icon name="chevronLeft" size={16} /> Configs</Link>
      <div className="editor-top">
        <input className="title-input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Config name" />
        <span className="badge">v{entry.data?.version}</span>
        {dirty && <span className="badge outdated">unsaved</span>}
        <span className="grow" />
        <div className="tabs" role="tablist">
          <button className={tab === "builder" ? "on" : ""} onClick={() => setTab("builder")}>Builder</button>
          <button className={tab === "json" ? "on" : ""} onClick={() => setTab("json")}>JSON</button>
        </div>
      </div>
      <input className="desc-input" value={description} placeholder="Description" onChange={(e) => setDescription(e.target.value)} />

      {tab === "builder" ? (
        <div className="builder">
          <div className="pane tree-pane">
            <div className="pane-title">Menu</div>
            <div className="row toolbar">
              <select value={addType} onChange={(e) => setAddType(e.target.value as MenuNode["type"])} aria-label="Item type">
                <option value="task">Task</option>
                <option value="switch">Switch</option>
                <option value="folder">Folder</option>
                <option value="action">Action</option>
              </select>
              <button onClick={add}><Icon name="plus" size={16} /> Add</button>
            </div>
            <Tree menu={menu} selected={selected} errorPaths={errorPaths} onSelect={setSelected} />
            <div className="row toolbar">
              <button className="secondary" disabled={!selected} title="Move up" onClick={() => act((m, p) => moveNode(m, p, -1))}>↑</button>
              <button className="secondary" disabled={!selected} title="Move down" onClick={() => act((m, p) => moveNode(m, p, 1))}>↓</button>
              <button className="secondary" disabled={!selected} title="Into the folder above" onClick={() => act(indentNode)}>→</button>
              <button className="secondary" disabled={!selected || selected.length < 2} title="Out of its folder" onClick={() => act(outdentNode)}>←</button>
              <span className="grow" />
              <button className="icon-only danger" disabled={!selected} onClick={del} title="Delete" aria-label="Delete"><Icon name="trash" /></button>
            </div>
          </div>

          <div className="pane props-pane">
            <div className="pane-title">{node ? "Item" : "Properties"}</div>
            {node ? (
              <Properties
                key={selected!.join(".")}
                node={node}
                catalog={catalog.data}
                onChange={(n) => setMenu(updateNode(menu, selected!, () => n))}
                uniqueId={(base) => uniqueId(menu, base, node.id)}
              />
            ) : (
              <p className="muted">Select an item in the tree or on the preview, or add one.</p>
            )}
          </div>

          <div className="pane preview-pane">
            <div className="pane-title">Preview</div>
            <Preview menu={menu} selected={selected} onSelect={setSelected} />
          </div>
        </div>
      ) : (
        <div className="form">
          <textarea
            spellCheck={false}
            value={jsonText}
            onChange={(e) => {
              setJsonText(e.target.value);
              try {
                const c = JSON.parse(e.target.value);
                setJsonError(null);
                setConfig(c);
              } catch (x) {
                setJsonError((x as Error).message);
              }
            }}
          />
        </div>
      )}

      <div className={`status-bar ${valid ? "ok" : "error"}`}>
        {jsonError ? (
          `JSON: ${jsonError}`
        ) : errors.length ? (
          <ul>
            {errors.map((e) => {
              const p = pathFromPointer(e.split(":")[0]);
              return (
                <li key={e}>
                  {p ? <button className="link err-link" onClick={() => { setTab("builder"); setSelected(p); }}>{e}</button> : e}
                </li>
              );
            })}
          </ul>
        ) : (
          "No problems found"
        )}
      </div>

      <div className="action-bar">
        <button className="secondary" onClick={() => save.mutate()} disabled={!!jsonError || save.isPending || !dirty}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
        {save.isSuccess && !dirty && <span className="ok small">Saved as v{save.data.version}</span>}
        <span className="grow" />
        <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Device to send to">
          <option value="">Send to…</option>
          {devices.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <button onClick={() => send.mutate()} disabled={!target || !valid || send.isPending}>
          <Icon name="send" size={16} /> {send.isPending ? "Sending…" : dirty ? "Save & send" : "Send"}
        </button>
        {(send.isSuccess || send.error) && (
          <p className={`small bar-note ${send.error ? "error" : "ok"}`}>
            {send.error ? String(send.error.message) : `Sent v${send.data!.libraryVersion} (delivery #${send.data!.configVersion}).`}
          </p>
        )}
      </div>
    </section>
  );
}
