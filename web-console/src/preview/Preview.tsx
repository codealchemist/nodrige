// A clickable stand-in for the panel's menu (menu.cpp showLevel/drawGrid):
// two tiles per page, header with page dots, folders, switch tiles with a
// toggle, task tiles with the reply badge. Drag sideways to swipe pages;
// swipe right on a folder's first page (or tap the header) to go back.
import { useEffect, useMemo, useRef, useState } from "react";
import type { MenuNode } from "../lib/api";
import { iconUrl } from "../lib/api";
import { cellH, cellW, L } from "./layout";
import { Glyph, NodeGlyph } from "./symbols";
import "./preview.css";
import type { Path } from "../builder/menuTree";

type Badge = "busy" | "ok";

export function Preview({
  menu,
  selected,
  onSelect,
  scale: maxScale = 2,
}: {
  menu: MenuNode[];
  selected: Path | null;
  onSelect?: (p: Path) => void;
  scale?: number;  // largest scale; shrinks to fit narrow screens
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(maxScale);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const fit = () => setScale(Math.max(0.5, Math.min(maxScale, (el.clientWidth - 40) / L.w)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxScale]);
  const [folder, setFolder] = useState<Path>([]);  // path of the open folder ([] = home)
  const [page, setPage] = useState(0);
  const [online, setOnline] = useState(true);
  const [switches, setSwitches] = useState<Record<string, boolean>>({});
  const [badges, setBadges] = useState<Record<string, Badge>>({});
  const [activeScene, setActiveScene] = useState<string | null>(null);
  const [actionPage, setActionPage] = useState<MenuNode | null>(null);
  const [anim, setAnim] = useState<"" | "left" | "right">("");
  // Drag offset of the page strip, in screen pixels; `settling` animates it.
  const [dragDx, setDragDx] = useState(0);
  const [settling, setSettling] = useState(false);
  const drag = useRef<{ x: number; dx: number; moved: boolean } | null>(null);
  const swiped = useRef(false);  // swallow the click that ends a drag
  const ownSelect = useRef<string | null>(null);  // selection made by tapping here

  // The open folder's items (fall back to home if the tree changed under us).
  const level = useMemo(() => {
    let nodes = menu;
    for (const i of folder) {
      const n = nodes[i];
      if (!n || n.type !== "folder") return { nodes: menu, title: "", valid: false };
      nodes = n.children ?? [];
    }
    return { nodes, title: folder.length ? nodeAt(menu, folder)?.label ?? "" : "", valid: true };
  }, [menu, folder]);
  useEffect(() => {
    if (!level.valid) setFolder([]);
  }, [level.valid]);

  const pages = Math.max(1, Math.ceil(level.nodes.length / 2));
  useEffect(() => {
    if (page >= pages) setPage(pages - 1);
  }, [pages, page]);

  // Follow the builder's selection: open its folder, turn to its page.
  useEffect(() => {
    if (!selected) return;
    if (ownSelect.current === selected.join(".")) return;  // tapped here: the tap already navigated
    ownSelect.current = null;
    const parent = selected.slice(0, -1);
    const idx = selected[selected.length - 1];
    setActionPage(null);
    setFolder(parent);
    setPage(Math.floor(idx / 2));
  }, [selected?.join(".")]);

  const slide = (dir: "left" | "right", fn: () => void) => {
    setAnim(dir);
    fn();
    setTimeout(() => setAnim(""), 220);
  };
  const goBack = () => {
    if (actionPage) return setActionPage(null);
    if (!folder.length) return;
    const idx = folder[folder.length - 1];
    slide("right", () => {
      setFolder(folder.slice(0, -1));
      setPage(Math.floor(idx / 2));
    });
  };
  // Pages wrap like the firmware's; a folder's first page has the way back
  // on its left instead of the last page.
  const hasPrev = pages > 1 && !(page === 0 && folder.length > 0);
  const hasNext = pages > 1;
  const SWIPE_MIN = 40;  // screen px, about LVGL's gesture threshold
  const settle = (to: number, then?: () => void) => {
    setSettling(true);
    setDragDx(to);
    setTimeout(() => {
      setSettling(false);
      then?.();
      setDragDx(0);
    }, 200);
  };
  const release = (dx: number) => {
    if (actionPage) return dx > SWIPE_MIN && setActionPage(null);
    if (dx < -SWIPE_MIN && hasNext) settle(-L.w, () => setPage((p) => (p + 1) % pages));
    else if (dx > SWIPE_MIN && hasPrev) settle(L.w, () => setPage((p) => (p + pages - 1) % pages));
    else if (dx > SWIPE_MIN && folder.length) settle(0, goBack);
    else settle(0);
  };
  const onDown = (e: React.PointerEvent) => {
    if (settling) return;
    drag.current = { x: e.clientX, dx: 0, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.dx = (e.clientX - d.x) / scale;
    if (Math.abs(d.dx) > 5) d.moved = true;
    if (!d.moved || actionPage) return;
    // Rubber band where there's no page to pull in.
    const free = d.dx < 0 ? hasNext : hasPrev;
    setDragDx(free ? d.dx : d.dx / 3);
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) {
      swiped.current = true;
      setTimeout(() => (swiped.current = false), 0);
      release(d.dx);
    }
  };

  const tap = (n: MenuNode, idx: number) => {
    const path = [...folder, idx];
    ownSelect.current = path.join(".");
    onSelect?.(path);
    if (n.type === "folder" && !n.binding) {
      slide("left", () => {
        setFolder(path);
        setPage(0);
      });
    } else if (n.type === "switch") {
      if (!online) return flash(n.id, "busy", 0);
      setSwitches((s) => ({ ...s, [n.id]: !(s[n.id] ?? n.switch?.default ?? false) }));
    } else if (n.type === "task") {
      if (!online) return;
      flash(n.id, "busy", 600);
      const scene = n.task?.payload?.tuyaScene as string | undefined;
      if (scene) setTimeout(() => setActiveScene(scene.toLowerCase()), 600);
    } else {
      setActionPage(n);
    }
  };
  const flash = (id: string, _b: Badge, busyMs: number) => {
    setBadges((b) => ({ ...b, [id]: "busy" }));
    setTimeout(() => setBadges((b) => ({ ...b, [id]: "ok" })), busyMs);
    setTimeout(() => setBadges((b) => {
      const { [id]: _, ...rest } = b;
      return rest;
    }), busyMs + 2000);
  };

  const selKey = selected?.join(".");
  const slots = [
    ...(hasPrev ? [{ off: -1, p: (page + pages - 1) % pages }] : []),
    { off: 0, p: page },
    ...(hasNext ? [{ off: 1, p: (page + 1) % pages }] : []),
  ];
  const renderPage = (p: number) =>
    level.nodes.slice(p * 2, p * 2 + 2).map((n, c) => {
      const idx = p * 2 + c;
      const path = [...folder, idx].join(".");
      return (
        <Tile
          key={path}
          node={n}
          left={c * (L.w / 2) + L.cellMargin}
          selected={selKey === path}
          online={online}
          on={switches[n.id] ?? n.switch?.default ?? false}
          badge={badges[n.id]}
          sceneActive={!!activeScene && String(n.task?.payload?.tuyaScene ?? "").toLowerCase() === activeScene}
          onTap={() => !swiped.current && tap(n, idx)}
        />
      );
    });

  return (
    <div className="preview-wrap" ref={wrapRef}>
      <div className="preview-tools">
        <label className="check small">
          <input type="checkbox" checked={online} onChange={(e) => setOnline(e.target.checked)} /> Online
        </label>
        <button className="link small" onClick={() => { setFolder([]); setPage(0); setActionPage(null); setSwitches({}); setActiveScene(null); }}>Reset</button>
      </div>
      <div className="bezel" style={{ width: L.w * scale + 24, height: L.h * scale + 24 }}>
        <div
          className="screen"
          style={{ width: L.w, height: L.h, transform: `scale(${scale})` }}
          onPointerCancel={() => { drag.current = null; settle(0); }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={onUp}
        >
          {actionPage ? (
            <ActionPage node={actionPage} onBack={() => setActionPage(null)} />
          ) : (
            <>
              <div className="hdr" onClick={() => (folder.length ? goBack() : undefined)}>
                {folder.length ? (
                  <span className="hdr-title"><Glyph name="left" size={16} stroke={3} />&nbsp;&nbsp;{level.title}</span>
                ) : (
                  <span className="hdr-status" style={{ color: online ? L.green : "#FFC107" }}>
                    <Glyph name={online ? "wifi" : "warning"} size={16} stroke={2.6} />&nbsp;&nbsp;{online ? "Online" : "No server"}
                  </span>
                )}
                {pages > 1 && (
                  <span className="dots">
                    {Array.from({ length: pages }, (_, i) => <span key={i} className={i === page ? "on" : ""} />)}
                  </span>
                )}
              </div>
              <div className={`cells ${anim}`}>
                <div
                  className="strip"
                  style={{ transform: `translateX(${dragDx}px)`, transition: settling ? "transform .2s ease-out" : "none" }}
                >
                  {slots.map(({ off, p }) => (
                    <div key={off} className="page" style={{ left: off * L.w, width: L.w, height: L.h }}>
                      {renderPage(p)}
                    </div>
                  ))}
                </div>
                {level.nodes.length === 0 && <div className="empty">{folder.length ? "(empty)" : "No menu items"}</div>}
              </div>
            </>
          )}
        </div>
      </div>
      <p className="muted small">Drag sideways to swipe · tap tiles · tap the header to go back</p>
    </div>
  );
}

function nodeAt(menu: MenuNode[], path: Path): MenuNode | undefined {
  let nodes = menu;
  let n: MenuNode | undefined;
  for (const i of path) {
    n = nodes[i];
    nodes = n?.children ?? [];
  }
  return n;
}

function Mask({ id, size, color, scale = 1 }: { id: string; size: number; color: string; scale?: number }) {
  const url = `url(${iconUrl(id)})`;
  return (
    <span
      className="mask"
      style={{ width: size, height: size, backgroundColor: color, maskImage: url, WebkitMaskImage: url, transform: scale !== 1 ? `scale(${scale})` : undefined }}
    />
  );
}

function Tile(props: {
  node: MenuNode;
  left: number;
  selected: boolean;
  online: boolean;
  on: boolean;
  badge?: Badge;
  sceneActive: boolean;
  onTap: () => void;
}) {
  const { node: n, left, selected, online, on, badge, sceneActive, onTap } = props;
  const isSwitch = n.type === "switch";
  const dimmed = (n.type === "task" || n.type === "switch") && !online;
  const iconColor = dimmed ? L.greyDim : !isSwitch ? "#fff" : on ? L.amber : L.greyOff;
  const big = n.label.length <= L.bigLabelMaxChars;
  const labelTop = isSwitch ? L.switchLabelTop : L.iconTop + L.icon + L.labelGap;

  return (
    <div
      className={`cell ${selected ? "selected" : ""}`}
      style={{ left, top: L.headerH, width: cellW, height: cellH, background: sceneActive ? L.activeSceneBg : L.cellBg }}
      onClick={onTap}
    >
      <div className="cell-icon" style={{ top: isSwitch ? 0 : L.iconTop }}>
        {n.icon ? (
          <Mask id={n.icon} size={L.icon} color={iconColor} scale={isSwitch ? 0.75 : 1} />
        ) : (
          <span style={{ display: "inline-block", marginTop: isSwitch ? 4 : 6 }}>
            <NodeGlyph node={n} size={48} color={iconColor} />
          </span>
        )}
      </div>
      <div
        className={`cell-label ${big ? "big" : "small"} ${isSwitch ? "one-line" : ""}`}
        style={{ top: labelTop, color: dimmed ? L.greyDim : "#fff" }}
      >
        {n.label}
      </div>
      {isSwitch && (
        <span className={`toggle ${on ? "on" : ""} ${dimmed ? "disabled" : ""}`} style={{ bottom: L.toggleBottom, width: L.toggleW, height: L.toggleH }}>
          <span />
        </span>
      )}
      {badge && <span className={`badge-dot ${badge}`}>{badge === "ok" ? "✓" : ""}</span>}
    </div>
  );
}

function ActionPage({ node, onBack }: { node: MenuNode; onBack: () => void }) {
  const what: Record<string, string> = {
    volume: "Volume slider (phone / computer)",
    phoneVolume: "Volume slider",
    weather: "Weather cards",
    screenDim: "Screen dimming slider",
    screenOff: "Screen off slider",
    switchSync: "Switch sync slider",
    shortcut: "Shortcut button picker",
    showAbout: "About notice",
    reprovision: "Reset confirmation",
    restoreDefaultConfig: "Restore confirmation",
  };
  return (
    <div className="action-page">
      <div className="hdr">
        <button className="back" onClick={onBack}><Glyph name="left" size={18} stroke={3} /></button>
        <span className="hdr-title" style={{ marginLeft: 8 }}>{node.label}</span>
      </div>
      <div className="action-body">
        <p>{what[node.action ?? ""] ?? node.action}</p>
        <p className="muted">Shown on the panel; not simulated here.</p>
      </div>
    </div>
  );
}
