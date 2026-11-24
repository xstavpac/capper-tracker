// The words and numbers of the Bot Guide (/docs/bot, components/docs/bot-guide.tsx). Pure and client-safe.
//
// Every number and name here mirrors the real endpoint (app/api/v1/picks/route.ts, server/data/api-picks.ts,
// server/api-bearer-auth.ts, lib/api-pick-result.ts, lib/ingest-line-outcome.ts). bot-guide-content-acceptance-test.ts
// pins each one against those files, so the guide can't drift from what the endpoint does.
import type { LineRejectReason, LineReviewReason } from "@/lib/ingest-line-outcome";
import { API_TOKEN_LEAGUES, API_TOKEN_RATE_PER_MINUTE, API_TOKEN_UI_MAX_ACTIVE } from "@/lib/api-token-ui";

export const BOT_API_URL = "https://www.bettingview.app/api/v1/picks";
export const BOT_TOKEN_PREFIX = "bv_live_";

export const BOT_LIMITS = {
  requestsPerMinute: API_TOKEN_RATE_PER_MINUTE,
  maxActiveTokens: API_TOKEN_UI_MAX_ACTIVE,
  maxPicksPerRequest: 50,
  maxBodyKb: 64,
  maxCapperChars: 100,
  maxClientIdChars: 100,
  maxTextChars: 500,
  // Failed token attempts (missing, malformed, unknown or revoked) from one IP address before it is refused.
  badTokenAttemptsPerMinute: 20,
  // The route's maxDuration: a full request can take this long.
  timeoutSeconds: 60,
  leagues: API_TOKEN_LEAGUES,
} as const;

// ---- examples -----------------------------------------------------------------------------------------------

export const EXAMPLE_BODY = `{
  "capper": "Five Star",
  "picks": [
    { "client_id": "msg-88213-1", "text": "Celtics ML -165" },
    { "client_id": "msg-88213-2", "text": "NFL Giants +6.5" },
    { "client_id": "msg-88213-3", "text": "Dodgers u 8.5" }
  ]
}`;

export const CURL_EXAMPLE = `curl -X POST ${BOT_API_URL} \\
  -H "Authorization: Bearer $BETTINGVIEW_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "capper": "Five Star",
    "picks": [
      { "client_id": "msg-88213-1", "text": "Celtics ML -165" },
      { "client_id": "msg-88213-2", "text": "NFL Giants +6.5" }
    ]
  }'`;

export const NODE_EXAMPLE = `// Node 18+ (built-in fetch). Keep the token in an environment variable.
const res = await fetch("${BOT_API_URL}", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.BETTINGVIEW_TOKEN}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    capper: "Five Star",
    picks: [{ client_id: "msg-88213-1", text: "Celtics ML -165" }],
  }),
});
const data = await res.json();
if (res.ok) {
  for (const r of data.results) console.log(r.client_id, r.status, r.reason ?? "");
} else {
  console.error(res.status, data.error, data.detail ?? "");
}`;

export const PYTHON_EXAMPLE = `# Python 3 with requests (pip install requests).
import os, requests

res = requests.post(
    "${BOT_API_URL}",
    headers={"Authorization": f"Bearer {os.environ['BETTINGVIEW_TOKEN']}"},
    json={
        "capper": "Five Star",
        "picks": [{"client_id": "msg-88213-1", "text": "Celtics ML -165"}],
    },
    timeout=${BOT_LIMITS.timeoutSeconds},
)
data = res.json()
if res.ok:
    for r in data["results"]:
        print(r["client_id"], r["status"], r.get("reason", ""))
else:
    print(res.status_code, data["error"], data.get("detail", ""))`;

// The real result shapes (lib/api-pick-result.ts), in the endpoint's own key order.
export const EXAMPLE_RESPONSE = `{
  "results": [
    {
      "client_id": "msg-88213-1",
      "status": "accepted",
      "pick": {
        "league": "NBA",
        "game": { "away": "Boston Celtics", "home": "New York Knicks", "startsAt": "2026-11-25T00:30:00.000Z" },
        "market": "MONEYLINE",
        "line": null,
        "odds": -165,
        "pickId": "cmi3x0k2a0001abcd1234efgh"
      }
    },
    {
      "client_id": "msg-88213-2",
      "status": "needs_review",
      "reason": "ambiguous_team",
      "candidates": [
        { "label": "New York Giants (NFL)", "league": "NFL", "game": { "away": "New York Giants", "home": "Dallas Cowboys", "startsAt": "2026-11-26T21:30:00.000Z" } },
        { "label": "San Francisco Giants (MLB)", "league": "MLB", "game": null }
      ]
    },
    {
      "client_id": "msg-88213-3",
      "status": "rejected",
      "reason": "no_game_found"
    }
  ]
}`;

// ---- what each status / reason means ------------------------------------------------------------------------

export const STATUS_ROWS: { status: "accepted" | "needs_review" | "rejected"; meaning: string }[] = [
  { status: "accepted", meaning: "Saved to your ledger. The result carries the league, the matched game, the market, line, odds and the new pick's id." },
  { status: "needs_review", meaning: "Held in Needs review on Catalog Import. The result carries the reason and the candidate answers." },
  { status: "rejected", meaning: "Not saved. The result carries the reason." },
];

