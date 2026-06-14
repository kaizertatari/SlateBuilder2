# PrizePicks Integration

## Overview
Integrate PrizePicks NBA lines with the existing Slate Builder app. Scrape PrizePicks API for today's NBA games, match player names to `players.json`, and provide batch analysis with a top 10 S/A tier results table.

## Current State (last verified 2026-05-04)

The integration is shipped end-to-end. Known gaps (kept here so they don't rot into "future enhancements"):

- **Production data is stale until next deploy.** `data/prizepicks-lines.json` is read from the deployed bundle. Running `npm run refresh-prizepicks` locally has no effect on prod. A `/api/refresh-lines` endpoint plus a writable store (Vercel Blob / Edge Config) is the long-term fix; an interim fix using `/tmp` is in place — see "Production data freshness" below.
- **Combo / fantasy stat types are dropped.** Anything outside the `STATS` whitelist (`Fantasy Score`, `Turnovers`, `Steals+Blocks`, etc.) is silently filtered out by the default. See "Stat Type Mapping → Dropped by default."
- **Rate limit on `/api/analyze-all` is 3/min/IP** — tight for iteration. Bump in `api/analyze-all.js` if needed.

---

## Phase 1: PrizePicks Scraper

### Files Created:
- `scripts/scrape-prizepicks.mjs` - Main scraper logic
- `scripts/refresh-prizepicks.mjs` - CLI wrapper with logging
- `api/lines.js` - API endpoint for serving scraped lines

### Files Modified:
- `package.json` - Added `refresh-prizepicks` npm script

### Features Implemented:
- Fetches from `https://api.prizepicks.com/projections?league_id=7&per_page=250&single_stat=true`
- Filters to today's games by comparing `start_time` date with current date
- Normalizes player names and matches to `players.json` keys
- Handles combo players (e.g., "CLE/DET" format)
- Outputs to `data/prizepicks-lines.json`

### Test Results:
```
npm run refresh-prizepicks
→ 1902 props scraped for 70 players
→ Games: CLE@DET, DET@CLE, LAL@OKC, OKC@LAL
```

---

### `/api/lines` — Filtered read

`GET /api/lines` serves the scraped JSON with optional query filters:

| Query param | Effect |
|-------------|--------|
| `player`    | Substring match against player names (case-insensitive). Clears `games`. |
| `stat`      | Exact match (case-insensitive) on `stat_type` (e.g. `Points`, `Pts+Rebs+Asts`). |
| `opponent`  | Exact-uppercase match on opponent abbreviation (e.g. `LAL`). |
| `game`      | Exact match on `away@home` game key (e.g. `LAL@OKC`). |

Example: `GET /api/lines?player=cunningham&stat=Points`

Returns `{ fetched_at, filters, data: { by_player, games }, total_props, total_players }`.

---

## Phase 2: Batch Analysis Endpoint

### File Created:
- `api/analyze-all.js` - New endpoint for batch analysis

### Features Implemented:
- **Endpoint:** `POST /api/analyze-all`
- **Request Body:**
  ```json
  {
    "player": "Cade Cunningham",          // required
    "statTypes": ["Points", "Rebounds"],  // optional; default = STATS whitelist
    "direction": "OVER"                   // optional; if omitted, BOTH OVER and UNDER are analyzed
  }
  ```
- Filters today's PrizePicks lines to one player, then groups by stat type. PrizePicks publishes 1–7 lines per (player, stat) — the endpoint picks the line **closest to the player's season average** (via `groundTruth.season.averages[PROP_TO_FIELD[stat]]`) and analyzes only that line.
- One ground-truth fetch per (player, stat) bucket, reused across both directions when both are requested. The cached `groundTruth` is threaded through to `analyzeSingle`, which overrides `prop_type` and `line` per task before building the prompt.
- Caps at `MAX_LINES` Gemini calls per request (currently 25) — for a single-player request, real task counts are typically 5–9 (one direction) or 10–18 (both), so the cap is a safety net.
- Calls `gatherGroundTruth()`, `buildPrompt()`, and `callGemini()` from `api/analyze.js`.
- Runs analyses sequentially (`CONCURRENCY = 1`) to stay under Gemini's free-tier 20 req/min quota; the retry chain in `callGemini` can issue up to 4 requests per failed task, so higher concurrency trips the quota.
- Filters results to S and A tiers only.
- Sorts by tier (S before A), then confidence (desc).
- Returns top 10 results, with `errors` (per-task Gemini failures) and `skipped` (per-bucket ground-truth failures) surfaced for debugging.

### Response Format:
```json
{
  "total_analyzed": 10,
  "total_s_a": 8,
  "top_10": [
    {
      "player": "Cade Cunningham",
      "game": "DET @ CLE",
      "prop_type": "Points",
      "direction": "OVER",
      "line": 28.5,
      "verdict": "OVER",
      "tier": "S",
      "confidence": 95,
      "justification": "Season avg 28.1..."
    }
  ]
}
```

### Modifications to `api/analyze.js`:
- Line 277: Added `export` to `callGemini` function for reuse

---

## Phase 3: Frontend Modifications

### File Modified:
- `src/App.jsx` - Complete rewrite for batch analysis workflow

### Changes Made:

#### 3.1 State Changes
| Old State | New State | Change |
|----------|----------|-------|
| `stat` (string) | `selectedStats` (array) | Multi-select, default: all STATS |
| `direction` (string) | `direction` (string) | Single choice: OVER or UNDER (radio buttons) |
| `line` (string) | REMOVED | Uses PrizePicks lines automatically |
| `result` (object) | `results` (array) | Holds multiple analysis results |
| `loading` (boolean) | `analyzing` (boolean) | Renamed for clarity |

#### 3.2 Player Select
- Added "ALL PLAYERS" option (no filter)
- Search/filter functionality preserved
- Dropdown with autocomplete

#### 3.3 Stat Type Multi-Select
- Checkbox group UI for selecting multiple stat types
- "Select All" toggle button
- Default: All STATS selected (Points, Rebounds, Assists, PRA, PR, PA, RA, 3-Pointers Made, FG Attempted)
- Only STATS array types are included (PRA maps to "Pts+Rebs+Asts")

#### 3.4 Direction Radio Buttons
- OVER / UNDER choice (single selection)
- Default: OVER
- Removed the dropdown select

#### 3.5 Results Table
- Displays top 10 S/A tier results (or fewer if less available)
- Columns: #, Player, Game, Prop Type, Line, Verdict, Tier, Confidence%
- Color-coded: S-Tier (gold), A-Tier (green)
- Verdict symbol: ▲ for OVER, ▼ for UNDER
- Expandable justifications below table

#### 3.6 Removed Elements
- Line input field (no longer needed - uses PrizePicks lines)
- Single result card display
- Unused direction dropdown

---

## Stat Type Mapping

### PrizePicks → Internal (passes the default filter)
| PrizePicks Stat | Internal STATS Value | PROP_TO_FIELD Key |
|-----------------|----------------------|-------------------|
| Points | Points | ppg |
| Rebounds | Rebounds | rpg |
| Assists | Assists | apg |
| Pts+Rebs+Asts | PRA | pra |
| Pts+Rebs | PR | pr |
| Pts+Asts | PA | pa |
| Rebs+Asts | RA | ra |
| 3-PT Made | 3-Pointers Made | fg3m |
| FG Attempted | FG Attempted | fga |

### Dropped by default
PrizePicks publishes additional stat types that the model framework does not score. These are silently filtered out unless the request explicitly includes them in `statTypes` AND a corresponding `PROP_TO_FIELD` entry exists. Common drops:

- `Fantasy Score`
- `Turnovers`
- `Blocked Shots`
- `Steals`
- `Steals+Blocks`
- `Free Throws Made`
- Combo / specialty types (e.g., `Pts+Rebs+Asts (Combo)`, period-specific lines)

If a prop you expect doesn't appear in results, check whether its `stat_type` is in the table above before debugging deeper.

### Filtering Logic
- Default (no `statTypes` provided): only include the STATS whitelist above.
- Custom `statTypes`: each entry must map to a known internal type and have a `PROP_TO_FIELD` key, otherwise it's dropped.

---

## Data Flow

```
User selects: Player="Cade Cunningham", Stats=[Points, Rebounds], Direction=OVER
              ↓
Frontend calls: POST /api/analyze-all
  Body: { player: "Cade Cunningham", statTypes: ["Points", "Rebounds"], direction: "OVER" }
              ↓
Backend:
  1. Read prizepicks-lines.json
  2. Filter: player="Cade Cunningham", statTypes=[Points, Rebounds]
  3. Found 14 lines (7 Points + 7 Rebounds lines)
  4. Limit to 10 most relevant lines
  5. For each line, analyze OVER direction only
  6. Call gatherGroundTruth() → buildPrompt() → callGemini()
  7. Filter S/A tier → e.g., 8 results
  8. Sort by confidence → ranked
  9. Return top 10
              ↓
Frontend displays table with 8-10 rows (S/A tier only)
```

---

## Usage Instructions

### 1. Scrape Today's Lines
```bash
npm run refresh-prizepicks
```
This fetches current PrizePicks lines for today's NBA games and saves to `data/prizepicks-lines.json`.

### 2. Run the App
```bash
npm run dev
```
Open `http://localhost:5173` (or Vercel URL in production)

### 3. Analyze Props
1. Select a player OR "ALL PLAYERS"
2. Select stat types (multiple checkboxes, or "Select All")
3. Choose direction: OVER or UNDER
4. Click "ANALYZE ALL LINES"
5. View top 10 S/A tier results in table

---

## Files Summary

| File | Action | Description |
|------|--------|-------------|
| `scripts/scrape-prizepicks.mjs` | ✅ CREATED | Main PrizePicks scraper |
| `scripts/refresh-prizepicks.mjs` | ✅ CREATED | CLI wrapper with logging |
| `api/lines.js` | ✅ CREATED | API endpoint for lines data |
| `api/analyze-all.js` | ✅ CREATED | Batch analysis endpoint |
| `api/analyze.js` | ✅ MODIFIED | Exported `callGemini` function |
| `src/App.jsx` | ✅ MODIFIED | Complete UI rewrite for batch analysis |
| `package.json` | ✅ MODIFIED | Added `refresh-prizepicks` script |
| `data/prizepicks-lines.json` | ✅ OUTPUT | Scraped lines data |

---

## Production data freshness

`data/prizepicks-lines.json` is bundled at deploy time. On Vercel, only `/tmp` is writable at runtime, and `/tmp` is per-instance and ephemeral.

Current behavior (`api/_lib/lines-store.js`):
1. On read, prefer `/tmp/prizepicks-lines.json` if present (warm-instance cache).
2. Fall back to the bundled `data/prizepicks-lines.json` from the deploy.
3. `POST /api/refresh-lines` (token-guarded via `REFRESH_TOKEN`) re-runs the scraper and writes to `/tmp` so subsequent reads on that instance are fresh.

Caveats:
- Cache is per Fluid Compute instance; warm instances see fresh data, cold ones see deploy-time data until refreshed.
- For durable cross-instance freshness, replace the `/tmp` path with Vercel Blob or Edge Config — `lines-store.js` is the single seam to swap.
- Pair `/api/refresh-lines` with a Vercel Cron (e.g. hourly) once the durable store is in place.

## Known Limitations

1. **Stat Type Coverage**: Only the STATS whitelist is analyzed; see "Dropped by default" above.
2. **Player Name Matching**: Combo entries like `"Cade Cunningham + James Harden"` are split on `+` and matched on the first component; if neither component is in `players.json`, the prop is kept but `player_key`/`nba_id` stay `null`.
3. **Rate Limiting**: Stricter rate limit on `/api/analyze-all` (3 requests per minute per IP).
4. **Cross-instance freshness**: see "Production data freshness."

---

## Future Enhancements

1. Replace `/tmp` cache with Vercel Blob or Edge Config in `api/_lib/lines-store.js` for durable cross-instance freshness.
2. Add a Vercel Cron that hits `/api/refresh-lines` hourly during NBA hours.
3. Add caching for Gemini results to avoid re-analyzing identical (player, prop_type, line) tuples.
4. Add "Refresh Lines" button in UI that calls `/api/refresh-lines` (token-guarded).
5. Confidence threshold filter in UI (e.g., only show 90%+).
6. Export feature (CSV/JSON download of results).
7. Support NFL props (PrizePicks also publishes NFL).

---

## Single-player scope

The endpoint deliberately accepts only one player per request:

- **Quality**: a player's `season.averages` drives line selection — a single ground-truth fetch covers every (stat, direction) for that player.
- **Cost**: ~5–9 Gemini calls per request (one direction) or 10–18 (both), comfortably under free-tier 20 req/min.
- **Latency**: ~30–60 s wall time at `CONCURRENCY = 1`.

For multi-player coverage, run separate requests sequentially.

---

## Verification (end-to-end)

On a fresh checkout:

1. `npm install`
2. `npm run refresh-prizepicks` → check `data/prizepicks-lines.json` has `total_props > 0` and `fetched_at` is current.
3. `npm run dev` → open `http://localhost:5173`.
4. Pick a player whose props appear in the JSON (e.g. `Cade Cunningham` if DET is on the slate), leave stats on default, choose `OVER`, click `ANALYZE ALL LINES`.
5. Expect a results panel with `total_analyzed > 0`. If `total_s_a == 0`, the framework correctly tagged everything as B/SKIP — try a different player.
6. Smoke `/api/lines`: `curl 'http://localhost:5173/api/lines?player=cunningham'` → JSON with `by_player`.
7. Smoke `/api/refresh-lines` (if `REFRESH_TOKEN` is set in `.env.local`): `curl -X POST -H "Authorization: Bearer $REFRESH_TOKEN" http://localhost:5173/api/refresh-lines` → 200 with `total_props`.
