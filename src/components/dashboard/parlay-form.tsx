"use client";

import { useState } from "react";
import { createParlayAction, type LegActionInput } from "@/server/actions/parlays";

type Capper = { id: string; name: string };
type League = { id: string; name: string; sportId: string };
type Sport = { id: string; name: string; leagues: League[] };

const BET_TYPES = [
  { value: "SPREAD", label: "Spread" },
  { value: "MONEYLINE", label: "Moneyline" },
  { value: "TOTAL", label: "Total" },
  { value: "PLAYER_PROP", label: "Player Prop" },
  { value: "NRFI", label: "NRFI / YRFI" },
];

const MIN_LEGS = 2;

type LegDraft = {
  sportId: string;
  leagueId: string;
  homeTeam: string;
  awayTeam: string;
  betType: string;
  betDetail: string;
  odds: string;
  line: string;
  period: string;
  gameTime: string;
};

function emptyLeg(defaultSportId: string): LegDraft {
  return {
    sportId: defaultSportId,
    leagueId: "",
    homeTeam: "",
    awayTeam: "",
    betType: "SPREAD",
    betDetail: "",
    odds: "",
    line: "",
    period: "FULL_GAME",
    gameTime: "",
  };
}

export function ParlayForm({ cappers, sports }: { cappers: Capper[]; sports: Sport[] }) {
  const [isOpen, setIsOpen] = useState(false);
  const [capperId, setCapperId] = useState(cappers[0]?.id ?? "");
  const [units, setUnits] = useState("1");
  const defaultSportId = sports[0]?.id ?? "";
  const [legs, setLegs] = useState<LegDraft[]>([emptyLeg(defaultSportId), emptyLeg(defaultSportId)]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (cappers.length === 0) {
    return (
      <div className="rounded-card bg-card p-4 shadow-soft">
        <p className="text-sm text-muted-foreground">
          Add a capper first before logging a parlay -{" "}
          <a href="/cappers" className="font-medium text-brand-600">
            go to Cappers
          </a>
          .
        </p>
      </div>
    );
  }

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="rounded-full border border-brand-200 bg-card px-5 py-2.5 text-sm font-medium text-brand-600 shadow-soft transition hover:bg-brand-50 dark:border-brand-800 dark:text-brand-400 dark:hover:bg-brand-500/10"
      >
        + Log a parlay
      </button>
    );
  }

  function updateLeg(index: number, patch: Partial<LegDraft>) {
    setLegs((prev) => prev.map((leg, i) => (i === index ? { ...leg, ...patch } : leg)));
  }

  function addLeg() {
    setLegs((prev) => [...prev, emptyLeg(defaultSportId)]);
  }

  function removeLeg(index: number) {
    setLegs((prev) => (prev.length <= MIN_LEGS ? prev : prev.filter((_, i) => i !== index)));
  }

  async function handleSubmit() {
    setError(null);
    setSubmitting(true);

    const legInputs: LegActionInput[] = legs.map((leg) => ({
      sportId: leg.sportId,
      leagueId: leg.leagueId || undefined,
      homeTeam: leg.homeTeam,
      awayTeam: leg.awayTeam,
      betType: leg.betType as LegActionInput["betType"],
      betDetail: leg.betDetail || undefined,
      odds: parseInt(leg.odds, 10),
      line: leg.line.trim() ? parseFloat(leg.line) : null,
      period: leg.period as LegActionInput["period"],
      gameTime: leg.gameTime,
    }));

    const result = await createParlayAction({
      capperId,
      units: parseFloat(units),
      legs: legInputs,
    });
    setSubmitting(false);

    if (!result.success) {
      setError(result.error);
      return;
    }

    setIsOpen(false);
    setUnits("1");
    setLegs([emptyLeg(defaultSportId), emptyLeg(defaultSportId)]);
  }

  return (
    <div className="rounded-card bg-card p-5 shadow-soft">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">Log a parlay</h3>
        <button type="button" onClick={() => setIsOpen(false)} className="text-sm text-muted-foreground hover:text-foreground">
          Cancel
        </button>
      </div>

      {error && <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-500/10 dark:text-red-400">{error}</div>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Capper</label>
          <select
            value={capperId}
            onChange={(e) => setCapperId(e.target.value)}
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-brand-400 focus:outline-none"
          >
            {cappers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Total units (whole parlay)</label>
          <input
            type="number"
            step="0.1"
            min="0.1"
            value={units}
            onChange={(e) => setUnits(e.target.value)}
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-brand-400 focus:outline-none"
          />
        </div>
      </div>

      <div className="mt-5 space-y-4">
        {legs.map((leg, i) => {
          const selectedSport = sports.find((s) => s.id === leg.sportId);
          return (
            <div key={i} className="rounded-lg border border-border-subtle p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-semibold text-muted-foreground">Leg {i + 1}</span>
                {legs.length > MIN_LEGS && (
                  <button
                    type="button"
                    onClick={() => removeLeg(i)}
                    className="text-xs text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                  >
                    Remove
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Bet type</label>
                  <select
                    value={leg.betType}
                    onChange={(e) => updateLeg(i, { betType: e.target.value })}
                    className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-brand-400 focus:outline-none"
                  >
                    {BET_TYPES.map((b) => (
                      <option key={b.value} value={b.value}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Sport</label>
                  <select
                    value={leg.sportId}
                    onChange={(e) => updateLeg(i, { sportId: e.target.value, leagueId: "" })}
                    className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-brand-400 focus:outline-none"
                  >
                    {sports.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Away team</label>
                  <input
                    value={leg.awayTeam}
                    onChange={(e) => updateLeg(i, { awayTeam: e.target.value })}
                    placeholder="e.g. Warriors"
                    className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-brand-400 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Home team</label>
                  <input
                    value={leg.homeTeam}
                    onChange={(e) => updateLeg(i, { homeTeam: e.target.value })}
                    placeholder="e.g. Lakers"
                    className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-brand-400 focus:outline-none"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Pick detail</label>
                  <input
                    value={leg.betDetail}
                    onChange={(e) => updateLeg(i, { betDetail: e.target.value })}
                    placeholder="e.g. Lakers -4.5"
                    className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-brand-400 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Odds (this leg)</label>
                  <input
                    type="number"
                    value={leg.odds}
                    onChange={(e) => updateLeg(i, { odds: e.target.value })}
                    placeholder="-110"
                    className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-brand-400 focus:outline-none"
                  />
                </div>

                {(leg.betType === "SPREAD" || leg.betType === "TOTAL") && (
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">Line</label>
                    <input
                      type="number"
                      step="0.5"
                      value={leg.line}
                      onChange={(e) => updateLeg(i, { line: e.target.value })}
                      placeholder={leg.betType === "SPREAD" ? "-4.5" : "224.5"}
                      className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-brand-400 focus:outline-none"
                    />
                  </div>
                )}

                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Period</label>
                  <select
                    value={leg.period}
                    onChange={(e) => updateLeg(i, { period: e.target.value })}
                    className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-brand-400 focus:outline-none"
                  >
                    <option value="FULL_GAME">Full game</option>
                    <option value="FIRST_HALF">First half / F5</option>
                  </select>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Game time</label>
                  <input
                    type="datetime-local"
                    value={leg.gameTime}
                    onChange={(e) => updateLeg(i, { gameTime: e.target.value })}
                    className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-brand-400 focus:outline-none"
                  />
                </div>

                {selectedSport && selectedSport.leagues.length > 0 && (
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">League (optional)</label>
                    <select
                      value={leg.leagueId}
                      onChange={(e) => updateLeg(i, { leagueId: e.target.value })}
                      className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-brand-400 focus:outline-none"
                    >
                      <option value="">None</option>
                      {selectedSport.leagues.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={addLeg}
        className="mt-3 rounded-full border border-border px-4 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
      >
        + Add leg
      </button>

      <div>
        <button
          type="button"
          disabled={submitting}
          onClick={handleSubmit}
          className="mt-4 rounded-full bg-brand-600 px-5 py-2.5 text-sm font-medium text-white shadow-soft transition hover:bg-brand-700 disabled:opacity-50"
        >
          {submitting ? "Logging..." : "Log parlay"}
        </button>
      </div>
    </div>
  );
}
