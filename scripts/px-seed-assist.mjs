// Seed-assist window for the PerimeterX slider regime (steady-state since
// 2026-08-02): opens a HEADED persistent context on .prizepicks-profile at
// app.prizepicks.com and waits for the operator to slide the "confirm you're
// human" slider ONCE. Critically, it NEVER reloads the page — a reload resets
// the slider mid-drag (2026-08-01 incident) — it only re-probes the
// projections API in-page every 5s and exits 0 the moment PX clears.
//
// Routine: Stop-ScheduledTask "Refresh Bridge" → delete .prizepicks-profile →
// node scripts/px-seed-assist.mjs → operator slides → headless
// `npm run refresh-prizepicks:guarded` → Start-ScheduledTask.
//
// Exit codes: 0 = PX cleared (probe 200), 1 = budget exhausted or the
// operator closed the window before clearing.

import path from "node:path";
import fssync from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_DIR = path.join(ROOT, ".prizepicks-profile");
const APP_URL = "https://app.prizepicks.com/";
const PROBE_URL = "https://api.prizepicks.com/projections?league_id=3&per_page=10&single_stat=true";
const BUDGET_MS = 15 * 60 * 1000;

// Same UA derivation as scrape-prizepicks-browser.mjs — a stale pinned major
// is a PX mismatch signal.
function detectChromeMajor() {
  const bases = [
    "C:\\Program Files\\Google\\Chrome\\Application",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application",
    path.join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application"),
  ];
  for (const base of bases) {
    try {
      const v = fssync.readdirSync(base).find((d) => /^\d+\.\d+\./.test(d));
      if (v) return v.split(".")[0];
    } catch {
      /* not installed here */
    }
  }
  return null;
}
const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${detectChromeMajor() ?? 150}.0.0.0 Safari/537.36`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raceTimeout = (promise, ms, fallback) =>
  Promise.race([promise, sleep(ms).then(() => fallback)]);

async function main() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("Playwright is not installed. Run: npm install && npx playwright install chromium");
  }

  const launchOpts = {
    headless: false,
    viewport: null,
    userAgent: UA,
    args: ["--disable-blink-features=AutomationControlled", "--start-maximized"],
    ignoreDefaultArgs: ["--enable-automation"],
  };
  let context;
  for (const channel of ["chrome", "msedge", null]) {
    try {
      context = await chromium.launchPersistentContext(PROFILE_DIR, channel ? { ...launchOpts, channel } : launchOpts);
      break;
    } catch {
      /* try next channel */
    }
  }
  if (!context) throw new Error("Could not launch a browser (chrome/msedge/bundled all failed)");

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    window.chrome = window.chrome || { runtime: {} };
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  console.log("Seed-assist window open. If a slider captcha is shown, slide it now.");
  console.log("This script will NOT reload the page; it probes the API every 5s.");

  const deadline = Date.now() + BUDGET_MS;
  while (Date.now() < deadline) {
    if (page.isClosed()) {
      console.error("Window was closed before PerimeterX cleared.");
      await context.close().catch(() => {});
      process.exit(1);
    }
    const status = await raceTimeout(
      page
        .evaluate(async (u) => {
          try {
            const r = await fetch(u, { headers: { Accept: "application/json" } });
            return r.status;
          } catch {
            return 0;
          }
        }, PROBE_URL)
        .catch(() => 0),
      15000,
      0,
    );
    if (status === 200) {
      console.log("PerimeterX cleared (probe 200). Closing window — run the guarded refresh now.");
      await context.close().catch(() => {});
      process.exit(0);
    }
    console.log(`  probe ${status} — waiting for the slide (${Math.round((deadline - Date.now()) / 1000)}s left)`);
    await sleep(5000);
  }
  console.error("Budget exhausted without a 200 probe — PX did not clear.");
  await context.close().catch(() => {});
  process.exit(1);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
