import 'dotenv/config'
import { installCoreLog } from './console/coreLog.js'
import { loadIntegrationSettings } from './settings/integrations.js'
import { buildIntegrationsRouter } from './settings/routes.js'
import express from 'express'
import https from 'node:https'
import fs from 'node:fs'
import { ensureDevCert, lanAddresses } from './devCert.js'
import { requireAuth, tokenProblem } from './identity/verifyToken.js'
import { createMqttAdapter } from './connectivity/adapters/mqttAdapter.js'
import { wireBroker } from './connectivity/broker.js'
import { stateEngine } from './state/stateEngine.js'
import { loadExtension } from './extensions/loader.js'
import echoExtension from './extensions/echo/index.js'
import menuTasksExtension from './extensions/menu-tasks/index.js'
import weatherExtension from './extensions/weather/index.js'
import spotifyExtension, { spotifyPublicRouter, spotifyRouter } from './extensions/spotify/index.js'
import { createProvisioningOrchestrator } from './provisioning/orchestrator.js'
import { bleWifiStrategy } from './provisioning/strategies/bleWifi.js'
import { bleGatewayStrategy } from './provisioning/strategies/bleGateway.js'
import { buildProvisioningRouter } from './provisioning/routes.js'
import { buildDeviceConfigRouter } from './devices/configRoutes.js'
import path from 'node:path'
import { createDeviceRegistry } from './devices/registry.js'
import { createConfigLibrary } from './configs/library.js'
import { buildConsoleRouter, iconRouter } from './console/routes.js'
import { attachMqttBridge } from './console/mqttBridge.js'
import { tuyaSceneNames } from './extensions/menu-tasks/tuya.js'

// Keep the Core's log for the console's Logs page (still printed as before).
installCoreLog()
if (tokenProblem()) {
  console.error(`[core] ${tokenProblem()}: every API request will be refused. Set your own in .env, e.g. DEV_BEARER_TOKEN=$(openssl rand -hex 24)`)
}
for (const k of ['CORE_MQTT_PASSWORD', 'CONSOLE_MQTT_PASSWORD']) {
  if (!process.env[k]) console.error(`[core] ${k} is not set in .env: the broker will refuse that login`)
}

// Integration ids and secrets saved from the console override .env.
const savedSettings = loadIntegrationSettings()
if (savedSettings) console.log(`[core] ${savedSettings} integration setting(s) from the console`)

const app = express()
app.use(express.json())

// Dev-only CORS: web-provisioner runs on a different origin (a static file
// server, see web-provisioner/scripts/serve.mjs) than the Core's API, and
// browsers block cross-origin fetch without this. Scoped to POC use — a real
// deployment would restrict CORS_ORIGIN rather than defaulting to "*".
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// Unauthenticated (ch.0 §0.7 acceptance checklist)
app.get('/health', (req, res) => res.json({ status: 'ok' }))

// Web console (nodrige/web-console): the built app and the icon artwork are
// public; its API calls below need the bearer token like everything else.
app.use('/console', express.static(path.resolve('../web-console/dist')))
app.get('/console/*', (req, res, next) =>
  req.path.startsWith('/console/session') ? next() : res.sendFile(path.resolve('../web-console/dist/index.html'), err => err && next()))
app.use(iconRouter())
app.use(spotifyPublicRouter())  // Spotify's sign-in redirect lands here

app.use(requireAuth)

// --- Connectivity & Command Broker (ch.5) ---
let broker
let deviceConfig
const registry = createDeviceRegistry()
const mqttAdapter = createMqttAdapter({
  url: process.env.MQTT_URL,
  onInbound: msg => {
    registry.onMessage(msg.clientId)
    broker.onDeviceMessage(msg)
  },
  onResult: msg => deviceConfig.onResult(msg),
  onStatus: msg => registry.onStatus(msg.clientId, msg.payload),
  onTelemetry: msg => registry.onTelemetry(msg.clientId, msg.payload)
})
broker = wireBroker(mqttAdapter)
deviceConfig = buildDeviceConfigRouter(mqttAdapter, console, (id, body) => registry.onConfigResult(id, body))

// --- Dynamic Extension Engine (ch.7) ---
// Echo is a permanent diagnostic extension, not a POC-only stand-in — it
// stays installed alongside any future extension (e.g. Google Home, ch.8).
const extensionCtx = {
  state: stateEngine,
  commands: { dispatch: broker.dispatchCommand },
  logger: console
}
loadExtension(echoExtension, extensionCtx)
// Demo backend for the device menu's tasks (esp32-c6-control ARCHITECTURE.md §6.3).
loadExtension(menuTasksExtension, extensionCtx)
loadExtension(weatherExtension, extensionCtx)
loadExtension(spotifyExtension, extensionCtx)
app.use(spotifyRouter())
app.use(buildIntegrationsRouter())

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

// --- Web console API: devices, config library, catalog ---
const library = createConfigLibrary()
if (library.list().length === 0) {
  // First run: seed the library with the firmware's default menu.
  try {
    const firmwareDir = path.resolve(process.env.FIRMWARE_DIR || '../../esp32-c6-control/poc')
    const def = JSON.parse(fs.readFileSync(path.join(firmwareDir, 'data/config/default_config.json'), 'utf8'))
    library.create({ name: 'Default', description: 'The firmware default menu', config: def })
  } catch {}
}
app.use(buildConsoleRouter({
  registry,
  library,
  publishConfig: (id, doc) => deviceConfig.push(id, doc),
  dispatch: cmd => broker.dispatchCommand(cmd),
  sceneNames: tuyaSceneNames,
  consoleMqtt: { path: '/mqtt', username: 'console', password: process.env.CONSOLE_MQTT_PASSWORD }
}))

// --- Device config push (esp32-c6-control docs/ARCHITECTURE.md §5.3) ---
app.use('/devices', deviceConfig.router)

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
const server = https.createServer(tlsOptions, app)
attachMqttBridge(server, { mqttUrl: process.env.MQTT_URL })
server.listen(port, '0.0.0.0', () => {
  console.log(`[core] listening on :${port}`)
  for (const ip of lanAddresses()) {
    console.log(`[core]   also reachable at https://${ip}:${port} from other devices on this network`)
  }
})
