"use client";

// The Generator card's Hybrid mode (Consensus Hybrid): its controls and its result.
// Thin on purpose - what to show and how to word it is lib/parlay/hybrid-view.ts,
// the work is the server actions (parlay-hybrid.ts). Nothing here generates by
// itself: the Generate button and the result's own buttons are the only callers.
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { hybridFanDuelLinkAction } from "@/server/actions/parlay-hybrid";
import { PanelShell, TINTS } from "@/components/dashboard/panel-shell";
import { BoltIcon, GamepadIcon, LayersIcon, SlidersIcon, TrophyIcon, WidthIcon } from "@/components/dashboard/cappers-icons";
import { GREEN } from "@/components/dashboard/stat-card";
import { FilterRow, LABEL, PILL_OUTLINE, PILL_PRIMARY, ScopeChip, Section, SettingRow, SettingsBlock, StepperControl, Tabs, TextSegments } from "@/components/parlay/parlay-controls";
import { IncludePicksChips } from "@/components/parlay/pick-mix-control";
import { formatGameTime } from "@/components/parlay/generator-result";
import type { HybridGenerator } from "@/components/parlay/use-hybrid-generator";
import type { TargetedGame } from "@/lib/parlay/slip-state";
import { GATE_MAX, GATE_MIN, GATE_STEP } from "@/lib/parlay/gate";
import { HYBRID_MAX_LEGS, type Hybrid, type HybridBoxLegs, type HybridWidth } from "@/lib/parlay/hybrid";
import type { HybridLinkResponse } from "@/lib/parlay/hybrid-link";
import type { HybridGenerateSettings } from "@/lib/parlay/hybrid-request";
import type { HybridGenerateResponse } from "@/server/data/hybrid-generate";
import {
  ALT_LINES_NOTE,
  BOX_LEGS_HINT,
  BOX_LEGS_OPTIONS,
  boxesInTargetText,
  boxLegsPatch,
  boxText,
  boxViews,
  BUDGET_NOTE,
  canSendToFanDuel,
  cardTabs,
  combinedPrice,
  crossGameText,
  deliveryView,
  FOOTER_NOTE,
  hybridFor,
  hybridGames,
  isMultiBox,
  legViews,
  LINK_TOO_MANY_TEXT,
  linkLegs,
  linkView,
  minTotalLegs,
  MODE_NOTE,
  MULTI_BOX_FROM,
  normalizePriceText,
  oddsAsOfText,
  PRICING_NOTE,
  SEND_NOTE,
  STALE_NOTE,
  TARGET_ODDS_PER_GAME_HINT,
  targetOddsLabel,
  targetStatus,
  TOTAL_LEGS_HINT,
  UNAVAILABLE_NOTE,
  WIDTH_HINT,
  type BoxView,
  type HybridCardKey,
  type LegView,
  type PageState,
} from "@/lib/parlay/hybrid-view";

const NOTICE = "mt-3 rounded-[12px] border border-amber-300 bg-amber-50/60 px-3.5 py-2.5 dark:border-amber-800 dark:bg-amber-500/10";
const INFO = "mt-3 rounded-[12px] border border-[#E6E8EF] bg-muted/40 px-3.5 py-2.5 dark:border-border";
const INPUT =
  "h-11 w-28 rounded-full border border-[#DADDE5] bg-white px-4 text-center text-[15px] font-semibold tabular-nums text-foreground outline-none transition focus:border-brand-600 dark:border-border dark:bg-card";
const ADD_FROM_LIVE =
  "inline-flex h-8 items-center rounded-full border border-brand-600 bg-brand-600 px-3.5 text-[13px] font-semibold text-white transition hover:bg-brand-700";
