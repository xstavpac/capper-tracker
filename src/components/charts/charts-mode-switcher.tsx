"use client";

import { useState } from "react";
import type { ModelVariableDef } from "@/lib/model-builder";
import { ChartsWorkspace } from "@/components/charts/charts-workspace";
import { TeamComparisonWorkspace } from "@/components/charts/team-comparison-workspace";
import { CapperComparisonWorkspace } from "@/components/charts/capper-comparison-workspace";
import { CustomMetricUpload } from "@/components/charts/custom-metric-upload";
import { SportSwitcher } from "@/components/charts/sport-switcher";

type Mode = "single" | "compare" | "cappers";

const MODE_LABEL: Record<Mode, string> = { single: "Team Stats", compare: "Team Comparison", cappers: "Capper Comparison" };

// One sport's fully-assembled Charts inputs, built server-side in
// charts/page.tsx: the team selector list plus the variable catalog already
// filtered to this sport (built-ins by ModelVariableDef.sport, custom
// metrics by CustomMetric.sportKey) and merged.
export type ChartsSportData = {
  key: string;
  label: string;
  teamNames: string[];
  variables: ModelVariableDef[];
};

// Top-level switch between the three charting tools plus the MLB/NFL sport
// toggle. Each workspace is a full, separate component (owns its own state
// from scratch) - switching modes never reconciles one tool's selections
// against another's, and switching sport remounts the active workspace
// (key={sport}) so a stale team/variable from the other sport can't linger.
// The sport toggle and "Add Custom Metric" both live here, one level up from
// the two team-stat workspaces, so they apply to whichever is showing.
// Capper Comparison is sport-agnostic - the sport toggle is hidden for it.
export function ChartsModeSwitcher({
  sportOptions,
  nflHasAnyData,
  cappers,
  sports,
}: {
  sportOptions: ChartsSportData[];
  // Whether NflTeamStatSnapshot has ANY rows at all (page-load snapshot) -
  // drives the empty-state wording so it stays accurate before Week 1 AND
  // after, without a hardcoded "appears after Week 1" string that would go
  // stale the moment the season starts.
  nflHasAnyData: boolean;
  cappers: { id: string; name: string }[];
  sports: { id: string; name: string }[];
}) {
  const [mode, setMode] = useState<Mode>("single");
  const [sport, setSport] = useState(sportOptions[0]?.key ?? "baseball_mlb");
  const [uploadOpen, setUploadOpen] = useState(false);

  const active = sportOptions.find((s) => s.key === sport) ?? sportOptions[0];

  // undefined => HistoricalVariableChart uses its default (MLB) message.
  const emptyMessage =
    active.key === "americanfootball_nfl"
      ? nflHasAnyData
        ? "No data for this team and variable in the selected date range."
        : "No NFL games have been ingested yet - team stats appear here automatically as games are played."
      : undefined;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          {mode !== "cappers" && sportOptions.length > 1 && (
            <SportSwitcher
              options={sportOptions.map((s) => ({ key: s.key, label: s.label }))}
              value={sport}
              onChange={setSport}
            />
          )}
          <div className="flex gap-1 rounded-full bg-muted p-1" style={{ width: "fit-content" }}>
            {(["single", "compare", "cappers"] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={
                  "rounded-full px-4 py-1.5 text-sm font-medium transition " +
                  (mode === m ? "bg-card text-foreground shadow-soft" : "text-muted-foreground hover:text-foreground")
                }
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
        </div>

        {mode !== "cappers" && (
          <button
            onClick={() => setUploadOpen(true)}
            className="rounded-full border border-border bg-card px-4 py-1.5 text-sm font-medium text-foreground shadow-soft transition hover:bg-muted"
          >
            + Add Custom Metric
          </button>
        )}
      </div>

      {mode === "single" && (
        <ChartsWorkspace
          key={sport}
          sportKey={active.key}
          teamNames={active.teamNames}
          variables={active.variables}
          emptyMessage={emptyMessage}
        />
      )}
      {mode === "compare" && (
        <TeamComparisonWorkspace
          key={sport}
          sportKey={active.key}
          teamNames={active.teamNames}
          variables={active.variables}
          emptyMessage={emptyMessage}
        />
      )}
      {mode === "cappers" && <CapperComparisonWorkspace cappers={cappers} sports={sports} />}

      {uploadOpen && <CustomMetricUpload sportKey={active.key} onClose={() => setUploadOpen(false)} />}
    </div>
  );
}
