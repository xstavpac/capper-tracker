// The Bot Guide (/docs/bot): every fact it states is pinned to the endpoint's real code, and the page renders.
//   1. Limits: picks/request, body size, field lengths (through the real validateApiPicksBody), requests a minute,
//      bad-token attempts per IP, active tokens, the route's maxDuration, the token prefix.
//   2. Reasons: every rejection reason the endpoint has is either explained or deliberately left out (compile-time
//      exhaustive), and the HTTP rows name the route's real error codes.
//   3. Examples: the request body and the curl body pass validateApiPicksBody; the sample response is the real result
//      shape, key order included (canonicalApiPickResult leaves it unchanged).
//   4. The page: renders every section, links back to /settings and on to /picks/import, never names the real-time-only
//      reason, and the route file exists where Settings links.
// Pure - no DB (prisma is imported but never queried). Run with:
//   node --require ./scripts/server-only-stub.cjs --import tsx src/components/docs/bot-guide-acceptance-test.ts
import { existsSync, readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LineRejectReason } from "@/lib/ingest-line-outcome";
import { API_TOKEN_PREFIX } from "@/lib/api-token-format";
import { API_TOKEN_REQUESTS_PER_MINUTE, BEARER_FAILURES_PER_IP_PER_MINUTE } from "@/server/api-bearer-auth";
import { API_PICKS_MAX_BODY_BYTES, API_PICKS_MAX_PICKS, validateApiPicksBody } from "@/server/data/api-picks";
import { MAX_ACTIVE_API_TOKENS } from "@/server/data/api-tokens";
import { canonicalApiPickResult, isApiPickResult } from "@/lib/api-pick-result";
import {
  BOT_API_URL,
  BOT_LIMITS,
  BOT_TOKEN_PREFIX,
  CURL_EXAMPLE,
  EXAMPLE_BODY,
  EXAMPLE_RESPONSE,
  HTTP_ROWS,
  REJECT_REASONS,
  REJECT_REASONS_NOT_FOR_TOKENS,
  REJECT_REASONS_SHOWN,
  REVIEW_REASONS,
} from "@/lib/bot-guide-content";
import { BotGuide } from "@/components/docs/bot-guide";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}
const eq = (label: string, actual: unknown, expected: unknown) =>
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);

// ---- 1 · Limits -----------------------------------------------------------------------------------------------
eq("picks per request", BOT_LIMITS.maxPicksPerRequest, API_PICKS_MAX_PICKS);
eq("body KB", BOT_LIMITS.maxBodyKb * 1024, API_PICKS_MAX_BODY_BYTES);
eq("requests a minute", BOT_LIMITS.requestsPerMinute, API_TOKEN_REQUESTS_PER_MINUTE);
eq("bad-token attempts per IP", BOT_LIMITS.badTokenAttemptsPerMinute, BEARER_FAILURES_PER_IP_PER_MINUTE);
eq("active tokens", BOT_LIMITS.maxActiveTokens, MAX_ACTIVE_API_TOKENS);
eq("token prefix", BOT_TOKEN_PREFIX, API_TOKEN_PREFIX);
const routeSrc = readFileSync("src/app/api/v1/picks/route.ts", "utf8");
check("route maxDuration matches the timeout advice", routeSrc.includes(`export const maxDuration = ${BOT_LIMITS.timeoutSeconds};`));
check("URL is the /api/v1/picks route", BOT_API_URL.endsWith("/api/v1/picks"));

const pick = (client_id: string, text: string) => ({ client_id, text });
const valid = (b: unknown) => validateApiPicksBody(b).ok;
const n = (len: number) => "x".repeat(len);
check("capper at the stated max is accepted", valid({ capper: n(BOT_LIMITS.maxCapperChars), picks: [pick("a", "Yankees ML")] }));
check("capper over the max is refused", !valid({ capper: n(BOT_LIMITS.maxCapperChars + 1), picks: [pick("a", "Yankees ML")] }));
check("client_id at the max is accepted", valid({ capper: "C", picks: [pick(n(BOT_LIMITS.maxClientIdChars), "Yankees ML")] }));
check("client_id over the max is refused", !valid({ capper: "C", picks: [pick(n(BOT_LIMITS.maxClientIdChars + 1), "Yankees ML")] }));
check("text at the max is accepted", valid({ capper: "C", picks: [pick("a", n(BOT_LIMITS.maxTextChars))] }));
check("text over the max is refused", !valid({ capper: "C", picks: [pick("a", n(BOT_LIMITS.maxTextChars + 1))] }));
const many = (k: number) => Array.from({ length: k }, (_, i) => pick("id" + i, "Yankees ML"));
check("max picks accepted", valid({ capper: "C", picks: many(BOT_LIMITS.maxPicksPerRequest) }));
check("one over max picks refused", !valid({ capper: "C", picks: many(BOT_LIMITS.maxPicksPerRequest + 1) }));
check("repeated client_id refused", !valid({ capper: "C", picks: [pick("a", "Yankees ML"), pick("a", "Mets ML")] }));

