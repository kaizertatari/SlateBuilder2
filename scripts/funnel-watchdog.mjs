// Funnel watchdog — detects and self-heals the Tailscale "funnel zombie"
// (CLAUDE.local.md runbook: `tailscale funnel status` shows on, bridge
// service healthy, but Vercel gets "Home bridge unreachable: fetch failed";
// twice on 2026-06-12, can be PARTIAL — only some ingress paths dead).
//
// Probes from the vantage that matters: the deployed function itself, via
// POST /api/refresh-lines?ping=1, which fetches the bridge's /health
// through the funnel without scraping. On a bridge-unreachable verdict it
// runs the documented fix (funnel reset + re-establish), waits out the
// ~3 min ingress propagation, and re-probes.
//
// Reset only fires on the zombie signature (deployed function says
// bridge_reachable:false / bridge unreachable). Auth failures, rate
// limits, or this machine failing to reach Vercel at all are logged and
// exit 1 WITHOUT a reset — a funnel reset can't fix those, and resetting
// on every blip would churn ingress state for nothing.
//
// Scheduled via Windows Task "Funnel Watchdog" (funnel-watchdog-task.bat,
// every 15 min) → logs/funnel-watchdog.log. Manual: npm run funnel-watchdog

import { execSync } from "node:child_process";
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();

const PING_URL = process.env.WATCHDOG_PING_URL || "https://slate-builder.vercel.app/api/refresh-lines?ping=1";
const TOKEN = (process.env.REFRESH_TOKEN || "").trim();
const BRIDGE_PORT = Number(process.env.HOME_BRIDGE_PORT ?? 4000);
const PROPAGATION_MS = 3 * 60_000;

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

// → { verdict: "ok" | "zombie" | "other", detail }
async function probe() {
  let res;
  try {
    res = await fetch(PING_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    // Couldn't reach Vercel from here — local network problem, not the funnel.
    return { verdict: "other", detail: `Vercel unreachable from this machine: ${err.message}` };
  }
  const body = await res.json().catch(() => ({}));
  if (body.bridge_reachable === true) {
    return { verdict: "ok", detail: `bridge_status=${body.bridge_status}` };
  }
  if (body.bridge_reachable === false || /bridge unreachable/i.test(body.error ?? "")) {
    return { verdict: "zombie", detail: body.error ?? `HTTP ${res.status}` };
  }
  return { verdict: "other", detail: `HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}` };
}

const first = await probe();
if (first.verdict === "ok") {
  log(`OK — funnel path healthy (${first.detail})`);
  process.exit(0);
}
if (first.verdict === "other") {
  log(`NO-RESET — probe failed for a non-funnel reason: ${first.detail}`);
  process.exit(1);
}

log(`ZOMBIE — ${first.detail}; resetting funnel`);
try {
  execSync("tailscale funnel reset", { stdio: "pipe" });
  execSync(`tailscale funnel --bg http://127.0.0.1:${BRIDGE_PORT}`, { stdio: "pipe" });
  log("funnel reset + re-established; waiting out ingress propagation");
} catch (err) {
  log(`RESET FAILED — ${String(err.message).slice(0, 200)}`);
  process.exit(1);
}

await new Promise((r) => setTimeout(r, PROPAGATION_MS));
const second = await probe();
if (second.verdict === "ok") {
  log(`RECOVERED — funnel path healthy after reset (${second.detail})`);
  process.exit(0);
}
log(`STILL DOWN after reset — ${second.detail}; manual investigation needed (see funnel-zombie runbook)`);
process.exit(1);
