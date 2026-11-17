// DOM wiring only — all actual logic lives in app.js/protocol.js/ble.js/qrScan.js.
import { runProvisioningFlow } from "./app.js";
import { createCoreClient } from "./coreClient.js";
import {
  isBarcodeDetectorSupported,
  startCamera,
  stopCamera,
  scanQrFromVideo,
  listCameras,
  getZoomCapability,
  setZoom,
} from "./qrScan.js";
import { parseQrPayload } from "./protocol.js";
import { loadSavedCreds, saveCreds, clearSavedCreds } from "./wifiCredsStore.js";

const $ = (id) => document.getElementById(id);
const logEl = $("log");
const qrStatusEl = $("qrStatus");
const cameraSelectEl = $("cameraSelect");
const zoomSliderEl = $("zoomSlider");
const wizardViewEl = $("wizardView");
const focusViewEl = $("focusView");
const focusHeadingEl = $("focusHeading");
const focusSpinnerEl = $("focusSpinner");
const focusResultIconEl = $("focusResultIcon");
const focusMessageEl = $("focusMessage");
const focusResetBtn = $("focusResetBtn");

let currentQrJson = null;
let currentQrDeviceName = null;
let cameraStream = null;
let scanAbortController = null;
let selectedCameraId = null;
let provisioningInFlight = false;

// Accessed via a LAN IP (e.g. from a phone) rather than localhost: the Core
// almost certainly runs on the same machine this page was served from, just
// on a different port, so default to that instead of a useless "localhost"
// (which on the phone means the phone itself).
const isLocalHost = ["localhost", "127.0.0.1"].includes(location.hostname);
if (!isLocalHost) {
  $("coreUrl").value = `https://${location.hostname}:7000`;
}

// Web Bluetooth and camera access both require a secure context. localhost
// gets this for free; a LAN IP over plain HTTP does not, and Chrome fails
// those APIs silently rather than with an obvious error — so surface this
// up front instead of letting the user hit a confusing failure later.
const insecureWarningShown = !window.isSecureContext;
if (insecureWarningShown) {
  $("coreUrlHint").innerHTML =
    `<span class="warn"><svg class="icon" aria-hidden="true"><use href="#icon-alert-triangle"></use></svg> ` +
    `Not a secure context (${location.origin}) — camera scan and Bluetooth will fail here. On this device, go to ` +
    `<code>chrome://flags/#unsafely-treat-insecure-origin-as-secure</code>, add <code>${location.origin}</code>, ` +
    `and restart Chrome. See README.md "Running on a phone".</span>`;
  setStepCollapsed("Settings", false); // safety-critical warning must stay visible, not tucked away
}

// ---- icons ----

const LOG_KIND_ICON = {
  ok: "check-circle",
  warn: "alert-triangle",
  error: "x-circle",
  core: "server",
  ble: "bluetooth",
  wifi: "wifi",
};

function iconEl(name, extraClass = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", `icon ${extraClass}`.trim());
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#icon-${name}`);
  svg.appendChild(use);
  return svg;
}

function setBadgeIcon(step, iconName) {
  const badge = $(`step${step}Badge`);
  badge.textContent = "";
  badge.appendChild(iconName ? iconEl(iconName) : document.createTextNode(String(step)));
}

// ---- log ----

function log(message, kind = "") {
  const line = document.createElement("div");
  line.className = `log-line${kind ? ` ${kind}` : ""}`;
  const iconName = LOG_KIND_ICON[kind];
  if (iconName) line.appendChild(iconEl(iconName));
  const text = document.createElement("span");
  text.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  line.appendChild(text);
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  console.log(message);
}

// ---- QR status ----

function setStatus(el, kind, message) {
  el.textContent = "";
  el.className = `qr-status${kind ? ` ${kind}` : ""}`;
  const iconName = LOG_KIND_ICON[kind];
  if (iconName) el.appendChild(iconEl(iconName));
  el.appendChild(document.createTextNode(message));
}

function setQr(raw, source) {
  try {
    const { name } = parseQrPayload(raw);
    currentQrJson = raw;
    currentQrDeviceName = name;
    setStatus(qrStatusEl, "ok", `QR ready (${source}) — device "${name}".`);
    scanAbortController?.abort(); // stop a still-running camera scan before committing to this QR
    setStepCollapsed(2, true);
    enterFocusView();
    runProvisioning();
  } catch (err) {
    currentQrJson = null;
    currentQrDeviceName = null;
    setStatus(qrStatusEl, "error", `Invalid QR: ${err.message}`);
    markInteractedAndRefresh();
  }
}

// ---- step accordion ----
// The blue "is-active" border is a strict order indicator, not a focus
// indicator: Wi-Fi is active until its fields are filled, then it collapses
// and Scan becomes active (and clickable) in its place. Step 2 (QR) has no
// other "smart" accordion behavior: it's disabled until Wi-Fi creds are
// filled, and its header IS the scan action — click to expand-and-scan,
// click again to stop-and-collapse. See the QR scanning section below.
// Settings is a standalone disclosure, see further below.

