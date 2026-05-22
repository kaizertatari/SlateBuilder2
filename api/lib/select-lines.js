// Choose which lines from a (player, stat) bucket get analyzed for a
// given direction. Pure JS — safe to import from both the API runtime
// and the browser bundle.
//
// Extracted from api/analyze-all.js so the React UI can preview the
// engine task count without re-implementing the picker.

export const ALL_ODDS_TYPES = ["goblin", "standard", "demon"];

/**
 * OVER selection (canonical order):
 *   1. Lowest-line goblin (easier OVER, discount payout)
 *   2. Standard (regular price)
 *   3. Lowest-line demon (harder OVER, boosted payout — usually
 *      pre-filter SKIPs but worth evaluating when math allows)
 *
 * UNDER selection:
 *   1. Lowest-line goblin
 *   2. Standard
 *   Demons are intentionally excluded on UNDER — a demon's higher line
 *   makes the UNDER trivially easier, which would generate inflated
 *   tier counts without representing a real edge.
 *
 * oddsTypes (optional): subset of ALL_ODDS_TYPES. When null/empty the
 * picker considers all three (back-compat). UNDER still drops demon
 * before honoring the request so the gate above is never bypassed.
 *
 * Fallback: only consider odds types in the request set — picking
 * demon-only on a bucket without a demon returns empty rather than
 * silently falling back to a goblin.
 */
export function selectLinesForStat(props, direction = "OVER", oddsTypes = null) {
  if (!Array.isArray(props) || props.length === 0) return [];
  const requested = new Set(
    Array.isArray(oddsTypes) && oddsTypes.length > 0 ? oddsTypes : ALL_ODDS_TYPES
  );
  if (direction === "UNDER") requested.delete("demon");
  if (requested.size === 0) return [];

  const lowestByType = (type) =>
    props
      .filter((p) => p.odds_type === type)
      .sort((a, b) => a.line - b.line)[0] ?? null;

  const chosen = [];
  const seenLines = new Set();
  const tryAdd = (entry) => {
    if (!entry) return;
    if (seenLines.has(entry.line)) return;
    seenLines.add(entry.line);
    chosen.push(entry);
  };
  // Canonical order keeps output stable across callers.
  for (const t of ALL_ODDS_TYPES) {
    if (requested.has(t)) tryAdd(lowestByType(t));
  }
  if (chosen.length === 0) {
    const fallback = props
      .filter((p) => requested.has(p.odds_type))
      .sort((a, b) => a.line - b.line)[0];
    if (fallback) chosen.push(fallback);
  }
  return chosen;
}
