import { spawn } from "node:child_process";

// Starts the dev MQTT broker and the Core server together, so a fresh
// checkout works with a single command. Pass --watch to also watch src/
// for changes. Both processes inherit stdio, so their own [broker]/[core]
// log prefixes (not added here) keep output distinguishable.
const watch = process.argv.includes("--watch");

const broker = spawn("node", ["scripts/dev-broker.js"], { stdio: "inherit" });
const server = spawn("node", watch ? ["--watch", "src/index.js"] : ["src/index.js"], {
  stdio: "inherit",
});

function shutdown() {
  server.kill("SIGINT");
  broker.kill("SIGINT");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

for (const child of [broker, server]) {
  child.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(`[dev-all] a child process exited with code ${code}, shutting down`);
      shutdown();
    }
  });
}
