// Scrape DraftKings + FanDuel Premier League markets → data/epl-odds.json.
//
//   matches  per fixture: de-vigged 1X2 + match/team goal totals from both
//            books, the fitted market team goal expectations λ_home/λ_away
//            (the game script the player model takes as teamContext), and
//            FanDuel's team shots / shots-on-target ladders.
//   players  per model player id: every one-sided milestone ladder by book
//            (shots, SOT, shots created, assists, goals, goal+assist,
//            tackles, saves, fouls, fouls won) with its fitted RAW λ̂.
//
// Same residential-IP plain-fetch pattern as scripts/scrape-odds.mjs (NBA/
// WNBA); kept in its own file so the basketball odds pipeline is untouched
// until the EPL engine ships. Needs data/epl-players.json + data/epl-model.json
// (player/team resolution, starting keepers for FanDuel's "<Team> Goalkeeper").
//
// Usage: npm run scrape-epl-odds  [-- --dry-run] [-- --days 8]

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { americanToProb, devig, fitLadder, fitTeamLambdas } from "../api/_lib/epl/market.js";
import { buildTeamResolver, buildPlayerResolver } from "../api/_lib/epl/names.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data/epl-odds.json");
const DRY = process.argv.includes("--dry-run");
const daysIdx = process.argv.indexOf("--days");
// FanDuel is fetched per event × tab, so only the near-term fixtures the
// PrizePicks board can carry (DraftKings returns every event in one call).
const FD_DAYS = daysIdx >= 0 ? Number(process.argv[daysIdx + 1]) : 8;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jsonFetch(url, headers = {}) {
  for (let i = 1; i <= 2; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...headers }, signal: AbortSignal.timeout(15000) });
      if (res.ok) return await res.json();
      if (res.status === 404) return null;
      console.error(`  HTTP ${res.status} ${url.slice(-80)}`);
    } catch (err) {
      console.error(`  fetch threw ${url.slice(-80)}: ${err.message}`);
    }
    await sleep(1500);
  }
  return null;
}

// ─── DraftKings (nash sportscontent API) ─────────────────────────────────────

const DK_BASE = "https://sportsbook-nash.draftkings.com/api/sportscontent/dkusil/v1/leagues/40253";
const DK_HEADERS = { Referer: "https://sportsbook.draftkings.com/" };
// Player milestone ladders: [category, subcategory, stat]
const DK_LADDERS = [
  [1113, 16868, "shots"], [1113, 16861, "sot"], [1714, 16863, "assists"], [537, 19814, "goal_assist"],
  [1567, 18345, "tackles"], [1567, 18346, "saves"], [1567, 18348, "fouls"], [1567, 19540, "fouled"],
];

