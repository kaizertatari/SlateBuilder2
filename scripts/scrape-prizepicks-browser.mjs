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

// A light API probe: 200 means PerimeterX has cleared this session. A non-200
// (403 challenge) or a thrown fetch (status 0 — CORS/"Failed to fetch" because
// the app page is a PX block, not the real app) means not yet cleared.
const PROBE_URL = "https://api.prizepicks.com/projections?league_id=3&per_page=10&single_stat=true";
async function probePxStatus(page) {
  return page.evaluate(async (u) => {
    try {
      const r = await fetch(u, { headers: { Accept: "application/json" } });
      return r.status;
    } catch {
      return 0;
    }
  }, PROBE_URL);
}

// Load the app and wait for PerimeterX to issue a cleared _px3, CONFIRMED by a
// 200 API probe. PX frequently challenges the first load (403) or serves a
// block page (in-page fetch → "Failed to fetch"); a reload once _pxvid is set
// usually clears it. A single goto + fixed wait is therefore unreliable —
// observed ~50/50 — so we reload and re-probe until 200 or the budget runs out.
// Returns false on budget exhaustion; caller proceeds and the 0-prop scrape
// trips the refuse-write guard rather than clobbering the blob.
async function ensurePxCleared(page, budgetMs = 60000) {
  const deadline = Date.now() + budgetMs;
  let cycle = 0;
  while (Date.now() < deadline) {
    await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    for (let probe = 0; probe < 4 && Date.now() < deadline; probe++) {
      await sleep(3000); // give PX's sensor JS time to run after (re)load
      if ((await probePxStatus(page)) === 200) {
        if (cycle > 0 || probe > 0) console.log(`  PerimeterX cleared (reload ${cycle}, probe ${probe + 1})`);
        return true;
      }
    }
    cycle++;
  }
  return false;
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
    // Earn a cleared _px3 on .prizepicks.com (shared with the api. subdomain)
    // BEFORE scraping — verified by a 200 probe, with reloads. Without this the
    // run is a coin flip: when PX doesn't clear on the first load, every league
    // fetch returns 403 / "Failed to fetch" and the scrape yields 0 props.
    if (!(await ensurePxCleared(page))) {
      console.warn("  PerimeterX did not clear within budget — scrape will likely return 0 props. Re-seed with --headed if this persists.");
    }
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
