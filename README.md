# nba-model-free

NBA PrizePicks verdict engine. A React + Vite UI calls a single Vercel
Function (`api/analyze.js`) that gathers ground-truth stats, hands them to
Gemini under the v3.3 framework, and returns a tiered verdict.

## Setup

```bash
cp .env.example .env.local
# fill in GOOGLE_API_KEY and BALLDONTLIE_API_KEY
npm install
npm run dev          # Vite frontend
vercel dev           # frontend + functions (recommended)
```

## Environment

| Var | Where used | Required |
| --- | --- | --- |
| `GOOGLE_API_KEY` | server only — `api/analyze.js` calls Gemini | yes |
| `BALLDONTLIE_API_KEY` | server only — fallback for stats.nba.com | yes |
| `RATE_LIMIT_WINDOW_MS` | server only — rate limit window size in milliseconds | no (default: 60000) |
| `RATE_LIMIT_MAX_REQUESTS` | server only — max requests per rate limit window | no (default: 10) |
| `GEMINI_PRIMARY_MODEL` | server only — primary Gemini model for analysis | no (default: gemini-2.5-flash) |
| `GEMINI_FALLBACK_MODEL` | server only — fallback Gemini model if primary fails | no (default: gemini-2.5-flash-lite) |
| `GEMINI_PRIMARY_DELAYS` | server only — comma-separated delays between Gemini retries (ms) | no (default: 0,500,1500) |
| `GEMINI_FALLBACK_DELAY` | server only — delay before trying fallback model (ms) | no (default: 500) |

Both are server-side only. Do **not** prefix with `VITE_`; that would publish
the key in the client bundle.

## Error Handling

The application implements structured error handling with specific error types:

- **ConfigurationError**: Missing or invalid configuration (API keys, etc.)
- **ValidationError**: Invalid request parameters
- **RateLimitError**: Too many requests (includes Retry-After header)
- **ExternalAPIError**: Failures in external APIs (stats.nba.com, ESPN, etc.)
- **LLMError**: Failures in the Gemini AI model
- **DataNotFoundError**: Required data not found

All errors return appropriate HTTP status codes and include retry information when applicable.

## API Endpoint

### POST /api/analyze

Analyzes a player prop and returns a verdict with confidence score.

#### Request Body
```json
{
  "player": "string", // Player name (e.g., "LeBron James")
  "propType": "string", // Prop type with OVER/UNDER (e.g., "Points OVER")
  "line": "number" // Prop line value (e.g., 25.5)
}
```

#### Response Body
```json
{
  "verdict": "OVER" | "UNDER" | "SKIP",
  "tier": "S" | "A" | "B" | "SKIP",
  "confidence": "integer (0-100)",
  "justification": "string (2-3 sentences explaining the decision)",
  "flags": "array of strings (contextual warnings or notes)",
  "data_used": {
    "season_avg": "number or null",
    "l5_avg": "number or null", 
    "home_away": "\"home\" | \"away\"",
    "win_prob": "number (0-1) or null",
    "opponent": "string",
    "game_context": "string"
  },
  "ground_truth": { /* detailed data used for analysis */ }
}
```

#### Error Responses
- `400`: Missing required fields or invalid prop type
- `429`: Rate limit exceeded (10 requests/minute/IP)
- `500`: Server error (missing API key, external API failure, etc.)

## Environment

| Var | Where used | Required |
| --- | --- | --- |
| `GOOGLE_API_KEY` | server only — `api/analyze.js` calls Gemini | yes |
| `BALLDONTLIE_API_KEY` | server only — fallback for stats.nba.com | yes |

Both are server-side only. Do **not** prefix with `VITE_`; that would publish
the key in the client bundle.

## Data-source cascade

For each request the orchestrator tries upstreams in order, returning `null`
on failure so the next tier can take over:

```
identity      stats.nba.com (commonplayerinfo) → balldontlie /players
season avg    stats.nba.com (playerdashboard)  → ESPN gamelog
last-N games  stats.nba.com (playergamelog)    → ESPN gamelog
splits        stats.nba.com only (regular season)
schedule      ESPN scoreboard
win prob      ESPN BPI predictor → ESPN probabilities
injuries      ESPN /injuries (SWR-cached league-wide)
```

stats.nba.com 403s frequently from Vercel egress IPs — the ESPN/balldontlie
fallback is the normal path on prod, not an emergency backup.

## SKIP semantics

A response of `verdict: "SKIP"` means the framework cannot evaluate the prop:

- `player_not_configured` — name not in `data/players.json`
- `player_lookup_failed` — both stats.nba.com and balldontlie returned nothing
- `schedule_unavailable` — ESPN scoreboard is down
- `no_upcoming_game` — team has no game in the next 7 days
- `Missing required data: …` — one of `season_avg`, `l5_avg`, `home_away`,
  `opponent`, or `win_prob` is null after the cascade

SKIP is not a bad pick — it's the model declining to answer.

## Smoke test

End-to-end against live Gemini, including a hallucination check that compares
`data_used` back to `groundTruth`:

```bash
node scripts/smoke-gemini.mjs "Nikola Jokic" "PRA OVER" 40.5 | tail -n 40
```

The verdict block at the end carries the parsed result, the raw JSON, and the
grounded-vs-output comparison.

## Development

### Available Scripts
- `npm run dev` - Start Vite frontend development server
- `vercel dev` - Start both frontend and Vercel functions (recommended)
- `npm run build` - Build for production (now includes TypeScript compilation)
- `npm run preview` - Preview production build locally
- `npm run test` - Run Vitest tests in interactive mode
- `npm run test:run` - Run Vitest tests once and exit
- `npm run test:watch` - Run Vitest tests in watch mode
- `npm run typecheck` - Run TypeScript type checking

### Data Refresh Scripts
- `npm run refresh-players` - Update playoff players list
- `npm run refresh-prizepicks` - Refresh PrizePicks lines data
- `npm run refresh-team-defense` - Update team defense statistics
- Various smoke tests for validating different components
