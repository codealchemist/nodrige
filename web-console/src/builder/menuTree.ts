// Immutable edits on the menu tree. A node is addressed by its path: the
// index at each level, e.g. [3, 0] = first child of the 4th top-level item.
import type { MenuNode, PanelConfig } from "../lib/api";

export type Path = number[];

export function getNode(menu: MenuNode[], path: Path): MenuNode | undefined {
  let nodes = menu;
  let node: MenuNode | undefined;
  for (const i of path) {
    node = nodes[i];
    if (!node) return undefined;
    nodes = node.children ?? [];
  }
  return node;
}

// The list that holds the node at `path`, rebuilt along the way.
function withList(menu: MenuNode[], parent: Path, fn: (list: MenuNode[]) => MenuNode[]): MenuNode[] {
  if (parent.length === 0) return fn([...menu]);
  const [i, ...rest] = parent;
  return menu.map((n, k) => (k === i ? { ...n, children: withList(n.children ?? [], rest, fn) } : n));
}

export function updateNode(menu: MenuNode[], path: Path, fn: (n: MenuNode) => MenuNode): MenuNode[] {
  const parent = path.slice(0, -1);
  const i = path[path.length - 1];
  return withList(menu, parent, (list) => list.map((n, k) => (k === i ? fn(n) : n)));
}

export function removeNode(menu: MenuNode[], path: Path): MenuNode[] {
  const i = path[path.length - 1];
  return withList(menu, path.slice(0, -1), (list) => list.filter((_, k) => k !== i));
}

// Inserts at `path` (the new node gets that path).
export function insertNode(menu: MenuNode[], path: Path, node: MenuNode): MenuNode[] {
  const i = path[path.length - 1];
  return withList(menu, path.slice(0, -1), (list) => [...list.slice(0, i), node, ...list.slice(i)]);
}

// Up/down within its list. Returns [menu, newPath].
export function moveNode(menu: MenuNode[], path: Path, delta: -1 | 1): [MenuNode[], Path] {
  const i = path[path.length - 1];
  const parent = path.slice(0, -1);
  const list = parent.length ? getNode(menu, parent)?.children ?? [] : menu;
  const j = i + delta;
  if (j < 0 || j >= list.length) return [menu, path];
  const next = withList(menu, parent, (l) => {
    [l[i], l[j]] = [l[j], l[i]];
    return l;
  });
  return [next, [...parent, j]];
}

// Into the folder just above it (as its last child). Returns [menu, newPath].
export function indentNode(menu: MenuNode[], path: Path): [MenuNode[], Path] {
  const i = path[path.length - 1];
  if (i === 0) return [menu, path];
  const parent = path.slice(0, -1);
  const prevPath = [...parent, i - 1];
  const prev = getNode(menu, prevPath);
  if (prev?.type !== "folder" || prev.binding) return [menu, path];
  const node = getNode(menu, path)!;
  let next = removeNode(menu, path);
  const count = prev.children?.length ?? 0;
  next = updateNode(next, prevPath, (f) => ({ ...f, children: [...(f.children ?? []), node] }));
  return [next, [...prevPath, count]];
}

// Out of its folder, right after it. Returns [menu, newPath].
export function outdentNode(menu: MenuNode[], path: Path): [MenuNode[], Path] {
  if (path.length < 2) return [menu, path];
  const node = getNode(menu, path)!;
  const folderPath = path.slice(0, -1);
  const target = [...folderPath.slice(0, -1), folderPath[folderPath.length - 1] + 1];
  let next = removeNode(menu, path);
  next = insertNode(next, target, node);
  return [next, target];
}

export function allIds(menu: MenuNode[], out = new Set<string>()): Set<string> {
  for (const n of menu) {
    out.add(n.id);
    if (n.children) allIds(n.children, out);
  }
  return out;
}

export function slugId(label: string): string {
  return (
    label
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "item"
  );
}

export function uniqueId(menu: MenuNode[], base: string, except?: string): string {
  const ids = allIds(menu);
  if (except) ids.delete(except);
  let id = base;
  for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
  return id;
}

// A new item of each type, ready to edit.
export function newNode(menu: MenuNode[], type: MenuNode["type"]): MenuNode {
  const label = { task: "New task", switch: "New switch", folder: "New folder", action: "About", player: "Player" }[type];
  const id = uniqueId(menu, slugId(label));
  switch (type) {
    case "task":
      return { id, type, label, task: { payload: { taskId: id }, qos: 1, expectsResult: true } };
    case "switch":
      return { id, type, label, switch: { payload: { taskId: id }, qos: 1, expectsResult: true, default: false } };
    case "folder":
      return { id, type, label, children: [] };
    case "action":
      return { id, type, label, action: "showAbout" };
    case "player":
      return { id, type, label, player: { taskId: "spotify-player" } };
  }
}

// "/menu/2/children/0/task" -> [2, 0], for jumping from an error to its item.
export function pathFromPointer(pointer: string): Path | null {
  const m = pointer.match(/^\/menu((?:\/\d+(?:\/children)?)*)/);
  if (!m) return null;
  const nums = [...m[1].matchAll(/\/(\d+)/g)].map((x) => Number(x[1]));
  return nums.length ? nums : null;
}

export const emptyConfig = (): PanelConfig => ({ menu: [] });
