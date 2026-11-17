import { Router } from "express";
import { OrchestratorError } from "./orchestrator.js";

export function buildProvisioningRouter(orchestrator) {
  const router = Router();

  router.post("/sessions", (req, res) => {
    const { strategyId } = req.body ?? {};
    try {
      const session = orchestrator.beginSession(strategyId, req.identity.sub);
      res.status(201).json({
        sessionId: session.sessionId,
        strategyId: session.strategyId,
        expiresAt: new Date(session.expiresAt).toISOString(),
        clientInstructions: session.clientInstructions,
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post("/sessions/:id/payload", async (req, res) => {
    try {
      const result = await orchestrator.submitPayload(req.params.id, req.body);
      res.status(result.status === "success" ? 200 : 422).json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get("/sessions/:id", (req, res) => {
    const session = orchestrator.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "session not found" });
    res.json({
      sessionId: session.sessionId,
      strategyId: session.strategyId,
      status: session.status,
      deviceId: session.deviceId ?? null,
      // Included so a self-driving strategy's remote agent (e.g. the BLE
      // Gateway Agent) can fetch the full mqttConfigPayload/UUIDs by
      // sessionId over HTTP instead of needing them pushed over MQTT.
      clientInstructions: session.clientInstructions,
    });
  });

  router.delete("/sessions/:id", (req, res) => {
    orchestrator.cancelSession(req.params.id);
    res.status(204).end();
  });

  return router;
}

function handleError(res, err) {
  if (err instanceof OrchestratorError) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  res.status(500).json({ error: "internal error" });
}
