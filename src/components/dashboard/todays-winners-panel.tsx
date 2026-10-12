"use client";

import { TODAYS_WINNERS_REFRESH_MS, todaysWinnersEmpty, type WinnerEntry } from "@/lib/cappers-panels";
import { useSafePoll } from "@/lib/use-safe-poll";
import { WinnerRows, WinnersFooter } from "@/components/dashboard/capper-panel";
import { TrophyFilledIcon } from "@/components/dashboard/cappers-icons";
import { CONTROL, Message, PanelShell, TINTS, type PanelTheme } from "@/components/dashboard/panel-shell";

const THEME: PanelTheme = { ...TINTS.green, title: "Today's Winners", subtitle: "Net units on today's graded picks", icon: <TrophyFilledIcon className="h-[17px] w-[17px]" /> };
const SOURCE = "/api/cappers/panel?panel=winners&window=today";

type Fetched = { rows: WinnerEntry[]; graded?: boolean };

// A 429's Retry-After reaches the poll's backoff as `retryAfterMs`.
async function fetchTodaysWinners(signal: AbortSignal): Promise<Fetched> {
  const res = await fetch(SOURCE, { signal });
  if (!res.ok) {
    const retryAfter = Number(res.headers.get("retry-after"));
    throw Object.assign(new Error(String(res.status)), retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {});
  }
  return (await res.json()) as Fetched;
}

// Biggest Winners (capper-panel.tsx) locked to "Today": the same route, rows and footer, with no
// dropdown. It fetches a beat after mount and again every TODAYS_WINNERS_REFRESH_MS while the tab is
// visible (useSafePoll: paused while hidden, backed off on failure), so the card follows the day as
// picks grade. A failed refresh keeps the last rows on screen.
export function TodaysWinnersPanel({ leaderboardHref }: { leaderboardHref: string }) {
  const { data, errored } = useSafePoll<Fetched>({ fetcher: fetchTodaysWinners, enabled: true, intervalMs: TODAYS_WINNERS_REFRESH_MS });
  const rows = data?.rows ?? [];
  return (
    <PanelShell
      theme={THEME}
      control={<span className={CONTROL + " shrink-0 whitespace-nowrap px-2.5 py-[5px] " + THEME.control}>Today</span>}
      footer={rows.length > 0 ? <WinnersFooter rows={rows} href={leaderboardHref} /> : undefined}
    >
      <div className="flex flex-1 flex-col" aria-busy={data === null && !errored}>
        {data === null ? (
          errored ? (
            <Message error>Couldn&apos;t load today&apos;s winners.</Message>
          ) : (
            <Message>Loading…</Message>
          )
        ) : rows.length === 0 ? (
          <Message>{todaysWinnersEmpty(data.graded)}</Message>
        ) : (
          <WinnerRows rows={rows} wide />
        )}
      </div>
    </PanelShell>
  );
}
