import type { DateRange } from "@/server/data/historical-variables";
import { easternDateKey } from "@/lib/dates";

// The "From ... to ..." pair every charts tool needs - extracted out of
// ChartsWorkspace so TeamComparisonWorkspace uses the exact same markup/
// constraints (start can't exceed end, end can't exceed today) instead of a
// second copy that could quietly drift.
export function DateRangePicker({ value, onChange }: { value: DateRange; onChange: (next: DateRange) => void }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <label className="text-muted-foreground">From</label>
      <input
        type="date"
        value={value.start}
        max={value.end}
        onChange={(e) => onChange({ ...value, start: e.target.value })}
        className="rounded-lg border border-border bg-card px-2 py-1 text-sm text-foreground"
      />
      <label className="text-muted-foreground">to</label>
      <input
        type="date"
        value={value.end}
        min={value.start}
        max={easternDateKey(new Date())}
        onChange={(e) => onChange({ ...value, end: e.target.value })}
        className="rounded-lg border border-border bg-card px-2 py-1 text-sm text-foreground"
      />
    </div>
  );
}
