// NFL sportsbook parsing (step 3). Pure — scripts/scrape-nfl-odds.mjs does
// the fetching. Verified live 2026-10-13:
//   DraftKings  nash sportscontent league 88808 (Node fetch; curl is 403'd).
//               Two-sided O/U subcategories per stat, plus TD Scorer
//               (cat 1003 / sub 12438: "Anytime TD Scorer" one-sided).
//   FanDuel     sbapi event-page tabs passing-props / receiving-props /
//               rushing-props / td-scorer-props; full-game O/U markets are
//               named "<Player> - <Stat>", alt ladders "<Player> - Alt …".
// Props post only a few days before each game.

import { devigTwoWay, parseAmerican, impliedProb } from "../odds.js";

// Team nickname → nflverse abbreviation. Books spell cities differently
// ("LA Rams" vs "Los Angeles Rams"), and the city alone is ambiguous for LA
// and NY, so the nickname is the key.
export const TEAM_BY_NICKNAME = {
  cardinals: "ARI", falcons: "ATL", ravens: "BAL", bills: "BUF", panthers: "CAR", bears: "CHI", bengals: "CIN", browns: "CLE",
  cowboys: "DAL", broncos: "DEN", lions: "DET", packers: "GB", texans: "HOU", colts: "IND", jaguars: "JAX", chiefs: "KC",
  rams: "LA", chargers: "LAC", raiders: "LV", dolphins: "MIA", vikings: "MIN", patriots: "NE", saints: "NO", giants: "NYG",
  jets: "NYJ", eagles: "PHI", steelers: "PIT", seahawks: "SEA", "49ers": "SF", buccaneers: "TB", titans: "TEN", commanders: "WAS",
};

/** "Seattle Seahawks" / "SEA Seahawks" → "SEA" (null when unknown). */
export function teamAbbr(name) {
  const last = String(name || "").trim().split(/\s+/).pop()?.toLowerCase();
  return TEAM_BY_NICKNAME[last] ?? null;
}

// DraftKings O/U subcategories (category / subcategory ids).
export const DK_OU = [
  { stat: "pass_yds", cat: 1000, sub: 9524 }, { stat: "pass_td", cat: 1000, sub: 9525 },
  { stat: "pass_att", cat: 1000, sub: 9517 }, { stat: "completions", cat: 1000, sub: 9522 },
  { stat: "pass_int", cat: 1000, sub: 15937 }, { stat: "pass_rush_yds", cat: 1000, sub: 9532 },
  { stat: "rush_yds", cat: 1001, sub: 9514 }, { stat: "rush_att", cat: 1001, sub: 9518 },
  { stat: "rush_rec_yds", cat: 1001, sub: 9523 },
  { stat: "rec_yds", cat: 1342, sub: 14114 }, { stat: "rec", cat: 1342, sub: 14115 },
  { stat: "longest_completion", cat: 1000, sub: 15968 }, { stat: "longest_rec", cat: 1342, sub: 15948 },
];
export const DK_TD = { cat: 1003, sub: 12438 };

// FanDuel full-game O/U markets: tab + exact market-name suffix.
export const FD_OU = [
  { stat: "pass_yds", tab: "passing-props", re: /\s-\s*Passing Yds$/i },
  { stat: "pass_td", tab: "passing-props", re: /\s-\s*Passing TDs$/i },
  { stat: "rec_yds", tab: "receiving-props", re: /\s-\s*Receiving Yds$/i },
  { stat: "rec", tab: "receiving-props", re: /\s-\s*Total Receptions$/i },
  { stat: "rush_yds", tab: "rushing-props", re: /\s-\s*Rushing Yds$/i },
  { stat: "rush_rec_yds", tab: "rushing-props", re: /\s-\s*Rushing \+ Receiving Yds$/i },
];
export const FD_TD_TAB = "td-scorer-props";

/** DK league payload → { eventId: { home, away, start_time, game } } (nflverse abbrs). */
export function dkEvents(base) {
  const out = {};
  for (const e of base?.events || []) {
    const home = e.participants?.find((p) => p.venueRole === "Home");
    const away = e.participants?.find((p) => p.venueRole === "Away");
    const h = teamAbbr(home?.name), a = teamAbbr(away?.name);
    if (!h || !a) continue;
    out[e.id] = { home: h, away: a, start_time: e.startEventDate ?? null, game: `${a}@${h}` };
  }
  return out;
}

/** DK league payload → game lines { "AWY@HOM": { total, home_spread } }. */
export function dkGameLines(base, events) {
  const games = {};
  const sels = {};
  for (const s of base?.selections || []) (sels[s.marketId] ??= []).push(s);
  for (const m of base?.markets || []) {
    const ev = events[m.eventId];
    if (!ev) continue;
    const g = (games[ev.game] ??= { home: ev.home, away: ev.away, start_time: ev.start_time, total: null, home_spread: null });
    const type = m.marketType?.name || m.name;
    const ss = sels[m.id] || [];
    if (type === "Total") { const o = ss.find((s) => /over/i.test(s.label)); if (o?.points != null) g.total = o.points; }
    else if (type === "Spread") for (const s of ss) if (s.points != null && teamAbbr(s.participants?.[0]?.name ?? s.label) === ev.home) g.home_spread = s.points;
  }
  return games;
}

