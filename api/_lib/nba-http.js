// Shared HTTP scaffolding for stats.nba.com endpoints.
//
// Two libs hit stats.nba.com (nba-stats, matchup-defender) and a third may
// follow. The headers, timeout, and null-on-failure contract were duplicated
// across them; this file is the single place to fix when stats.nba.com
// tightens its bot detection or rotates header expectations.

import { logPrefix } from "./request-context.js";
import { logEvent } from "./verdict-logger.js";

export const NBA_BASE = "https://stats.nba.com/stats";
export const WNBA_BASE = "https://stats.wnba.com/stats";

function baseFor(leagueId) {
  return leagueId === "10" ? WNBA_BASE : NBA_BASE;
}

// stats.nba.com checks these specific x-nba-stats-* headers and a browser-y
// User-Agent; missing any of them yields a silent 4xx. stats.wnba.com expects
// the same shape but with wnba.com Origin/Referer.
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

export const WNBA_HEADERS = {
  ...NBA_HEADERS,
  "Origin": "https://www.wnba.com",
  "Referer": "https://www.wnba.com/",
};

function headersFor(leagueId) {
  return leagueId === "10" ? WNBA_HEADERS : NBA_HEADERS;
}

// Vercel egress IPs are often silently dropped by stats.nba.com (no response,
// not a 4xx). Without a timeout, each call hangs until Node's socket timeout
// fires (~60-120s). 6s is enough for a healthy response from a working IP
// and short enough to not dominate orchestrator latency.
export const NBA_FETCH_TIMEOUT_MS = 6000;

export async function nbaFetch(endpoint, params, opts = {}) {
  const leagueId = opts.leagueId ?? params?.LeagueID ?? "00";
  const base = baseFor(leagueId);
  const headers = headersFor(leagueId);
  const qs = new URLSearchParams(params).toString();
  const url = `${base}/${endpoint}?${qs}`;
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(NBA_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 408/429 and 4xx from Vercel-IP throttling are expected weather;
      // 5xx is a real outage. Severity reflects that so dashboards don't
      // look red every time stats.nba.com declines us.
      const level = res.status >= 500 ? "error" : "warn";
      console.error(`${logPrefix()}${base} ${endpoint} ${res.status}`);
      logEvent({
        level,
        source: "nba-http",
        message: `${base} ${endpoint} HTTP ${res.status}`,
        errorStatus: res.status,
        context: { url, league_id: leagueId },
      });
      return null;
    }
    return await res.json();
  } catch (err) {
    // AbortError = our own 6s timeout firing (Vercel-IP throttle), which
    // is the dominant failure mode on this edge — classify as warn.
    const isTimeout = err.name === "AbortError" || /timeout/i.test(err.message);
    console.error(`${logPrefix()}${base} ${endpoint} threw:`, err.message);
    logEvent({
      level: isTimeout ? "warn" : "error",
      source: "nba-http",
      message: `${base} ${endpoint} threw: ${err.message}`,
      errorName: err.name,
      context: { url, league_id: leagueId, timeout_ms: NBA_FETCH_TIMEOUT_MS },
    });
    return null;
  }
}

export function rowToObj(headers, row) {
  return Object.fromEntries(headers.map((h, i) => [h, row[i]]));
}

export function findResultSet(payload, name) {
  return payload?.resultSets?.find((rs) => rs.name === name) ?? null;
}
