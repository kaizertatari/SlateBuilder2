// Shared .env.local loader for smoke scripts. Vercel handles env vars in
// deployment; this is purely for `node scripts/*.mjs` runs.
//
// Usage:
//   import { loadEnvLocal } from "./_env.mjs";
//   loadEnvLocal();   // resolves repo root automatically
//
// Existing process.env values win (won't clobber CI / shell exports).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadEnvLocal(rootDir = REPO_ROOT) {
  const file = path.join(rootDir, ".env.local");
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}
