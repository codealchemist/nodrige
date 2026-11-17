// Echo Extension — permanent diagnostic extension proving the hook contract works.
// Not a stand-in for any future extension; it stays installed alongside them.
// See docs/00-poc-implementation-guide.md §0.5.
export default {
  manifest: {
    id: "echo",
    version: "0.1.0",
    displayName: "Echo Extension",
    permissions: { stateRead: true, commandDispatch: true },
    entryPoint: "src/extensions/echo/index.js",
  },

  async onEnable(ctx) {
    ctx.logger.log("[echo] enabled");
  },

  async onStateChanged(event, ctx) {
    await ctx.commands.dispatch({
      clientId: event.clientId,
      componentId: event.componentId,
      action: "echo",
      value: event.value,
      correlationId: `echo-${Date.now()}`,
    });
    ctx.logger.log(`[echo] ${event.clientId}/${event.componentId} = ${event.value} -> echoed`);
  },
};
