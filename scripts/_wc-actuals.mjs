// Shared World Cup actuals helpers for the grader and the FBref
// match-stats fallback (WC_FRAMEWORK_SPEC.md §7, §10.6).
//
// ESPN fifa.world rosters carry only Shots/SOT/Saves (+ goals/assists/
// fouls/cards) per player — validated 2026-06-12 against event 760415.
// Tackles, Clearances, Passes Attempted, key passes, crosses, and
// dribbles only exist on FBref match reports, scraped into
// data/wc-match-stats.json by scripts/refresh-wc-match-stats.mjs.
// mergeWcEntry overlays that snapshot onto the ESPN entry so every prop
// (including the all-or-nothing fantasy composite) can grade.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeName } from "../api/_lib/string-utils.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WC_MATCH_STATS_PATH = path.join(ROOT, "data/wc-match-stats.json");

// Per-player stat fields shared by ESPN entries and FBref snapshot rows.
export const WC_STAT_FIELDS = ["sh", "st", "tk", "sv", "clr", "pa", "g", "a", "kp", "cr", "drb", "fc", "yc", "rc"];

// First finite value among candidate stat keys.
export function pickWcStat(statMap, keys) {
  for (const k of keys) {
    const v = statMap[k];
    if (Number.isFinite(v)) return v;
  }
  return null;
}

// Resolve a WC verdict's actual from a per-player entry (spec §10.6).
// Fantasy is computed from the official PP outfield weights ONLY when every
// component graded — a partial sum would silently mis-grade, so null it and
// let the ungradeable counter surface the gap instead.
export const WC_FANTASY_COMPONENTS = [
  ["g", 10], ["a", 5], ["sh", 1], ["st", 1], ["pa", 0.05], ["kp", 0.5],
  ["clr", 1], ["tk", 1], ["drb", 1], ["cr", 0.5], ["yc", -1], ["rc", -2], ["fc", -0.5],
];

export function wcActualFor(stat, entry) {
  switch (stat) {
    case "Shots": return entry.sh;
    case "Shots On Target": return entry.st;
    case "Tackles": return entry.tk;
    case "Goalie Saves": return entry.sv;
    case "Clearances": return entry.clr;
    case "Passes Attempted": return entry.pa;
    case "Outfield Fantasy Score": {
      let total = 0;
      for (const [k, w] of WC_FANTASY_COMPONENTS) {
        if (!Number.isFinite(entry[k])) return null; // all-or-nothing
        total += w * entry[k];
      }
      return Number(total.toFixed(2));
    }
    default: return null;
  }
}

// Load data/wc-match-stats.json; null when absent/unreadable (the grader
// then runs ESPN-only, exactly as before the fallback existed).
export async function loadWcMatchStats(file = WC_MATCH_STATS_PATH) {
  try {
    const snap = JSON.parse(await fs.readFile(file, "utf8"));
    return snap && typeof snap.matches === "object" ? snap : null;
  } catch {
    return null;
  }
}

// Snapshot → Map<YYYY-MM-DD, Map<normName, playerRow>>. Duplicate names on
// one date (two matches) are a real ambiguity — keep the first and let the
// grader's name-match semantics stay deterministic.
export function indexWcMatchStatsByDate(snapshot) {
  const byDate = new Map();
  if (!snapshot?.matches) return byDate;
  for (const match of Object.values(snapshot.matches)) {
    if (!match?.date || !match?.players) continue;
    let day = byDate.get(match.date);
    if (!day) byDate.set(match.date, (day = new Map()));
    for (const [key, row] of Object.entries(match.players)) {
      if (!day.has(key)) day.set(key, row);
    }
  }
  return byDate;
}

// Overlay an FBref match-report row onto an ESPN roster entry. ESPN values
// win when present (same source the verdict's void/dnp semantics come
// from); FBref fills the nulls. With no ESPN entry at all, the FBref row
// stands alone — it only lists players who appeared, so played=true needs
// minutes as a sanity check.
export function mergeWcEntry(espnEntry, fbEntry) {
  if (!espnEntry && !fbEntry) return null;
  if (!fbEntry) return espnEntry;
  const base = espnEntry ?? {
    name: fbEntry.name,
    team: fbEntry.team ?? null,
    played: (fbEntry.min ?? 0) > 0,
    event_id: null,
  };
  const merged = { ...base };
  for (const f of WC_STAT_FIELDS) {
    if (!Number.isFinite(merged[f]) && Number.isFinite(fbEntry[f])) merged[f] = fbEntry[f];
  }
  return merged;
}

export { normalizeName };
