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
