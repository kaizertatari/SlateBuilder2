// Shared HTTP scaffolding for stats.nba.com endpoints.
//
// Two libs hit stats.nba.com (nba-stats, matchup-defender) and a third may
// follow. The headers, timeout, and null-on-failure contract were duplicated
// across them; this file is the single place to fix when stats.nba.com
// tightens its bot detection or rotates header expectations.

import { logPrefix } from "./request-context.ts";

export const NBA_BASE = "https://stats.nba.com/stats";

// stats.nba.com checks these specific x-nba-stats-* headers and a browser-y
// User-Agent; missing any of them yields a silent 4xx.
export const NBA_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin": "https://www.nba.com",
  "Referer": "https://www.nba.com/",
  "x-nba-stats-origin": "stats",
  "x-nba-stats-token": "true",
  "Connection": "keep-alive",
};

// Vercel egress IPs are often silently dropped by stats.nba.com (no response,
// not a 4xx). Without a timeout, each call hangs until Node's socket timeout
// fires (~60-120s). 6s is enough for a healthy response from a working IP
// and short enough to not dominate orchestrator latency.
export const NBA_FETCH_TIMEOUT_MS = 6000;

export async function nbaFetch(endpoint, params) {
  const qs = new URLSearchParams(params).toString();
  const url = `${NBA_BASE}/${endpoint}?${qs}`;
  try {
    const res = await fetch(url, {
      headers: NBA_HEADERS,
      signal: AbortSignal.timeout(NBA_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`${logPrefix()}stats.nba.com ${endpoint} ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`${logPrefix()}stats.nba.com ${endpoint} threw:`, err.message);
    return null;
  }
}

export function rowToObj(headers, row) {
  return Object.fromEntries(headers.map((h, i) => [h, row[i]]));
}

export function findResultSet(payload, name) {
  return payload?.resultSets?.find((rs) => rs.name === name) ?? null;
}
