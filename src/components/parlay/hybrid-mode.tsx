"use client";

// The Generator card's Hybrid mode (Consensus Hybrid): its controls and its result.
// Thin on purpose - what to show and how to word it is lib/parlay/hybrid-view.ts,
// the work is the server actions (parlay-hybrid.ts). Nothing here generates by
// itself: the Generate button and the result's own buttons are the only callers.
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { hybridFanDuelLinkAction } from "@/server/actions/parlay-hybrid";
import { PanelShell, TINTS } from "@/components/dashboard/panel-shell";
import { BoltIcon } from "@/components/dashboard/cappers-icons";
import { GREEN } from "@/components/dashboard/stat-card";
import { CountStepper, LABEL, PILL_OUTLINE, PILL_PRIMARY, ScopeChip, Tabs, TextSegments } from "@/components/parlay/parlay-controls";
import { IncludePicksChips } from "@/components/parlay/pick-mix-control";
import { formatGameTime } from "@/components/parlay/generator-result";
import type { HybridGenerator } from "@/components/parlay/use-hybrid-generator";
import type { TargetedGame } from "@/lib/parlay/slip-state";
import { GATE_MAX, GATE_MIN, GATE_STEP } from "@/lib/parlay/gate";
import { HYBRID_MAX_LEGS } from "@/lib/parlay/hybrid";
import type { Hybrid, HybridBoxLegs, HybridWidth } from "@/lib/parlay/hybrid";
import type { HybridLinkResponse } from "@/lib/parlay/hybrid-link";
import type { HybridGenerateSettings } from "@/lib/parlay/hybrid-request";
import type { HybridGenerateResponse } from "@/server/data/hybrid-generate";
import {
  ALT_LINES_NOTE,
  BOX_LEGS_HINT,
  BOX_LEGS_OPTIONS,
  boxLegsPatch,
  boxText,
  bumpMaxLegs,
  cardTabs,
  combinedPrice,
  crossGameText,
  FOOTER_NOTE,
  hybridFor,
  hybridGames,
  legViews,
  linkLegs,
  linkView,
  minMaxLegs,
  MODE_NOTE,
  normalizePriceText,
  oddsAsOfText,
  PRICING_NOTE,
  SEND_NOTE,
  STALE_NOTE,
  targetStatus,
  UNAVAILABLE_NOTE,
  WIDTH_HINT,
  type HybridCardKey,
  type PageState,
} from "@/lib/parlay/hybrid-view";

const SECTION = "border-t border-[#0F1420]/[0.08] pt-3.5 dark:border-white/10";
const NOTICE = "mt-3 rounded-[12px] border border-amber-300 bg-amber-50/60 px-3.5 py-2.5 dark:border-amber-800 dark:bg-amber-500/10";
const INFO = "mt-3 rounded-[12px] border border-[#E6E8EF] bg-muted/40 px-3.5 py-2.5 dark:border-border";
const INPUT =
  "h-11 w-24 rounded-full border border-[#DADDE5] bg-white px-4 text-center text-[15px] font-semibold tabular-nums text-foreground outline-none transition focus:border-brand-600 dark:border-border dark:bg-card";
const WIDTH_OPTIONS: { key: HybridWidth; label: string }[] = [
  { key: "balanced", label: "Balanced" },
  { key: "wider", label: "Wider" },
];
const CATEGORIES_HIDDEN = ["PROPS"] as const;

export type Mode = "standard" | "hybrid";
const MODE_OPTIONS: { key: Mode; label: string }[] = [
  { key: "standard", label: "Standard" },
  { key: "hybrid", label: "Hybrid" },
];

// Standard | Hybrid, at the top of the Generator card.
export function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className={LABEL}>Mode</span>
      <TextSegments<Mode> label="Generator mode" options={MODE_OPTIONS} value={mode} onChange={onChange} />
    </div>
  );
}

function Spinner() {
  return <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />;
}

function PriceField({ label, value, onChange, invalid }: { label: string; value: string; onChange: (v: string) => void; invalid: boolean }) {
  return (
    <input
      type="text"
      inputMode="text"
      autoComplete="off"
      spellCheck={false}
      aria-label={label}
      aria-invalid={invalid}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => onChange(normalizePriceText(value))}
      className={INPUT + (invalid ? " border-red-400 dark:border-red-500" : "")}
    />
  );
}


// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export function HybridControls({
  gen,
  leagues,
  isLeagueInScope,
  isLeagueLocked,
  toggleLeague,
  targetedGames,
  onToggleTarget,
  onClearTargets,
  canGenerate,
  modeToggle,
}: {
  gen: HybridGenerator;
  leagues: string[];
  isLeagueInScope: (l: string) => boolean;
  isLeagueLocked: (l: string) => boolean;
  toggleLeague: (l: string) => void;
  targetedGames: TargetedGame[];
  onToggleTarget: (g: TargetedGame) => unknown;
  onClearTargets: () => void;
  canGenerate: boolean;
  modeToggle: ReactNode;
}) {
  const { form, patchForm, parsed } = gen;
  const errors = parsed.ok ? {} : parsed.errors;
  const busy = gen.phase === "loading";
  const explicit = targetedGames.filter((g) => !g.viaPicks);

  return (
    <PanelShell
      theme={{
        ...TINTS.neutral,
        title: "Parlay Generator",
        subtitle: "A side and a total from one game, placed on forgiving lines by capper consensus.",
        icon: <BoltIcon className="h-[17px] w-[17px] stroke-[2.2]" />,
      }}
      footer={undefined}
      wrapSubtitle
    >
      {modeToggle}
      <p className="text-xs font-medium text-muted-foreground">{MODE_NOTE}</p>

      {/* 1 · Target games */}
      <div className={"mt-4 " + SECTION}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className={LABEL}>1 · Target games{explicit.length > 0 ? " · " + explicit.length : ""}</p>
          <Link
            href="/live"
            className="inline-flex h-8 items-center rounded-full border border-brand-600 bg-brand-600 px-3.5 text-[13px] font-semibold text-white transition hover:bg-brand-700"
          >
            + Add games from Live
          </Link>
        </div>
        {explicit.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Choose which games to build around, or use the full slate.</p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            {explicit.map((g) => (
              <span key={g.gameId} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-brand-600 bg-brand-600 pl-3 pr-1 text-[13px] font-semibold text-white">
                {g.gameLabel}
                <button type="button" onClick={() => onToggleTarget(g)} aria-label={"Stop targeting " + g.gameLabel} className="flex h-7 w-7 items-center justify-center rounded-full text-base leading-none hover:bg-white/20">
                  ×
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={onClearTargets}
              className="inline-flex h-9 items-center rounded-full border border-[#DADDE5] bg-white px-3 text-[13px] font-semibold text-foreground hover:bg-foreground/[0.035] dark:border-border dark:bg-card"
            >
              Use full slate
            </button>
          </div>
        )}
      </div>

      {/* 2 · Filters */}
      <div className={"mt-4 " + SECTION}>
        <p className={LABEL}>2 · Filters</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {leagues.map((league) => (
            <ScopeChip
              key={league}
              label={league}
              inScope={isLeagueInScope(league)}
              onToggle={() => toggleLeague(league)}
              ariaLabel={
                isLeagueLocked(league) ? league + " is on: your slip has picks or games from it" : (isLeagueInScope(league) ? "Leave out " : "Include ") + league + " games"
              }
            />
          ))}
        </div>
        <div className="mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className={LABEL}>Include picks</span>
          <IncludePicksChips value={gen.include} onToggle={gen.toggleInclude} hide={[...CATEGORIES_HIDDEN]} />
        </div>
        <div className="mt-3.5">
          <CountStepper
            label="Minimum win rate"
            value={form.minWinPct}
            min={GATE_MIN}
            max={GATE_MAX}
            step={GATE_STEP}
            unit="%"
            onChange={(n) => patchForm({ minWinPct: Math.max(GATE_MIN, Math.min(GATE_MAX, n)) })}
            note="Only cappers at or above this win rate on that bet type count toward consensus."
          />
        </div>
      </div>

      {/* 3 · Hybrid settings */}
      <div className={"mt-4 " + SECTION}>
        <p className={LABEL}>3 · Hybrid</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className={LABEL}>Target odds</span>
          <PriceField label="Minimum target odds" value={form.targetMin} onChange={(v) => patchForm({ targetMin: v })} invalid={!!errors.target} />
          <span className="text-sm text-muted-foreground" aria-hidden>
            to
          </span>
          <PriceField label="Maximum target odds" value={form.targetMax} onChange={(v) => patchForm({ targetMax: v })} invalid={!!errors.target} />
        </div>
        {errors.target && (
          <p role="alert" className="mt-1.5 text-xs font-medium text-red-600 dark:text-red-400">
            {errors.target}
          </p>
        )}
        <div className="mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className={LABEL}>Box width</span>
          <TextSegments<HybridWidth> label="Box width" options={WIDTH_OPTIONS} value={form.width} onChange={(width) => patchForm({ width })} />
          <span className="text-xs font-medium text-muted-foreground">{WIDTH_HINT}</span>
        </div>
        <div className="mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className={LABEL}>Legs</span>
          <TextSegments<HybridBoxLegs> label="Legs" options={BOX_LEGS_OPTIONS} value={form.boxLegs} onChange={(boxLegs) => patchForm(boxLegsPatch(form, boxLegs))} />
          <span className="text-xs font-medium text-muted-foreground">{BOX_LEGS_HINT}</span>
        </div>
        <div className="mt-3.5">
          <CountStepper
            label="Max legs"
            value={form.maxLegs}
            min={minMaxLegs(form.boxLegs)}
            max={HYBRID_MAX_LEGS}
            onChange={(n) => patchForm({ maxLegs: Math.max(minMaxLegs(form.boxLegs), Math.min(HYBRID_MAX_LEGS, n)) })}
            note="two is a side and a total from one game"
          />
        </div>
        <div className="mt-3.5">
          <button type="button" onClick={() => patchForm({ advanced: !form.advanced })} aria-expanded={form.advanced} className="text-[13px] font-semibold text-brand-600 hover:underline dark:text-brand-400">
            {form.advanced ? "Hide advanced" : "Advanced"}
          </button>
          {form.advanced && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className={LABEL}>Per-leg odds</span>
              <PriceField label="Minimum per-leg odds" value={form.legMin} onChange={(v) => patchForm({ legMin: v })} invalid={!!errors.perLeg} />
              <span className="text-sm text-muted-foreground" aria-hidden>
                to
              </span>
              <PriceField label="Maximum per-leg odds" value={form.legMax} onChange={(v) => patchForm({ legMax: v })} invalid={!!errors.perLeg} />
              <span className="text-xs font-medium text-muted-foreground">leave both empty for no limit</span>
            </div>
          )}
          {errors.perLeg && (
            <p role="alert" className="mt-1.5 text-xs font-medium text-red-600 dark:text-red-400">
              {errors.perLeg}
            </p>
          )}
        </div>
      </div>

      {/* Generate */}
      <div className={"mt-4 flex flex-wrap items-center justify-end gap-3 " + SECTION}>
        <button type="button" onClick={() => void gen.generate()} disabled={busy || !parsed.ok || !canGenerate} className={PILL_PRIMARY} aria-busy={busy}>
          {busy ? <Spinner /> : <BoltIcon className="h-4 w-4" />}
          {busy ? "Generating…" : "Generate hybrid"}
        </button>
      </div>
      {!canGenerate && <p className="mt-2 text-xs font-medium text-muted-foreground">Switch at least one league on to generate a hybrid.</p>}
    </PanelShell>
  );
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

function Skeleton() {
  return (
    <PanelShell theme={{ ...TINTS.neutral, title: "Building your hybrid…", subtitle: "Reading consensus and FanDuel's alternate lines", icon: <BoltIcon className="h-[17px] w-[17px] stroke-[2.2]" /> }} footer={undefined} busy wrapSubtitle>
      <div className="animate-pulse space-y-3" aria-hidden>
        <div className="h-6 w-4/5 rounded-md bg-muted" />
        <div className="h-9 w-40 rounded-md bg-muted" />
        <div className="h-16 rounded-[12px] bg-muted" />
        <div className="h-16 rounded-[12px] bg-muted" />
      </div>
    </PanelShell>
  );
}

function Message({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <PanelShell theme={{ ...TINTS.neutral, title: "Consensus Hybrid", subtitle: title, icon: <BoltIcon className="h-[17px] w-[17px] stroke-[2.2]" /> }} footer={<p className="min-w-0 flex-1 truncate text-xs font-medium text-[#3A4152] dark:text-foreground/75">{FOOTER_NOTE}</p>} wrapSubtitle>
      <div role="status" className="text-sm text-foreground">
        {children}
      </div>
      {action && <div className="mt-3">{action}</div>}
    </PanelShell>
  );
}

function GameList({ games }: { games: string[] }) {
  return (
    <ul className="mt-1.5 list-disc pl-5 text-sm text-muted-foreground">
      {games.map((g) => (
        <li key={g}>{g}</li>
      ))}
    </ul>
  );
}

function StatusText({ kind, text }: { kind: "in" | "near" | "far"; text: string }) {
  return <span className={"text-[13px] font-semibold " + (kind === "in" ? GREEN : "text-muted-foreground")}>{text}</span>;
}

function HybridCard({
  hybrid,
  settings,
  eventSportKeys,
  response,
  state,
  busy,
  onGenerate,
  onAllowMore,
  cardKey,
}: {
  hybrid: Hybrid;
  settings: HybridGenerateSettings;
  eventSportKeys: Record<string, string>;
  response: HybridGenerateResponse;
  state: Extract<PageState, { kind: "result" | "no-fit" }>;
  busy: boolean;
  onGenerate: () => void;
  onAllowMore: () => void;
  cardKey: HybridCardKey;
}) {
  const status = targetStatus(hybrid.combinedAmerican, settings);
  const price = combinedPrice(hybrid);
  const asOf = oddsAsOfText(hybrid.oddsAsOf, formatGameTime);
  const games = hybridGames(hybrid, formatGameTime);
  const legs = legViews(hybrid);
  const flags = state.flags;
  return (
    <div className="mt-1">
      {hybrid.anyStale && (
        <div role="status" className={NOTICE}>
          <p className="text-sm font-semibold text-foreground">{STALE_NOTE}</p>
          <p className="text-xs font-medium text-muted-foreground">{UNAVAILABLE_NOTE} These are the last prices on file.</p>
        </div>
      )}
      {hybrid.structure === "cross-game" && (
        <div role="status" className={INFO}>
          <p className="text-xs font-medium text-foreground">{crossGameText(hybrid)}</p>
        </div>
      )}

      <p className="mt-3 text-[18px] font-semibold leading-snug text-foreground [overflow-wrap:anywhere]">{boxText(hybrid)}</p>
      <p className="mt-1 text-xs font-medium text-muted-foreground">{games.map((g) => g.text).join("  ·  ")}</p>

      <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="text-2xl font-semibold tabular-nums text-foreground" aria-label="Combined price">
          {price.text}
        </p>
        {price.note && <p className="text-xs font-medium text-muted-foreground">{price.note}</p>}
        <StatusText kind={status.kind} text={status.text} />
      </div>
      {asOf && <p className="mt-0.5 text-xs font-medium text-muted-foreground">{asOf}</p>}
      {cardKey === "primary" && flags.outsideTarget && flags.canAllowMoreLegs && (
        <div className="mt-2.5">
          <button type="button" onClick={onAllowMore} disabled={busy} className={PILL_OUTLINE}>
            {busy ? "Generating…" : `Allow more legs (up to ${bumpMaxLegs(settings.maxLegs)})`}
          </button>
        </div>
      )}

      <ol className="mt-3 divide-y divide-[#0F1420]/[0.06] dark:divide-white/10">
        {legs.map((l, i) => (
          <li key={l.key + i} className="py-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <p className="min-w-0 text-[15px] font-semibold leading-snug text-foreground [overflow-wrap:anywhere]">
                {l.title}
                {l.game && <span className="ml-2 text-xs font-medium text-muted-foreground">{l.game}</span>}
              </p>
              <p className="shrink-0 text-sm font-semibold tabular-nums text-foreground">{l.price}</p>
            </div>
            <p className="mt-0.5 text-xs font-medium text-muted-foreground">{l.consensus}</p>
            {l.reason && <p className="text-xs font-medium text-muted-foreground">{l.reason}</p>}
          </li>
        ))}
      </ol>

      <HybridSend key={cardKey + "|" + response.generatedAt} hybrid={hybrid} settings={settings} eventSportKeys={eventSportKeys} onRegenerate={onGenerate} />
    </div>
  );
}

function HybridSend({ hybrid, settings, eventSportKeys, onRegenerate }: { hybrid: Hybrid; settings: HybridGenerateSettings; eventSportKeys: Record<string, string>; onRegenerate: () => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<HybridLinkResponse | null>(null);
  const legs = linkLegs(hybrid, eventSportKeys);
  const hybridKey = hybrid.legs.map((l) => l.positionKey + l.point + l.price).join("|");

  // An answer for a different hybrid no longer describes this one.
  useEffect(() => {
    setLink(null);
    setError(null);
  }, [hybridKey]);

  async function send() {
    if (!legs) return;
    setLoading(true);
    setError(null);
    try {
      const res = await hybridFanDuelLinkAction(legs);
      if ("error" in res) {
        setLink(null);
        setError(res.error);
      } else setLink(res);
    } catch {
      setLink(null);
      setError("Couldn't check FanDuel right now. Try again.");
    } finally {
      setLoading(false);
    }
  }

  const view = link ? linkView(hybrid, link, settings, formatGameTime) : null;
  const blocked = hybrid.anyStale;
  return (
    <div className="border-t border-[#0F1420]/[0.08] py-3 dark:border-white/10">
      <button type="button" onClick={() => void send()} disabled={loading || blocked || !legs} className={PILL_OUTLINE} title={blocked ? STALE_NOTE : undefined}>
        {loading ? "Checking FanDuel…" : link ? "Check FanDuel again" : "Send to FanDuel"}
      </button>
      {blocked && <p className="mt-2 text-xs font-medium text-muted-foreground">{STALE_NOTE}: sending is off until the prices refresh. Generate again to refresh them.</p>}
      <p className="mt-2 text-xs font-medium text-muted-foreground">{hybrid.isEstimate ? SEND_NOTE : "Review your betslip on FanDuel before placing."}</p>
      {error && (
        <p role="alert" className="mt-2 text-xs font-medium text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {view?.kind === "ready" && (
        <div className="mt-2.5 rounded-[12px] border border-[#E6E8EF] bg-white px-3.5 py-2.5 dark:border-border dark:bg-card">
          {view.moves.length > 0 ? (
            <div role="status">
              <p className={LABEL}>Price moved</p>
              <ul className="mt-0.5 text-[13px] font-medium text-foreground">
                {view.moves.map((m) => (
                  <li key={m.text}>{m.text}</li>
                ))}
              </ul>
              {view.combined && (
                <p className="mt-1.5 text-[13px] font-medium text-foreground">
                  New combined estimate <span className="font-semibold tabular-nums">{view.combined.text}</span> · <StatusText kind={view.combined.status.kind} text={view.combined.status.text} />
                </p>
              )}
            </div>
          ) : (
            <p className="text-[13px] font-medium text-muted-foreground">FanDuel's prices match what's shown.</p>
          )}
          <a href={view.url} target="_blank" rel="noopener noreferrer" className={PILL_PRIMARY + " mt-2.5"}>
            Open FanDuel
          </a>
          <p className="mt-2 text-xs font-medium text-muted-foreground">Review your betslip on FanDuel before placing.</p>
        </div>
      )}

      {view?.kind === "blocked" && (
        <div role="status" className={NOTICE}>
          <p className={LABEL}>Not sent</p>
          <ul className="mt-0.5 text-[13px] font-medium text-foreground">
            {view.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button type="button" onClick={onRegenerate} className={PILL_OUTLINE}>
              Re-generate
            </button>
            {view.stale && (
              <button type="button" onClick={() => void send()} disabled={loading} className={PILL_OUTLINE}>
                Try again
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function HybridResults({ gen }: { gen: HybridGenerator }) {
  const { state, response, builtSettings } = gen;
  const busy = gen.phase === "loading";
  const retry = () => void gen.generate();
  // Re-runs with one more leg allowed, from the settings the shown result was built with.
  const onAllowMoreLegs = () => void gen.generate({ maxLegs: bumpMaxLegs(gen.builtSettings?.maxLegs ?? gen.form.maxLegs) });

  if (state.kind === "idle") return null;
  if (state.kind === "loading") return <Skeleton />;
  if (state.kind === "error") {
    return (
      <Message
        title="Something went wrong"
        action={
          <button type="button" onClick={retry} disabled={busy} className={PILL_OUTLINE}>
            Retry
          </button>
        }
      >
        <p>{state.message}</p>
      </Message>
    );
  }
  if (state.kind === "pricing-in-progress") {
    return (
      <Message
        title="Pricing in progress"
        action={
          <button type="button" onClick={retry} disabled={busy} className={PILL_OUTLINE}>
            Retry
          </button>
        }
      >
        <p>{PRICING_NOTE}</p>
        <GameList games={state.games} />
      </Message>
    );
  }
  if (state.kind === "alt-lines-not-posted") {
    return (
      <Message title="Alternate lines not posted yet">
        <p>{ALT_LINES_NOTE}</p>
        <p className="mt-2 text-xs font-medium text-muted-foreground">Skipped:</p>
        <GameList games={state.games} />
      </Message>
    );
  }
  if (state.kind === "prices-unavailable") {
    return (
      <Message
        title="Prices unavailable"
        action={
          <button type="button" onClick={retry} disabled={busy} className={PILL_OUTLINE}>
            Retry
          </button>
        }
      >
        <p>{UNAVAILABLE_NOTE}</p>
        <GameList games={state.games} />
      </Message>
    );
  }
  if (state.kind === "no-box") {
    return (
      <Message title="No hybrid to build right now">
        <p>{state.message}</p>
        {state.detail && <p className="mt-1 text-xs font-medium text-muted-foreground">{state.detail}</p>}
      </Message>
    );
  }

  if (!response || !builtSettings) return null;
  const tabs = cardTabs(response);
  const key = tabs.some((t) => t.key === gen.card) ? gen.card : "primary";
  const hybrid = hybridFor(response, key);
  if (!hybrid) return null;
  const flags = state.flags;
  return (
    <PanelShell
      theme={{
        ...TINTS.neutral,
        title: "Your hybrid",
        subtitle: `${hybrid.legs.length} legs · ${new Set(hybrid.legs.map((l) => l.eventId)).size === 1 ? "one game" : "different games"}${key === "primary" ? "" : " · alternate"}`,
        icon: <BoltIcon className="h-[17px] w-[17px] stroke-[2.2]" />,
      }}
      footer={<p className="min-w-0 flex-1 truncate text-xs font-medium text-[#3A4152] dark:text-foreground/75">{FOOTER_NOTE}</p>}
      busy={busy}
      wrapSubtitle
    >
      {tabs.length > 1 && <Tabs<HybridCardKey> label="Hybrid choices" tabs={tabs} value={key} onChange={gen.setCard} />}
      {gen.settingsChanged && <p className="mt-2 text-xs font-medium text-muted-foreground">Settings changed since this was built. Press Generate hybrid to update it.</p>}
      {flags.skippedGames.length > 0 && (
        <div role="status" className={INFO}>
          <p className="text-xs font-medium text-foreground">{ALT_LINES_NOTE} Skipped: {flags.skippedGames.join(", ")}.</p>
        </div>
      )}
      {flags.unavailableGames.length > 0 && (
        <div role="status" className={INFO}>
          <p className="text-xs font-medium text-foreground">
            {UNAVAILABLE_NOTE} Skipped: {flags.unavailableGames.join(", ")}.
          </p>
        </div>
      )}
      {flags.pricingGames.length > 0 && (
        <div role="status" className={INFO}>
          <p className="text-xs font-medium text-foreground">{PRICING_NOTE} Skipped for now: {flags.pricingGames.join(", ")}.</p>
        </div>
      )}
      <HybridCard
        key={key}
        hybrid={hybrid}
        settings={builtSettings}
        eventSportKeys={response.eventSportKeys}
        response={response}
        state={state}
        busy={busy}
        onGenerate={retry}
        onAllowMore={onAllowMoreLegs}
        cardKey={key}
      />
    </PanelShell>
  );
}

