// Stand-ins for the LVGL built-in symbols the panel draws when an item has
// no icon artwork (menu.cpp nodeSymbol()): small SVGs in the same spirit.
import type { MenuNode } from "../lib/api";

type Glyph = "folder" | "envelope" | "play" | "power" | "settings" | "volume" | "eye" | "eyeClosed" | "refresh" | "keyboard" | "list" | "wifi" | "warning" | "left";

export function glyphFor(n: MenuNode): Glyph {
  if (n.type === "folder") return n.binding === "message_inbox" ? "envelope" : "folder";
  if (n.type === "switch") return "power";
  if (n.type === "action") {
    switch (n.action) {
      case "volume":
      case "phoneVolume":
        return "volume";
      case "screenDim":
        return "eyeClosed";
      case "screenOff":
        return "power";
      case "switchSync":
        return "refresh";
      case "shortcut":
        return "keyboard";
      case "weather":
        return "eye";
      default:
        return "settings";
    }
  }
  return "play";
}

const PATHS: Record<Glyph, string> = {
  folder: "M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  envelope: "M3 6h18v12H3z M3 6l9 7 9-7",
  play: "M7 4l13 8-13 8z",
  power: "M12 3v9 M7 6.5a7 7 0 1 0 10 0",
  settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M19 5l-2 2 M7 17l-2 2",
  volume: "M4 9h4l5-4v14l-5-4H4z M16 9a4 4 0 0 1 0 6 M18.5 6.5a8 8 0 0 1 0 11",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  eyeClosed: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M4 4l16 16",
  refresh: "M20 6v5h-5 M4 18v-5h5 M5.5 9a7 7 0 0 1 13-1 M18.5 15a7 7 0 0 1-13 1",
  keyboard: "M3 6h18v12H3z M7 10h.01 M11 10h.01 M15 10h.01 M7 14h10",
  list: "M8 6h12 M8 12h12 M8 18h12 M4 6h.01 M4 12h.01 M4 18h.01",
  wifi: "M2 9a15 15 0 0 1 20 0 M5 12.5a10 10 0 0 1 14 0 M8.5 16a5 5 0 0 1 7 0 M12 19.5h.01",
  warning: "M12 3l10 18H2z M12 10v5 M12 18h.01",
  left: "M15 5l-7 7 7 7",
};

export function Glyph({ name, size = 24, color = "currentColor", stroke = 2.2 }: { name: Glyph; size?: number; color?: string; stroke?: number }) {
  const filled = name === "play";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? color : "none"} stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name]} />
    </svg>
  );
}

export function NodeGlyph({ node, size, color }: { node: MenuNode; size?: number; color?: string }) {
  return <Glyph name={glyphFor(node)} size={size} color={color} />;
}
