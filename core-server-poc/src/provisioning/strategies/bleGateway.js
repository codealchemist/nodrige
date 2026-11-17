import { mintDeviceIdentity } from "./bleProtocol.js";

const GATEWAY_CLIENT_ID = process.env.GATEWAY_CLIENT_ID || "ble-gateway-01";
const GATEWAY_TIMEOUT_MS = 60_000; // time to find + fully provision one device

// Server-driven variant: no human operates a companion app. Instead, a BLE
// Gateway Agent — a small local process with a physical BLE radio, connected
// to the Core over the ordinary Connectivity Broker like any other client
// (see ../../../../ble-gateway-agent/) — does the discovery and drives the
// handshake in docs/PROVISIONING_PROTOCOL_V2.md on the Core's behalf. The
// Core still never touches BLE itself (ch.1 principle P5) — it only commands
// a client that does, the same way it commands any device.
//
// Implements the ProvisioningStrategy shape from docs/04-device-provisioning.md §4.2.
export const bleGatewayStrategy = {
  id: "ble-gateway",

  buildClientInstructions({ sessionId }) {
    // No app-facing BLE instructions here — the gateway agent fetches these
    // itself via GET /provisioning/sessions/:id once it's commanded (below).
    // Returned mainly so GET /provisioning/sessions/:id has something to show
    // an operator watching the session, e.g. in a debug UI.
    return { ...mintDeviceIdentity(), gatewayClientId: GATEWAY_CLIENT_ID, sessionId };
  },

  // Fires once the session is durably stored. Commands the gateway agent to
  // start, then listens on the State Engine for its report — this is what
  // lets the session resolve without any external HTTP submitPayload call.
  onSessionStarted(session, ctx) {
    const { state, commands, logger = console, resolveSession } = ctx;
    const { sessionId } = session;

    const unsubscribe = state.subscribe(
      { clientId: GATEWAY_CLIENT_ID, componentId: "ble-gateway", eventType: "provisioning_result" },
      (event) => {
        if (event.value !== sessionId) return; // another session's report

        clearTimeout(timer);
        unsubscribe();

        const { deviceId, mqttConfigPayload } = session.clientInstructions;
        if (event.metadata?.outcome === "success") {
          resolveSession({ status: "success", deviceId, deviceCredential: mqttConfigPayload.password });
        } else {
          resolveSession({
            status: "failed",
            error: {
              code: event.metadata?.reason ?? "gateway_failed",
              message: `gateway agent "${GATEWAY_CLIENT_ID}" reported failure`,
            },
          });
        }
      }
    );

    const timer = setTimeout(() => {
      unsubscribe();
      resolveSession({
        status: "failed",
        error: {
          code: "gateway_timeout",
          message: `no report from gateway agent "${GATEWAY_CLIENT_ID}" within ${GATEWAY_TIMEOUT_MS}ms — is it connected and provisioned as a client itself?`,
        },
      });
    }, GATEWAY_TIMEOUT_MS);

    // A small scalar pointer, not the full payload (CoreCommand.value is
    // scalar-only, ch.5 §5.4) — the gateway agent fetches clientInstructions
    // itself via GET /provisioning/sessions/:id using this sessionId.
    commands
      .dispatch({ clientId: GATEWAY_CLIENT_ID, componentId: "ble-gateway", action: "provision", value: sessionId })
      .catch((err) => {
        clearTimeout(timer);
        unsubscribe();
        logger.error(`[ble-gateway] failed to dispatch command to ${GATEWAY_CLIENT_ID}`, err);
        resolveSession({ status: "failed", error: { code: "dispatch_failed", message: err.message } });
      });
  },

  // Not used on the happy path — the gateway agent's report resolves the
  // session directly via onSessionStarted's listener. Kept as a manual
  // override/debug escape hatch (e.g. an operator force-completing a stuck
  // session by hand), matching the same shape as bleWifi.js's handlePayload.
  async handlePayload(payload, session) {
    const { status, reason } = payload ?? {};
    const { deviceId, mqttConfigPayload } = session.clientInstructions;

    if (status !== "connected") {
      return {
        status: "failed",
        error: { code: reason ?? "unknown", message: `manual override: ${status ?? "unknown"}` },
      };
    }
    return { status: "success", deviceId, deviceCredential: mqttConfigPayload.password };
  },
};
