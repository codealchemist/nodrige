// Panel config validation for the Core and the web console: the JSON Schema
// (shape and per-type fields) plus the checks a schema can't express (ids
// unique across the whole tree). The device still validates on arrival and
// reports the outcome; this catches mistakes before anything is sent.
import fs from "node:fs";
import Ajv from "ajv";

export const schema = JSON.parse(fs.readFileSync(new URL("./panel-config.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const check = ajv.compile(schema);

// [] when valid; else readable messages with a JSON path, e.g.
// "/menu/2/task: must have required property 'payload'".
export function validateConfig(config) {
  const errors = [];
  if (!check(config)) {
    for (const e of check.errors) {
      // if/then noise: only report the concrete failure.
      if (e.keyword === "if") continue;
      errors.push(`${e.instancePath || "/"}: ${e.message}${e.params?.allowedValues ? ` (${e.params.allowedValues.join(", ")})` : ""}`);
    }
  }
  const seen = new Map();
  const walk = (nodes, at) =>
    (nodes ?? []).forEach((n, i) => {
      const p = `${at}/${i}`;
      if (n?.id) {
        if (seen.has(n.id)) errors.push(`${p}/id: duplicate id "${n.id}" (also at ${seen.get(n.id)})`);
        else seen.set(n.id, p);
      }
      if (Array.isArray(n?.children)) walk(n.children, `${p}/children`);
    });
  walk(config?.menu, "/menu");
  return [...new Set(errors)];
}
