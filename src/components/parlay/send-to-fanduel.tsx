"use client";

// "Send to FanDuel" under a built parlay on /parlay. A tap asks the server
// (POST /api/parlay/fanduel-link) to find each leg at FanDuel, then lists what
// it found - FanDuel's current price beside the pick's own, FanDuel's line
// beside the pick's on a leg sent at another line (marked "Worse line" when
// the sent one is harder to win), and any leg that couldn't be sent with why -
// with a link that opens FanDuel's betslip holding the legs that were found.
// Nothing is fetched until the button is tapped, and
// only the legs' pick ids are sent. When two or more legs are on one game and
// the link doesn't hold all of them, that is said outright, per game.
import { useEffect, useState } from "react";
import { LABEL, PILL_OUTLINE, PILL_PRIMARY } from "@/components/parlay/parlay-controls";
import { notSentDisplay, type FanDuelLegResult, type FanDuelLinkResponse, type FanDuelSentLine } from "@/lib/parlay/fanduel-link";
import { incompleteSameGameGroups } from "@/lib/parlay/same-game-display";

// gameId / gameLabel are what group legs by game for the same-game notice; a
// leg without them is simply in no group.
export type SendLeg = { pickId: string; betDetail: string; gameId?: string; gameLabel?: string };

const formatOdds = (odds: number) => (odds > 0 ? "+" : "") + odds;

// "Over 6.5" / "Under 3.5"; a spread's line carries its sign ("+7.5").
const formatLine = (line: number, side: FanDuelSentLine["side"]) => (side ? side + " " + line : (line > 0 ? "+" : "") + line);

const isSent = (leg: FanDuelLegResult) => leg.status === "matched" || leg.status === "adjusted";

function LegLine({ leg, betDetail }: { leg: FanDuelLegResult; betDetail: string }) {
  if (leg.status === "matched" || leg.status === "adjusted") {
    const moved = leg.fanDuelOdds !== null && leg.pickOdds !== null && leg.fanDuelOdds !== leg.pickOdds;
    const line = leg.sentLine;
    return (
      <li className="flex items-baseline justify-between gap-3 py-1.5">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-foreground [overflow-wrap:anywhere]">{betDetail}</p>
          {line && (
            <p className="mt-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
              {line.worse && (
                <span className="mr-1.5 whitespace-nowrap rounded-full bg-red-100 px-1.5 py-0.5 font-semibold text-red-700 dark:bg-red-500/15 dark:text-red-300">
                  Worse line
                </span>
              )}
              <span className="font-semibold">Sent as {formatLine(line.fanDuel, line.side)}</span> · pick {formatLine(line.pick, line.side)}
              {line.worse && <span className="text-red-700 dark:text-red-300"> · harder to win than your pick</span>}
            </p>
          )}
        </div>
        <p className="shrink-0 text-right text-[13px] font-semibold tabular-nums text-foreground">
          {leg.fanDuelOdds !== null && formatOdds(leg.fanDuelOdds)}
          {moved && <span className="ml-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">pick {formatOdds(leg.pickOdds!)}</span>}
        </p>
      </li>
    );
  }
  const notSent = notSentDisplay(leg);
  return (
    <li className="py-1.5">
      <p className="text-[13px] font-medium text-muted-foreground [overflow-wrap:anywhere]">{betDetail}</p>
      <p className="text-xs font-medium text-muted-foreground">
        <span className="rounded-full bg-muted px-1.5 py-0.5 font-semibold">{notSent.label}</span> {notSent.reason}
      </p>
    </li>
  );
}

