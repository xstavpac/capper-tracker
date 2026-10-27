// Consensus Hybrid's request validation (hybrid-request.ts): the settings the
// server action accepts, and the clear errors for the ones it doesn't. Pure.
//   npx tsx src/lib/parlay/hybrid-request-acceptance-test.ts
import { parseHybridRequest } from "@/lib/parlay/hybrid-request";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const LIVE = new Set(["NFL", "NBA", "MLB", "NHL"]);
const settings = { targetMin: -140, targetMax: -110, width: "balanced", perLegRange: null, maxLegs: 4 };
const base = { leagues: ["NBA"], targets: [], include: "ALL", settings };
const parse = (over: Record<string, unknown> = {}, s: Record<string, unknown> = {}) => parseHybridRequest({ ...base, ...over, settings: { ...settings, ...s } }, LIVE);
const errorOf = (r: unknown) => (r && typeof r === "object" && "error" in r ? (r as { error: string }).error : null);

const ok = parse();
check("a valid request parses", errorOf(ok), null);
check("...into the settings as sent", "settings" in ok && ok.settings, { targetMin: -140, targetMax: -110, width: "balanced", perLegRange: null, maxLegs: 4 });

// ---- target range ----
check("targetMin above targetMax is rejected, saying why", errorOf(parse({}, { targetMin: -110, targetMax: -140 })), "The target range is backwards: -110 is higher than -140. Put the longer price second (e.g. -140 to -110).");
check("equal ends are a one-price target (allowed)", errorOf(parse({}, { targetMin: -120, targetMax: -120 })), null);
check("a plus-money range is fine", errorOf(parse({}, { targetMin: 100, targetMax: 150 })), null);
check("across even money (-110 to +120) is fine", errorOf(parse({}, { targetMin: -110, targetMax: 120 })), null);
check("not American odds (50) is rejected", errorOf(parse({}, { targetMin: 50 })), "The target odds must be American odds like -140 or +120.");
check("a string, NaN, a missing target", [errorOf(parse({}, { targetMax: "-110" })) !== null, errorOf(parse({}, { targetMin: NaN })) !== null, errorOf(parse({}, { targetMin: undefined })) !== null], [true, true, true]);

// ---- width ----
check("width must be balanced or wider", [errorOf(parse({}, { width: "wider" })), errorOf(parse({}, { width: "narrow" })), errorOf(parse({}, { width: undefined }))], [null, "Width must be \"balanced\" or \"wider\".", "Width must be \"balanced\" or \"wider\"."]);

// ---- max legs ----
check("maxLegs 2, 3, 4 are fine", [2, 3, 4].map((n) => errorOf(parse({}, { maxLegs: n }))), [null, null, null]);
check("maxLegs 1 / 5 / 3.5 / '3' / missing are rejected", [1, 5, 3.5, "3", undefined].map((n) => errorOf(parse({}, { maxLegs: n })) === "Legs must be a whole number from 2 to 4."), [true, true, true, true, true]);

// ---- per-leg range ----
check("no range, or null, is fine", [errorOf(parse({}, { perLegRange: undefined })), errorOf(parse({}, { perLegRange: null }))], [null, null]);
check("a sane range parses", "settings" in parse({}, { perLegRange: { min: -300, max: 150 } }) && (parse({}, { perLegRange: { min: -300, max: 150 } }) as { settings: { perLegRange: unknown } }).settings.perLegRange, { min: -300, max: 150 });
check("a backwards range is rejected", errorOf(parse({}, { perLegRange: { min: -110, max: -300 } })), "The per-leg range is backwards: -110 is higher than -300.");
check("a range wholly below the -600 floor can't match anything", errorOf(parse({}, { perLegRange: { min: -2000, max: -800 } })), "No leg is priced shorter than -600, so a per-leg range ending at -800 can't match anything.");
check("a range that reaches the floor is fine", errorOf(parse({}, { perLegRange: { min: -2000, max: -600 } })), null);
check("a non-price end (0, 99) is rejected", [errorOf(parse({}, { perLegRange: { min: 0, max: 150 } })) !== null, errorOf(parse({}, { perLegRange: { min: -300, max: 99 } })) !== null], [true, true]);
check("a range that is not an object", errorOf(parse({}, { perLegRange: "wide" })) !== null, true);

// ---- scope ----
check("a league the Live board doesn't carry", errorOf(parse({ leagues: ["Cricket"] })) !== null, true);
check("no league and no target", errorOf(parse({ leagues: [] })), "Pick at least one league or game.");
check("targets stand in for leagues", errorOf(parse({ leagues: [], targets: [{ gameId: "g1", leagueName: "NBA" }] })), null);
check("a target with a bad id or league", [errorOf(parse({ targets: [{ gameId: "", leagueName: "NBA" }] })) !== null, errorOf(parse({ targets: [{ gameId: "g1", leagueName: "XFL" }] })) !== null, errorOf(parse({ targets: ["g1"] })) !== null], [true, true, true]);
check("duplicate leagues and targets collapse", (() => { const r = parse({ leagues: ["NBA", "NBA"], targets: [{ gameId: "g1", leagueName: "NBA" }, { gameId: "g1", leagueName: "NBA" }] }); return "leagues" in r ? [r.leagues, r.targets.length] : null; })(), [["NBA"], 1]);
check("not an object", errorOf(parseHybridRequest(null, LIVE)) !== null, true);
check("the settings must be an object", errorOf(parseHybridRequest({ ...base, settings: null }, LIVE)) !== null, true);

// ---- Include Picks: Moneyline / Spread / Totals only ----
check("All Picks stays All", "include" in ok && ok.include, "ALL");
check("a market selection is kept", (parse({ include: ["MONEYLINE", "TOTALS"] }) as { include: unknown }).include, ["MONEYLINE", "TOTALS"]);
check("Props is dropped from a mixed selection", (parse({ include: ["SPREAD", "PROPS"] }) as { include: unknown }).include, ["SPREAD"]);
check("Props alone is rejected: a hybrid has no props", errorOf(parse({ include: ["PROPS"] })), "Consensus Hybrid uses Moneyline, Spread and Totals picks - include at least one of them.");

console.log(failures > 0 ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures > 0 ? 1 : 0);
