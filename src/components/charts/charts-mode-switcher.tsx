"use client";

import { useState } from "react";
import { ChartsWorkspace } from "@/components/charts/charts-workspace";
import { TeamComparisonWorkspace } from "@/components/charts/team-comparison-workspace";

type Mode = "single" | "compare";

const MODE_LABEL: Record<Mode, string> = { single: "Team Stats", compare: "Team Comparison" };

// Top-level switch between the two charting tools - both are full, separate
// workspaces (each owns its own team/variable/date-range state from
// scratch), not tabs over one shared state, so switching modes never has to
// reconcile single-team vs. two-team selections against each other.
export function ChartsModeSwitcher({ sportKey, teamNames }: { sportKey: string; teamNames: string[] }) {
  const [mode, setMode] = useState<Mode>("single");

  return (
    <div>
      <div className="mb-4 flex gap-1 rounded-full bg-muted p-1" style={{ width: "fit-content" }}>
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

      {mode === "single" ? (
        <ChartsWorkspace sportKey={sportKey} teamNames={teamNames} />
      ) : (
        <TeamComparisonWorkspace sportKey={sportKey} teamNames={teamNames} />
      )}
    </div>
  );
}