// Review reasons the endpoint can return (all of LineReviewReason).
export const REVIEW_REASONS: Record<LineReviewReason, string> = {
  ambiguous_team: "The team name fits more than one team or league (\"Giants\"). Add a league prefix: NFL Giants +6.5.",
  ambiguous_player: "The player name fits more than one player. Send the full name.",
  missing_total_line: "A total with no number. The review offers the current market line.",
  capper_name: "The capper name is close to one you already track. Pick the existing capper or create a new one.",
  far_future_game: "The matched game is far in the future. Confirm it's the right one.",
};

// The rejection reasons a token request can really get. Left out on purpose: no_capper (the request always has a
// capper) and game_already_final (real-time Telegram ingest only - picks sent after a game starts are accepted).
export const REJECT_REASONS_SHOWN = [
  "unparseable",
  "combined_pick",
  "parlay_not_supported",
  "league_not_allowed",
  "no_game_found",
  "game_not_scheduled_yet",
  "doubleheader_final",
  "duplicate",
  "duplicate_in_request",
  "total_without_line",
  "invalid_odds",
  "pick_limit",
  "error",
] as const;
export const REJECT_REASONS_NOT_FOR_TOKENS = ["no_capper", "game_already_final"] as const satisfies readonly LineRejectReason[];

export const REJECT_REASONS: Record<(typeof REJECT_REASONS_SHOWN)[number], string> = {
  unparseable: "No pick could be read from the text.",
  combined_pick: "More than one team or bet on one line (\"Bears + Cubs\"). Send one pick per item.",
  parlay_not_supported: "A moneyline parlay (MLP). Parlays aren't taken through the API.",
  league_not_allowed: `The pick is in a league outside ${API_TOKEN_LEAGUES.join(", ")}.`,
  no_game_found: "No game matched the team on the day it was matched to.",
  game_not_scheduled_yet: "The pick names a future day whose schedule isn't loaded yet. Send it again closer to game day.",
  doubleheader_final: "A doubleheader where every game is already final.",
  duplicate: "The same pick is already in your ledger.",
  duplicate_in_request: "The same pick text appears twice in one request. The second one is rejected.",
  total_without_line: "A total with no number that couldn't be filled in.",
  invalid_odds: "The odds aren't valid American odds.",
  pick_limit: "Your plan's pick limit is reached.",
  error: "Something failed on our side while saving. Send the pick again.",
};

// ---- HTTP responses (route.ts, api-bearer-auth.ts, rate-limit.ts) -------------------------------------------

export const HTTP_ROWS: { code: number; body: string; meaning: string }[] = [
  { code: 200, body: `{ "results": [ ... ] }`, meaning: "The request was read. One result per pick, in the order you sent them. Check each result's status." },
  { code: 400, body: `{ "error": "invalid_request", "detail": "..." }`, meaning: "The body is wrong: not JSON, over 64 KB, or a field breaks a rule. The detail says which." },
  { code: 401, body: `{ "error": "invalid_token" }`, meaning: "The Authorization header is missing or malformed, or the token is unknown or revoked." },
  { code: 429, body: `{ "error": "rate_limited", "retryAfterSeconds": 12 }`, meaning: "Too many requests. Wait the number of seconds given (also in the Retry-After header), then retry." },
  { code: 503, body: `{ "error": "temporarily_unavailable" }`, meaning: "We couldn't process the request just now. Nothing was saved. Retry later with the same client_ids." },
];

// ---- day matching (resolveTokenDayGameFromFeeds / namedPickDay) ---------------------------------------------

export const DAY_RULES: string[] = [
  "The day is the request's date in Eastern time. Midnight Eastern starts the next day.",
  "A pick that names a day is matched to that day's game: today, tonight, tomorrow, a weekday (Thursday, Thurs, Thu) or a date (11/27, 11/27/26). A weekday means the next one, today included.",
  "Otherwise the pick goes to the team's game that day, whether it's upcoming, live or already final.",
  "After midnight Eastern it's a new day, so a pick sent then goes to the team's next game.",
  "If the team isn't playing that day, the pick goes to its next game.",
];

// ---- tips for the user's own LLM ----------------------------------------------------------------------------

export const LLM_TIPS: string[] = [
  "Ask for one pick per item, as one short line, the way a capper writes it: team, then the bet, then the odds.",
  "Have it put the league in front whenever a name could mean two teams (NFL Giants, MLB Giants, NCAAB Duke).",
  "Have it keep a day or date the capper wrote (Thursday, 11/27). Without one, the pick goes to today's game.",
  "Tell it to split parlays and \"A + B\" picks into separate picks, or skip them.",
  "Ask for JSON only, in exactly the request shape above, so your code can send it without changes.",
  "Make client_id stable and unique per pick, for example the source message id plus the pick's position, so a resend never duplicates.",
];

export const LLM_PROMPT_EXAMPLE = `You turn sports betting posts into picks.
Return JSON only: { "capper": "<name>", "picks": [ { "client_id": "<msg id>-<n>", "text": "<pick>" } ] }
Rules for "text":
- One straight bet per pick: team or player, the bet, then the odds if given.
  Examples: "Celtics ML -165", "Chiefs -3.5", "Dodgers u 8.5", "Jahmyr Gibbs over 65.5 rush yds"
- Put the league first when a name could mean two teams: "NFL Giants +6.5".
- Keep any day or date the post gives ("Thursday", "11/27").
- Split parlays into separate picks. Leave out anything that isn't a pick.`;
