"use client";

import { useState } from "react";
import { parseCatalog, type ParsedPick } from "@/lib/parse-catalog";
import { bulkImportPicksAction } from "@/server/actions/bulk-picks";

export function BulkImportForm({ existingCapperNames }: { existingCapperNames: string[] }) {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<ParsedPick[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(
    null
  );

  const existingLower = existingCapperNames.map((n) => n.toLowerCase());

  function handleParse() {
    setResult(null);
    setParsed(parseCatalog(text, existingCapperNames));
  }

  async function handleImport() {
    if (!parsed) return;
    setImporting(true);
    const res = await bulkImportPicksAction(
      parsed.map((p) => ({
        capperName: p.capperName,
        sportName: p.sportName,
        description: p.description,
        betType: p.betType,
        odds: p.odds,
        units: p.units,
        isFirstFive: p.isFirstFive,
      }))
    );
    setImporting(false);
    if (res.success) {
      setResult({ imported: res.imported, skipped: res.skipped, errors: res.errors });
      setParsed(null);
      setText("");
    }
  }

  return (
    <div className="rounded-card bg-white p-5 shadow-soft">
      <h3 className="mb-1 text-sm font-medium text-gray-900">Betting Catalog Import</h3>
      <p className="mb-3 text-xs text-gray-500">
        Paste a full catalog dump below - capper name lines followed by bullet picks. We will
        auto-detect sport, bet type, odds, and units for each pick.
      </p>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={10}
        placeholder={"ExampleCapper123\n* MLB: Detroit Tigers ML (-117) (2u)"}
        className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-xs focus:border-brand-400 focus:outline-none"
      />

      <button
        onClick={handleParse}
        disabled={!text.trim()}
        className="mt-3 rounded-full bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200 disabled:opacity-50"
      >
        Preview
      </button>

      {parsed && (
        <div className="mt-4">
          <div className="mb-2 text-sm font-medium text-gray-700">
            {parsed.length} pick{parsed.length === 1 ? "" : "s"} found
          </div>
          <div className="max-h-80 overflow-y-auto rounded-lg border border-gray-100">
            <div className="divide-y divide-gray-100">
              {parsed.map((p, i) => (
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
            disabled={importing}
            className="mt-3 rounded-full bg-brand-600 px-5 py-2.5 text-sm font-medium text-white shadow-soft hover:bg-brand-700 disabled:opacity-50"
          >
            {importing ? "Importing..." : "Import " + parsed.length + " picks"}
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
        </div>
      )}
    </div>
  );
}
