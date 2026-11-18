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
// POC: the "backend" here is a small demo table; a real deployment maps
// taskIds to actual integrations (here: Tuya scenes, ./tuya.js).
import { runTuyaScene, tuyaConfigured } from "./tuya.js";

const handlers = {
  "player-volume": (p) => ({
    status: "ok",
    message: `Volume set to ${p.level}`,
    level: p.level,
  }),
  "lights-on": (p) => ({ status: "ok", message: `Lights ${p.state ?? "on"}` }),
  // `switch` nodes send their new state as payload.state ("on" | "off").
  lights: (p) => ({ status: "ok", message: `Lights ${p.state}`, state: p.state }),
  "scene-movie": (p) => ({ status: "ok", message: `Scene "${p.name}" started` }),
};

export default {
  manifest: {
    id: "menu-tasks",
    version: "0.1.0",
    displayName: "Menu Tasks (demo backend)",
    permissions: { stateRead: true, commandDispatch: true },
    entryPoint: "src/extensions/menu-tasks/index.js",
  },

  async onEnable(ctx) {
    ctx.logger.log(`[menu-tasks] enabled — demo handlers: ${Object.keys(handlers).join(", ")}`);
    ctx.logger.log(
      `[menu-tasks] tuyaScene tasks: ${tuyaConfigured() ? "Tuya cloud configured" : "Tuya NOT configured (TUYA_ACCESS_ID/SECRET)"}`
    );
  },

  async onStateChanged(event, ctx) {
    if (event.eventType !== "task") return;
    const { taskId, expectsResult, payload = {} } = event.metadata ?? {};
    const requestId = event.value;
    ctx.logger.log(
      `[menu-tasks] ${event.clientId} ran "${taskId}" (${event.componentId}) ` +
        `${JSON.stringify(payload)}${expectsResult ? " — replying" : ""}`
    );
    if (!expectsResult) return;

    const handler = handlers[taskId];
    // `tuyaScene` tasks (the panel's Night / Day) run a Smart Life scene.
    const result = payload.tuyaScene
      ? await runTuyaScene(payload.tuyaScene, ctx.logger)
      : handler
        ? handler(payload)
        : { status: "error", message: `No handler for "${taskId}"` };

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
