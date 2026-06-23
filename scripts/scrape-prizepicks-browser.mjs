// Browser-backed PrizePicks scrape — defeats the PerimeterX (HUMAN) bot
// management that fronts api.prizepicks.com as of 2026-06. Plain fetch (and
// headless Chrome WITHOUT fingerprint hardening) gets a 403 challenge body
// (appId "PXZNeitfzP"); a real browser context that runs PX's JS earns a
// cleared _px3 cookie on .prizepicks.com, after which the public projections
// API returns 200 to an in-page fetch.
//
// Reuses the .prizepicks-profile persistent context + automation-tell
// stripping from fetch-prizepicks-entries.mjs. The decisive bit for HEADLESS
// is the addInitScript fingerprint patch (navigator.webdriver undefined, etc.)
// — verified: headless passes PX with it, 403s without it. So this runs
// headless by default (service/cron friendly); --headed is only for debugging
// or re-seeding the profile if PX ever hard-blocks.
//
// IMPORTANT: residential/home IP only — PrizePicks 403s cloud IPs regardless.
//
// Usage:
//   node scripts/scrape-prizepicks-browser.mjs            (headless)
//   node scripts/scrape-prizepicks-browser.mjs --headed   (debug / re-seed)

import path from "node:path";
import fssync from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scrapePrizePicksForToday } from "./scrape-prizepicks.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_DIR = path.join(ROOT, ".prizepicks-profile");
const APP_URL = "https://app.prizepicks.com/";
// A real Chrome UA — headless Chrome's default UA carries a "HeadlessChrome"
// token that PX flags; override it to the stable desktop string.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launchContext(headed) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("Playwright is not installed. Run: npm install && npx playwright install chromium");
  }

  const launchOpts = {
    headless: !headed,
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

  // Fingerprint hardening, applied before any page script runs. This is what
  // lets PerimeterX clear in headless — see file header.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    window.chrome = window.chrome || { runtime: {} };
  });
  return context;
}

// Returns a fetchJson(url) -> parsed JSON | null backed by an in-page fetch, so
// every request carries the page's cleared _px3 cookie + real TLS/JS
// fingerprint. Retries past the transient 403 (PX challenge) / 429 (rate) PP
// serves before/around clearance.
function makeFetchJson(page) {
  return async function fetchJson(url) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await page.evaluate(async (u) => {
        try {
          const res = await fetch(u, { headers: { Accept: "application/json" } });
          return { status: res.status, text: await res.text() };
        } catch (e) {
          return { status: 0, text: "", error: String(e) };
        }
      }, url);
      if (r.status === 200) {
        try {
          return JSON.parse(r.text);
        } catch {
          return null;
        }
      }
      console.error(`  PP browser fetch HTTP ${r.status}${r.error ? ` (${r.error})` : ""} (attempt ${attempt + 1}/4) ${url.slice(0, 80)}`);
      await sleep(3000); // let PX finish clearing / rate-limit cool
    }
    return null;
  };
}

// opts: { headed?, write?, outputPath?, leagues? } — write/outputPath/leagues
// pass straight through to scrapePrizePicksForToday.
export async function scrapePrizePicksViaBrowser(opts = {}) {
  const { headed = false, ...rest } = opts;
  if (!fssync.existsSync(PROFILE_DIR)) {
    console.warn("  No .prizepicks-profile yet — if PerimeterX hard-blocks, run once with --headed to seed clearance.");
  }
  const context = await launchContext(headed);
  const page = context.pages()[0] || (await context.newPage());
  try {
    // Load the app so PerimeterX's JS executes and sets a cleared _px3 cookie
    // on .prizepicks.com (shared with the api. subdomain). The top-level doc
    // itself may return 403 — that's fine; clearance lands a few seconds later
    // and the in-page API fetch (makeFetchJson) retries past it.
    await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await sleep(8000);
    return await scrapePrizePicksForToday({ ...rest, fetchJson: makeFetchJson(page) });
  } finally {
    await context.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const headed = process.argv.includes("--headed");
  scrapePrizePicksViaBrowser({ headed, write: false })
    .then((r) => {
      console.log(`\nDone: ${r.total_props} props for ${r.total_players} players`);
      for (const [league, stats] of Object.entries(r.leagues ?? {})) {
        console.log(`  ${league}: ${stats.total_props ?? 0} props${stats.error ? ` (error: ${stats.error})` : ""}`);
      }
    })
    .catch((e) => {
      console.error("Fatal:", e.message);
      process.exit(1);
    });
}
