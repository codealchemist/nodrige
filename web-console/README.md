# web-console

A web console for the nodrige Core: devices with live status, a library of
panel configs with a visual builder and a live device preview, and sending a
config to a device.

Built with Vite, React and TypeScript.

## Run it

The Core must be running (`cd ../core-server-poc && npm start`).

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173/console/ and sign in with the Core's token
(`DEV_BEARER_TOKEN` in `core-server-poc/.env`). In dev, Vite forwards the API
and the `/mqtt` WebSocket to the Core, so the browser never deals with the
Core's self-signed certificate.

For the Core to serve the console itself at `https://<core>:7000/console/`:

```bash
npm run build
```

## How it talks to the Core

| What | How |
|---|---|
| Devices, config library, catalog, sending configs | Core HTTP API with the bearer token |
| Live presence and config results | MQTT over WebSocket at `/mqtt` (the Core pipes it to the broker), read-only `console` login |

Presence comes from each panel's retained `devices/<id>/status` message:
`online` with its IP, firmware build and config version, or the broker's
last-will `offline`. Configs in the library are stored without a version; the
Core assigns one more than the device's current version when sending.

## Config builder

Open a config to edit it in three panes:

- **Tree:** the menu, in panel order. Add tasks, switches, folders and local
  actions; move items up/down, into the folder above (→) or out of their
  folder (←); delete. Items with errors are shown in red.
- **Properties:** label, ID, icon (from the firmware's built-in icons, or the
  built-in symbol), and per type: task ID, Tuya scene (from your Smart Life
  account), extra payload, wait-for-reply, shortcut-button behaviour; switch
  on/off scenes; local action; messages inbox.
- **Preview:** the panel's menu at its real 320 × 172 size (scaled up), using
  the firmware's layout numbers (`src/preview/layout.ts`, copied from
  `esp32-c6-control/poc/src/menu.cpp`). Drag sideways to swipe pages, tap
  tiles: folders open, switches toggle, tasks show the spinner and ✓ and
  light up as the active scene. Untick **Online** to see remote tiles dimmed.
  Selecting an item in the tree turns the preview to it, and tapping a tile
  selects it in the tree.

The **JSON** tab edits the same config as text. Every change is checked
against the Core's schema; click an error to jump to its item. **Save** bumps
the config's version when its content changed; **Send** saves first if
needed.