async function scrapeDraftKings(ctx) {
  const events = new Map(); // DK event id → { home, away, kickoff }
  const noteEvents = (d) => {
    for (const e of d?.events || []) {
      if (events.has(e.id)) continue;
      const home = e.participants?.find((p) => p.venueRole === "Home");
      const away = e.participants?.find((p) => p.venueRole === "Away");
      const h = ctx.team(home?.metadata?.rosettaTeamName) ?? ctx.team(home?.name);
      const a = ctx.team(away?.metadata?.rosettaTeamName) ?? ctx.team(away?.name);
      if (h && a) events.set(e.id, { home: h, away: a, kickoff: e.startEventDate });
      else ctx.unresolvedTeams.add(`DK: ${home?.name} v ${away?.name}`);
    }
  };

  // Match lines.
  const ml = await jsonFetch(`${DK_BASE}/categories/490/subcategories/4514`, DK_HEADERS);
  noteEvents(ml);
  for (const m of (ml?.markets || []).filter((x) => x.subcategoryId === 4514)) {
    const ev = events.get(m.eventId);
    if (!ev) continue;
    const sel = (ml.selections || []).filter((s) => s.marketId === m.id);
    const get = (t) => americanToProb(sel.find((s) => s.outcomeType === t)?.displayOdds?.american);
    const fair = devig([get("Home"), get("Tie"), get("Away")]);
    if (fair) ctx.match(ev).books.draftkings.result = { home: fair[0], draw: fair[1], away: fair[2] };
  }
  await sleep(400);
  const tot = await jsonFetch(`${DK_BASE}/categories/490/subcategories/13171`, DK_HEADERS);
  noteEvents(tot);
  for (const m of (tot?.markets || []).filter((x) => x.subcategoryId === 13171)) {
    const ev = events.get(m.eventId);
    if (!ev) continue;
    const sel = (tot.selections || []).filter((s) => s.marketId === m.id);
    const lines = [...new Set(sel.map((s) => s.points).filter((p) => p != null))];
    for (const line of lines) {
      const o = americanToProb(sel.find((s) => s.points === line && s.outcomeType === "Over")?.displayOdds?.american);
      const u = americanToProb(sel.find((s) => s.points === line && s.outcomeType === "Under")?.displayOdds?.american);
      const fair = devig([o, u]);
      if (fair) ctx.match(ev).books.draftkings.totals.push({ line, over: fair[0] });
    }
  }

  // Player ladders.
  for (const [cat, sub, stat] of DK_LADDERS) {
    await sleep(400);
    const d = await jsonFetch(`${DK_BASE}/categories/${cat}/subcategories/${sub}`, DK_HEADERS);
    noteEvents(d);
    const selByMarket = new Map();
    for (const s of d?.selections || []) {
      if (!selByMarket.has(s.marketId)) selByMarket.set(s.marketId, []);
      selByMarket.get(s.marketId).push(s);
    }
    for (const m of (d?.markets || []).filter((x) => x.subcategoryId === sub)) {
      const ev = events.get(m.eventId);
      const sels = selByMarket.get(m.id) || [];
      const who = sels[0]?.participants?.[0];
      if (!ev || !who?.name) continue;
      const abbr = who.venueRole === "HomePlayer" ? ev.home : who.venueRole === "AwayPlayer" ? ev.away : null;
      const rungs = sels
        .map((s) => ({ k: Number(s.milestoneValue ?? parseInt(s.label, 10)), implied: americanToProb(s.displayOdds?.american) }))
        .filter((r) => Number.isInteger(r.k) && r.implied != null);
      ctx.ladder("draftkings", who.name, abbr, ev, stat, rungs);
    }
  }

  // Anytime goalscorer: one price per player (k = 1).
  await sleep(400);
  const gs = await jsonFetch(`${DK_BASE}/categories/537/subcategories/16604`, DK_HEADERS);
  noteEvents(gs);
  for (const m of (gs?.markets || []).filter((x) => x.subcategoryId === 16604 && /anytime/i.test(x.marketType?.name ?? x.name))) {
    const ev = events.get(m.eventId);
    if (!ev) continue;
    for (const s of (gs.selections || []).filter((x) => x.marketId === m.id)) {
      const who = s.participants?.[0];
      if (!who?.name) continue;
      const abbr = who.venueRole === "HomePlayer" ? ev.home : who.venueRole === "AwayPlayer" ? ev.away : null;
      ctx.ladder("draftkings", who.name, abbr, ev, "goals", [{ k: 1, implied: americanToProb(s.displayOdds?.american) }]);
    }
  }
  return events.size;
}

// ─── FanDuel (sbapi) ─────────────────────────────────────────────────────────

const FD_AK = "FhMFpcPWXMeyZxOx";
const FD_COMMON = `_ak=${FD_AK}&betexRegion=GBR&capiJurisdiction=intl&currencyCode=USD&exchangeLocale=en_US&includePrices=true&language=en&regionCode=ILLINOIS&timezone=America%2FNew_York`;
const FD_BASE = "https://sbapi.il.sportsbook.fanduel.com/api";
const FD_EPL_COMPETITION = "10932509";
const FD_TABS = ["popular", "shots", "shots-on-target", "goals", "assists", "saves", "same-game-parlay"];

