# 12 — Panel Modules and the Config Builder (design)

**Status:** Proposed. Nothing here is built yet.
**Affects:** web console (builder), Core (`src/configs`, `src/console`, extension manifests). The panel firmware does not change in phases 1–3.

## 1. Problem

Today a panel config is a single tree of menu items. Each item mixes three different concerns:

| Concern | Today, on the same item |
|---|---|
| **Where it shows** | position in the tree, parent folder |
| **How it looks** | `label`, `icon`, item `type` (task / switch / folder / action) |
| **What it does** | `task.payload` (`taskId`, `tuyaScene`, free JSON), `switch.on` / `switch.off`, `expectsResult`, `qos`, `shortcut` |

As a result:

- **The same control can't be reused.** A "Lights" switch in two configs is two copies, and changing its Tuya scene means editing both.
- **The item editor keeps growing.** Every behaviour option lands in one form (shortcut modes, an "Off" scene, extra JSON payload). It is hard to read, and the free JSON hides typos until the Core rejects them at run time.
- **New controls have no natural place.** A slider bound to any value, a read-only value tile or a weather card would each be another special case in the item form.
- **The builder doesn't know what the Core can do.** The catalog sends scene names and a flat list of task ids, but not which parameters each task takes.

## 2. Proposal: three layers

```
 Integrations            Modules                       Configs
 (Core extensions,  ──▶  (library, edited in    ──▶   (library, edited in
  read-only)              the module creator)          the config builder)
                                                              │
                                                              ▼ compile at send
                                                       Panel config v1
                                                       (today's format, firmware unchanged)
```

1. **Integrations.** These are what the Core can do, declared by the extensions themselves: "run a Tuya scene", "read a room's on/off state", "set the computer volume", "weather forecast". Each declares typed parameters and where their options come from (for example, the Tuya scene list). Built-in panel pages (Weather, Volume, the settings pages, About) are integrations too, provided by the panel itself instead of the Core. This keeps the Core rule: it learns about scenes only through an extension's manifest, never in its own code.
2. **Modules.** A reusable control: a **control type**, the **integration calls** it makes with their parameters, a **default look** (label, icon) and its **shortcut-button behaviour**. Modules are edited in the module creator.
3. **Configs.** Pages and folders that **place** modules, each with an optional label or icon override. Configs never define behaviour. They are edited in the config builder.

At send time the Core **compiles** a config and the modules it uses into today's panel config, which the existing schema then validates. The firmware, the device's config store and `configVersion` stay exactly as they are.

## 3. Data shapes

### 3.1 Integration (declared in an extension manifest)

```jsonc
// menu-tasks manifest → capabilities[]
{
  "id": "tuya.scene",                 // global, "<namespace>.<name>"
  "label": "Run a Tuya scene",
  "kind": "trigger",                  // trigger | read | set
  "params": [
    { "key": "scene", "label": "Scene", "type": "enum", "options": { "source": "tuya.scenes" } }
  ],
  "replies": true,                    // sends a task result the panel can show
  "emit": { "tuyaScene": "{scene}" }  // how params map onto today's task payload
}
```

Other declarations:

| id | kind | params | Today's equivalent |
|---|---|---|---|
| `tuya.scene` | trigger | scene | `payload.tuyaScene` |
| `tuya.switchState` | read | onScene | `taskId: "switch-state"` |
| `computer.volume` | set | level 0–100 | `taskId: "player-volume"` |
| `core.info` | read | — | `taskId: "core-info"` |
| `panel.weather` | page | — | `action: "weather"` |
| `panel.volume` | page | — | `action: "volume"` |
| `panel.screenDim` … `panel.restoreDefaultConfig` | page | — | the other `action` values |

`options.source` names a dynamic list that the Core resolves for `/catalog`, for example `tuya.scenes` → `sceneNames()`. The panel integrations are a static list that the console back end owns, since the Core can't learn them from the firmware.

### 3.2 Module

Stored as `data/modules/<id>.json`, each with its own edit counter, like configs.

```jsonc
{
  "id": "lights",
  "version": 4,
  "name": "Lights",
  "description": "Estudio lights via the Turn On / Turn Off scenes",
  "control": "switch",               // button | switch | page | (later) slider, value
  "look": { "label": "Lights", "icon": "icon_light_on" },
  "calls": {                         // which calls a control type needs:
    "on":  { "use": "tuya.scene", "params": { "scene": "Turn On" } },
    "off": { "use": "tuya.scene", "params": { "scene": "Turn Off" } },
    "state": { "use": "tuya.switchState", "params": { "onScene": "Turn On" } }
  },
  "options": { "waitForReply": true, "defaultOn": false },
  "shortcut": { "mode": "toggle" }   // none | run | toggle (+ "off" call for buttons)
}
```

Which calls and options each control type takes:

| Control | Calls | Options | Shortcut modes |
|---|---|---|---|
| `button` | `run` | waitForReply, highlightActiveScene | none, run, toggle (needs an `off` call) |
| `switch` | `on`, `off`, `state` (optional) | waitForReply, defaultOn | none, toggle |
| `page` | `open` (a `panel.*` integration) | — | none |
| `slider` (later) | `set`, `read` | min, max, step | none |
| `value` (later) | `read` | unit, refresh | none |

The module creator shows only the fields that fit the chosen control type. Each call's parameters come from its integration's declaration, so the form uses real dropdowns and number fields instead of free JSON. An "Advanced" section keeps a raw extra-payload escape hatch for integrations that don't declare their parameters yet.

### 3.3 Config

