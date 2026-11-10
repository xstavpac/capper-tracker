// Capper "did you mean" names: near misses are SUGGESTED (never auto-merged) - except a name that is one saved
// capper plus/minus a single "s" (both >= 5 chars, no other near match), which files under it - and a
// person's answer to a name pair is remembered so that exact pair is not asked again.
// Pure - no database. Run with: npx tsx src/lib/capper-canonical-key-acceptance-test.ts
import { readFileSync } from "node:fs";
import {
  capperKeys,
  capperPairKeys,
  findPluralOnlyMatch,
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

// --- regex fix: per-word key splits on whitespace, not the letter s ---
check("4. perWord key strips one trailing s per WORD: 'Cody covers spreads' -> codycoverspread", capperKeys("Cody covers spreads").includes("codycoverspread") && !capperKeys("Cody covers spreads").includes("codycoverpread"));
check("4b. 'codycoversspreads' squashes to the saved name exactly: no question at all", resolveCapperNameSuggestion("codycoversspreads", ["Cody covers spreads"], []).suggestion === null);
check("4b2. a genuine extra s mid-name ('codycoverssspreads') is still found", findPluralOnlyMatch("codycoverssspreads", ["Cody covers spreads"]) === "Cody covers spreads");
check("4c. multi-s name: 'Bass Pros Lasses' keeps its s letters in the key", capperKeys("Bass Pros Lasses").includes("basprolasse") && canon("basspros lasses", ["Bass Pros Lasses"]) === null);

// --- narrow auto-resolve: one s, one saved capper, >= 5 chars ---
const plural = (n: string, saved: string[]) => findPluralOnlyMatch(n, saved);
check("A1. 'codycoverspreads' auto-resolves to 'Cody covers spreads'", plural("codycoverspreads", ["Cody covers spreads"]) === "Cody covers spreads");
check("A1b. via resolveCapperNameSuggestion: remembered SAME, auto", (() => { const r = resolveCapperNameSuggestion("codycoverspreads", ["Cody covers spreads"], []); return r.suggestion === "Cody covers spreads" && r.remembered === "SAME" && r.auto === true; })());
check("A2. trailing s: 'Lock King' -> 'Lock Kings'; extra s the other way too", plural("Lock King", ["Lock Kings"]) === "Lock Kings" && plural("Lock Kings", ["Lock King"]) === "Lock King");
check("A3. two saved cappers qualify -> prompt, not auto", plural("Lock King", ["Lock Kings", "Locks King"]) === null && resolveCapperNameSuggestion("Lock King", ["Lock Kings", "Locks King"], []).remembered === null);
check("A3b. another saved capper is also a near match -> prompt", plural("Lock King", ["Lock Kings", "Lock Kingz"]) === null);
check("A4. non-s difference (typo) still prompts, not auto", plural("Lock Kingz", ["Lock Kings"]) === null && resolveCapperNameSuggestion("Lock Kingz", ["Lock Kings"], []).remembered === null);
check("A4b. s plus another edit is not auto", plural("Lock Kinge", ["Lock Kings"]) === null && plural("Lock Kingss", ["Lock King"]) === null);
check("A5. short names never auto: Bears/Bear, AFS/AF, TBS/TB, Bear/Bears", plural("Bears", ["Bear"]) === null && plural("AFS", ["AF"]) === null && plural("TBS", ["TB"]) === null && plural("Bear", ["Bears"]) === null);
check("A6. Sharp Sam vs Sharp Pete: nothing", plural("Sharp Sam", ["Sharp Pete"]) === null && canon("Sharp Sam", ["Sharp Pete"]) === null);
check("A7. a stored DIFFERENT answer beats the auto-resolve", resolveCapperNameSuggestion("Lock King", ["Lock Kings"], [{ ...capperPairKeys("Lock King", "Lock Kings"), decision: "DIFFERENT" }]).remembered === "DIFFERENT");
check("A8. exact saved name: still no suggestion", resolveCapperNameSuggestion("lock kings", ["Lock Kings"], []).suggestion === null);

// --- remembered answers: a tiny model of two consecutive imports (typo pairs, which still ask) ---
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

check("N. with no stored answers, a non-plural near miss asks (never silently resolved)", asks("Codycoverspreadz") && asks("Lock Kingz"));
check("N2. no stored answer -> remembered is null for a typo candidate", resolveCapperNameSuggestion("Codycoverspreadz", saved, []).remembered === null);
check("N3. exact (case/space-insensitive) saved name: no question at all", resolveCapperNameSuggestion("cody covers  SPREADS", saved, []).suggestion === null);

answer("Codycoverspreadz", "SAME");
check("R1. after answering once, the exact pair no longer asks", !asks("Codycoverspreadz"));
check("R1b. ...and replays the stored answer", resolveCapperNameSuggestion("Codycoverspreadz", saved, store).remembered === "SAME");
check("R1c. case/punctuation variants of the same typed name reuse it", resolveCapperNameSuggestion("CODY-coverspreadz", saved, store).remembered === "SAME");
check("R2. a different new pair still asks (Lock Kingz vs Lock Kings)", asks("Lock Kingz"));

answer("Lock Kingz", "DIFFERENT");
check("R3. a DIFFERENT answer is remembered too (no prompt, not merged)", !asks("Lock Kingz") && resolveCapperNameSuggestion("Lock Kingz", saved, store).remembered === "DIFFERENT");
check("R4. an answer for one pair does not leak to another typed spelling", asks("Lock Kingq"));

// --- wiring guards: the only place a name is rewritten is a remembered SAME ---
const orch = readFileSync("src/server/data/catalog-import-orchestrator.ts", "utf8");
check("W1. orchestrator rewrites a name only on remembered === SAME", /remembered === "SAME"\) p = \{ \.\.\.p, capperName: remembered\.suggestion \}/.test(orch) && !/findCanonicalCapperMatch/.test(orch));
const find = readFileSync("src/server/data/capper-find-or-create.ts", "utf8");
check("W2. findOrCreateCapper does not use the remembered-answer feature", !/capper-name-decisions|resolveCapperNameSuggestion|findCanonicalCapperMatch/.test(find));

process.exit(failed ? 1 : 0);
