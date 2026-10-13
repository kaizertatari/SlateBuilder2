// Fit PrizePicks payout constants from YOUR real entry history (read-only,
// SUGGEST-ONLY — edit api/_lib/prizepicks-payouts.js after review).
//
// The projections feed carries no per-pick multiplier (only an
// `adjusted_odds` true/false flag), so the real price of a goblin/demon leg
// is only visible on placed entries. This reads the raw dump written by
// `npm run fetch-entries` (tmp/prizepicks-entries-raw.json), drops promo and
// free entries, and fits
//   log(top payout) = log(all-standard payout for that size)
//                     + n_goblin·log(f_goblin) + n_demon·log(f_demon)
// by least squares, against the all-standard payouts observed in the same
// history (falling back to the app's table for sizes with none).
//
// Usage: npm run fit-payouts [-- --raw path/to/raw.json]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { POWER_MULTIPLIER, LINE_TYPE_FACTOR } from "../api/_lib/prizepicks-payouts.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Power pays only when every leg hits: the all-hit row of
// full_payout_multipliers has no partial-payout entries. Flex rows carry
// payouts for fewer hits (e.g. [25, 2, 0.4]).
export const isFlexEntry = (a) => {
  const top = Array.isArray(a.full_payout_multipliers) ? a.full_payout_multipliers[0] : null;
  return Array.isArray(top) && top.slice(1).some((x) => x > 0);
};

/** Raw JSON:API pages → [{ n, mode, standard, goblin, demon, multiplier, created_at }]. */
export function entryRows(pages) {
  const inc = new Map();
  for (const p of pages) for (const x of p.included || []) inc.set(`${x.type}:${x.id}`, x);
  const rows = [];
  for (const p of pages) {
    for (const e of p.data || []) {
      const a = e.attributes || {};
      if (a.promotion_id != null || !(a.amount_bet_cents > 0) || !(a.amount_to_win_cents > 0)) continue;
      const preds = (e.relationships?.predictions?.data || []).map((r) => inc.get(`prediction:${r.id}`)).filter(Boolean);
      if (!preds.length) continue;
      const c = { standard: 0, goblin: 0, demon: 0 };
      for (const pr of preds) {
        const t = pr.attributes?.odds_type || "standard";
        if (t in c) c[t]++;
      }
      rows.push({ n: preds.length, mode: isFlexEntry(a) ? "flex" : "power", ...c, multiplier: a.amount_to_win_cents / a.amount_bet_cents, created_at: a.created_at ?? null });
    }
  }
  return rows;
}

const median = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

/** Least-squares fit of per-leg goblin/demon factors (see header). */
export function fitPayouts(rows, fallbackBase = POWER_MULTIPLIER) {
  const stdBySize = {};
  for (const r of rows) if (!r.goblin && !r.demon) (stdBySize[r.n] ||= []).push(r.multiplier);
  const base = {};
  for (const n of Object.keys({ ...fallbackBase, ...stdBySize })) base[n] = stdBySize[n] ? median(stdBySize[n]) : fallbackBase[n];
  let gg = 0, gd = 0, dd = 0, yg = 0, yd = 0, used = 0;
  for (const r of rows) {
    if (!(r.goblin || r.demon) || !base[r.n]) continue;
    const y = Math.log(r.multiplier / base[r.n]);
    gg += r.goblin * r.goblin; gd += r.goblin * r.demon; dd += r.demon * r.demon;
    yg += r.goblin * y; yd += r.demon * y;
    used++;
  }
  let goblin = null, demon = null;
  const det = gg * dd - gd * gd;
  if (det > 0) { goblin = Math.exp((yg * dd - yd * gd) / det); demon = Math.exp((gg * yd - gd * yg) / det); }
  else if (gg > 0) goblin = Math.exp(yg / gg);
  const counts = { goblin: rows.filter((r) => r.goblin).length, demon: rows.filter((r) => r.demon).length };
  return { base, stdBySize, factors: { goblin, demon }, used, counts };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--raw");
  const file = i >= 0 ? process.argv[i + 1] : path.join(ROOT, "tmp/prizepicks-entries-raw.json");
  if (!fs.existsSync(file)) {
    console.log(`No raw entries dump at ${file}. Run: npm run fetch-entries`);
    process.exit(0);
  }
  const all = entryRows(JSON.parse(fs.readFileSync(file, "utf8")));
  // Fit on Power entries only (Flex top payouts are a different table).
  const rows = all.filter((r) => r.mode === "power");
  const dates = rows.map((r) => r.created_at).filter(Boolean).sort();
  const f = fitPayouts(rows);
  const be = (factor) => 1 / (Math.sqrt(f.base[2] ?? POWER_MULTIPLIER[2]) * factor);
  console.log(`PrizePicks payout fit — ${rows.length} paid non-promo Power entries (${all.length - rows.length} Flex excluded) (${dates[0]?.slice(0, 10)} → ${dates.at(-1)?.slice(0, 10)})\n`);
  console.log("All-standard Power payout by size (observed median vs app POWER_MULTIPLIER)");
  for (const n of Object.keys(f.base).sort()) {
    const obs = f.stdBySize[n];
    console.log(`  ${n}-pick  observed ${obs ? `${f.base[n]}× (n=${obs.length}: ${obs.join(", ")})` : "—"}   app ${POWER_MULTIPLIER[n] ?? "—"}×`);
  }
  console.log(`\nPer-leg line-type factor (fit on ${f.used} entries; goblin in ${f.counts.goblin}, demon in ${f.counts.demon})`);
  for (const t of ["goblin", "demon"]) {
    const v = f.factors[t];
    console.log(`  ${t.padEnd(7)} fitted ${v == null ? "—" : v.toFixed(3)}   app ${LINE_TYPE_FACTOR[t]}   → 2-pick per-leg break-even ${v == null ? "—" : `${(be(v) * 100).toFixed(1)}%`} (app ${(be(LINE_TYPE_FACTOR[t]) * 100).toFixed(1)}%)`);
  }
  console.log("\nSuggest-only. PrizePicks prices goblins/demons per line (how far it moved), so these are averages;");
  console.log("thin cells (demon) deserve a re-fit after fresh entries: npm run fetch-entries && npm run fit-payouts");
}
