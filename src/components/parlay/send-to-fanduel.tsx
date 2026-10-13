"use client";

// "Send to FanDuel" under a built parlay on /parlay. A tap asks the server
// (POST /api/parlay/fanduel-link) to find each leg at FanDuel, then lists what
// it found - FanDuel's current price beside the pick's own, a "Line changed"
// tag on a leg sent at FanDuel's line instead of the pick's, and any leg that
// couldn't be sent with why - with a link that opens FanDuel's betslip holding
// the legs that were found. Nothing is fetched until the button is tapped, and
// only the legs' pick ids are sent.
import { useEffect, useState } from "react";
import { LABEL, PILL_OUTLINE, PILL_PRIMARY } from "@/components/parlay/parlay-controls";
import type { FanDuelLegResult, FanDuelLinkResponse } from "@/lib/parlay/fanduel-link";

export type SendLeg = { pickId: string; betDetail: string; betType: string };

const formatOdds = (odds: number) => (odds > 0 ? "+" : "") + odds;

// A spread's line carries its sign; a total's or a prop's is a bare number.
const formatLine = (line: number, betType: string) => (betType === "SPREAD" && line > 0 ? "+" : "") + line;

const isSent = (leg: FanDuelLegResult) => leg.status === "matched" || leg.status === "adjusted";

const NOT_SENT_LABEL: Record<Exclude<FanDuelLegResult["status"], "matched" | "adjusted">, string> = {
  started: "Started",
  not_found: "Not found",
  ambiguous: "Ambiguous",
  unsupported: "Not supported",
  error: "Unavailable",
};

function LegLine({ leg, sendLeg }: { leg: FanDuelLegResult; sendLeg: SendLeg | undefined }) {
  const betDetail = sendLeg?.betDetail ?? "";
  if (leg.status === "matched" || leg.status === "adjusted") {
    const moved = leg.fanDuelOdds !== null && leg.pickOdds !== null && leg.fanDuelOdds !== leg.pickOdds;
    return (
      <li className="flex items-baseline justify-between gap-3 py-1.5">
        <p className="min-w-0 text-[13px] font-medium text-foreground [overflow-wrap:anywhere]">
          {betDetail}
          {leg.status === "adjusted" && leg.fanDuelLine !== null && (
            <>
              {" → "}
              {formatLine(leg.fanDuelLine, sendLeg?.betType ?? "")}
              <span className="ml-1.5 whitespace-nowrap rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-400/15 dark:text-amber-300">
                Line changed
              </span>
            </>
          )}
        </p>
        <p className="shrink-0 text-right text-[13px] font-semibold tabular-nums text-foreground">
          {leg.fanDuelOdds !== null && formatOdds(leg.fanDuelOdds)}
          {moved && <span className="ml-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">pick {formatOdds(leg.pickOdds!)}</span>}
        </p>
      </li>
    );
  }
  return (
    <li className="py-1.5">
      <p className="text-[13px] font-medium text-muted-foreground [overflow-wrap:anywhere]">{betDetail}</p>
      <p className="text-xs font-medium text-muted-foreground">
        <span className="rounded-full bg-muted px-1.5 py-0.5 font-semibold">{NOT_SENT_LABEL[leg.status]}</span> {leg.reason}
      </p>
    </li>
  );
}

export function SendToFanDuel({ legs }: { legs: SendLeg[] }) {
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

  if (legs.length === 0) return null;
  const sendLegById = new Map(legs.map((l) => [l.pickId, l]));
  const sent = result?.legs.filter(isSent) ?? [];
  const notSent = result?.legs.filter((l) => !isSent(l)) ?? [];

  return (
    <div className="border-t border-[#0F1420]/[0.08] py-3 dark:border-white/10">
      <button type="button" onClick={send} disabled={loading} className={PILL_OUTLINE}>
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
                  <LegLine key={leg.pickId} leg={leg} sendLeg={sendLegById.get(leg.pickId)} />
                ))}
              </ul>
            </>
          )}
          {notSent.length > 0 && (
            <>
              <p className={LABEL + (sent.length > 0 ? " mt-2" : "")}>{sent.length > 0 ? "Not sent" : "No legs could be sent"}</p>
              <ul className="divide-y divide-[#0F1420]/[0.06] dark:divide-white/10">
                {notSent.map((leg) => (
                  <LegLine key={leg.pickId} leg={leg} sendLeg={sendLegById.get(leg.pickId)} />
                ))}
              </ul>
            </>
          )}
          {result.url && (
            <a href={result.url} target="_blank" rel="noopener noreferrer" className={PILL_PRIMARY + " mt-2.5"}>
              Open FanDuel
            </a>
          )}
          <p className="mt-2 text-xs font-medium text-muted-foreground">Review your betslip on FanDuel before placing.</p>
        </div>
      )}
    </div>
  );
}
