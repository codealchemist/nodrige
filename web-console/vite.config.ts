import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json" with { type: "json" };

// In dev, the Core (https://localhost:7000, self-signed) serves the API and
// the /mqtt WebSocket bridge; proxy them so the app has one origin. The
// production build is served by the Core itself at /console/.
const core = process.env.CORE_URL || "https://localhost:7000";
const api = { target: core, changeOrigin: true, secure: false };

export default defineConfig({
  base: "/console/",
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [react()],
  server: {
    proxy: {
      "/devices": api,
      "/configs": api,
      "/catalog": api,
      "/spotify": api,
      "/integrations": api,
      "/logs": api,
      "/console/session": api,
      "/mqtt": { ...api, ws: true },
    },
  },
});
