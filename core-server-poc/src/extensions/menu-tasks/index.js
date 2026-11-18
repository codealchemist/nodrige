// Menu Tasks Extension — the server side of a device's config-driven menu
// tasks (esp32-c6-control docs/ARCHITECTURE.md §6.3).
//
// A device publishes each task invocation to its `messages` topic as a
// CoreEvent:
//   { componentId: <menu node id>, eventType: "task", value: <requestId>,
//     metadata: { taskId, expectsResult, payload: { taskId, ...params, requestId } } }
// Switch nodes use the same shape; their payload adds `state: "on" | "off"`
// plus the config's per-state object (e.g. a `tuyaScene` for each state).
// `value` is the requestId so every invocation is a State Engine *change*
// (a repeated "Lights On" would otherwise be swallowed as a heartbeat).
//
// For tasks with expectsResult, this replies with a command on the device's
// `cmd` topic, matched by requestId:
//   { action: "task_result", correlationId: <requestId>,
//     result: { status: "ok" | "error", message, ... } }
//
// Integrations: Tuya scenes for `tuyaScene` tasks (./tuya.js), the computer's
// volume for "player-volume" (./computerVolume.js). Tasks run whether or not
// they expect a result; only the reply depends on expectsResult.
import fs from "node:fs";

import { getComputerVolume, setComputerVolume } from "./computerVolume.js";
import { activeScenes, runTuyaScene, switchStateFromScene, tuyaConfigured } from "./tuya.js";

// Tells a panel which Tuya scenes are active right now, so it can highlight
// those scene tiles (it asks when a page with scene tiles opens):
//   { action: "scene_state", active: ["night mode", ...] }
// (lowercase scene names, matched against each tile's tuyaScene).
async function sendSceneState(ctx, clientIds, active) {
  for (const clientId of clientIds) {
    await ctx.commands.dispatch({
      clientId,
      componentId: "scene-state",
      action: "scene_state",
      value: active.join(","),
      active,
    });
  }
}

// The Core's own package version, for the panel's device details page.
const CORE_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "unknown";
  }
})();

// Handlers by taskId; each returns a task result ({ status, message, ... }).
const handlers = {
  // A panel switch's current state (on boot / screen wake), read from the
  // lights its "on" scene acts on: { state: "on" | "off" }.
  "switch-state": async (p, ctx) =>
    p.onScene
      ? switchStateFromScene(p.onScene, ctx?.logger)
      : { status: "error", message: "switch-state needs onScene" },
  // The panel's device details page asks who it is talking to.
  "core-info": async () => ({
    status: "ok",
    message: `Core v${CORE_VERSION}`,
    version: CORE_VERSION,
    uptimeSec: Math.round(process.uptime()),
  }),
  // The computer's volume (panel Volume page, "Computer" target). With a
  // `level` it sets it; without, it just reports it. Either way the reply
  // carries the real level.
  "player-volume": async (p) => {
    try {
      const v = p.level === undefined ? await getComputerVolume() : await setComputerVolume(p.level);
      return {
        status: "ok",
        message: `Volume ${v.level}${v.muted ? " (muted)" : ""}`,
        level: v.level,
        muted: v.muted,
      };
    } catch (err) {
      return { status: "error", message: err.message };
    }
  },
};

export default {
  manifest: {
    id: "menu-tasks",
    version: "0.1.0",
    displayName: "Menu Tasks",
    permissions: { stateRead: true, commandDispatch: true },
    entryPoint: "src/extensions/menu-tasks/index.js",
  },

  async onEnable(ctx) {
    ctx.logger.log(`[menu-tasks] enabled — handlers: ${Object.keys(handlers).join(", ")}`);
    ctx.logger.log(
      `[menu-tasks] tuyaScene tasks: ${tuyaConfigured() ? "Tuya cloud configured" : "Tuya NOT configured (TUYA_ACCESS_ID/SECRET)"}`
    );
  },

  async onStateChanged(event, ctx) {
    if (event.eventType !== "task") return;
    const { taskId, expectsResult, payload = {} } = event.metadata ?? {};
    const requestId = event.value;

    // A panel opened a page with scene tiles: tell it which are active.
    if (taskId === "scene-state") {
      await sendSceneState(ctx, [event.clientId], await activeScenes(ctx.logger));
      return;
    }

    ctx.logger.log(
      `[menu-tasks] ${event.clientId} ran "${taskId}" (${event.componentId}) ` +
        `${JSON.stringify(payload)}${expectsResult ? " — replying" : ""}`
    );

    const handler = handlers[taskId];
    // `tuyaScene` tasks (Night, Day, the Lights switch) run a Smart Life scene.
    const result = payload.tuyaScene
      ? await runTuyaScene(payload.tuyaScene, ctx.logger)
      : handler
        ? await handler(payload, ctx)
        : { status: "error", message: `No handler for "${taskId}"` };
    if (!expectsResult) {
      if (result.status !== "ok") ctx.logger.log(`[menu-tasks] "${taskId}" failed: ${result.message}`);
      return;
    }

    await ctx.commands.dispatch({
      clientId: event.clientId,
      componentId: event.componentId,
      action: "task_result",
      value: result.status,
      correlationId: requestId,
      result,
    });
    ctx.logger.log(`[menu-tasks] -> ${event.clientId} task_result ${requestId}: ${result.message}`);
  },
};
