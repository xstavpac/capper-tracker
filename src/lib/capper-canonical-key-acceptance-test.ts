// Capper "did you mean" names: plural-"s" variants are SUGGESTED (never auto-merged), and a
// person's answer to a name pair is remembered so that exact pair is not asked again.
// Pure - no database. Run with: npx tsx src/lib/capper-canonical-key-acceptance-test.ts
import { readFileSync } from "node:fs";
import {
  capperPairKeys,
  findCanonicalCapperMatch,
  findClosestFuzzyMatch,
  resolveCapperNameSuggestion,
  type StoredCapperNameDecision,
} from "./fuzzy-match";

let failed = 0;
function check(label: string, ok: boolean) {
  console.log((ok ? "PASS " : "FAIL ") + label);
  if (!ok) failed++;
}
const canon = (name: string, saved: string[]) => findCanonicalCapperMatch(name, saved);

// --- matching (unchanged from the silent version, but it now only produces a suggestion) ---
check("1. 'Codycoverspreads' matches 'Cody covers spreads' (mid-string s)", canon("Codycoverspreads", ["Cody covers spreads"]) === "Cody covers spreads");
check("1b. LEGACY reproduces: Levenshtein alone also asks here, every import", findClosestFuzzyMatch("Codycoverspreads", ["Cody covers spreads"], (n) => n) !== null);
check("2. 'codycoversspread' matches 'Cody Covers Spreads' (trailing s)", canon("codycoversspread", ["Cody Covers Spreads"]) === "Cody Covers Spreads");
check("3a. Sharp Sam vs Sharp Pete: no canonical match", canon("Sharp Sam", ["Sharp Pete"]) === null);
check("3b. Bears vs Bear: under the 5-char floor", canon("Bears", ["Bear"]) === null);
check("3c. AFS vs AF / TBS vs TB", canon("AFS", ["AF"]) === null && canon("TBS", ["TB"]) === null);

// --- remembered answers: a tiny model of two consecutive imports ---
const saved = ["Cody covers spreads", "Lock Kings"];
let store: StoredCapperNameDecision[] = [];
const answer = (raw: string, d: "SAME" | "DIFFERENT") => {
  const s = resolveCapperNameSuggestion(raw, saved, store).suggestion!;
  store = [...store, { ...capperPairKeys(raw, s), decision: d }];
};
const asks = (raw: string) => {
  const r = resolveCapperNameSuggestion(raw, saved, store);
  return r.suggestion !== null && r.remembered === null;
};

check("N. with no stored answers, a plural-variant pair asks (never silently resolved)", asks("Codycoverspreads") && asks("Lock King"));
check("N2. no stored answer -> remembered is null for every candidate (nothing auto-merges)", resolveCapperNameSuggestion("Codycoverspreads", saved, []).remembered === null);
check("N3. exact (case/space-insensitive) saved name: no question at all", resolveCapperNameSuggestion("cody covers  SPREADS", saved, []).suggestion === null);

answer("Codycoverspreads", "SAME");
check("R1. after answering once, the exact pair no longer asks", !asks("Codycoverspreads"));
check("R1b. ...and replays the stored answer", resolveCapperNameSuggestion("Codycoverspreads", saved, store).remembered === "SAME");
check("R1c. case/punctuation variants of the same typed name reuse it", resolveCapperNameSuggestion("CODY-coverspreads", saved, store).remembered === "SAME");
check("R2. a different new pair still asks (Lock King vs Lock Kings)", asks("Lock King"));

answer("Lock King", "DIFFERENT");
check("R3. a DIFFERENT answer is remembered too (no prompt, not merged)", !asks("Lock King") && resolveCapperNameSuggestion("Lock King", saved, store).remembered === "DIFFERENT");
check("R4. an answer for one pair does not leak to another typed spelling", asks("Lock Kingz"));

// --- wiring guards: the only place a name is rewritten is a remembered SAME ---
const orch = readFileSync("src/server/data/catalog-import-orchestrator.ts", "utf8");
check("W1. orchestrator rewrites a name only on remembered === SAME", /remembered === "SAME"\) p = \{ \.\.\.p, capperName: remembered\.suggestion \}/.test(orch) && !/findCanonicalCapperMatch/.test(orch));
const find = readFileSync("src/server/data/capper-find-or-create.ts", "utf8");
check("W2. findOrCreateCapper does not use the remembered-answer feature", !/capper-name-decisions|resolveCapperNameSuggestion|findCanonicalCapperMatch/.test(find));

process.exit(failed ? 1 : 0);
