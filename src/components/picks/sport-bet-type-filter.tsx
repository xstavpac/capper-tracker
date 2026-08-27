"use client";

import { useState } from "react";

type BetTypeOption = { value: string; label: string };

const SELECT_CLASS = "w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground sm:w-auto";

// Sport and bet-type together in one client component, not two separate
// plain server-rendered <select>s - the bet-type <select>'s available
// options depend on which sport is currently selected (see PicksPage's
// computeVisibleBetTypeOptions), so they can't be independent. Before this,
// changing the sport dropdown didn't recompute bet-type options until a full
// page reload (clicking Filter) - confusing, since the two controls visually
// look like they should react to each other immediately.
//
// `optionsBySportId` is precomputed server-side (every real sport id plus ""
// for "All sports") and passed down as plain data - this component never
// needs to import chipSetForLeague or anything else from the server-only
// stats.ts module, just look up whichever sport is currently selected.
// Selecting a sport whose option list no longer contains the currently-
// selected bet type resets it to "All bet types" rather than silently
// submitting a stale, now-invalid value.
export function SportBetTypeFilter({
  sports,
  optionsBySportId,
  initialSportId,
  initialBetType,
}: {
  sports: { id: string; name: string }[];
  optionsBySportId: Record<string, BetTypeOption[]>;
  initialSportId: string;
  initialBetType: string;
}) {
  const [sportId, setSportId] = useState(initialSportId);
  const [betType, setBetType] = useState(initialBetType);
  const options = optionsBySportId[sportId] ?? [];

  return (
    <>
      <select
        name="sportId"
        value={sportId}
        onChange={(e) => {
          const nextSportId = e.target.value;
          setSportId(nextSportId);
          const nextOptions = optionsBySportId[nextSportId] ?? [];
          if (!nextOptions.some((o) => o.value === betType)) setBetType("");
        }}
        className={SELECT_CLASS}
      >
        <option value="">All sports</option>
        {sports.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>

      <select name="betType" value={betType} onChange={(e) => setBetType(e.target.value)} className={SELECT_CLASS}>
        <option value="">All bet types</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </>
  );
}
