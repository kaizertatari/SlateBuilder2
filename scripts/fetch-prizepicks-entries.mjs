// Fetch MY PrizePicks account bet history (past entries) and write a JSON
// snapshot to data/prizepicks-entries.json.
//
// This is fundamentally different from scripts/scrape-prizepicks.mjs, which
// hits the PUBLIC, unauthenticated projections API. Entry history requires
// being logged in, and PrizePicks:
//   - has NO documented API for entries (the endpoint is undocumented), and
//   - guards login with Cloudflare + bot detection + captcha/2FA.
//
// So instead of scripting username/password login, we drive a real (headed)
// browser via Playwright and let the operator log in by hand. To get past the
// bot challenge we launch SYSTEM Chrome/Edge (not the bundled Chromium) with
// the automation flags stripped (navigator.webdriver undefined), backed by a
// persistent profile dir so the login sticks. The script then passively
// captures the entries XHR/fetch the web app makes (auto-detecting the
// undocumented endpoint), follows JSON:API pagination to pull the full
// history, normalizes it, and writes the snapshot.
//
// IMPORTANT: run this from the residential/home machine only. PrizePicks
// 403s cloud IPs — same constraint as refresh-prizepicks. Never run from CI
// or a deployed function.
//
// Usage:
//   npm run fetch-entries
//   node scripts/fetch-prizepicks-entries.mjs --since 2026-01-01 --limit 200
//   node scripts/fetch-prizepicks-entries.mjs --headless    (reuse saved profile)
//   node scripts/fetch-prizepicks-entries.mjs --from-raw     (re-normalize the
//       last raw dump without re-opening the browser — for tweaking mappings)
//
// One-time setup:
//   npm install && npx playwright install chromium
//
// Env (optional, .env.local):
//   ENTRIES_URL_PATTERN — regex (case-insensitive) used to recognize the
//                         entries endpoint. Default: "entries". Override if
//                         your account uses a different route (the script
//                         logs every JSON XHR URL so you can find it).

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnvLocal } from "./_env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_DIR = path.join(ROOT, ".prizepicks-profile");
const OUTPUT = path.join(ROOT, "data/prizepicks-entries.json");
const RAW_DUMP = path.join(ROOT, "tmp/prizepicks-entries-raw.json");
const APP_URL = "https://app.prizepicks.com/";

// How many pages to auto-follow via links.next before bailing (safety net).
const MAX_PAGES = 200;

// ─── CLI args ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { headless: false, since: null, limit: Infinity, fromRaw: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--headless") args.headless = true;
    else if (a === "--from-raw") args.fromRaw = true;
    else if (a === "--since") args.since = argv[++i] ?? null;
    else if (a === "--limit") args.limit = Number(argv[++i]) || Infinity;
  }
  return args;
}

// ─── Small helpers ────────────────────────────────────────────────────────────

