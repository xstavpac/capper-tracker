// Settings › API tokens: the words and rules the panel shows. Pure, so the client panel and its test share them.
// The limits mirror src/server/data/api-tokens.ts (MAX_ACTIVE_API_TOKENS, API_TOKEN_NAME_MAX), which the server
// enforces; that module imports Prisma, so a client component can't import the constants from there.

export const API_TOKEN_UI_MAX_ACTIVE = 5;
export const API_TOKEN_UI_NAME_MAX = 40;
export const API_TOKEN_RATE_PER_MINUTE = 60;
export const API_TOKEN_LEAGUES = ["NBA", "NFL", "NCAAB", "NCAAF", "NHL", "WNBA", "MLB"] as const;

export const TOKEN_LIMIT_MESSAGE = `You can have up to ${API_TOKEN_UI_MAX_ACTIVE} active tokens. Revoke one to create another.`;
export const TOKEN_NAME_MESSAGE = `Give the token a name of 1–${API_TOKEN_UI_NAME_MAX} characters.`;
export const NETWORK_MESSAGE = "Couldn't reach BettingView. Check your connection and try again.";
export const REVOKE_FAILED_MESSAGE = "That token wasn't found. The list has been refreshed.";

/** Same rule as the server's normalizeApiTokenName: trimmed, 1-40 code points. */
export function isValidTokenName(name: string): boolean {
  const length = [...name.trim()].length;
  return length >= 1 && length <= API_TOKEN_UI_NAME_MAX;
}

export function createErrorMessage(error: "invalid_name" | "token_limit"): string {
  return error === "token_limit" ? TOKEN_LIMIT_MESSAGE : TOKEN_NAME_MESSAGE;
}

/** "Never", "just now", "1 minute ago", "2 hours ago", "3 days ago". */
export function formatLastUsed(date: Date | null, nowMs: number): string {
  if (!date) return "Never";
  const minutes = Math.floor((nowMs - date.getTime()) / 60000);
  if (minutes < 1) return "just now";
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"} ago`;
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return unit(hours, "hour");
  return unit(Math.floor(hours / 24), "day");
}

/** The masked token as the table shows it: the stored prefix, then four dots. */
export function maskedToken(prefix: string): string {
  return prefix + "••••";
}
