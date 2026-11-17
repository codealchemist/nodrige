import { randomUUID } from "node:crypto";

const SESSION_TTL_MS = 5 * 60 * 1000;

export class OrchestratorError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Strategy-agnostic orchestrator: routes/session-store logic never branches
// on strategyId. See docs/04-device-provisioning.md §4.2.
//
// `ctx` (state/commands, same shapes extensions get — ch.7 §7.4) is threaded
// through to strategies that drive provisioning themselves rather than
// waiting on an external HTTP submitPayload call — see the ble-gateway
// strategy, which dispatches a command to a BLE Gateway Agent and resolves
// the session internally once the agent reports back over MQTT.
export function createProvisioningOrchestrator(strategies, ctx = {}) {
  const sessions = new Map();

  function resolveSession(sessionId, result) {
    const session = sessions.get(sessionId);
    if (!session || session.status !== "pending") return session ?? null;

    if (result.status === "success") {
      session.status = "success";
      session.deviceId = result.deviceId;
      session.deviceCredential = result.deviceCredential;
    } else {
      session.status = "failed";
      session.error = result.error;
    }
    return session;
  }

  function beginSession(strategyId, actorUserId) {
    const strategy = strategies[strategyId];
    if (!strategy) {
      throw new OrchestratorError(400, `unknown strategyId "${strategyId}"`);
    }

    const sessionId = randomUUID();
    const session = {
      sessionId,
      strategyId,
      status: "pending",
      actorUserId,
      clientInstructions: strategy.buildClientInstructions({ sessionId, actorUserId }),
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    sessions.set(sessionId, session);

    // Self-driving strategies (ble-gateway) kick off their work now that the
    // session is durably stored and safe to resolve into from an async callback.
    strategy.onSessionStarted?.(session, {
      ...ctx,
      resolveSession: (result) => resolveSession(sessionId, result),
    });

    return session;
  }

  async function submitPayload(sessionId, payload) {
    const session = sessions.get(sessionId);
    if (!session) throw new OrchestratorError(404, "session not found");
    if (session.status !== "pending") {
      throw new OrchestratorError(409, `session already ${session.status}`);
    }
    if (Date.now() > session.expiresAt) {
      session.status = "failed";
      throw new OrchestratorError(410, "session expired");
    }

    const strategy = strategies[session.strategyId];
    const result = await strategy.handlePayload(payload, session);
    resolveSession(sessionId, result);
    return result;
  }

  function getSession(sessionId) {
    return sessions.get(sessionId) ?? null;
  }

  function cancelSession(sessionId) {
    const session = sessions.get(sessionId);
    if (session) session.status = "failed";
  }

  return { beginSession, submitPayload, getSession, cancelSession };
}
