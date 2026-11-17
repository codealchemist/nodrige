import 'dotenv/config'
import express from 'express'
import https from 'node:https'
import fs from 'node:fs'
import { ensureDevCert, lanAddresses } from './devCert.js'
import { requireAuth } from './identity/verifyToken.js'
import { createMqttAdapter } from './connectivity/adapters/mqttAdapter.js'
import { wireBroker } from './connectivity/broker.js'
import { stateEngine } from './state/stateEngine.js'
import { loadExtension } from './extensions/loader.js'
import echoExtension from './extensions/echo/index.js'
import { createProvisioningOrchestrator } from './provisioning/orchestrator.js'
import { bleWifiStrategy } from './provisioning/strategies/bleWifi.js'
import { bleGatewayStrategy } from './provisioning/strategies/bleGateway.js'
import { buildProvisioningRouter } from './provisioning/routes.js'

const app = express()
app.use(express.json())

// Dev-only CORS: web-provisioner runs on a different origin (a static file
// server, see web-provisioner/scripts/serve.mjs) than the Core's API, and
// browsers block cross-origin fetch without this. Scoped to POC use — a real
// deployment would restrict CORS_ORIGIN rather than defaulting to "*".
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// Unauthenticated (ch.0 §0.7 acceptance checklist)
app.get('/health', (req, res) => res.json({ status: 'ok' }))

app.use(requireAuth)

// --- Connectivity & Command Broker (ch.5) ---
let broker
const mqttAdapter = createMqttAdapter({
  url: process.env.MQTT_URL,
  onInbound: msg => broker.onDeviceMessage(msg)
})
broker = wireBroker(mqttAdapter)

// --- Dynamic Extension Engine (ch.7) ---
// Echo is a permanent diagnostic extension, not a POC-only stand-in — it
// stays installed alongside any future extension (e.g. Google Home, ch.8).
loadExtension(echoExtension, {
  state: stateEngine,
  commands: { dispatch: broker.dispatchCommand },
  logger: console
})

// --- Device Setup & Provisioning Orchestrator (ch.4) ---
// ctx mirrors what extensions get (ch.7 §7.4) — self-driving strategies like
// ble-gateway use it to command a remote agent and listen for its report.
const orchestrator = createProvisioningOrchestrator(
  {
    'ble-wifi': bleWifiStrategy,
    'ble-gateway': bleGatewayStrategy
  },
  {
    state: stateEngine,
    commands: { dispatch: broker.dispatchCommand },
    logger: console
  }
)
app.use('/provisioning', buildProvisioningRouter(orchestrator))

// --- Debug-only state inspection (POC only — remove post-POC) ---
app.get('/debug/state/:clientId', (req, res) => {
  res.json(stateEngine.getAllForClient(req.params.clientId))
})

const port = process.env.PORT || 7000

// HTTPS, not plain HTTP: web-provisioner is served over HTTPS (needed for
// Web Bluetooth/camera off localhost — see its README), and a browser
// blocks fetch() calls from an HTTPS page to a plain-HTTP API as mixed
// content. Self-signed, generated on demand — see src/devCert.js.
const { keyPath, certPath } = ensureDevCert()
const tlsOptions = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }

// Explicit host so this is reachable from another device on the same
// network (e.g. a phone running web-provisioner) — not just localhost.
https.createServer(tlsOptions, app).listen(port, '0.0.0.0', () => {
  console.log(`[core] listening on :${port}`)
  for (const ip of lanAddresses()) {
    console.log(`[core]   also reachable at https://${ip}:${port} from other devices on this network`)
  }
})
