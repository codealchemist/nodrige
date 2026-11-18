# web-console

A web console for the nodrige Core: devices with live status, a library of
panel configs, and sending a config to a device. The visual config builder
with a live device preview comes next.

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