// Return the first defined value among the given keys (case-sensitive).
function pick(obj, ...keys) {
  if (!obj) return undefined;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

function toNum(v) {
  if (v === undefined || v === null) return null;
  const n = Number(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// PrizePicks wager.result enum → settled buckets. partial_win (Flex play that
// missed a leg but still paid) and cashed_out both count as a win.
function normWagerResult(raw) {
  const s = String(raw ?? "").toLowerCase();
  if (s === "won" || s === "partial_win" || s === "cashed_out") return "won";
  if (s === "lost") return "lost";
  if (s === "refunded") return "push";
  return "open"; // pending / unknown
}

// PrizePicks prediction.result enum → per-leg outcome.
function normLegResult(raw) {
  const s = String(raw ?? "").toLowerCase();
  if (s === "correct") return "win";
  if (s === "incorrect") return "loss";
  if (s === "tie") return "push";
  if (s === "dnp" || s === "reboot") return "void";
  return "open"; // pending / unknown
}

function centsToDollars(cents) {
  const n = Number(cents);
  return Number.isFinite(n) ? Math.round(n) / 100 : null;
}

function normPick(raw) {
  const s = String(raw ?? "").toLowerCase();
  if (s.includes("over") || s === "more" || s === "higher") return "over";
  if (s.includes("under") || s === "less" || s === "lower") return "under";
  return s || null;
}

function waitForEnter(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

// Strip HTTP/2 pseudo-headers and hop-by-hop headers so the captured request
// headers can be safely replayed via context.request. The browser context
// already carries cookies, so we drop cookie/host/content-length too.
function cleanHeaders(headers) {
  const out = {};
  const drop = new Set(["host", "content-length", "cookie", "accept-encoding", "connection"]);
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.startsWith(":")) continue;
    if (drop.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

// ─── Normalization (DEFENSIVE — verify against tmp/prizepicks-entries-raw.json) ─
//
// The entries payload is undocumented. We support two shapes:
//   A) JSON:API   — { data: [entries], included: [legs, players, ...] }
//   B) plain      — { entries: [...] } or a bare array, legs nested per entry
// Field names below are best-effort with fallbacks; once you've seen the real
// raw dump, tighten the pick(...) key lists to match.

// Flatten every page body into a flat list of wager resources + a JSON:API
// `included` lookup (keyed "type:id") for resolving relationships.
function collectEntries(bodies) {
  const included = {};
  const entryItems = [];
  for (const body of bodies) {
    if (!body || typeof body !== "object") continue;
    for (const it of body.included || []) {
      if (it?.type && it?.id != null) included[`${it.type}:${it.id}`] = it;
    }
    const data = Array.isArray(body) ? body : body.data ?? body.entries ?? body.results ?? null;
    if (Array.isArray(data)) {
      for (const d of data) {
        // Top-level entries are `new_wager` resources; keep anything that
        // looks like a wager/entry or carries the predictions relationship.
        if (/wager|entr/i.test(d?.type ?? "") || d?.relationships?.predictions) entryItems.push(d);
      }
    }
  }
  return { included, entryItems };
}

// Resolve a relationship pointer (or array of them) to included resources.
function resolveRel(rel, included) {
  const data = rel?.data;
  if (!data) return [];
  const arr = Array.isArray(data) ? data : [data];
  return arr.map((ref) => included[`${ref.type}:${ref.id}`]).filter(Boolean);
}

// Normalize one leg from a `prediction` resource: player from new_player,
// stat/line/opponent from the related projection, actual value from the
// related score. Field names verified against tmp/prizepicks-entries-raw.json.
function normalizeLeg(pred, included) {
  const a = pred?.attributes ?? {};
  const rels = pred?.relationships ?? {};
  const player = resolveRel(rels.new_player, included)[0]?.attributes ?? {};
  const projection = resolveRel(rels.projection, included)[0]?.attributes ?? {};
  const score = resolveRel(rels.score, included)[0]?.attributes ?? {};
  return {
    player: pick(player, "display_name", "name") ?? null,
    team: pick(player, "team", "team_name") ?? null,
    opponent: pick(projection, "description") ?? null,
    stat_type: pick(projection, "stat_display_name", "stat_type") ?? null,
    odds_type: pick(a, "odds_type") ?? pick(projection, "odds_type") ?? null, // standard | demon | goblin
    line: toNum(pick(a, "line_score")),
    pick: normPick(pick(a, "wager_type")),
    actual: toNum(pick(score, "score")),
    result: normLegResult(pick(a, "effective_result", "result")),
    start_time: pick(projection, "start_time") ?? null,
  };
}

// Normalize one `new_wager` entry. Money is in cents; PrizePicks has no
// "power/flex" field directly — pick_protection (partial-payout protection)
// distinguishes Flex from Power.
function normalizeEntry(item, included) {
  const a = item?.attributes ?? {};
  const id = item?.id ?? pick(a, "uuid") ?? null;
  const legs = resolveRel(item?.relationships?.predictions, included).map((p) => normalizeLeg(p, included));

  const wager = centsToDollars(a.amount_bet_cents);
  const won = centsToDollars(a.amount_won_cents);
  const potential = centsToDollars(a.amount_to_win_cents);
  const status = normWagerResult(a.result);
  return {
    id,
    created_at: pick(a, "created_at") ?? null,
    settled_at: status === "open" ? null : pick(a, "updated_at") ?? null,
    type: a.pick_protection ? "flex" : "power", // best-effort
    game_mode: pick(a, "game_mode") ?? null,
    status,
    status_raw: pick(a, "result") ?? null,
    wager,
    payout: won,
    potential_payout: potential,
    multiplier: wager && potential ? Math.round((potential / wager) * 100) / 100 : null,
    legs,
  };
}

function buildSummary(entries) {
  const record = { won: 0, lost: 0, push: 0, open: 0 };
  let wagered = 0; // settled stake only
  let payout = 0; // settled winnings only
  let openStake = 0;
  let from = null;
  let to = null;
  for (const e of entries) {
    record[e.status] = (record[e.status] ?? 0) + 1;
    if (e.status === "open") {
      if (e.wager) openStake += e.wager;
    } else {
      if (e.wager) wagered += e.wager;
      if (e.payout) payout += e.payout;
    }
    const t = e.created_at ? Date.parse(e.created_at) : NaN;
    if (Number.isFinite(t)) {
      if (from === null || t < from) from = t;
      if (to === null || t > to) to = t;
    }
  }
  const round = (n) => Math.round(n * 100) / 100;
  return {
    total_entries: entries.length,
    date_range: {
      from: from ? new Date(from).toISOString() : null,
      to: to ? new Date(to).toISOString() : null,
    },
    record,
    total_wagered: round(wagered),
    total_payout: round(payout),
    net: round(payout - wagered),
    open_stake: round(openStake),
  };
}

// ─── Pagination (best-effort, JSON:API links.next) ───────────────────────────

async function followNextLinks(context, bodies, headers) {
  const fetched = new Set(bodies.map((b) => b?.links?.self).filter(Boolean));
  const frontier = [];
  for (const b of bodies) {
    const next = b?.links?.next ?? b?.meta?.next;
    if (next && !fetched.has(next)) frontier.push(next);
  }
  let added = 0;
  while (frontier.length && added < MAX_PAGES) {
    const url = frontier.shift();
    if (fetched.has(url)) continue;
    fetched.add(url);
    let body;
    try {
      const resp = await context.request.get(url, { headers });
      body = await resp.json();
    } catch (err) {
      console.warn(`  ! pagination fetch failed for ${url.slice(0, 80)}: ${err.message}`);
      continue;
    }
    bodies.push(body);
    added++;
    const next = body?.links?.next ?? body?.meta?.next;
    if (next && !fetched.has(next)) frontier.push(next);
  }
  if (added) console.log(`  Followed ${added} additional page(s) via links.next`);
  return added;
}

// Normalize captured page bodies → snapshot, apply --since/--limit, write
// OUTPUT, and print the summary. Shared by the live capture and --from-raw.
async function finalize(bodies, args) {
  const { included, entryItems } = collectEntries(bodies);
  const byId = new Map();
  for (const item of entryItems) {
    const e = normalizeEntry(item, included);
    if (e.id != null) byId.set(e.id, e);
    else byId.set(`__noid_${byId.size}`, e);
  }
  let entries = [...byId.values()];

  // Optional --since filter.
  if (args.since) {
    const sinceMs = Date.parse(args.since);
    if (Number.isFinite(sinceMs)) {
      entries = entries.filter((e) => {
        const t = e.created_at ? Date.parse(e.created_at) : NaN;
        return !Number.isFinite(t) || t >= sinceMs;
      });
    }
  }

  // Newest first, then apply --limit.
  entries.sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0));
  if (Number.isFinite(args.limit)) entries = entries.slice(0, args.limit);

  const result = { fetched_at: new Date().toISOString(), summary: buildSummary(entries), entries };
  await fs.writeFile(OUTPUT, JSON.stringify(result, null, 2) + "\n");

  const s = result.summary;
  console.log(`\n  Wrote ${entries.length} entries → ${path.relative(ROOT, OUTPUT)}`);
  console.log(
    `  Record (settled): ${s.record.won}W-${s.record.lost}L-${s.record.push}P | ${s.record.open} open | ` +
      `wagered $${s.total_wagered} | won $${s.total_payout} | net $${s.net}`,
  );
  if (s.date_range.from) console.log(`  Range: ${s.date_range.from.slice(0, 10)} → ${s.date_range.to.slice(0, 10)}`);
  if (entries.some((e) => e.legs.length === 0 || e.legs.some((l) => !l.player))) {
    console.log(
      "\n  NOTE: some legs are missing player/fields — the entries schema is\n" +
        `  undocumented. Inspect ${path.relative(ROOT, RAW_DUMP)} and tighten the\n` +
        "  field mappings in normalizeEntry/normalizeLeg if needed.",
    );
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  loadEnvLocal();
  const args = parseArgs(process.argv.slice(2));
  const entriesPattern = new RegExp(process.env.ENTRIES_URL_PATTERN || "entries", "i");

  // Re-normalize from the saved raw dump without re-launching the browser —
  // fast loop for tightening field mappings against real captured data.
  if (args.fromRaw) {
    const bodies = JSON.parse(await fs.readFile(RAW_DUMP, "utf8"));
    console.log(`=== fetch-prizepicks-entries (--from-raw) ===\n  Loaded ${bodies.length} page(s) from ${path.relative(ROOT, RAW_DUMP)}`);
    await finalize(bodies, args);
    return;
  }

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error(
      "Playwright is not installed.\n" +
        "Run:  npm install && npx playwright install chromium\n" +
        "then re-run:  npm run fetch-entries",
    );
    process.exit(1);
  }

  const profileExists = fssync.existsSync(PROFILE_DIR);
  if (args.headless && !profileExists) {
    console.error("--headless needs an existing profile; run once headed to log in first.");
    process.exit(1);
  }

  console.log("=== fetch-prizepicks-entries ===");
  console.log(profileExists ? "  Reusing saved login profile." : "  Fresh profile — you'll log in by hand.");

  // Launch a REAL browser (system Chrome/Edge, not Playwright's bundled
  // Chromium) with the automation tells stripped, so PrizePicks' bot challenge
  // (Cloudflare / hCaptcha) doesn't reject the login. The decisive one is
  // navigator.webdriver: the default --enable-automation flag sets it true and
  // bot vendors fail the challenge on it regardless of how you solve it.
  const launchOpts = {
    headless: args.headless,
    viewport: null,
    args: ["--disable-blink-features=AutomationControlled", "--start-maximized"],
    ignoreDefaultArgs: ["--enable-automation"],
  };
  let context;
  for (const channel of ["chrome", "msedge", null]) {
    try {
      context = await chromium.launchPersistentContext(
        PROFILE_DIR,
        channel ? { ...launchOpts, channel } : launchOpts,
      );
      console.log(channel ? `  Using system ${channel}.` : "  Using bundled Chromium (install Chrome for best results).");
      break;
    } catch (err) {
      if (channel === null) throw err;
    }
  }

  // Belt-and-suspenders fingerprint patches, applied before any page script runs.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });

  // Passive capture: accumulate every entries-looking JSON response the app
  // makes, and remember the first matching request's URL + auth headers so we
  // can follow pagination ourselves.
  const bodies = [];
  const seenJsonUrls = new Set();
  const capture = { url: null, method: null, headers: null };

  const onResponse = async (resp) => {
    try {
      const url = resp.url();
      const ct = resp.headers()["content-type"] || "";
      if (!ct.includes("json")) return;
      seenJsonUrls.add(url);
      if (!entriesPattern.test(url)) return;
      const body = await resp.json().catch(() => null);
      if (!body) return;
      bodies.push(body);
      if (!capture.url) {
        const req = resp.request();
        capture.url = url;
        capture.method = req.method();
        capture.headers = cleanHeaders(await req.allHeaders());
        console.log(`  Captured entries endpoint: ${req.method()} ${url}`);
      }
    } catch {
      /* ignore individual response parse errors */
    }
  };

  // Attach to the initial page and any popups/new tabs (e.g. an OAuth window).
  context.on("page", (p) => p.on("response", onResponse));
  const page = context.pages()[0] || (await context.newPage());
  page.on("response", onResponse);

  await page.goto(APP_URL, { waitUntil: "domcontentloaded" }).catch(() => {});

  console.log("\n  A Chromium window is open.");
  console.log("  1) Log in if prompted (handle any captcha / 2FA in the window).");
  console.log("  2) Open your entries / past-entries history and scroll so it loads.");
  await waitForEnter("\n  Press ENTER here once your history is on screen... ");

  // Login state persists automatically in PROFILE_DIR across runs — no
  // separate session file to manage.

  // Auto-follow pagination if we captured a GET endpoint with JSON:API links.
  if (capture.url && capture.method === "GET") {
    await followNextLinks(context, bodies, capture.headers);
  }

  await context.close();

  if (bodies.length === 0) {
    console.error(
      "\n  No entries response was captured.\n" +
        "  - Make sure you actually opened your entry history before pressing Enter.\n" +
        "  - If the endpoint isn't matched, set ENTRIES_URL_PATTERN in .env.local.\n" +
        `  - Observed JSON XHR URLs this run (${seenJsonUrls.size}):`,
    );
    for (const u of seenJsonUrls) console.error(`      ${u}`);
    process.exit(1);
  }

  // Dump raw for schema verification BEFORE normalizing, so a bad normalizer
  // never costs you the captured data.
  await fs.mkdir(path.dirname(RAW_DUMP), { recursive: true });
  await fs.writeFile(RAW_DUMP, JSON.stringify(bodies, null, 2) + "\n");
  console.log(`  Raw response(s) dumped → ${path.relative(ROOT, RAW_DUMP)} (${bodies.length} page[s])`);

  await finalize(bodies, args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("Fatal:", e.message);
    process.exit(1);
  });
}