// ---- 2 · Reasons --------------------------------------------------------------------------------------------------
// Compile-time: adding a LineRejectReason without placing it here fails tsc.
const placed: Record<LineRejectReason | "game_not_scheduled_yet", "shown" | "not_for_tokens"> = {
  combined_pick: "shown",
  league_not_allowed: "shown",
  duplicate: "shown",
  duplicate_in_request: "shown",
  pick_limit: "shown",
  no_game_found: "shown",
  doubleheader_final: "shown",
  game_already_final: "not_for_tokens",
  invalid_odds: "shown",
  total_without_line: "shown",
  unparseable: "shown",
  no_capper: "not_for_tokens",
  parlay_not_supported: "shown",
  error: "shown",
  game_not_scheduled_yet: "shown",
};
eq(
  "shown reasons are exactly the 'shown' set",
  [...REJECT_REASONS_SHOWN].sort(),
  Object.keys(placed).filter((k) => placed[k as keyof typeof placed] === "shown").sort()
);
eq(
  "left-out reasons are exactly the 'not_for_tokens' set",
  [...REJECT_REASONS_NOT_FOR_TOKENS].sort(),
  Object.keys(placed).filter((k) => placed[k as keyof typeof placed] === "not_for_tokens").sort()
);
eq("every shown reason is explained", Object.keys(REJECT_REASONS).sort(), [...REJECT_REASONS_SHOWN].sort());
eq("review reasons", Object.keys(REVIEW_REASONS).sort(), ["ambiguous_player", "ambiguous_team", "capper_name", "far_future_game", "missing_total_line"]);
const authSrc = readFileSync("src/server/api-bearer-auth.ts", "utf8");
const rateSrc = readFileSync("src/lib/rate-limit.ts", "utf8");
const allSrc = routeSrc + authSrc + rateSrc;
for (const r of HTTP_ROWS.filter((r) => r.code !== 200)) {
  const code = /"error": "([a-z_]+)"/.exec(r.body)?.[1] ?? "";
  check(`HTTP ${r.code} error code "${code}" is in the endpoint code`, code !== "" && allSrc.includes(`"${code}"`));
}
check("429 names retryAfterSeconds (rate-limit.ts)", rateSrc.includes("retryAfterSeconds") && HTTP_ROWS.some((r) => r.code === 429 && r.body.includes("retryAfterSeconds")));
check("400 names detail (route.ts)", routeSrc.includes('error: "invalid_request", detail') && HTTP_ROWS.some((r) => r.code === 400 && r.body.includes("detail")));

// ---- 3 · Examples -------------------------------------------------------------------------------------------------
check("request body example is valid", valid(JSON.parse(EXAMPLE_BODY)));
const curlBody = /-d '([\s\S]*)'$/.exec(CURL_EXAMPLE)?.[1];
check("curl body is valid", !!curlBody && valid(JSON.parse(curlBody)));
check("curl sends the bearer header", CURL_EXAMPLE.includes('-H "Authorization: Bearer $BETTINGVIEW_TOKEN"'));
const response = JSON.parse(EXAMPLE_RESPONSE) as { results: unknown[] };
eq("sample response statuses", response.results.map((r) => (r as { status: string }).status), ["accepted", "needs_review", "rejected"]);
for (const r of response.results) {
  check("sample result has the real shape", isApiPickResult(r));
  if (isApiPickResult(r)) eq(`sample ${r.status} is in the endpoint's key order`, canonicalApiPickResult(r), r);
}

// ---- 4 · The page -------------------------------------------------------------------------------------------------
// tsx compiles JSX to React.createElement (classic runtime): the components need React as a global here.
(globalThis as unknown as { React: typeof React }).React = React;
const html = renderToStaticMarkup(React.createElement(BotGuide));
for (const id of ["token", "request", "format", "matching", "response", "limits", "prompting"]) {
  check(`section #${id} renders and is in the nav`, html.includes(`id="${id}"`) && html.includes(`href="#${id}"`));
}
check("links to Settings", html.includes('href="/settings"'));
check("links to Catalog Import", html.includes('href="/picks/import"'));
check("mentions Needs review", html.includes("Needs review"));
check("says picks after the start are accepted", html.includes("Picks sent after a game has started are accepted"));
check("never names a real-time-only reason", !html.includes("game_already_final") && !html.includes("no_capper"));
check("support note", html.includes("can&#x27;t help set it up or debug it") || html.includes("can't help set it up or debug it"));
check("route file exists where Settings links", existsSync("src/app/(app)/docs/bot/page.tsx"));
check("Settings still links to /docs/bot", readFileSync("src/components/settings/api-tokens-panel.tsx", "utf8").includes('href="/docs/bot"'));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
