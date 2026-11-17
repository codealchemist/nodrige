import { stateBus } from "../state/stateEngine.js";

// Minimal, in-process only. No permission enforcement, no timeouts,
// no circuit breaker — hardened later per docs/10-concurrency-strategy.md.
export function loadExtension(extension, ctx) {
  extension.onEnable?.(ctx);

  if (extension.onStateChanged) {
    stateBus.on("state.changed", (event) => {
      Promise.resolve(extension.onStateChanged(event, ctx)).catch((err) => {
        ctx.logger.error(`[${extension.manifest.id}] onStateChanged error`, err);
      });
    });
  }

  ctx.logger.log(`[loader] extension "${extension.manifest.id}" loaded`);
}
