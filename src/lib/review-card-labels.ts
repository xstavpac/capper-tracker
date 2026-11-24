// The review queue's wording that depends on the viewer's clock: the source line under each card's pick text and the
// ambiguous-team candidate labels. Pure, so the card renders the same text in a test as on the page; the component
// passes the time zone only after mount (the server's zone is not the viewer's).
import type { ReviewCardGame, ReviewCardSource } from "@/server/data/ingest-review-queue";

export function reviewSourceName(source: ReviewCardSource): string {
  if (source.type === "TELEGRAM") return "Telegram";
  return source.tokenName ?? "API token";
}

function timeText(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) });
}

function dayText(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleDateString("en-US", { weekday: "short", ...(timeZone ? { timeZone } : {}) });
}

// "Five Star · Telegram bot token · 2:14 AM". `timeZone` undefined = the runtime's zone (the browser's, after mount);
// local=false (before mount) leaves the time off so the server's render and the first client render agree.
export function reviewSourceLine(card: { capperName: string; source: ReviewCardSource; createdAt: string }, local: boolean, timeZone?: string): string {
  const parts = [card.capperName, reviewSourceName(card.source)];
  if (local) parts.push(timeText(card.createdAt, timeZone));
  return parts.join(" · ");
}

// "Detroit Lions (NFL) · vs GB Thu 12:30 PM" from the stored label "Detroit Lions (NFL)" (a near-miss capper's
// " - as X" suffix stays at the end). No stored game: the label as it is. Before mount the day and time are left off.
export function candidateLabel(label: string, game: ReviewCardGame | undefined, local: boolean, timeZone?: string): string {
  if (!game) return label;
  const cut = label.indexOf(" - as ");
  const base = cut === -1 ? label : label.slice(0, cut);
  const suffix = cut === -1 ? "" : label.slice(cut);
  const matchup = game.side === "HOME" ? "vs " + game.away : game.side === "AWAY" ? "at " + game.home : game.away + " @ " + game.home;
  const when = local ? " " + dayText(game.startsAt, timeZone) + " " + timeText(game.startsAt, timeZone) : "";
  return base + " · " + matchup + when + suffix;
}
