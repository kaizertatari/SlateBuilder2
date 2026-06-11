// Regex parser for free-text injury detail strings. ESPN delivers
// injuries[].detail as prose ("Right ankle sprain", "Mild left knee
// strain — day-to-day"). Rule 6's body-region modulation (framework
// lines 218-225) needs a structured signal to decide whether to
// suppress reb counts, demote 3PM picks, etc.
//
// Returns { [playerName]: { knee, ankle, lower_leg, achilles, back,
// oblique, rib, shoulder, elbow, hand, wrist, generic } }. Each value
// is a boolean. `generic` fires when an injury is present but no
// region pattern matches — keeps callers from confusing "no injury"
// with "uncategorized injury".

const PATTERNS = {
  achilles: /\bachilles\b/i,
  lower_leg: /\blower[- ]?leg|\bcalf\b|\bshin\b/i,
  knee: /\bknee\b|\bmeniscus\b|\bACL\b|\bMCL\b/i,
  ankle: /\bankle\b/i,
  hip: /\bhip\b/i,
  back: /\bback\b|\bspine\b|\blumbar\b/i,
  oblique: /\boblique\b/i,
  rib: /\brib\b|\bribs\b/i,
  shoulder: /\bshoulder\b/i,
  elbow: /\belbow\b/i,
  hand: /\bhand\b|\bfinger\b|\bthumb\b/i,
  wrist: /\bwrist\b/i,
};

const REGION_KEYS = Object.keys(PATTERNS);

function emptyRegions() {
  const out = {};
  for (const k of REGION_KEYS) out[k] = false;
  out.generic = false;
  return out;
}

function regionsFor(detail) {
  const regions = emptyRegions();
  if (typeof detail !== "string" || !detail.trim()) return regions;
  let any = false;
  for (const k of REGION_KEYS) {
    if (PATTERNS[k].test(detail)) {
      regions[k] = true;
      any = true;
    }
  }
  if (!any) regions.generic = true;
  return regions;
}

/**
 * Parse a list of injury entries into a per-player region map. Multiple
 * entries for the same player merge with OR semantics (any region from
 * any entry counts).
 *
 * @param {Array<{player: string, detail: string}>} injuries
 * @returns {Object<string, Object<string, boolean>>}
 */
export function parseInjuryRegions(injuries) {
  const out = {};
  if (!Array.isArray(injuries)) return out;
  for (const entry of injuries) {
    const name = entry?.player;
    if (!name) continue;
    const regions = regionsFor(entry.detail);
    if (out[name]) {
      // OR-merge into existing map (multiple injury entries per player).
      for (const k of Object.keys(regions)) {
        if (regions[k]) out[name][k] = true;
      }
    } else {
      out[name] = regions;
    }
  }
  return out;
}

// Regions historically associated with reduced minutes / load management
// even without an explicit "minutes restriction" string. Used by the
// mechanism-1 detector when the detail text is bare ("knee soreness").
export const MINUTES_LIMITING_REGIONS = new Set([
  "achilles", "lower_leg", "knee", "ankle", "hip", "back",
]);
