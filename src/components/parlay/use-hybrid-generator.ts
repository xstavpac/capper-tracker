"use client";

// Consensus Hybrid's state, held by the Generator card so flipping Standard <->
// Hybrid loses nothing. It never generates by itself: the one request goes out
// when `generate` is called (a click), never from an effect, never on a timer, so
// no Odds API credits are spent without one. Changing a setting after a result
// only marks the result as built with other settings (`settingsChanged`).
import { useMemo, useRef, useState } from "react";
import { hybridGenerateAction } from "@/server/actions/parlay-hybrid";
import { toggleInclude, type IncludeSelection } from "@/lib/parlay/include-picks";
import type { BetCategory } from "@/lib/parlay/bet-category";
import type { HybridGenerateRequest, HybridGenerateSettings } from "@/lib/parlay/hybrid-request";
import type { HybridGenerateResponse } from "@/server/data/hybrid-generate";
import { buildSettings, DEFAULT_FORM, pageState, type HybridCardKey, type HybridForm, type PageState } from "@/lib/parlay/hybrid-view";

type Phase = "idle" | "loading" | "done" | "error";
type Built = { settings: HybridGenerateSettings; key: string };

export type HybridGenerator = {
  form: HybridForm;
  patchForm: (patch: Partial<HybridForm>) => void;
  include: IncludeSelection;
  toggleInclude: (key: "ALL" | BetCategory) => void;
  // Null while the form has an error; the errors say which field.
  parsed: ReturnType<typeof buildSettings>;
  phase: Phase;
  response: HybridGenerateResponse | null;
  // The settings the shown response was built with.
  builtSettings: HybridGenerateSettings | null;
  settingsChanged: boolean;
  state: PageState;
  card: HybridCardKey;
  setCard: (k: HybridCardKey) => void;
  generate: (patch?: Partial<HybridForm>) => Promise<void>;
};

export function useHybridGenerator(scope: { leagues: string[]; targets: { gameId: string; leagueName: string }[] }): HybridGenerator {
  const [form, setForm] = useState<HybridForm>(DEFAULT_FORM);
  const [include, setInclude] = useState<IncludeSelection>("ALL");
  const [phase, setPhase] = useState<Phase>("idle");
  const [response, setResponse] = useState<HybridGenerateResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [built, setBuilt] = useState<Built | null>(null);
  const [card, setCard] = useState<HybridCardKey>("primary");
  // A later click wins over an earlier answer still in flight.
  const sequence = useRef(0);

  const parsed = useMemo(() => buildSettings(form), [form]);
  const keyOf = (settings: HybridGenerateSettings) => JSON.stringify({ scope, include, settings });
  const settingsChanged = built !== null && (!parsed.ok || keyOf(parsed.settings) !== built.key);

  async function generate(patch?: Partial<HybridForm>) {
    const nextForm = patch ? { ...form, ...patch } : form;
    if (patch) setForm(nextForm);
    const next = buildSettings(nextForm);
    if (!next.ok || (scope.leagues.length === 0 && scope.targets.length === 0)) return;
    const mine = ++sequence.current;
    const request: HybridGenerateRequest = { leagues: scope.leagues, targets: scope.targets, include, settings: next.settings };
    setPhase("loading");
    setErrorMessage(null);
    try {
      const res = await hybridGenerateAction(request);
      if (mine !== sequence.current) return;
      if ("error" in res) {
        setErrorMessage(res.error);
        setPhase("error");
        return;
      }
      setResponse(res);
      setBuilt({ settings: next.settings, key: keyOf(next.settings) });
      setCard("primary");
      setPhase("done");
    } catch {
      // A thrown error's text is not for the page: the state shows a friendly message.
      if (mine !== sequence.current) return;
      setErrorMessage(null);
      setPhase("error");
    }
  }

  const state = pageState({
    phase,
    response,
    errorMessage,
    settings: built?.settings ?? (parsed.ok ? parsed.settings : { targetMin: -140, targetMax: -110, maxLegs: form.maxLegs }),
  });

  return {
    form,
    patchForm: (patch) => setForm((f) => ({ ...f, ...patch })),
    include,
    toggleInclude: (key) => setInclude((cur) => toggleInclude(cur, key)),
    parsed,
    phase,
    response,
    builtSettings: built?.settings ?? null,
    settingsChanged,
    state,
    card,
    setCard,
    generate,
  };
}
