import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Starts the Core server POC (which itself starts the dev MQTT broker) and
// the web provisioner's static HTTPS server together, so a fresh checkout
// can be exercised end-to-end with a single command. Both processes inherit
// stdio; their own log prefixes ([core]/[broker], [web-provisioner]) keep
// output distinguishable.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const core = spawn("npm", ["start"], { cwd: path.join(root, "core-server-poc"), stdio: "inherit" });
const web = spawn("npm", ["run", "serve"], { cwd: path.join(root, "web-provisioner"), stdio: "inherit" });

function shutdown() {
  core.kill("SIGINT");
  web.kill("SIGINT");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

for (const child of [core, web]) {
  child.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(`[dev-all] a child process exited with code ${code}, shutting down`);
      shutdown();
    }
  });
}
