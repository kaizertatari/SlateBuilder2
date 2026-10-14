// NFL grading (step 5). Pure — scripts/grade-nfl-outcomes.mjs does the I/O.
//
//   actualFor / gradeVerdict  settle a logged NFL verdict against the player's
//                             nflverse weekly stat row + snap count
//                             (PrizePicks rules: no snap played → void, an
//                             exact tie on an integer line → push)
//   playedState               did the player take a snap? (a stats row alone
//                             misses a player who played but touched nothing)
//   openClose / clvFor        the first and the last pre-kickoff verdict per
//                             line → closing-line value of the market price
//
// The selection + join helpers are league-agnostic and shared with EPL.

import { FANTASY_WEIGHTS } from "./model.js";
import { statOf } from "./nflverse.js";
import { joinKey, latestBeforeKickoff } from "../epl/grading.js";

export { joinKey, latestBeforeKickoff };

// PrizePicks NFL Fantasy Score also scores 2 per two-point conversion and 6
// per return / fumble-recovery TD (not in the model's simulation — rare
// enough not to move a line). Checked against nflverse fantasy_points_ppr on
// 2025–26 rows: 6,689 of 6,691 identical once its −2 INT / fumble lost is set
// to PrizePicks' −1.
const TWO_PT = 2, RETURN_TD = 6;

/** Actual value of a model stat key from a compact nflverse player-game row. */
export function actualFor(stat, row) {
  const n = (f) => statOf(row, f);
  switch (stat) {
    case "rush_rec_yds": return n("rush_yds") + n("rec_yds");
    case "pass_rush_yds": return n("pass_yds") + n("rush_yds");
    case "rush_rec_td": return n("rush_td") + n("rec_td");
    case "tackles_ast": return n("tackles_solo") + n("tackle_ast");
    case "kicking_pts": return 3 * n("fg_made") + n("pat_made");
    case "fantasy": {
      const w = FANTASY_WEIGHTS;
      const fum = n("rush_fum_lost") + n("rec_fum_lost") + n("sack_fum_lost");
      const twoPt = n("pass_2pt") + n("rush_2pt") + n("rec_2pt");
      return Number((
        w.pass_yds * n("pass_yds") + w.pass_td * n("pass_td") + w.pass_int * n("pass_int") +
        w.rush_yds * n("rush_yds") + w.rush_td * n("rush_td") +
        w.rec * n("rec") + w.rec_yds * n("rec_yds") + w.rec_td * n("rec_td") +
        w.fum_lost * fum + TWO_PT * twoPt + RETURN_TD * (n("st_td") + n("fum_rec_td"))
      ).toFixed(2));
    }
    case "pass_yds": case "pass_att": case "completions": case "pass_td": case "pass_int":
    case "rush_yds": case "rush_att": case "rec_yds": case "rec": case "targets":
    case "def_sacks": case "fg_made":
      return n(stat);
    default: return null;
  }
}

/**
 * Did the player play? nflverse weekly stats only list players who appear in
 * a play's stat columns, so a receiver with 0 targets has no row — the snap
 * counts settle that.
 * @param {{ statRow?:Object|null, snapRow?:Object|null, snapsPublished:boolean }} a
 * @returns {true|false|null}  null = can't tell yet (snap counts not out)
 */
export function playedState({ statRow = null, snapRow = null, snapsPublished }) {
  if (statRow) return true;
  if (snapRow) return (snapRow.off_snaps ?? 0) + (snapRow.def_snaps ?? 0) + (snapRow.st_snaps ?? 0) > 0;
  return snapsPublished ? false : null;
}

/**
 * @param {{ nfl_stat:string, line:number, direction:"OVER"|"UNDER" }} v
 * @param {{ statRow?:Object|null, played:boolean }} a
 * @returns {{ hit_or_miss:"hit"|"miss"|"push"|"void", reason:string|null, actual_value:number|null }}
 */
export function gradeVerdict(v, { statRow = null, played }) {
  if (!played) return { hit_or_miss: "void", reason: "dnp", actual_value: null };
  const actual = actualFor(v.nfl_stat, statRow ?? {});
  if (actual == null) return { hit_or_miss: "void", reason: "unknown_stat", actual_value: null };
  const line = Number(v.line);
  if (actual === line) return { hit_or_miss: "push", reason: null, actual_value: actual };
  const over = actual > line;
  const hit = String(v.direction).toUpperCase() === "OVER" ? over : !over;
  return { hit_or_miss: hit ? "hit" : "miss", reason: null, actual_value: actual };
}

/**
 * Per join key, the first and the last verdict priced before kickoff. The
 * last one is the closing snapshot (the gameday sweep runs inside the final
 * 90 minutes), the first is when the line was first priced.
 * @returns {Map<string, { open:Object, close:Object, n:number }>}
 */
export function openClose(verdicts) {
  const out = new Map();
  for (const v of verdicts) {
    const t = Date.parse(v._time);
    const ko = Date.parse(v.game_start_time);
    if (!Number.isFinite(t) || (Number.isFinite(ko) && t >= ko)) continue;
    const k = joinKey(v);
    const cur = out.get(k);
    if (!cur) { out.set(k, { open: v, close: v, n: 1 }); continue; }
    cur.n++;
    if (t < Date.parse(cur.open._time)) cur.open = v;
    if (t > Date.parse(cur.close._time)) cur.close = v;
  }
  return out;
}

/**
 * Closing-line value of the picked side: how far the books' price for it
 * moved between the first and the last pre-kickoff verdict (positive = the
 * market moved toward the pick). Market prices are side-specific already.
 */
export function clvFor({ open, close }) {
  const a = Number(open?.nfl_p_market), b = Number(close?.nfl_p_market);
  if (open?.nfl_p_market == null || close?.nfl_p_market == null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Number((b - a).toFixed(4));
}

/** Kickoff + this long before a game is worth settling (final + nightly nflverse build). */
export const SETTLE_AFTER_MS = 4 * 3600 * 1000;
/** Give up waiting on snap counts after this long: no stats row → void "unverified". */
export const SNAP_WAIT_MS = 7 * 86400 * 1000;