// marketType → { stat, k } for player ladders (full match only: the regexes
// are anchored, so "…_IN_1ST_HALF" / "…_EACH_HALF" / "…_OUTSIDE_THE_BOX"
// variants never match).
function fdPlayerMarket(type) {
  let m;
  if ((m = type.match(/^PLAYER_TO_HAVE_(\d+)_OR_MORE_SHOTS$/))) return { stat: "shots", k: +m[1] };
  if ((m = type.match(/^PLAYER_TO_HAVE_(\d+)_OR_MORE_SHOTS_ON_TARGET$/))) return { stat: "sot", k: +m[1] };
  if ((m = type.match(/^PLAYER_TO_CREATE_(\d+)_OR_MORE_SHOTS$/))) return { stat: "key_passes", k: +m[1] };
  if ((m = type.match(/^GOALKEEPER_TO_MAKE_(\d+)_OR_MORE_SAVES$/))) return { stat: "saves", k: +m[1], keeper: true };
  if (type === "ANYTIME_ASSIST") return { stat: "assists", k: 1 };
  if (type === "TO_SCORE") return { stat: "goals", k: 1 };
  if (type === "TO_SCORE_OR_ASSIST") return { stat: "goal_assist", k: 1 };
  return null;
}

const runnerAmerican = (r) => r?.winRunnerOdds?.americanDisplayOdds?.americanOdds;

