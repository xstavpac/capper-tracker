"use client";

import { useState } from "react";
import { parseCatalog, resolveAmbiguousPick, type AmbiguousOption, type ParsedPick } from "@/lib/parse-catalog";
import { bulkImportPicksAction, previewBulkImportOdds } from "@/server/actions/bulk-picks";
import { dropCatalogButtonClass, LightningIcon } from "@/components/dashboard/drop-catalog-button";

const CAPPER_ACCENTS = [
  "border-l-sky-400",
  "border-l-emerald-400",
  "border-l-amber-400",
  "border-l-fuchsia-400",
  "border-l-rose-400",
  "border-l-indigo-400",
  "border-l-teal-400",
  "border-l-orange-400",
];

export function BulkImportForm({ existingCapperNames }: { existingCapperNames: string[] }) {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<ParsedPick[] | null>(null);
  const [enrichedOdds, setEnrichedOdds] = useState<Record<number, number>>({});
  const [loadingOdds, setLoadingOdds] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<
    { imported: number; skipped: number; errors: string[]; unmatchedGames: string[] } | null
  >(null);

  const existingLower = existingCapperNames.map((n) => n.toLowerCase());

  function handleParse() {
    setResult(null);
    setEnrichedOdds({});
    const items = parseCatalog(text, existingCapperNames);
    setParsed(items);
    fetchOddsFor(items.map((p, idx) => ({ p, idx })).filter((e) => !e.p.ambiguous));
  }

  // The parser is client-side only and can't see live odds, so every pick
  // without an explicit price shows the -110 default at first - fetch the
  // same real-price lookup the actual import uses and merge it in once it
  // resolves, so the preview matches what importing will actually save.
  // Keyed by each pick's index in `parsed` (not its position among valid
  // picks) so a later single-pick refetch - e.g. after resolving an
  // ambiguous team - can merge in without invalidating odds already fetched
  // for every other row, which a valid-picks-position key would do the
  // moment resolution shifts everything after it.
  function fetchOddsFor(entries: { p: ParsedPick; idx: number }[]) {
    if (entries.length === 0) return;
    setLoadingOdds(true);
    previewBulkImportOdds(
      entries.map((e) => ({
        sportName: e.p.sportName,
        betType: e.p.betType,
        hasExplicitOdds: e.p.hasExplicitOdds,
        odds: e.p.odds,
        totalSide: e.p.totalSide,
        teamNicknames: e.p.teamNicknames,
        description: e.p.description,
      }))
    )
      .then((odds) => {
        setEnrichedOdds((prev) => {
          const next = { ...prev };
          for (const [posKey, value] of Object.entries(odds)) {
            const globalIdx = entries[Number(posKey)]?.idx;
            if (globalIdx !== undefined) next[globalIdx] = value;
          }
          return next;
        });
      })
      .finally(() => setLoadingOdds(false));
  }

  function resolveAmbiguous(idx: number, choice: AmbiguousOption) {
    if (!parsed) return;
    const resolved = resolveAmbiguousPick(parsed[idx], choice);
    setParsed((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      next[idx] = resolved;
      return next;
    });
    if (!resolved.hasExplicitOdds) fetchOddsFor([{ p: resolved, idx }]);
  }

  const allEntries = (parsed ?? []).map((p, idx) => ({ p, idx }));
  const validEntries = allEntries.filter((e) => !e.p.ambiguous);
  const ambiguousEntries = allEntries.filter((e) => e.p.ambiguous);
  const validPicks = validEntries.map((e) => e.p);
  const ambiguousPicks = ambiguousEntries.map((e) => e.p);

  const capperAccent = new Map<string, string>();
  for (const p of validPicks) {
    if (!capperAccent.has(p.capperName)) {
      capperAccent.set(p.capperName, CAPPER_ACCENTS[capperAccent.size % CAPPER_ACCENTS.length]);
    }
  }

  async function handleImport() {
    if (validPicks.length === 0) return;
    setImporting(true);
    const res = await bulkImportPicksAction(
      validPicks.map((p) => ({
        capperName: p.capperName,
        sportName: p.sportName,
        description: p.description,
        betType: p.betType,
        odds: p.odds,
        hasExplicitOdds: p.hasExplicitOdds,
        totalSide: p.totalSide,
        teamNicknames: p.teamNicknames,
        units: p.units,
        isFirstFive: p.isFirstFive,
      }))
    );
    setImporting(false);
    if (res.success) {
      setResult({
        imported: res.imported,
        skipped: res.skipped,
        errors: res.errors,
        unmatchedGames: res.unmatchedGames,
      });
      setParsed(null);
      setText("");
    }
  }

  return (
    <div className="rounded-card bg-white p-5 shadow-soft">
      <h3 className="mb-1 text-sm font-medium text-gray-900">Betting Catalog Import</h3>
      <p className="mb-1 text-xs text-gray-500">
        Paste a full catalog dump below - capper name lines followed by picks. We will
        auto-detect sport, bet type, odds, and units for each pick.
      </p>
      <p className="mb-3 text-xs text-gray-400">
        Leave a blank line between different cappers&apos; picks. Cappers already in your saved
        list are recognized automatically, even if their name contains a team name. For a
        brand-new capper whose name happens to collide with a team name (e.g. &quot;Tigers Fan
        Picks&quot;), prefix it with * the first time, e.g. &quot;*Tigers Fan Picks&quot;, so
        it&apos;s read as a name instead of a pick.
      </p>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={10}
        placeholder={
          "Vegas John\nCubs moneyline\nWhite Sox -1.5\n\nHigh Roller Hank\nYankees ML\nDodgers under 8.5"
        }
        className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-xs focus:border-brand-400 focus:outline-none"
      />

      <button onClick={handleParse} disabled={!text.trim()} className={"mt-3 " + dropCatalogButtonClass}>
        <LightningIcon />
        Drop Catalog
      </button>

      {parsed && (
        <div className="mt-4">
          <div className="mb-2 text-sm font-medium text-gray-700">
            {validPicks.length} pick{validPicks.length === 1 ? "" : "s"} found
            {ambiguousPicks.length > 0 &&
              " - " + ambiguousPicks.length + " need clarification"}
            {loadingOdds && <span className="ml-2 font-normal text-gray-400">Looking up real odds...</span>}
          </div>

          {ambiguousEntries.length > 0 && (
            <div className="mb-3 space-y-2">
              {ambiguousEntries.map(({ p, idx }) => (
                <div key={"amb-" + idx} className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <div className="font-medium">
                    {p.capperName}: "{p.description}"
                  </div>
                  <div className="mt-0.5">
                    Ambiguous team - could mean {p.ambiguous!.map((o) => o.label).join(" or ")}.
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {p.ambiguous!.map((opt) => (
                      <button
                        key={opt.label}
                        type="button"
                        onClick={() => resolveAmbiguous(idx, opt)}
                        className="rounded-full border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-medium text-amber-800 transition hover:bg-amber-100"
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <div className="mt-1 text-amber-600">
                    Or edit the text above to specify the city, then preview again.
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="max-h-80 overflow-y-auto rounded-lg border border-gray-100">
            <div>
              {validEntries.map(({ p, idx }, i) => {
                const realOdds = enrichedOdds[idx];
                const displayOdds = realOdds ?? p.odds;
                // A heavier divider below the last pick in each capper's group (not
                // between every pick) - the color accent alone was easy to miss at a
                // glance in a large catalog, this makes the group boundary itself clear.
                const isGroupEnd = validEntries[i + 1] && validEntries[i + 1].p.capperName !== p.capperName;
                return (
                  <div
                    key={idx}
                    className={
                      // Explicit per-row bottom border instead of the parent's divide-y utility -
                      // divide-y sets the border-color shorthand (all 4 sides) on every row but the
                      // first, which was silently stomping this per-capper border-l accent color.
                      "flex flex-col gap-0.5 border-l-4 px-3 py-2 text-xs last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-0 " +
                      (isGroupEnd ? "border-b-2 border-b-gray-300" : "border-b border-b-gray-100") +
                      " " +
                      capperAccent.get(p.capperName)
                    }
                  >
                    <div className="min-w-0">
                      <span className="font-medium">{p.capperName}</span>
                      {!existingLower.includes(p.capperName.toLowerCase()) && (
                        <span className="ml-1 rounded-full bg-brand-50 px-1.5 py-0.5 text-brand-600">
                          new
                        </span>
                      )}
                      <span className="ml-2 text-gray-500">
                        {p.sportName} - {p.description}
                      </span>
                    </div>
                    <div className="text-gray-400 sm:shrink-0">
                      {p.betType} - {displayOdds > 0 ? "+" : ""}
                      {displayOdds}
                      {realOdds !== undefined && <span className="ml-1 text-emerald-600">(real)</span>}
                      {" - " + p.units + "u"}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <button
            onClick={handleImport}
            disabled={importing || validPicks.length === 0}
            className="mt-3 rounded-full bg-brand-600 px-5 py-2.5 text-sm font-medium text-white shadow-soft hover:bg-brand-700 disabled:opacity-50"
          >
            {importing ? "Importing..." : "Import " + validPicks.length + " picks"}
          </button>
        </div>
      )}

      {result && (
        <div className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Imported {result.imported} pick{result.imported === 1 ? "" : "s"}.
          {result.skipped > 0 && " " + result.skipped + " skipped."}
          {result.errors.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-xs text-red-600">
              {result.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
          {result.unmatchedGames.length > 0 && (
            <div className="mt-2 text-xs text-amber-700">
              Couldn&apos;t match {result.unmatchedGames.length} pick
              {result.unmatchedGames.length === 1 ? "" : "s"} to today&apos;s schedule - they
              were still imported, but won&apos;t auto-grade:
              <ul className="mt-1 list-disc pl-4">
                {result.unmatchedGames.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
