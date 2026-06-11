// Shared string helpers used across data adapters and the ground-truth
// composer. Two normalize variants are kept on purpose:
//   - normalizeLite is for date/identifier comparisons where punctuation
//     stripping would be wrong (it only lowercases + strips diacritics).
//   - normalizeName is for player/team name comparisons; it also strips
//     suffixes like "Jr.", apostrophes, and hyphens, and collapses
//     whitespace, matching how PrizePicks/ESPN/NBA disagree on punctuation.

export function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, "0")}, ${d.getUTCFullYear()}`;
}

export function normalizeLite(s) {
  return String(s).toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").trim();
}

export function normalizeName(s) {
  return String(s)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[.'’-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
