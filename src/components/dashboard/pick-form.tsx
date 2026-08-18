"use client";

import { useState, useRef } from "react";
import { createPickAction } from "@/server/actions/picks";

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

export function PickForm({ cappers, sports, atLimit }: { cappers: Capper[]; sports: Sport[]; atLimit?: boolean }) {
  const [isOpen, setIsOpen] = useState(false);
  const [sportId, setSportId] = useState(sports[0]?.id ?? "");
  const [betType, setBetType] = useState("SPREAD");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const selectedSport = sports.find((s) => s.id === sportId);

  if (atLimit && !isOpen) {
    return (
      <div className="rounded-card bg-amber-50 p-4 shadow-soft dark:bg-amber-500/10">
        <p className="text-sm text-amber-800 dark:text-amber-300">
          You&apos;ve reached the Free plan&apos;s 1,000-pick limit - tracking is paused until you upgrade.
        </p>
        <a
          href="/pricing"
          className="mt-2 inline-block rounded-full bg-amber-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-amber-700"
        >
          Upgrade to Basic for unlimited picks
        </a>
      </div>
    );
  }

  if (cappers.length === 0) {
    return (
      <div className="rounded-card bg-card p-4 shadow-soft">
        <p className="text-sm text-muted-foreground">
          Add a capper first before logging picks -{" "}
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
        className="rounded-full bg-brand-600 px-5 py-2.5 text-sm font-medium text-white shadow-soft transition hover:bg-brand-700"
      >
        + Log a pick
      </button>
    );
  }

  async function handleSubmit(formData: FormData) {
    setError(null);
    setSubmitting(true);

    const result = await createPickAction(formData);
    setSubmitting(false);

    if (!result.success) {
      setError(result.error);
      return;
    }

    setIsOpen(false);
    formRef.current?.reset();
    setBetType("SPREAD");
  }

  const betDetailPlaceholder =
    betType === "SPREAD"
      ? "e.g. Lakers -4.5"
      : betType === "MONEYLINE"
        ? "e.g. Celtics ML"
        : betType === "TOTAL"
          ? "e.g. Over 224.5"
          : "e.g. LeBron James Over 27.5 pts";

  return (
    <form
      ref={formRef}
      action={handleSubmit}
      className="rounded-card bg-card p-5 shadow-soft"
    >
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">Log a pick</h3>
        <button
          type="button"
          onClick={() => setIsOpen(false)}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-500/10 dark:text-red-400">{error}</div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Capper</label>
          <select
            name="capperId"
            required
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
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Bet type</label>
          <select
            name="betType"
            value={betType}
            onChange={(e) => setBetType(e.target.value)}
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
            name="sportId"
            value={sportId}
            onChange={(e) => setSportId(e.target.value)}
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
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            League (optional)
          </label>
          <select
            name="leagueId"
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-brand-400 focus:outline-none"
          >
            <option value="">None</option>
            {selectedSport?.leagues.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Away team</label>
          <input
            name="awayTeam"
            required
            placeholder="e.g. Warriors"
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-brand-400 focus:outline-none"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Home team</label>
          <input
            name="homeTeam"
            required
            placeholder="e.g. Lakers"
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-brand-400 focus:outline-none"
          />
        </div>

        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Pick detail</label>
          <input
            name="betDetail"
            placeholder={betDetailPlaceholder}
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-brand-400 focus:outline-none"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Odds (American)
          </label>
          <input
            name="odds"
            type="number"
            required
            placeholder="-110"
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-brand-400 focus:outline-none"
          />
        </div>

        {(betType === "SPREAD" || betType === "TOTAL") && (
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              {betType === "SPREAD" ? "Spread line (e.g. -4.5)" : "Total line (e.g. 224.5)"}
            </label>
            <input
              name="line"
              type="number"
              step="0.5"
              placeholder={betType === "SPREAD" ? "-4.5" : "224.5"}
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-brand-400 focus:outline-none"
            />
          </div>
        )}

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Period</label>
          <select
            name="period"
            defaultValue="FULL_GAME"
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-brand-400 focus:outline-none"
          >
            <option value="FULL_GAME">Full game</option>
            <option value="FIRST_HALF">First half / F5</option>
          </select>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Units</label>
          <input
            name="units"
            type="number"
            step="0.1"
            min="0.1"
            required
            placeholder="1"
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-brand-400 focus:outline-none"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Sportsbook (optional)
          </label>
          <input
            name="sportsbook"
            placeholder="e.g. DraftKings"
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-brand-400 focus:outline-none"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Game time</label>
          <input
            name="gameTime"
            type="datetime-local"
            required
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-brand-400 focus:outline-none"
          />
        </div>

        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Notes (optional)</label>
          <textarea
            name="notes"
            rows={2}
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-brand-400 focus:outline-none"
          />
        </div>
      </div>

      <button
        type="submit"
        disabled={submitting}
        className="mt-4 rounded-full bg-brand-600 px-5 py-2.5 text-sm font-medium text-white shadow-soft transition hover:bg-brand-700 disabled:opacity-50"
      >
        {submitting ? "Logging..." : "Log pick"}
      </button>
    </form>
  );
}