const WIDTH_OPTIONS: { key: HybridWidth; label: string }[] = [
  { key: "balanced", label: "Balanced" },
  { key: "wider", label: "Wide" },
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
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
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
      <p className="mt-2 text-xs font-medium text-muted-foreground">{MODE_NOTE}</p>

      {/* 1 · Target games (Hybrid doesn't use the slip's picks) */}
      <Section
        n={1}
        tone="green"
        title={`Target Games${explicit.length > 0 ? " · " + explicit.length : ""}`}
        description="Games you've targeted on Live, or the full slate."
        actions={
          <Link href="/live" className={ADD_FROM_LIVE}>
            + Add games from Live
          </Link>
        }
      >
        {explicit.length > 0 && (
          <div className="flex flex-wrap gap-2">
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
      </Section>

      {/* 2 · Pick filters */}
      <Section n={2} title="Pick Filters" description="Choose which games to build around, or use the full slate.">
        <div className="space-y-3">
          <FilterRow label="Leagues">
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
          </FilterRow>
          <FilterRow label="Bet types">
            <IncludePicksChips value={gen.include} onToggle={gen.toggleInclude} hide={[...CATEGORIES_HIDDEN]} />
          </FilterRow>
          <SettingsBlock>
            <SettingRow icon={<TrophyIcon className="h-5 w-5" />} label="Minimum capper win rate" note="Only cappers at or above this win rate count toward consensus.">
              <StepperControl
                label="Minimum capper win rate"
                value={form.minWinPct}
                min={GATE_MIN}
                max={GATE_MAX}
                step={GATE_STEP}
                unit="%"
                onChange={(n) => patchForm({ minWinPct: Math.max(GATE_MIN, Math.min(GATE_MAX, n)) })}
              />
            </SettingRow>
          </SettingsBlock>
        </div>
      </Section>

      {/* 3 · Line flexibility */}
      <Section n={3} title="Line Flexibility" description="Adjust how far from consensus we can go when building your parlay.">
        <div className="space-y-1">
          <SettingRow
            soft
            icon={<SlidersIcon className="h-5 w-5" />}
            label={targetOddsLabel(form.maxLegs)}
            note={form.maxLegs >= MULTI_BOX_FROM ? TARGET_ODDS_PER_GAME_HINT : undefined}
          >
            <PriceField label="Minimum target odds" value={form.targetMin} onChange={(v) => patchForm({ targetMin: v })} invalid={!!errors.target} />
            <span className="px-1 text-sm text-muted-foreground" aria-hidden>
              to
            </span>
            <PriceField label="Maximum target odds" value={form.targetMax} onChange={(v) => patchForm({ targetMax: v })} invalid={!!errors.target} />
          </SettingRow>
          {errors.target && (
            <p role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
              {errors.target}
            </p>
          )}
          <SettingRow soft icon={<WidthIcon className="h-5 w-5" />} label="Line range" note={WIDTH_HINT}>
            <TextSegments<HybridWidth> label="Line range" options={WIDTH_OPTIONS} value={form.width} onChange={(width) => patchForm({ width })} />
          </SettingRow>
        </div>
        <div className="mt-2">
          <SettingsBlock>
            <SettingRow icon={<GamepadIcon className="h-5 w-5" />} label="Legs per game" note={BOX_LEGS_HINT}>
              <TextSegments<HybridBoxLegs> label="Legs per game" options={BOX_LEGS_OPTIONS} value={form.boxLegs} onChange={(boxLegs) => patchForm(boxLegsPatch(form, boxLegs))} />
            </SettingRow>
            <SettingRow icon={<LayersIcon className="h-5 w-5" />} label="Total legs" note={TOTAL_LEGS_HINT}>
              <StepperControl
                label="Total legs"
                value={form.maxLegs}
                min={minTotalLegs(form.boxLegs)}
                max={HYBRID_MAX_LEGS}
                onChange={(n) => patchForm({ maxLegs: Math.max(minTotalLegs(form.boxLegs), Math.min(HYBRID_MAX_LEGS, n)) })}
              />
            </SettingRow>
          </SettingsBlock>
        </div>
        <div className="mt-2 flex flex-col items-end">
          <button type="button" onClick={() => patchForm({ advanced: !form.advanced })} aria-expanded={form.advanced} className="text-[13px] font-semibold text-brand-600 hover:underline dark:text-brand-400">
            {form.advanced ? "Hide advanced" : "Advanced"}
          </button>
        </div>
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
      </Section>

      {/* Clear · Generate */}
      <div className="mt-3.5 flex flex-wrap items-center justify-end gap-2 border-t border-[#0F1420]/[0.08] pt-3.5 dark:border-white/10">
        <button type="button" onClick={gen.clear} disabled={gen.phase === "idle"} className={PILL_OUTLINE}>
          Clear result
        </button>
        <button type="button" onClick={() => void gen.generate()} disabled={busy || !parsed.ok || !canGenerate} className={PILL_PRIMARY} aria-busy={busy}>
          {busy ? <Spinner /> : <BoltIcon className="h-4 w-4" />}
          {busy ? "Generating…" : "Generate parlay"}
        </button>
      </div>
      {!canGenerate && <p className="mt-2 text-xs font-medium text-muted-foreground">Switch at least one league on to generate a parlay.</p>}
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

function LegList({ legs }: { legs: LegView[] }) {
  return (
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
  );
}

// One game's box in a multi-box parlay: its own price and its own in-target flag.
function BoxSection({ box, n }: { box: BoxView; n: number }) {
  return (
    <section aria-label={`Game ${n}: ${box.game}`} className="rounded-[12px] border border-[#E6E8EF] px-3.5 py-3 dark:border-border">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className="min-w-0 text-xs font-semibold text-muted-foreground [overflow-wrap:anywhere]">
          {n} · {box.game}
        </p>
        <p className="flex flex-wrap items-baseline gap-x-2.5">
          <span className="text-lg font-semibold tabular-nums text-foreground" aria-label={`Game ${n} price`}>
            {box.price.text}
          </span>
          <StatusText kind={box.status.kind} text={box.status.text} />
        </p>
      </div>
      <p className="mt-1 text-[15px] font-semibold leading-snug text-foreground [overflow-wrap:anywhere]">{box.description}</p>
      <LegList legs={box.legs} />
    </section>
  );
}

function HybridCard({
  hybrid,
  settings,
  eventSportKeys,
  response,
  state,
  busy,
  onGenerate,
  cardKey,
}: {
  hybrid: Hybrid;
  settings: HybridGenerateSettings;
  eventSportKeys: Record<string, string>;
  response: HybridGenerateResponse;
  state: Extract<PageState, { kind: "result" | "no-fit" }>;
  busy: boolean;
  onGenerate: () => void;
  cardKey: HybridCardKey;
}) {
  const status = targetStatus(hybrid.combinedAmerican, settings);
  const price = combinedPrice(hybrid);
  const asOf = oddsAsOfText(hybrid.oddsAsOf, formatGameTime);
  const games = hybridGames(hybrid, formatGameTime);
  const legs = legViews(hybrid);
  const multi = isMultiBox(hybrid);
  const boxes = multi ? boxViews(hybrid, settings) : [];
  const boxesStatus = multi ? boxesInTargetText(hybrid) : null;
  const delivery = cardKey === "primary" ? deliveryView(response.result.delivery) : null;
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
      {!multi && <p className="mt-1 text-xs font-medium text-muted-foreground">{games.map((g) => g.text).join("  ·  ")}</p>}

      <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="text-2xl font-semibold tabular-nums text-foreground" aria-label="Combined price">
          {price.text}
        </p>
        {price.note && <p className="text-xs font-medium text-muted-foreground">{price.note}</p>}
        <StatusText kind={(boxesStatus ?? status).kind} text={(boxesStatus ?? status).text} />
      </div>
      {delivery && (
        <p role="status" className={"mt-1 text-[13px] font-semibold " + (delivery.short ? "text-amber-700 dark:text-amber-400" : "text-foreground")}>
          {delivery.text}
        </p>
      )}
      {asOf && <p className="mt-0.5 text-xs font-medium text-muted-foreground">{asOf}</p>}

      {multi ? (
        <div className="mt-3 space-y-2.5">
          {boxes.map((b, i) => (
            <BoxSection key={b.key + i} box={b} n={i + 1} />
          ))}
        </div>
      ) : (
        <LegList legs={legs} />
      )}

      <HybridSend key={cardKey + "|" + response.generatedAt} hybrid={hybrid} settings={settings} eventSportKeys={eventSportKeys} linkable={response.linkable} onRegenerate={onGenerate} />
    </div>
  );
}

function HybridSend({ hybrid, settings, eventSportKeys, linkable, onRegenerate }: { hybrid: Hybrid; settings: HybridGenerateSettings; eventSportKeys: Record<string, string>; linkable: boolean | undefined; onRegenerate: () => void }) {
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
  const tooMany = !canSendToFanDuel(hybrid, linkable);
  const blocked = hybrid.anyStale;
  if (tooMany) {
    return (
      <div className="border-t border-[#0F1420]/[0.08] py-3 dark:border-white/10">
        <button type="button" disabled className={PILL_OUTLINE} title={LINK_TOO_MANY_TEXT}>
          Send to FanDuel
        </button>
        <p role="status" className="mt-2 text-xs font-medium text-muted-foreground">
          {LINK_TOO_MANY_TEXT}
        </p>
      </div>
    );
  }
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
        subtitle: isMultiBox(hybrid)
          ? `${hybrid.legs.length} legs · ${hybrid.boxes!.length} games`
          : `${hybrid.legs.length} legs · ${new Set(hybrid.legs.map((l) => l.eventId)).size === 1 ? "one game" : "different games"}${key === "primary" ? "" : " · alternate"}`,
        icon: <BoltIcon className="h-[17px] w-[17px] stroke-[2.2]" />,
      }}
      footer={<p className="min-w-0 flex-1 truncate text-xs font-medium text-[#3A4152] dark:text-foreground/75">{FOOTER_NOTE}</p>}
      busy={busy}
      wrapSubtitle
    >
      {tabs.length > 1 && <Tabs<HybridCardKey> label="Hybrid choices" tabs={tabs} value={key} onChange={gen.setCard} />}
      {gen.settingsChanged && <p className="mt-2 text-xs font-medium text-muted-foreground">Settings changed since this was built. Press Generate parlay to update it.</p>}
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
      {flags.budgetLimited && (
        <div role="status" className={INFO}>
          <p className="text-xs font-medium text-foreground">{BUDGET_NOTE}</p>
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
        cardKey={key}
      />
    </PanelShell>
  );
}

