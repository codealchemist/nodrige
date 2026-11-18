// The panel's menu layout, copied from the firmware so the preview matches
// the device. Source: esp32-c6-control/poc/src/menu.cpp, drawGrid() and the
// constants above it. If the firmware's layout changes, change these too
// (a shared layout file both sides read is planned).
export const L = {
  w: 320,
  h: 172,
  headerH: 30,          // kHeaderH
  cellMargin: 4,        // kCellM
  cellRadius: 12,
  cellBg: "#1C1C1C",
  cellPressed: "#3A3A3A",
  activeSceneBg: "#5A4300",
  dot: 7,
  dotGap: 6,
  icon: 64,             // tile artwork size
  iconTop: 12,
  labelGap: 8,          // label top = iconTop + 64 + 8
  bigLabelMaxChars: 9,  // <= 9 chars: 28 px, else 20 px over up to 2 lines
  switchIcon: 48,       // switch tiles: icon drawn at 75 %
  switchIconTop: 8,
  switchLabelTop: 64,
  toggleW: 48,
  toggleH: 24,
  toggleBottom: 8,
  amber: "#FFC107",     // lv_palette_main(LV_PALETTE_AMBER)
  greyOff: "#757575",   // lv_palette_darken(LV_PALETTE_GREY, 1)
  greyDim: "#616161",   // offline: lv_palette_darken(LV_PALETTE_GREY, 2)
  green: "#4CAF50",
  blue: "#2196F3",
  red: "#F44336",
} as const;

export const cellW = L.w / 2 - 2 * L.cellMargin;          // 152
export const cellH = L.h - L.headerH - L.cellMargin;      // 138