```jsonc
{
  "id": "default",
  "version": 23,
  "name": "Default",
  "home": {
    "layout": "grid2",
    "items": [
      { "module": "lights" },
      { "module": "volume" },
      { "module": "weather" },
      { "inbox": true, "label": "Messages" },
      { "folder": { "id": "scenes", "label": "Scenes", "icon": "icon_scenes", "layout": "grid2", "items": [
          { "module": "scene-night" },
          { "module": "scene-high-night", "label": "Hi Night" }   // per-placement override
      ] } },
      { "folder": { "id": "settings", "label": "Settings", "items": [ { "module": "screen-dim" } /* … */ ] } }
    ]
  }
}
```

- A **placement** is `{ module, label?, icon? }`. It can override how the item looks but never what it does. To change behaviour, you edit the module or duplicate it.
- **Folders and the inbox stay in the config.** They are structure, not behaviour, so they don't become modules.
- **The panel item id** is the module id. If the same module is placed twice, the second copy gets a `-2` suffix at compile time. The shortcut setting on the device refers to these ids, so they must stay stable between sends.
- **`layout`** is only `grid2` until the firmware can draw other layouts (§7).

## 4. Compiling for the panel

`compile(config, modules) → panelConfig` lives in `src/configs/compile.js`. It is used by the builder preview, by `/configs/validate` and by `/configs/:id/send`.

| Module | Compiles to |
|---|---|
| `button` + `tuya.scene` | `{ type: "task", task: { payload: { taskId: <id>, tuyaScene }, qos: 1, expectsResult } }` |
| `button` with shortcut `toggle` | the same, plus `shortcut: { off: <emit of the off call> }` |
| `switch` | `{ type: "switch", switch: { payload: { taskId: <id> }, on: <emit>, off: <emit>, default, expectsResult } }` |
| `page` + `panel.X` | `{ type: "action", action: "X" }` |
| inbox placement | `{ type: "folder", binding: "message_inbox" }` |

The output is checked against `panel-config.schema.json`, so the firmware's contract has only one definition. Errors are mapped back to the module or placement that caused them, which keeps the "click an error to jump to the item" behaviour working.

**Versions.** A config refers to modules by id and always uses each module's current version. On every send, the Core records which version of each module went out, `{ lights: 4, … }`, next to the existing delivery number. The Devices page can then add a third "out of date" reason next to "config vN available": "module *Lights* changed since this was sent". This is simpler than pinning module versions in each config, and it shows the effect on devices, which is the one people care about.

## 5. Console UI

Navigation becomes **Devices · Modules · Configs**.

**Module creator** (`/modules/:id`):
- A form that adapts to the control type: control type, then each call (integration, then its parameters), then look, options and shortcut.
- A **single-tile preview** using the existing `Tile` component, with tap and toggle working.
- **Used in**: the configs that place this module, and the devices that currently run it.
- Actions: Save, Duplicate, Delete. Delete is blocked while any config uses the module.

**Config builder** (`/configs/:id`), same three panes as today:
- **Tree.** Folders, the inbox and module placements. "Add" opens a module picker (search, grouped by control type) instead of a type dropdown.
- **Properties.** For a placement: the label and icon overrides, the module's summary, and "Edit module →". For a folder: label, icon and layout.
- **Preview.** Unchanged; it renders the compiled config.
- **"New module…"** in the picker creates a module and places it in one step, so quick one-off items don't need a trip to the other screen.

## 6. Migration

A one-time migration runs on Core start when `data/modules/` doesn't exist yet:

1. Walk every stored config. Each non-folder item becomes a module with the item's id, look and behaviour, and its place in the tree becomes a placement. Folders and the inbox stay.
2. Items with the same behaviour and look across configs are merged into one module. If they conflict, both are kept with an id suffix and a warning is logged.
3. Each config is rewritten in the new shape, keeping its `version`. The old file is kept as `<id>.v1.json` for one release.
4. To verify, the new config compiles back to exactly the old panel config. The migration aborts if it doesn't.

## 7. Later: page layouts (needs firmware)

Layouts change how many tiles a page holds, so they need drawing code in `menu.cpp` (`drawGrid`) and the same change in the preview:

| Layout | Tiles per page | Note |
|---|---|---|
| `grid2` | 2 | today |
| `hero` | 1 | full-width tile, larger icon and label |
| `grid4` | 4 (2×2) | small icon, one-line label, no switch toggle |
| `list` | 3 rows | icon left, label, right-aligned value or toggle |

Each layout is added on both sides at once, along with the `layout` field in the panel schema and the firmware validator. To avoid drift, the layout constants move to a file shared by the firmware build and the console, the "shared layout file" already planned in `web-console/src/preview/layout.ts`.

## 8. Plan

| Phase | Scope | Done when |
|---|---|---|
| 1 | Integration declarations in extension manifests; `/catalog` returns them with resolved option lists | The builder's scene and task dropdowns come from declarations |
| 2 | Module storage and API (`/modules` CRUD, `/modules/:id/usage`), module schema, module creator with tile preview | Modules can be created and edited; nothing uses them yet |
| 3 | Config v2 shape, `compile.js`, migration, config builder places modules, per-module send record | The default config migrates, compiles to the identical panel config and sends; Devices page shows module changes |
| 4 | Layouts (§7), one at a time, firmware and console together | `hero` and `grid4` draw identically on the panel and in the preview |

## 9. Open questions

- **Panel-only items.** Settings pages like "Screen dimming" only open a page on the panel. Should they live under a separate built-in "Panel" group in the module library (read-only, always available) instead of each being its own editable module? *Leaning yes:* list them in the picker as built-ins and create nothing in storage.
- **Module parameters at placement time.** One "Tuya scene" module that takes its scene per placement, instead of one module per scene, would cut the number of modules but bring behaviour back into configs. *Leaning no* for now; Duplicate covers it.
- **Sharing beyond one Core.** Exporting and importing modules as JSON would be easy once they exist, but it's out of scope here.
