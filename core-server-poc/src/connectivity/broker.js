import { stateEngine } from "../state/stateEngine.js";

// Wire payload -> canonical CoreEvent (ch. 5, §5.3)
export function normalizeInbound(msg) {
  const body = JSON.parse(msg.payload.toString()); // { componentId, eventType, value }
  return { clientId: msg.clientId, ...body, timestamp: msg.receivedAt };
}

export function wireBroker(adapter, logger = console) {
  return {
    onDeviceMessage: (msg) => {
      try {
        stateEngine.upsert(normalizeInbound(msg));
      } catch (err) {
        logger.error(`[broker] failed to normalize inbound message on ${msg.topic}`, err.message);
      }
    },
    dispatchCommand: (cmd) =>
      adapter.sendOutbound({
        clientId: cmd.clientId,
        payload: Buffer.from(JSON.stringify(cmd)),
      }),
  };
}
