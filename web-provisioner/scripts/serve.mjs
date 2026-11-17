// Static file server for local dev, over HTTPS with a self-signed cert.
// Bound to all interfaces so it's reachable from another device on the same
// network (e.g. a phone). HTTPS (not plain HTTP) is what makes that work for
// Web Bluetooth/camera: a LAN IP is not a secure context over plain HTTP the
// way localhost is, but any HTTPS origin qualifies once the browser trusts
// the cert — see README.md "Running on a phone" for that one-time step.
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDevCert, lanAddresses } from "./devCert.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT) || 8080;
const host = "0.0.0.0";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const { keyPath, certPath } = ensureDevCert();
const tlsOptions = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };

https
  .createServer(tlsOptions, (req, res) => {
    const urlPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
    const filePath = path.join(root, decodeURIComponent(urlPath));

    if (!filePath.startsWith(root)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
      res.end(data);
    });
  })
  .listen(port, host, () => {
    console.log(`[web-provisioner] serving ${root}`);
    console.log(`[web-provisioner]   https://localhost:${port}  (this machine)`);
    for (const ip of lanAddresses()) {
      console.log(`[web-provisioner]   https://${ip}:${port}  (same network, e.g. a phone)`);
    }
    console.log(`[web-provisioner] self-signed cert — every browser/device visiting for the first time`);
    console.log(`[web-provisioner] will see a warning; click through it once. See README.md "Running on a phone".`);
  });