// `keepWhenEmpty` shows the button, disabled, when there are no legs;
// otherwise nothing is shown for none. `onOpened` runs when the user opens
// FanDuel's betslip - the generator clears the slip then.
export function SendToFanDuel({ legs, keepWhenEmpty, onOpened }: { legs: SendLeg[]; keepWhenEmpty?: boolean; onOpened?: () => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FanDuelLinkResponse | null>(null);

  // An answer for different legs no longer describes this parlay.
  const legsKey = legs.map((l) => l.pickId).join(",");
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [legsKey]);

  async function send() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/parlay/fanduel-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pickIds: legs.map((l) => l.pickId) }),
      });
      if (!res.ok) throw new Error("request failed");
      setResult((await res.json()) as FanDuelLinkResponse);
    } catch {
      setResult(null);
      setError("Couldn't check FanDuel right now - try again.");
    } finally {
      setLoading(false);
    }
  }

  if (legs.length === 0 && !keepWhenEmpty) return null;
  const betDetailById = new Map(legs.map((l) => [l.pickId, l.betDetail]));
  const sent = result?.legs.filter(isSent) ?? [];
  const notSent = result?.legs.filter((l) => !isSent(l)) ?? [];
  const worseLines = sent.filter((l) => l.sentLine?.worse).length;
  const brokenGroups = result ? incompleteSameGameGroups(legs, new Set(sent.map((l) => l.pickId))) : [];

  return (
    <div className="border-t border-[#0F1420]/[0.08] py-3 dark:border-white/10">
      <button type="button" onClick={send} disabled={loading || legs.length === 0} className={PILL_OUTLINE}>
        {loading ? "Checking FanDuel…" : result ? "Check FanDuel again" : "Send to FanDuel"}
      </button>
      {error && <p className="mt-2 text-xs font-medium text-red-600 dark:text-red-400">{error}</p>}

      {result && (
        <div className="mt-2.5 rounded-[12px] border border-[#E6E8EF] bg-white px-3.5 py-2.5 dark:border-border dark:bg-card">
          {sent.length > 0 && (
            <>
              <p className={LABEL}>
                On FanDuel · {sent.length} of {result.legs.length} leg{result.legs.length === 1 ? "" : "s"}
              </p>
              <ul className="divide-y divide-[#0F1420]/[0.06] dark:divide-white/10">
                {sent.map((leg) => (
                  <LegLine key={leg.pickId} leg={leg} betDetail={betDetailById.get(leg.pickId) ?? ""} />
                ))}
              </ul>
            </>
          )}
          {notSent.length > 0 && (
            <>
              <p className={LABEL + (sent.length > 0 ? " mt-2" : "")}>{sent.length > 0 ? "Not sent" : "No legs could be sent"}</p>
              <ul className="divide-y divide-[#0F1420]/[0.06] dark:divide-white/10">
                {notSent.map((leg) => (
                  <LegLine key={leg.pickId} leg={leg} betDetail={betDetailById.get(leg.pickId) ?? ""} />
                ))}
              </ul>
            </>
          )}
          {brokenGroups.length > 0 && (
            <div role="alert" className="mt-2 rounded-[10px] border border-amber-300 bg-amber-50/60 px-3 py-2 dark:border-amber-800 dark:bg-amber-500/10">
              <p className="text-xs font-semibold text-foreground">Same-game legs not fully sent</p>
              <ul className="mt-0.5 text-xs font-medium text-muted-foreground">
                {brokenGroups.map((g) => (
                  <li key={g.gameId}>
                    {g.gameLabel || "One game"}: {g.sent} of {g.total} legs {g.sent === 1 ? "is" : "are"} in the FanDuel link.
                  </li>
                ))}
              </ul>
            </div>
          )}
          {worseLines > 0 && (
            <p role="alert" className="mt-2 rounded-[10px] border border-red-300 bg-red-50/60 px-3 py-2 text-xs font-semibold text-red-700 dark:border-red-800 dark:bg-red-500/10 dark:text-red-300">
              {worseLines} leg{worseLines === 1 ? " is" : "s are"} going at a line that is harder to win than your pick.
            </p>
          )}
          {result.url && (
            <a href={result.url} target="_blank" rel="noopener noreferrer" onClick={onOpened} className={PILL_PRIMARY + " mt-2.5"}>
              Open FanDuel
            </a>
          )}
          <p className="mt-2 text-xs font-medium text-muted-foreground">Review your betslip on FanDuel before placing.</p>
        </div>
      )}
    </div>
  );
}