async function scrapeFanDuel(ctx) {
  const sp = await jsonFetch(`${FD_BASE}/content-managed-page?page=SPORT&eventTypeId=1&${FD_COMMON}`);
  const horizon = Date.now() + FD_DAYS * 86400000;
  const evs = Object.values(sp?.attachments?.events || {}).filter(
    (e) => String(e.competitionId) === FD_EPL_COMPETITION && / v /.test(e.name) && Date.parse(e.openDate) <= horizon
  );
  let n = 0;
  for (const e of evs) {
    const [hName, aName] = e.name.split(" v ");
    const ev = { home: ctx.team(hName), away: ctx.team(aName), kickoff: e.openDate };
    if (!ev.home || !ev.away) {
      ctx.unresolvedTeams.add(`FD: ${e.name}`);
      continue;
    }
    n++;
    const ladders = new Map(); // `${stat}|${runner}` → { stat, runner, keeper, rungs[] }
    const teamLadders = { shots: {}, sot: {} };
    const book = ctx.match(ev).books.fanduel;
    // Only the tabs this event actually has (the default page lists them).
    const layout = await jsonFetch(`${FD_BASE}/event-page?eventId=${e.eventId}&${FD_COMMON}`);
    const present = new Set(Object.values(layout?.layout?.tabs || {}).map((t) => String(t.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")));
    for (const tab of FD_TABS.filter((t) => present.has(t))) {
      await sleep(250);
      const p = await jsonFetch(`${FD_BASE}/event-page?eventId=${e.eventId}&tab=${tab}&${FD_COMMON}`);
      for (const m of Object.values(p?.attachments?.markets || {})) {
        const type = String(m.marketType || "");
        const runners = m.runners || [];
        let mm;
        const pm = fdPlayerMarket(type);
        if (pm) {
          for (const r of runners) {
            const implied = americanToProb(runnerAmerican(r));
            if (implied == null) continue;
            const key = `${pm.stat}|${r.runnerName}`;
            const l = ladders.get(key) ?? { stat: pm.stat, runner: r.runnerName, keeper: !!pm.keeper, rungs: [] };
            if (!l.rungs.some((x) => x.k === pm.k)) l.rungs.push({ k: pm.k, implied });
            ladders.set(key, l);
          }
        } else if (type === "WIN-DRAW-WIN" && runners.length === 3) {
          const byName = (n) => americanToProb(runnerAmerican(runners.find((r) => r.runnerName === n)));
          const fair = devig([byName(hName), byName("Draw"), byName(aName)]);
          if (fair) book.result = { home: fair[0], draw: fair[1], away: fair[2] };
        } else if ((mm = type.match(/^OVER_UNDER_(\d)(\d)$/)) && runners.length === 2) {
          const fair = devig([americanToProb(runnerAmerican(runners.find((r) => /over/i.test(r.runnerName)))), americanToProb(runnerAmerican(runners.find((r) => /under/i.test(r.runnerName))))]);
          if (fair) book.totals.push({ line: Number(`${mm[1]}.${mm[2]}`), over: fair[0] });
        } else if ((mm = type.match(/^(HOME|AWAY)_TEAM_OVER\/UNDER_(\d+\.5)$/)) && runners.length === 2) {
          const fair = devig([americanToProb(runnerAmerican(runners.find((r) => /over/i.test(r.runnerName)))), americanToProb(runnerAmerican(runners.find((r) => /under/i.test(r.runnerName))))]);
          if (fair) book[mm[1] === "HOME" ? "homeTotals" : "awayTotals"].push({ line: Number(mm[2]), over: fair[0] });
        } else if ((mm = type.match(/^TEAM_TO_HAVE_(\d+)_OR_MORE_SHOTS(_ON_TARGET)?$/))) {
          const stat = mm[2] ? "sot" : "shots";
          for (const r of runners) {
            const abbr = ctx.team(r.runnerName);
            const implied = americanToProb(runnerAmerican(r));
            if (!abbr || implied == null) continue;
            (teamLadders[stat][abbr] ??= []).push({ k: +mm[1], implied });
          }
        }
      }
    }
    for (const l of ladders.values()) {
      if (l.keeper) {
        // "Fulham Goalkeeper" → that team's starting keeper.
        const abbr = ctx.team(l.runner.replace(/\s+goalkeeper$/i, ""));
        const gkId = abbr ? ctx.startingKeeper(abbr) : null;
        if (gkId) ctx.ladderById("fanduel", gkId, ev, "saves", l.rungs, `${l.runner} (starting GK)`);
        else ctx.unresolvedPlayers.add(`FD: ${l.runner}`);
      } else {
        ctx.ladder("fanduel", l.runner, null, ev, l.stat, l.rungs);
      }
    }
    for (const stat of ["shots", "sot"]) {
      for (const [abbr, rungs] of Object.entries(teamLadders[stat])) {
        const fit = fitLadder(rungs);
        if (fit) (ctx.match(ev).team_ladders[stat] ??= {})[abbr] = { rungs: rungs.sort((a, b) => a.k - b.k), lambda_hat: fit.lambda };
      }
    }
  }
  return n;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const registry = JSON.parse(await fs.readFile(path.join(ROOT, "data/epl-players.json"), "utf8"));
  const model = JSON.parse(await fs.readFile(path.join(ROOT, "data/epl-model.json"), "utf8"));
  const team = buildTeamResolver(registry);
  const resolvePlayer = buildPlayerResolver(model, registry);
  const abbrOf = (tid) => model.teams?.[tid]?.abbr ?? null;

  const matches = {};
  const players = {};
  const ctx = {
    team,
    unresolvedTeams: new Set(),
    unresolvedPlayers: new Set(),
    match(ev) {
      const key = `${ev.home}-${ev.away}`;
      return (matches[key] ??= {
        home: ev.home, away: ev.away, kickoff: ev.kickoff,
        books: {
          draftkings: { result: null, totals: [] },
          fanduel: { result: null, totals: [], homeTotals: [], awayTotals: [] },
        },
        team_ladders: {},
      });
    },
    startingKeeper(abbr) {
      const gks = Object.entries(model.players).filter(([, p]) => p.gk && abbrOf(p.team_id) === abbr && !p.prior_only);
      gks.sort((a, b) => b[1].minutes.p_start - a[1].minutes.p_start);
      return gks[0]?.[0] ?? null;
    },
    ladderById(book, id, ev, stat, rungs, label) {
      if (!rungs.length) return;
      const p = model.players[id];
      const entry = (players[id] ??= { name: p.name, team: abbrOf(p.team_id), match: `${ev.home}-${ev.away}`, props: {} });
      const fit = fitLadder(rungs);
      (entry.props[stat] ??= {})[book] = { rungs: rungs.sort((a, b) => a.k - b.k), lambda_hat: fit?.lambda ?? null, overround: fit?.overround ?? null, ...(label ? { label } : {}) };
    },
    ladder(book, name, abbr, ev, stat, rungs) {
      const r = abbr
        ? resolvePlayer(name, abbr)
        : resolvePlayer(name, ev.home) ?? resolvePlayer(name, ev.away);
      if (!r) {
        ctx.unresolvedPlayers.add(`${book === "draftkings" ? "DK" : "FD"}: ${name}`);
        return;
      }
      ctx.ladderById(book, r.id, ev, stat, rungs);
    },
  };

  console.log("=== scrape-epl-odds ===");
  const dkEvents = await scrapeDraftKings(ctx);
  console.log(`  DraftKings: ${dkEvents} events`);
  const fdEvents = await scrapeFanDuel(ctx);
  console.log(`  FanDuel: ${fdEvents} events`);

  // Market team goal expectations: pool both books' de-vigged probabilities.
  for (const m of Object.values(matches)) {
    const dk = m.books.draftkings, fd = m.books.fanduel;
    const results = [dk.result, fd.result].filter(Boolean);
    const result = results.length
      ? Object.fromEntries(["home", "draw", "away"].map((k) => [k, results.reduce((a, r) => a + r[k], 0) / results.length]))
      : null;
    const fit = fitTeamLambdas({ result, totals: [...dk.totals, ...fd.totals], homeTotals: fd.homeTotals, awayTotals: fd.awayTotals });
    m.lambda = fit;
    m.result = result;
  }
  // Pooled raw λ̂ per player-stat (mean over books that quote it).
  for (const p of Object.values(players)) {
    for (const byBook of Object.values(p.props)) {
      const ls = ["draftkings", "fanduel"].map((b) => byBook[b]?.lambda_hat).filter((x) => x > 0);
      byBook.lambda_hat = ls.length ? Number((ls.reduce((a, b) => a + b, 0) / ls.length).toFixed(4)) : null;
    }
  }

  const statCounts = {};
  for (const p of Object.values(players)) for (const s of Object.keys(p.props)) statCounts[s] = (statCounts[s] || 0) + 1;
  const withLambda = Object.values(matches).filter((m) => m.lambda).length;
  console.log(`  ${Object.keys(matches).length} fixtures (${withLambda} with market λ), ${Object.keys(players).length} players`);
  console.log(`  player ladders by stat: ${JSON.stringify(statCounts)}`);
  if (ctx.unresolvedTeams.size) console.warn(`  ! unresolved teams: ${[...ctx.unresolvedTeams].join("; ")}`);
  if (ctx.unresolvedPlayers.size) console.log(`  unresolved players (${ctx.unresolvedPlayers.size}): ${[...ctx.unresolvedPlayers].slice(0, 25).join(", ")}${ctx.unresolvedPlayers.size > 25 ? ", …" : ""}`);

  for (const [key, m] of Object.entries(matches).sort((a, b) => String(a[1].kickoff).localeCompare(String(b[1].kickoff))).slice(0, 12)) {
    const r = m.result;
    console.log(`  ${key.padEnd(8)} ${String(m.kickoff).slice(0, 16)}  1X2 ${r ? [r.home, r.draw, r.away].map((x) => (x * 100).toFixed(0)).join("/") : "—"}  λ ${m.lambda ? `${m.lambda.home}–${m.lambda.away} (rmse ${m.lambda.rmse}, n=${m.lambda.n})` : "—"}`);
  }

  if (!Object.keys(matches).length) throw new Error("no EPL markets scraped — refusing to write");
  const out = {
    fetched_at: new Date().toISOString(),
    sources: ["draftkings", "fanduel"],
    matches,
    players,
    unresolved: { teams: [...ctx.unresolvedTeams], players: [...ctx.unresolvedPlayers] },
  };
  if (DRY) {
    console.log("  DRY RUN — nothing written");
    return;
  }
  await fs.writeFile(OUT, JSON.stringify(out) + "\n");
  console.log(`  wrote data/epl-odds.json (${(JSON.stringify(out).length / 1024).toFixed(0)} KB)`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
