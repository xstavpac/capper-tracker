// The frozen diffs' slip cases (selection / NBA same-game / contrarian / long-shot / scoring switch) were
// captured when Best available put every slip pick in and generated the rest. Best available now never
// reads the slip (generator.ts snapshotForFill); that build is Combined with every slip pick as a manual
// leg (manualSlots: MAX_PARLAY_LEGS, clamped to the slip). Its legs, Hedge and Contrarian are byte-identical
// to the frozen ones. What differs is Combined's own wording, by design: a slip pick it skipped is
// not_selected (not left_out / duplicate), its shortfall line, no `limited`, its capacityText and the
// `combined` block. The frozen harnesses compare those cases on legs, Hedge and Contrarian only.
import type { GeneratorSettings } from "@/lib/parlay/generator";

export const fillModeAnnotationsDiffer = (settings: Pick<GeneratorSettings, "fillFrom">): boolean => settings.fillFrom === "COMBINED";

// `now` with the mode-annotation fields taken from `was`, so a compare sees legs, Hedge and Contrarian only.
export function withFrozenAnnotations<T extends object>(now: T, was: T | undefined, fields: readonly (keyof T)[]): T {
  if (!was) return now;
  const out = { ...now };
  for (const f of fields) out[f] = was[f];
  return out;
}
