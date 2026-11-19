import { useEffect, useState } from "react";
import type { Catalog, MenuNode } from "../lib/api";
import { iconUrl } from "../lib/api";
import { NodeGlyph } from "../preview/symbols";
import { slugId } from "./menuTree";

type Props = {
  node: MenuNode;
  catalog?: Catalog;
  onChange: (n: MenuNode) => void;
  uniqueId: (base: string) => string;
};

export function Properties({ node, catalog, onChange, uniqueId }: Props) {
  const set = (patch: Partial<MenuNode>) => onChange({ ...node, ...patch });
  const scenes = catalog?.scenes ?? [];

  return (
    <div className="props">
      <datalist id="task-ids">{(catalog?.tasks ?? []).map((t) => <option key={t} value={t} />)}</datalist>
      <label>
        <span className="field-label">Label</span>
        <input
          value={node.label}
          maxLength={40}
          onChange={(e) => set({ label: e.target.value })}
          onBlur={() => {
            // A new item still has its placeholder id: follow the label.
            if (/^new-(task|switch|folder)(-\d+)?$|^about(-\d+)?$/.test(node.id) && node.label) set({ id: uniqueId(slugId(node.label)) });
          }}
        />
      </label>
      <label>
        <span className="field-label">ID <span className="hint">unique; the Core and the shortcut setting refer to it</span></span>
        <input value={node.id} onChange={(e) => set({ id: e.target.value.replace(/[^A-Za-z0-9_-]/g, "") })} />
      </label>

      <IconPicker value={node.icon} node={node} icons={catalog?.icons ?? []} onChange={(icon) => set({ icon })} />

      {node.type === "task" && <TaskFields node={node} scenes={scenes} onChange={onChange} />}
      {node.type === "switch" && <SwitchFields node={node} scenes={scenes} onChange={onChange} />}
      {node.type === "folder" && (
        <label className="check">
          <input
            type="checkbox"
            checked={node.binding === "message_inbox"}
            onChange={(e) => {
              const { binding, children, ...rest } = node;
              onChange(e.target.checked ? { ...rest, binding: "message_inbox" } : { ...rest, children: children ?? [] });
            }}
          />
          Messages inbox (filled by the panel, no items of its own)
        </label>
      )}
      {node.type === "action" && (
        <label>
          <span className="field-label">Action</span>
          <select value={node.action} onChange={(e) => set({ action: e.target.value })}>
            {(catalog?.actions ?? []).map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}

function IconPicker({ value, node, icons, onChange }: { value?: string; node: MenuNode; icons: Catalog["icons"]; onChange: (v?: string) => void }) {
  const [open, setOpen] = useState(false);
  // Menu tiles use the big icons; the small caption icons don't fit a tile.
  const usable = icons.filter((i) => (i.size ?? 64) >= 48);
  return (
    <div className="field">
      <span className="field-label">Icon</span>
      <button type="button" className="secondary icon-btn" onClick={() => setOpen(!open)}>
        {value ? <span className="tile-icon" style={{ maskImage: `url(${iconUrl(value)})`, WebkitMaskImage: `url(${iconUrl(value)})` }} /> : <NodeGlyph node={node} size={22} />}
        <span>{value ?? "Built-in symbol"}</span>
      </button>
      {open && (
        <div className="icon-grid">
          <button type="button" className={`icon-cell ${!value ? "sel" : ""}`} onClick={() => { onChange(undefined); setOpen(false); }} title="Built-in symbol (no artwork)">
            <NodeGlyph node={node} size={28} />
          </button>
          {usable.map((i) => (
            <button key={i.id} type="button" className={`icon-cell ${value === i.id ? "sel" : ""}`} title={i.id} onClick={() => { onChange(i.id); setOpen(false); }}>
              <span className="tile-icon" style={{ maskImage: `url(${i.url})`, WebkitMaskImage: `url(${i.url})` }} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SceneSelect({ value, scenes, onChange, none = "None" }: { value?: string; scenes: string[]; onChange: (v?: string) => void; none?: string }) {
  const known = !value || scenes.includes(value);
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">{none}</option>
      {!known && <option value={value}>{value} (not in Tuya)</option>}
      {scenes.map((s) => <option key={s} value={s}>{s}</option>)}
    </select>
  );
}

// Payload keys shown as their own fields; the rest are edited as JSON.
const KNOWN_KEYS = ["taskId", "tuyaScene"];

function ExtraPayload({ payload, onChange }: { payload: Record<string, unknown>; onChange: (p: Record<string, unknown>) => void }) {
  const rest = Object.fromEntries(Object.entries(payload).filter(([k]) => !KNOWN_KEYS.includes(k)));
  const [text, setText] = useState(JSON.stringify(rest, null, 2));
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setText(JSON.stringify(rest, null, 2)), [JSON.stringify(rest)]);
  return (
    <label>
      <span className="field-label">Extra payload <span className="hint">other fields sent to the Core, as JSON</span></span>
      <textarea
        className="small-json"
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const v = JSON.parse(e.target.value || "{}");
            if (typeof v !== "object" || Array.isArray(v) || v === null) throw new Error("must be an object");
            setErr(null);
            const keep = Object.fromEntries(Object.entries(payload).filter(([k]) => KNOWN_KEYS.includes(k)));
            onChange({ ...keep, ...v });
          } catch (x) {
            setErr((x as Error).message);
          }
        }}
      />
      {err && <span className="error small">{err}</span>}
    </label>
  );
}

function TaskFields({ node, scenes, onChange }: { node: MenuNode; scenes: string[]; onChange: (n: MenuNode) => void }) {
  const task = node.task ?? { payload: {} };
  const payload = task.payload ?? {};
  const setTask = (patch: Partial<NonNullable<MenuNode["task"]>>) => onChange({ ...node, task: { ...task, ...patch } });
  const setPayload = (patch: Record<string, unknown>) => {
    const p = { ...payload, ...patch };
    for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
    setTask({ payload: p });
  };
  const sc = node.shortcut;
  const scMode = !sc ? "none" : typeof sc === "object" ? "toggle" : "run";
  const offScene = typeof sc === "object" ? (sc.off?.tuyaScene as string | undefined) : undefined;

  return (
    <>
      <h3>Task</h3>
      <label>
        <span className="field-label">Task ID <span className="hint">which Core handler runs it</span></span>
        <input list="task-ids" value={String(payload.taskId ?? "")} onChange={(e) => setPayload({ taskId: e.target.value || undefined })} />
      </label>
      <label>
        <span className="field-label">Tuya scene <span className="hint">run a Smart Life scene</span></span>
        <SceneSelect value={payload.tuyaScene as string | undefined} scenes={scenes} onChange={(v) => setPayload({ tuyaScene: v })} />
      </label>
      <ExtraPayload payload={payload} onChange={(p) => setTask({ payload: p })} />
      <label className="check">
        <input type="checkbox" checked={task.expectsResult ?? false} onChange={(e) => setTask({ expectsResult: e.target.checked })} />
        Wait for a reply (spinner, then ✓ or ✗ on the tile)
      </label>
      <h3>Shortcut button</h3>
      <label>
        <select
          value={scMode}
          onChange={(e) => {
            const m = e.target.value;
            const { shortcut, ...rest } = node;
            onChange(m === "none" ? rest : m === "run" ? { ...rest, shortcut: true } : { ...rest, shortcut: { off: { tuyaScene: offScene ?? "Turn Off" } } });
          }}
        >
          <option value="none">Not available to the button</option>
          <option value="run">Each press runs it</option>
          <option value="toggle">Press runs it, next press turns off</option>
        </select>
      </label>
      {scMode === "toggle" && (
        <label>
          <span className="field-label">"Off" scene</span>
          <SceneSelect value={offScene} scenes={scenes} none="Choose a scene…" onChange={(v) => onChange({ ...node, shortcut: { off: v ? { tuyaScene: v } : {} } })} />
        </label>
      )}
    </>
  );
}

function SwitchFields({ node, scenes, onChange }: { node: MenuNode; scenes: string[]; onChange: (n: MenuNode) => void }) {
  const sw = node.switch ?? { payload: {} };
  const setSw = (patch: Partial<NonNullable<MenuNode["switch"]>>) => onChange({ ...node, switch: { ...sw, ...patch } });
  return (
    <>
      <h3>Switch</h3>
      <label>
        <span className="field-label">Task ID</span>
        <input list="task-ids" value={String(sw.payload?.taskId ?? "")} onChange={(e) => setSw({ payload: { ...sw.payload, taskId: e.target.value } })} />
      </label>
      <label>
        <span className="field-label">Read state with <span className="hint">task whose reply says on or off; read on boot, wake and when its page opens</span></span>
        <input
          list="task-ids"
          placeholder={sw.on?.tuyaScene ? "From the On scene's lights" : "Not read"}
          value={String(sw.state?.taskId ?? "")}
          onChange={(e) => setSw({ state: e.target.value ? { ...sw.state, taskId: e.target.value } : undefined })}
        />
      </label>
      <label>
        <span className="field-label">"On" scene</span>
        <SceneSelect value={sw.on?.tuyaScene as string | undefined} scenes={scenes} onChange={(v) => setSw({ on: v ? { ...sw.on, tuyaScene: v } : undefined })} />
      </label>
      <label>
        <span className="field-label">"Off" scene</span>
        <SceneSelect value={sw.off?.tuyaScene as string | undefined} scenes={scenes} onChange={(v) => setSw({ off: v ? { ...sw.off, tuyaScene: v } : undefined })} />
      </label>
      <label className="check">
        <input type="checkbox" checked={sw.default ?? false} onChange={(e) => setSw({ default: e.target.checked })} />
        Starts on
      </label>
      <label className="check">
        <input type="checkbox" checked={sw.expectsResult ?? false} onChange={(e) => setSw({ expectsResult: e.target.checked })} />
        Wait for a reply (flips back if it fails)
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={node.shortcut === true}
          onChange={(e) => {
            const { shortcut, ...rest } = node;
            onChange(e.target.checked ? { ...rest, shortcut: true } : rest);
          }}
        />
        The shortcut button can toggle it
      </label>
    </>
  );
}
