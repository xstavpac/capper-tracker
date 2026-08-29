"use client";

// Two-option MLB / NFL toggle above the workspace switcher. Drives the team
// selector, variable picker, and data provider for both team workspaces
// (ChartsWorkspace, TeamComparisonWorkspace). Not shown in Capper
// Comparison mode - that tool is sport-agnostic. Selection is not persisted;
// the page always opens on the first option (MLB).
export type SportOption = { key: string; label: string };

export function SportSwitcher({
  options,
  value,
  onChange,
}: {
  options: SportOption[];
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="flex gap-1 rounded-full bg-muted p-1" style={{ width: "fit-content" }}>
      {options.map((opt) => (
        <button
          key={opt.key}
          onClick={() => onChange(opt.key)}
          className={
            "rounded-full px-4 py-1.5 text-sm font-medium transition " +
            (value === opt.key ? "bg-card text-foreground shadow-soft" : "text-muted-foreground hover:text-foreground")
          }
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
