import type { MenuNode } from "../lib/api";
import { iconUrl } from "../lib/api";
import { NodeGlyph } from "../preview/symbols";
import type { Path } from "./menuTree";

const TYPE_LABEL: Record<MenuNode["type"], string> = { task: "Task", switch: "Switch", folder: "Folder", action: "Action", player: "Player" };

export function Tree({
  menu,
  selected,
  errorPaths,
  onSelect,
}: {
  menu: MenuNode[];
  selected: Path | null;
  errorPaths: Set<string>;
  onSelect: (p: Path) => void;
}) {
  const render = (nodes: MenuNode[], parent: Path, depth: number): JSX.Element[] =>
    nodes.flatMap((n, i) => {
      const path = [...parent, i];
      const key = path.join(".");
      const isSel = selected?.join(".") === key;
      const hasErr = errorPaths.has(key);
      return [
        <button
          key={key}
          className={`tree-row ${isSel ? "sel" : ""} ${hasErr ? "err" : ""}`}
          style={{ paddingLeft: 10 + depth * 18 }}
          onClick={() => onSelect(path)}
          title={`${TYPE_LABEL[n.type]} · ${n.id}`}
        >
          {n.icon ? <span className="tree-icon" style={{ maskImage: `url(${iconUrl(n.icon)})`, WebkitMaskImage: `url(${iconUrl(n.icon)})` }} /> : <NodeGlyph node={n} size={16} />}
          <span className="tree-label">{n.label || "(no label)"}</span>
          <span className="tree-type">{TYPE_LABEL[n.type]}</span>
        </button>,
        ...(n.type === "folder" && n.children ? render(n.children, path, depth + 1) : []),
      ];
    });

  return <div className="tree">{menu.length ? render(menu, [], 0) : <p className="muted small">No items yet.</p>}</div>;
}