let userInteracted = false;
let lastFocusTarget = null;
let wifiConfirmed = false; // set on blur, not every keystroke — collapsing mid-type would yank the field out from under the user
const manuallyOpened = new Set();

function stepComplete(n) {
  if (n === 1) return !!$("wifiSsid").value.trim();
  if (n === 2) return !!currentQrJson;
  return false;
}

function setStepCollapsed(n, collapsed) {
  const section = $(`step${n}`);
  section.classList.toggle("is-collapsed", collapsed);
  $(`step${n}HeaderBtn`).setAttribute("aria-expanded", String(!collapsed));
  $(`step${n}Body`).toggleAttribute("inert", collapsed);
}

function updateStepSummaries() {
  $("step1Summary").textContent = stepComplete(1) ? `"${$("wifiSsid").value.trim()}"` : "";
  $("step2Summary").textContent = stepComplete(2)
    ? `device "${currentQrDeviceName}"`
    : stepComplete(1)
      ? ""
      : "Fill in Wi-Fi credentials above first";
}

function refreshStepStates() {
  updateStepSummaries();
  for (const n of [1, 2]) {
    const complete = stepComplete(n);
    $(`step${n}`).classList.toggle("is-complete", complete);
    setBadgeIcon(n, complete ? "check-circle" : null);
  }
  const wifiDone = stepComplete(1);
  const wifiStepDone = wifiDone && wifiConfirmed;
  $("step2HeaderBtn").disabled = !wifiDone;
  if (!userInteracted) return;
  $("step1").classList.toggle("is-active", !wifiStepDone);
  setStepCollapsed(1, wifiStepDone && !manuallyOpened.has(1));
  const step2Expanded = !$("step2").classList.contains("is-collapsed");
  $("step2").classList.toggle("is-active", wifiStepDone && !stepComplete(2));
  const focusTarget = step2Expanded ? null : wifiStepDone ? "step2HeaderBtn" : wifiDone ? null : "wifiSsid";
  const editingWifiField = document.activeElement === $("wifiSsid") || document.activeElement === $("wifiPassword");
  if (focusTarget && focusTarget !== lastFocusTarget && !editingWifiField) {
    $(focusTarget)?.focus();
  }
  lastFocusTarget = focusTarget;
}

function markInteractedAndRefresh() {
  userInteracted = true;
  refreshStepStates();
}

$("step1HeaderBtn").addEventListener("click", () => {
  userInteracted = true;
  const opening = $("step1").classList.contains("is-collapsed");
  if (opening) manuallyOpened.add(1);
  else manuallyOpened.delete(1);
  setStepCollapsed(1, !opening);
});

$("stepSettingsHeaderBtn").addEventListener("click", () => {
  const opening = $("stepSettings").classList.contains("is-collapsed");
  setStepCollapsed("Settings", !opening);
});

function persistWifiCreds() {
  const ssid = $("wifiSsid").value;
  if (ssid) saveCreds(ssid, $("wifiPassword").value);
  else clearSavedCreds();
}
function confirmWifiStep() {
  wifiConfirmed = stepComplete(1);
  markInteractedAndRefresh();
}
$("wifiSsid").addEventListener("change", persistWifiCreds);
$("wifiPassword").addEventListener("change", persistWifiCreds);
$("wifiSsid").addEventListener("change", confirmWifiStep);
$("wifiPassword").addEventListener("change", confirmWifiStep);
$("wifiSsid").addEventListener("input", markInteractedAndRefresh);
$("wifiPassword").addEventListener("input", markInteractedAndRefresh);

refreshStepStates(); // populate badges/summaries for any prefilled defaults, without collapsing anything

async function initWifiCreds() {
  const saved = await loadSavedCreds();
  if (saved) {
    $("wifiSsid").value = saved.ssid;
    $("wifiPassword").value = saved.password;
    userInteracted = true; // returning user: skip the "keep everything open" first-load grace period
    wifiConfirmed = true; // data was already filled in — no need to wait for a blur to collapse it
  }
  refreshStepStates();
}
initWifiCreds();

// ---- QR scanning ----
// The step 2 header doubles as the scan action: clicking it while collapsed
// expands the section and starts the camera; clicking it again while
// expanded stops the scan and collapses it back down. See setStepCollapsed
// calls below and the step2HeaderBtn listener at the end of this section.

let stopRequested = false;

// Device labels are only populated once permission has been granted, so this
// runs after the first successful getUserMedia rather than on page load.
async function populateCameraSelect() {
  const cameras = await listCameras();
  if (cameras.length < 2) {
    cameraSelectEl.hidden = true;
    return;
  }
  cameraSelectEl.innerHTML = "";
  cameras.forEach((camera, i) => {
    const option = document.createElement("option");
    option.value = camera.deviceId;
    option.textContent = camera.label || `Camera ${i + 1}`;
    cameraSelectEl.appendChild(option);
  });
  const activeId = cameraStream?.getVideoTracks()[0]?.getSettings().deviceId;
  if (activeId) cameraSelectEl.value = activeId;
  cameraSelectEl.hidden = false;
}

