"use client";

import { useState } from "react";
import type { ModelVariableDef } from "@/lib/model-builder";
import { ChartsWorkspace } from "@/components/charts/charts-workspace";
import { TeamComparisonWorkspace } from "@/components/charts/team-comparison-workspace";
import { CustomMetricUpload } from "@/components/charts/custom-metric-upload";

type Mode = "single" | "compare";

const MODE_LABEL: Record<Mode, string> = { single: "Team Stats", compare: "Team Comparison" };

// Top-level switch between the two charting tools - both are full, separate
// workspaces (each owns its own team/variable/date-range state from
// scratch), not tabs over one shared state, so switching modes never has to
// reconcile single-team vs. two-team selections against each other. The
// merged variable catalog (built-ins + this user's Custom Metrics, see
// charts/page.tsx) and the "Add Custom Metric" upload entry point live here,
// one level up from both workspaces, so uploading a metric once makes it
// available in both without either workspace needing its own upload button.
export function ChartsModeSwitcher({
  sportKey,
  teamNames,
  variables,
}: {
  sportKey: string;
  teamNames: string[];
  variables: ModelVariableDef[];
}) {
  const [mode, setMode] = useState<Mode>("single");
  const [uploadOpen, setUploadOpen] = useState(false);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-full bg-muted p-1" style={{ width: "fit-content" }}>
          {(["single", "compare"] as Mode[]).map((m) => (
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

        <button
          onClick={() => setUploadOpen(true)}
          className="rounded-full border border-border bg-card px-4 py-1.5 text-sm font-medium text-foreground shadow-soft transition hover:bg-muted"
        >
          + Add Custom Metric
        </button>
      </div>

      {mode === "single" ? (
        <ChartsWorkspace sportKey={sportKey} teamNames={teamNames} variables={variables} />
      ) : (
        <TeamComparisonWorkspace sportKey={sportKey} teamNames={teamNames} variables={variables} />
      )}

      {uploadOpen && <CustomMetricUpload sportKey={sportKey} onClose={() => setUploadOpen(false)} />}
    </div>
  );
}
