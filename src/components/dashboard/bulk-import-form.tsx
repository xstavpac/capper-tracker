"use client";

import { useState } from "react";
import { parseCatalog, type ParsedPick } from "@/lib/parse-catalog";
import { bulkImportPicksAction } from "@/server/actions/bulk-picks";
import { dropCatalogButtonClass, LightningIcon } from "@/components/dashboard/drop-catalog-button";

export function BulkImportForm({ existingCapperNames }: { existingCapperNames: string[] }) {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<ParsedPick[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<
    { imported: number; skipped: number; errors: string[]; unmatchedGames: string[] } | null
  >(null);

  const existingLower = existingCapperNames.map((n) => n.toLowerCase());

  function handleParse() {
    setResult(null);
    setParsed(parseCatalog(text, existingCapperNames));
  }

  const validPicks = (parsed ?? []).filter((p) => !p.ambiguous);
  const ambiguousPicks = (parsed ?? []).filter((p) => p.ambiguous);

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
      <p className="mb-3 text-xs text-gray-500">
        Paste a full catalog dump below - capper name lines followed by picks. We will
        auto-detect sport, bet type, odds, and units for each pick.
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
          </div>

          {ambiguousPicks.length > 0 && (
            <div className="mb-3 space-y-2">
              {ambiguousPicks.map((p, i) => (
                <div key={"amb-" + i} className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <div className="font-medium">
                    {p.capperName}: "{p.description}"
                  </div>
                  <div className="mt-0.5">
                    Ambiguous team - could mean {p.ambiguous!.join(" or ")}. Edit the text
                    above to specify the city, then preview again.
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="max-h-80 overflow-y-auto rounded-lg border border-gray-100">
            <div className="divide-y divide-gray-100">
              {validPicks.map((p, i) => (
                <div key={i} className="flex items-center justify-between px-3 py-2 text-xs">
                  <div>
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
                  <div className="text-gray-400">
                    {p.betType} - {p.odds > 0 ? "+" : ""}
                    {p.odds} - {p.units}u
                  </div>
                </div>
              ))}
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
              {result.unmatchedGames.length === 1 ? "" : "s"} to today&apos;s MLB schedule - they
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
