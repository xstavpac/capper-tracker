"use client";

import { useState } from "react";
import { getRecordColor } from "@/server/data/stats";
import type {
  ZoneModelBucketResult,
  ZoneModelReport,
  ZoneSideRecord,
  PendingZoneReport,
  PendingZoneGame,
} from "@/server/data/zone-model";

const TEXT_CLASSES: Record<"green" | "red", string> = {
  green: "text-emerald-700 dark:text-emerald-300",
  red: "text-red-700 dark:text-red-300",
};

function PendingGameLine({ game }: { game: PendingZoneGame }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5 text-sm">
      <span className="text-foreground">
        {game.awayTeam} @ {game.homeTeam}
      </span>
      <span className="text-muted-foreground">
        &Delta; {game.deltaDisplay} &rarr; <span className="font-medium text-foreground">{game.qualifyingSide}</span> ({game.qualifierLabel})
      </span>
    </div>
  );
}

// One side's record within a bucket. A side with no games shows an explicit
// "no games" rather than a misleading 0-0 / 0% - winPct is null there, never
// a divide-by-zero fallback. Both sides are always shown so a negative-delta
// range reads directly (the underdog's real record, not the favorite's
// relabelled).
function SideRow({ label, record }: { label: string; record: ZoneSideRecord }) {
  if (record.games === 0) {
    return (
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-xs text-muted-foreground">no games</span>
      </div>
    );
  }
  const color = getRecordColor(record.winPct!);
  return (
    <div className="flex items-baseline justify-between gap-2 text-sm tabular-nums">
      <span className="text-muted-foreground">{label}</span>
      <span>
        <span className="font-medium text-foreground">
          {record.wins}-{record.losses}
        </span>{" "}
        <span className={"font-semibold " + TEXT_CLASSES[color]}>{Math.round(record.winPct!)}%</span>{" "}
        <span className="text-xs font-normal text-muted-foreground">
          &middot; {record.games}g
        </span>
      </span>
    </div>
  );
}

// A tile is a real button (not a hover-only affordance) - its expanded/
// collapsed state and the "N pending" count are always visible, not
// revealed only on mouseover. A tile with zero games on BOTH sides renders
// as its own explicit, always-visible dimmed state and is not clickable
// (there is nothing to expand).
function BucketTile({
  result,
  sideALabel,
  sideBLabel,
  pendingGames,
  expanded,
  onToggle,
}: {
  result: ZoneModelBucketResult;
  sideALabel: string;
  sideBLabel: string;
  pendingGames: PendingZoneGame[];
  expanded: boolean;
  onToggle: () => void;
}) {
  if (result.sideA.games === 0 && result.sideB.games === 0) {
    return (
      <div className="rounded-card border border-dashed border-border-subtle p-3 opacity-60">
        <div className="text-xs font-medium text-muted-foreground">{result.bucket.label}</div>
        <div className="mt-1 text-sm text-muted-foreground">No games in this range yet</div>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={
          "w-full rounded-card border border-border-subtle bg-card p-3 text-left transition " +
          (expanded ? "ring-2 ring-blue-400 dark:ring-blue-300" : "hover:bg-muted/50")
        }
      >
        <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
          <span>{result.bucket.label}</span>
          <span>{pendingGames.length > 0 ? `${pendingGames.length} pending` : ""}</span>
        </div>
        <div className="mt-1.5 space-y-1">
          <SideRow label={sideALabel} record={result.sideA} />
          <SideRow label={sideBLabel} record={result.sideB} />
        </div>
      </button>
      {expanded && (
        <div className="mt-1 rounded-card border border-border-subtle bg-card p-3 shadow-soft">
          {pendingGames.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pending games currently fall in this range.</p>
          ) : (
            <div className="divide-y divide-border-subtle">
              {pendingGames.map((game, i) => (
                <PendingGameLine key={`${game.awayTeam}-${game.homeTeam}-${game.commenceTime}-${i}`} game={game} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BucketGrid({
  dimensionKey,
  title,
  subtitle,
  results,
  sideALabel,
  sideBLabel,
  gamesByBucket,
  expandedTile,
  onToggleTile,
}: {
  dimensionKey: string;
  title: string;
  subtitle: string;
  results: ZoneModelBucketResult[];
  sideALabel: string;
  sideBLabel: string;
  gamesByBucket: Record<string, PendingZoneGame[]>;
  expandedTile: string | null;
  onToggleTile: (tileKey: string) => void;
}) {
  return (
    <div>
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {results.map((result) => {
          const tileKey = `${dimensionKey}:${result.bucket.id}`;
          return (
            <BucketTile
              key={result.bucket.id}
              result={result}
              sideALabel={sideALabel}
              sideBLabel={sideBLabel}
              pendingGames={gamesByBucket[result.bucket.id] ?? []}
              expanded={expandedTile === tileKey}
              onToggle={() => onToggleTile(tileKey)}
            />
          );
        })}
      </div>
    </div>
  );
}

export function ZoneModelView({ report, pending }: { report: ZoneModelReport; pending: PendingZoneReport }) {
  const [expandedTile, setExpandedTile] = useState<string | null>(null);

  function toggleTile(tileKey: string) {
    setExpandedTile((current) => (current === tileKey ? null : tileKey));
  }

  const pendingByDimension = new Map(pending.dimensions.map((d) => [d.key, d.gamesByBucket]));
  const totalGamesConsidered = report.dimensions.reduce((sum, d) => sum + d.gamesConsidered, 0);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Zone Model</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Bucketed delta calibration - admin-only. Each game is placed into a range using each team&apos;s
          BettingView tendency/stat history exactly as it stood the day before that game - never a current or
          later rate. Every range reports <span className="font-medium text-foreground">both</span> sides&apos;
          real records (favorite and underdog, over and under, or home and away) independently: each game is
          bucketed once per side by that side&apos;s own version of the delta, so the two records come from
          different games and neither is inferred by inverting the other. Nothing is averaged, smoothed, or an
          implicit claim that a bigger delta performs better, and there is no minimum-sample cutoff. Click any
          tile to see today&apos;s pending games currently in that range (current data, no point-in-time
          restriction; still listed from the favorite / over / home side only). Point-in-time history starts
          wherever each dimension&apos;s own daily snapshot began, so earlier games are excluded from that
          dimension.
        </p>
      </div>

      <div className="space-y-8">
        {report.dimensions.map((dimension) => (
          <BucketGrid
            key={dimension.key}
            dimensionKey={dimension.key}
            title={dimension.label}
            subtitle={dimension.description}
            results={dimension.buckets}
            sideALabel={dimension.sideALabel}
            sideBLabel={dimension.sideBLabel}
            gamesByBucket={pendingByDimension.get(dimension.key) ?? {}}
            expandedTile={expandedTile}
            onToggleTile={toggleTile}
          />
        ))}
      </div>

      <p className="mt-8 text-xs text-muted-foreground">
        {report.dimensions.map((d) => `${d.label}: ${d.gamesConsidered}`).join(" · ")} graded games
        contributed ({totalGamesConsidered} total across dimensions).
      </p>
    </div>
  );
}