function setupZoomSlider() {
  const zoomCap = getZoomCapability(cameraStream);
  if (!zoomCap) {
    zoomSliderEl.hidden = true;
    return;
  }
  zoomSliderEl.min = zoomCap.min;
  zoomSliderEl.max = zoomCap.max;
  zoomSliderEl.step = zoomCap.step;
  zoomSliderEl.value = zoomCap.current;
  zoomSliderEl.hidden = false;
}

async function beginScan() {
  stopRequested = false;
  try {
    if (!isBarcodeDetectorSupported()) {
      setStatus(qrStatusEl, "error", "BarcodeDetector is not supported in this browser — use the manual paste option below.");
      return;
    }
    setStatus(qrStatusEl, "", "Requesting camera access…");
    cameraStream = await startCamera($("video"), { deviceId: selectedCameraId });
    if (stopRequested) throw new DOMException("scan aborted", "AbortError");
    $("video").hidden = false;
    $("zoomLabel").hidden = false;
    $("cameraHint").hidden = false;
    scanAbortController = new AbortController();
    setStatus(qrStatusEl, "", "Scanning...");
    await populateCameraSelect();
    setupZoomSlider();

    const raw = await scanQrFromVideo($("video"), { signal: scanAbortController.signal });
    setQr(raw, "camera");
  } catch (err) {
    if (err.name !== "AbortError") {
      setStatus(qrStatusEl, "error", `Scan failed: ${err.message}`);
    } else {
      setStatus(qrStatusEl, "", "No QR scanned yet.");
    }
  } finally {
    stopCamera(cameraStream);
    $("video").hidden = true;
    $("zoomLabel").hidden = true;
    $("cameraHint").hidden = true;
    cameraSelectEl.hidden = true;
    zoomSliderEl.hidden = true;
  }
}

$("step2HeaderBtn").addEventListener("click", async () => {
  const collapsed = $("step2").classList.contains("is-collapsed");
  if (collapsed) {
    setStepCollapsed(2, false);
    refreshStepStates();
    await beginScan();
    refreshStepStates();
  } else {
    stopRequested = true;
    scanAbortController?.abort();
    setStepCollapsed(2, true);
    refreshStepStates();
  }
});

$("cameraSelect").addEventListener("change", async () => {
  selectedCameraId = cameraSelectEl.value;
  if (!cameraStream) return;
  stopCamera(cameraStream);
  cameraStream = await startCamera($("video"), { deviceId: selectedCameraId });
  setupZoomSlider();
});

$("zoomSlider").addEventListener("input", () => {
  setZoom(cameraStream, Number(zoomSliderEl.value));
});

$("useQrPasteBtn").addEventListener("click", () => {
  setQr($("qrPaste").value.trim(), "pasted");
});

// ---- focus view + provisioning ----

function enterFocusView() {
  wizardViewEl.hidden = true;
  focusViewEl.hidden = false;
  focusSpinnerEl.hidden = false;
  focusResultIconEl.textContent = "";
  focusMessageEl.textContent = "Provisioning…";
  focusResetBtn.hidden = true;
  logEl.textContent = "";
  focusHeadingEl.focus();
}

function exitFocusView() {
  focusViewEl.hidden = true;
  wizardViewEl.hidden = false;
  currentQrJson = null;
  currentQrDeviceName = null;
  setStatus(qrStatusEl, "", "No QR scanned yet.");
  lastFocusTarget = null; // forces refreshStepStates() to re-focus the scan step even though its target didn't change
  refreshStepStates();
}

function showFocusResult(kind, message) {
  focusSpinnerEl.hidden = true;
  focusResultIconEl.textContent = "";
  focusResultIconEl.appendChild(iconEl(kind === "ok" ? "check-circle" : "x-circle", `focus-result-icon ${kind}`));
  focusMessageEl.textContent = message;
  focusResetBtn.textContent = kind === "ok" ? "Provision another device" : "Try again";
  focusResetBtn.hidden = false;
}

async function runProvisioning() {
  if (provisioningInFlight) return;
  provisioningInFlight = true;
  const coreClient = createCoreClient({
    baseUrl: $("coreUrl").value.replace(/\/$/, ""),
    bearerToken: $("bearerToken").value,
  });

  try {
    const result = await runProvisioningFlow({
      qrJson: currentQrJson,
      wifiSsid: $("wifiSsid").value,
      wifiPassword: $("wifiPassword").value,
      coreClient,
      log,
    });
    log(`Provisioning succeeded — deviceId ${result.deviceId}`, "ok");
    showFocusResult("ok", `Provisioned — deviceId ${result.deviceId}`);
  } catch (err) {
    log(`Provisioning failed: ${err.message}`, "error");
    showFocusResult("error", `Provisioning failed: ${err.message}`);
  } finally {
    provisioningInFlight = false;
  }
}

focusResetBtn.addEventListener("click", exitFocusView);
