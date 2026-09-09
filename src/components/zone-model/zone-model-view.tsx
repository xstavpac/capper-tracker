import { getRecordColor } from "@/server/data/stats";
import type { ZoneModelBucketResult, ZoneModelReport } from "@/server/data/zone-model";

const CARD_CLASSES: Record<"green" | "red", string> = {
  green: "bg-emerald-100 dark:bg-emerald-500/20",
  red: "bg-red-100 dark:bg-red-500/20",
};
const TEXT_CLASSES: Record<"green" | "red", string> = {
  green: "text-emerald-700 dark:text-emerald-300",
  red: "text-red-700 dark:text-red-300",
};

// A bucket with zero games renders as its own explicit, always-visible
// state - dimmed and labeled "No games in this range yet" directly in the
// tile body, not hidden and not only revealed on hover. Every other tile
// shows its real record and win% next to its real game count, with no
// minimum-sample gate (same "show the real number, never hide it behind a
// threshold" convention team-tendencies.ts established).
function BucketTile({ result }: { result: ZoneModelBucketResult }) {
  if (result.games === 0) {
    return (
      <div className="rounded-card border border-dashed border-border-subtle p-3 opacity-60">
        <div className="text-xs font-medium text-muted-foreground">{result.bucket.label}</div>
        <div className="mt-1 text-sm text-muted-foreground">No games in this range yet</div>
      </div>
    );
  }

  const color = getRecordColor(result.winPct!);
  return (
    <div className={"rounded-card p-3 " + CARD_CLASSES[color]}>
      <div className={"text-xs font-medium " + TEXT_CLASSES[color]}>{result.bucket.label}</div>
      <div className="mt-1 text-sm font-medium text-foreground">
        {result.wins}-{result.losses}
        <span className="ml-1.5 text-xs font-normal text-muted-foreground">
          &middot; {result.games} game{result.games === 1 ? "" : "s"}
        </span>
      </div>
      <div className={"mt-0.5 text-sm font-semibold " + TEXT_CLASSES[color]}>{Math.round(result.winPct!)}%</div>
    </div>
  );
}

function BucketGrid({
  title,
  subtitle,
  results,
}: {
  title: string;
  subtitle: string;
  results: ZoneModelBucketResult[];
}) {
  return (
    <div>
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {results.map((result) => (
          <BucketTile key={result.bucket.id} result={result} />
        ))}
      </div>
    </div>
  );
}

export function ZoneModelView({ report }: { report: ZoneModelReport }) {
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Zone Model</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Bucketed delta calibration - admin-only. Every graded game is placed into a range by its ML or Total
          delta (each team&apos;s all-time BettingView tendency history, not a point-in-time snapshot), and each
          range reports its own real record. Ranges are independent: none of this is averaged, smoothed, or an
          implicit claim that a bigger delta performs better.
        </p>
      </div>

      <div className="space-y-8">
        <BucketGrid
          title="ML Delta"
          subtitle="Favorite's history win% as a favorite, minus the underdog's history win% as an underdog. W-L is the favorite's record within that range."
          results={report.ml}
        />
        <BucketGrid
          title="Total Delta"
          subtitle="This matchup's combined history over-rate, minus its combined history under-rate. W-L is the over's record within that range."
          results={report.total}
        />
      </div>

      <p className="mt-8 text-xs text-muted-foreground">
        {report.mlGamesConsidered} graded game{report.mlGamesConsidered === 1 ? "" : "s"} contributed to ML Delta
        &middot; {report.totalGamesConsidered} contributed to Total Delta.
      </p>
    </div>
  );
}
