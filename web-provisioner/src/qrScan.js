// QR scanning via the browser's native BarcodeDetector (Chrome desktop +
// Android support "qr_code"). Deliberately no bundled third-party QR
// decoding library — keeps this app dependency-free. Where BarcodeDetector
// isn't available, app.js falls back to a manual paste-JSON input.

export function isBarcodeDetectorSupported() {
  return "BarcodeDetector" in window;
}

export async function listCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === "videoinput");
}

// Without a deviceId, "environment" is ambiguous on multi-lens phones — it
// often binds to the ultra-wide lens, which has a fixed/poor macro focus and
// can't resolve a small QR code up close. Passing a deviceId (from
// listCameras(), once the user has picked the main lens) avoids that.
export async function startCamera(videoElement, { deviceId } = {}) {
  const video = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "environment" };
  const stream = await navigator.mediaDevices.getUserMedia({ video });
  videoElement.srcObject = stream;
  await videoElement.play();
  await applyContinuousFocus(stream);
  return stream;
}

export function stopCamera(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

// focusMode/zoom are non-standard MediaTrackConstraints Chrome exposes on
// Android only — capabilities() returns {} (or the property is absent)
// everywhere else, so this is a silent no-op on desktop/iOS.
async function applyContinuousFocus(stream) {
  const track = stream.getVideoTracks()[0];
  const caps = track?.getCapabilities?.();
  if (!caps?.focusMode?.includes("continuous")) return;
  try {
    await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
  } catch {
    // some devices advertise the capability but reject the constraint — ignore
  }
}

// Returns null where optical/digital zoom control isn't exposed (most
// desktop/iOS cameras). Zooming in on a tiny QR code both helps autofocus
// lock and gives BarcodeDetector more pixels to decode.
export function getZoomCapability(stream) {
  const track = stream?.getVideoTracks()[0];
  const caps = track?.getCapabilities?.();
  if (!caps?.zoom) return null;
  return {
    min: caps.zoom.min,
    max: caps.zoom.max,
    step: caps.zoom.step ?? 0.1,
    current: track.getSettings().zoom ?? caps.zoom.min,
  };
}

export async function setZoom(stream, value) {
  const track = stream?.getVideoTracks()[0];
  await track?.applyConstraints({ advanced: [{ zoom: value }] });
}

// Resolves with the raw decoded string once a QR code is found in the video
// stream. Pass an AbortSignal to cancel (e.g. user clicks "stop scanning").
export async function scanQrFromVideo(videoElement, { signal } = {}) {
  if (!isBarcodeDetectorSupported()) {
    throw new Error("BarcodeDetector is not supported in this browser — use the manual paste option instead.");
  }
  const supportedFormats = await window.BarcodeDetector.getSupportedFormats();
  if (!supportedFormats.includes("qr_code")) {
    throw new Error("This browser's BarcodeDetector does not support QR codes.");
  }
  const detector = new window.BarcodeDetector({ formats: ["qr_code"] });

  return new Promise((resolve, reject) => {
    let stopped = false;
    signal?.addEventListener("abort", () => {
      stopped = true;
      reject(new DOMException("scan aborted", "AbortError"));
    });

    async function tick() {
      if (stopped) return;
      try {
        const barcodes = await detector.detect(videoElement);
        if (barcodes.length > 0) {
          stopped = true;
          resolve(barcodes[0].rawValue);
          return;
        }
      } catch (err) {
        stopped = true;
        reject(err);
        return;
      }
      requestAnimationFrame(tick);
    }
    tick();
  });
}