const sideTeam = (ev, venueRole) => (venueRole === "HomePlayer" ? ev?.home : venueRole === "AwayPlayer" ? ev?.away : null);

/** DK O/U subcategory payload → quotes [{ player, stat, line, over/under american, fair_over, team, game, start_time }]. */
export function parseDkOU(data, stat, events) {
  const out = [];
  const sels = {};
  for (const s of data?.selections || []) (sels[s.marketId] ??= []).push(s);
  for (const m of data?.markets || []) {
    const ss = sels[m.id] || [];
    const over = ss.find((s) => /^over$/i.test(s.label));
    const under = ss.find((s) => /^under$/i.test(s.label));
    if (!over || !under || over.points == null || over.points !== under.points) continue;
    const player = over.participants?.[0]?.name;
    if (!player) continue;
    const fair = devigTwoWay(over.displayOdds?.american, under.displayOdds?.american);
    if (fair == null) continue;
    const ev = events[m.eventId];
    out.push({ book: "draftkings", player, stat, line: over.points, over_american: parseAmerican(over.displayOdds?.american), under_american: parseAmerican(under.displayOdds?.american),
      fair_over: Number(fair.toFixed(4)), team: sideTeam(ev, over.participants?.[0]?.venueRole), game: ev?.game ?? null, start_time: ev?.start_time ?? null });
  }
  return out;
}

/** DK TD Scorer payload → anytime-TD quotes [{ player, american, implied, team, game }] (one-sided). */
export function parseDkTd(data, events) {
  const out = [];
  const sels = {};
  for (const s of data?.selections || []) (sels[s.marketId] ??= []).push(s);
  for (const m of data?.markets || []) {
    if (!/anytime/i.test(m.name || "")) continue;
    const ev = events[m.eventId];
    for (const s of sels[m.id] || []) {
      const player = s.participants?.[0]?.name ?? s.label;
      const american = parseAmerican(s.displayOdds?.american);
      if (!player || american == null) continue;
      out.push({ book: "draftkings", player, american, implied: Number(impliedProb(american).toFixed(4)), team: sideTeam(ev, s.participants?.[0]?.venueRole), game: ev?.game ?? null });
    }
  }
  return out;
}

/** FD event-page attachments → O/U quotes for the tab's specs. */
export function parseFdOU(attachments, specs, ev) {
  const out = [];
  for (const m of Object.values(attachments?.markets || {})) {
    const name = String(m.marketName || "");
    const spec = specs.find((x) => x.re.test(name));
    if (!spec) continue;
    const runners = m.runners || [];
    const over = runners.find((r) => /over/i.test(r.runnerName));
    const under = runners.find((r) => /under/i.test(r.runnerName));
    if (!over || !under || over.handicap == null || over.handicap !== under.handicap) continue;
    const oa = over.winRunnerOdds?.americanDisplayOdds?.americanOdds;
    const ua = under.winRunnerOdds?.americanDisplayOdds?.americanOdds;
    const fair = devigTwoWay(oa, ua);
    if (fair == null) continue;
    out.push({ book: "fanduel", player: name.replace(spec.re, "").trim(), stat: spec.stat, line: over.handicap, over_american: parseAmerican(oa), under_american: parseAmerican(ua),
      fair_over: Number(fair.toFixed(4)), team: null, game: ev?.game ?? null, start_time: ev?.start_time ?? null });
  }
  return out;
}

/** FD td-scorer tab → anytime-TD quotes (one-sided). */
export function parseFdTd(attachments, ev) {
  const out = [];
  for (const m of Object.values(attachments?.markets || {})) {
    if (!/^any\s*time touchdown scorer$/i.test(String(m.marketName || "").trim())) continue;
    for (const r of m.runners || []) {
      const american = parseAmerican(r.winRunnerOdds?.americanDisplayOdds?.americanOdds);
      if (!r.runnerName || american == null) continue;
      out.push({ book: "fanduel", player: r.runnerName.trim(), american, implied: Number(impliedProb(american).toFixed(4)), team: null, game: ev?.game ?? null });
    }
  }
  return out;
}

/** FD event name "Houston Texans @ Jacksonville Jaguars" → { home, away, game }. */
export function fdEvent(e) {
  const [a, h] = String(e?.name || "").split(/\s+@\s+/);
  const away = teamAbbr(a), home = teamAbbr(h);
  return away && home ? { home, away, game: `${away}@${home}`, start_time: e.openDate ?? null } : null;
}
