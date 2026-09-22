import { requireUser } from "@/server/auth";
import { LIVE_SPORTS } from "@/server/data/odds";
import { getLiveBoardData } from "@/server/data/live-board-picks";
import { LiveScoreboard } from "@/components/live/live-scoreboard";
import { ParlaySlipButton } from "@/components/parlay/parlay-slip-button";
import { ParlayPoolSection } from "@/components/parlay/parlay-pool-section";

function tabClass(isActive: boolean) {
  return (
    "rounded-full px-4 py-1.5 text-sm font-medium " +
    (isActive ? "bg-red-600 text-white" : "bg-card text-muted-foreground shadow-soft hover:bg-muted")
  );
}

// The Parlay Generator's My Picks mode: build a parlay from exactly the
// picks the user has pooled (via the Parlay slip button, here or on Live),
// scoped by which leagues are toggled on, up to a requested leg count. No
// substitutions/alternates/hedge logic - the pool + scope + leg count is the
// whole construction.
export default async function ParlayPage({ searchParams }: { searchParams: { sport?: string } }) {
  // "Browse & add" below reuses the exact same board Live shows (same data,
  // same GamePicksExpander/PickCard rendering) so this tab isn't just a
  // read-out of the pool - it's a second full place to find and add more
  // picks. Defaults to MLB for the same reason live/page.tsx does: it's the
  // only league fully wired up with real data most of the year.
  const activeSport = searchParams.sport || "baseball_mlb";
  const sportLabel = LIVE_SPORTS.find((s) => s.key === activeSport)?.label ?? activeSport;

  const user = await requireUser();
  const { odds, scores, expanderPicksByGame } = await getLiveBoardData(user.id, activeSport, sportLabel);
  const hasApiKey = process.env.ODDS_API_KEY ? true : false;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Parlay Generator</h1>
          <p className="mt-1 text-sm text-muted-foreground">My Picks - build a parlay from your pooled picks.</p>
        </div>
        <ParlaySlipButton />
      </div>

      <ParlayPoolSection />

      <div className="mb-4 mt-8">
        <h2 className="text-sm font-semibold text-foreground">Browse &amp; add picks</h2>
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        {LIVE_SPORTS.map((s) => (
          <a key={s.key} href={"/parlay?sport=" + s.key} className={tabClass(activeSport === s.key)}>
            {s.label}
          </a>
        ))}
      </div>

      {odds.length === 0 && hasApiKey && (
        <div className="rounded-card bg-card p-10 text-center shadow-soft">
          <p className="text-sm text-muted-foreground">No games found for this sport right now.</p>
        </div>
      )}

      {odds.length > 0 && (
        <LiveScoreboard
          key={activeSport}
          activeSport={activeSport}
          odds={odds}
          boardPulseOdds={[]}
          initialScores={scores}
          matchedPicksByGame={expanderPicksByGame}
          showBoardPulse={false}
        />
      )}
    </div>
  );
}
