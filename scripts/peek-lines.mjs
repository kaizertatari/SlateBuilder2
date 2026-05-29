// Inspect data/prizepicks-lines.json WITHOUT opening the whole file.
//
// The bundled slate snapshot is ~2 MB / 70k lines — reading it whole in an
// editor or a Claude Code `Read` blows the session context. This prints a
// compact summary or a filtered slice instead.
//
// Usage:
//   node scripts/peek-lines.mjs                  # slate summary
//   node scripts/peek-lines.mjs "Wembanyama"     # one player's props (substring, case-insensitive)
//   node scripts/peek-lines.mjs --stat "Points"  # all props for a stat type
//   node scripts/peek-lines.mjs --json           # machine-readable summary

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(REPO_ROOT, "data", "prizepicks-lines.json");

function loadSlate() {
  if (!fs.existsSync(FILE)) {
    console.error(`Not found: ${FILE}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(FILE, "utf8");
  const slate = JSON.parse(raw);
  const games = slate.games ?? {};
  const props = [];
  for (const [key, g] of Object.entries(games)) {
    for (const p of g.props ?? []) props.push({ ...p, game_key: key });
  }
  return { slate, games, props, bytes: Buffer.byteLength(raw) };
}

function isCombo(p) {
  return /\s\+\s/.test(p.player ?? "") || /\(combo\)/i.test(p.stat_type ?? "");
}

function tallyBy(props, keyFn) {
  const m = new Map();
  for (const p of props) m.set(keyFn(p), (m.get(keyFn(p)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function fmtProp(p) {
  return `  ${p.game_key.padEnd(9)} ${String(p.stat_type).padEnd(22)} ${String(p.line).padStart(6)} ${String(p.odds_type).padEnd(9)} ${p.player}`;
}

function main() {
  const args = process.argv.slice(2);
  const { slate, games, props, bytes } = loadSlate();

  const jsonMode = args.includes("--json");
  const statIdx = args.indexOf("--stat");
  const statFilter = statIdx >= 0 ? args[statIdx + 1] : null;
  const playerFilter = args.find((a) => !a.startsWith("--") && a !== statFilter) ?? null;

  if (playerFilter) {
    const q = playerFilter.toLowerCase();
    const hits = props.filter((p) => String(p.player).toLowerCase().includes(q));
    console.log(`${hits.length} prop(s) matching "${playerFilter}":`);
    hits.sort((a, b) => a.game_key.localeCompare(b.game_key) || String(a.stat_type).localeCompare(String(b.stat_type)));
    hits.forEach((p) => console.log(fmtProp(p)));
    return;
  }

  if (statFilter) {
    const q = statFilter.toLowerCase();
    const hits = props.filter((p) => String(p.stat_type).toLowerCase() === q);
    console.log(`${hits.length} prop(s) with stat_type == "${statFilter}":`);
    hits.sort((a, b) => a.line - b.line);
    hits.forEach((p) => console.log(fmtProp(p)));
    return;
  }

  const combos = props.filter(isCombo).length;
  const summary = {
    file: path.relative(REPO_ROOT, FILE),
    size_kb: Math.round(bytes / 1024),
    fetched_at: slate.fetched_at ?? null,
    games: Object.keys(games).length,
    props: props.length,
    combo_props: combos,
    unique_players: new Set(props.map((p) => p.player)).size,
    leagues: tallyBy(props, (p) => p.league ?? "?"),
    by_stat: tallyBy(props, (p) => p.stat_type ?? "?"),
    by_odds_type: tallyBy(props, (p) => p.odds_type ?? "?"),
  };

  if (jsonMode) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`=== ${summary.file} (${summary.size_kb} KB) ===`);
  console.log(`fetched_at: ${summary.fetched_at}`);
  console.log(`games: ${summary.games}   props: ${summary.props}   unique players: ${summary.unique_players}   combos: ${summary.combo_props}`);
  console.log(`leagues: ${summary.leagues.map(([k, n]) => `${k}=${n}`).join("  ")}`);
  console.log(`odds types: ${summary.by_odds_type.map(([k, n]) => `${k}=${n}`).join("  ")}`);
  console.log(`by stat_type:`);
  for (const [k, n] of summary.by_stat) console.log(`  ${String(k).padEnd(24)} ${n}`);
  console.log(`\nTip: node scripts/peek-lines.mjs "<player>"   |   --stat "<stat>"   |   --json`);
}

main();
