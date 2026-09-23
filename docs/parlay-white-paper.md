# BettingView Auto Parlay + Hedge + Contrarian — White Paper

Sep 21, 2026 · @stav

## 1. Overview

BettingView's capper hierarchy already tracks category-specific win rates across moneyline, spreads, totals, first-half/first-5, quarters, NRFI, and player props. This feature turns that hierarchy into a parlay-construction engine rather than a static leaderboard.

The distinction from a standard "AI picks my parlay" tool is that the bettor's own selections stay the anchor. The system does not go shopping through the full slate on its own — it starts from picks the bettor has already tagged, and only reaches outside that pool when the bettor explicitly turns on a mode that permits it (Auto Hedge or Contrarian). Every substitution the system makes is shown with its reasoning, so the output reads as an analytics-driven recommendation rather than a black box.

**Working name:** BettingView Auto Parlay + Hedge + Contrarian.

## 2. Core Architecture

**Entry point:** before anything else, the bettor chooses **Select Your Own Picks** or **Auto-Generate** — two different workflows, not two settings within one flow.

**Select Your Own Picks flow:** Pick anywhere on the site → Parlay Pool → choose scope → choose leg count → choose construction mode (My Picks / Auto Hedge / Contrarian) → generated result(s).

**Auto-Generate flow:** choose scope → choose leg count → BettingView ranks the full qualifying slate within that scope and generates a parlay with no tagged pool involved. See Section 2.3.

The bettor taps picks into a Parlay Pool from anywhere in BettingView (Live pages, game cards, Sharp Money tab) rather than building a parlay in a separate, isolated tool. Once a leg count is chosen, three construction modes are available:

| Mode | Source pool | Behavior |
| --- | --- | --- |
| **My Picks** | User's tagged picks only | Strict — selects the best combination from exactly what the user tagged. No outside picks. The 55% candidate gate does not remove the user's original selections from the Primary pool. |
| **Auto Hedge** | User's picks + outside qualifying alternates | Starts from the user's selections; the system may replace individual legs with a qualifying alternate (same team/game, different or independent market) when one is available. |
| **Contrarian** | User's picks + opposite-side qualifying alternates | Starts from the user's selections; the system may replace individual legs with a qualifying capper on the opposing side of that game/market. |

The user's original selections are never overwritten. Auto Hedge and Contrarian each produce a **separate, additional** parlay alongside the primary — the user always sees what they picked, plus what the system generated from it.

> **Hard invariant:** "the user's tagged picks are never mutated in place" is not descriptive text — it is a non-negotiable implementation constraint. Auto Hedge and Contrarian read the user's pool and write new parlay objects; they never write back to the user's original selections.

**Engine pipeline (internal stages):**

1. **User Pool** — picks the bettor explicitly tagged
2. **Candidate Discovery** — find qualifying alternates for each leg
3. **Relationship Classifier** — Correlated / Independent / Opposing (Section 4)
4. **Qualification** — 55%+ market-specific eligibility gate (Section 3)
5. **Confidence Score** — sample-size-adjusted strength, eligible candidates only (Section 7)
6. **Candidate Ranking** — order eligible candidates by score
7. **Mutation Engine** — Primary → B → C, tracked by substitution count (Section 7)
8. **Constraint Validation** — reject any generated parlay with conflicting legs (Section 9)
9. **Explanation Layer** — surface why each swap happened, and why close alternates were passed over (Section 9)

Each stage is a separable unit — useful for testing the classifier, the scorer, and the constraint checker independently before wiring them into one generator.

## 2.1 Parlay Scope

The Parlay Generator is universal across supported leagues. Before choosing a leg count, the bettor selects which available leagues are included in the pool. A league appears only when the user has tagged at least one pick in that league. There is no special "MLB Only" mode or "All Leagues" mode — MLB, NFL, NBA, NHL, etc. are simply individual league options that can be turned on or off, and the result is whatever combination of leagues happens to be toggled on.

| Toggle state | Example | Eligible pool |
| --- | --- | --- |
| MLB on, others off | MLB toggled on, NFL/NBA off | User-tagged MLB picks only — the result of MLB being the only toggle on, not a distinct "MLB Only" mode. |
| Several toggled on | MLB + NFL on, NBA off | User-tagged picks from exactly those leagues — e.g. MLB and NFL together, with NBA excluded |
| Every tagged league on | MLB + NFL + NBA all on | User-tagged picks across every league the bettor has tagged — the result of every toggle being on, not a distinct "All Leagues" mode. |

MLB defaults to on; every other tagged league defaults to off. That's a deliberate default, not just a starting state: it means someone who has tagged picks in three sports doesn't get an unexpectedly huge cross-league parlay the first time they open the builder — they have to actively opt other leagues in. MLB defaults on because that's where BettingView's capper/data coverage is currently deepest.

> **Hard invariant: scope restricts the pool — it never expands the search.** No toggle configuration authorizes the generator to scan the full sports slate for new primary legs; toggling leagues on only widens the eligible pool to the user's tagged picks in those leagues. Auto Hedge and Contrarian may still reach outside the user's tagged selections, but only within the leagues currently toggled on and only according to their own qualification rules (Sections 3–5) — never into an untagged league, and never into a tagged league whose toggle is off.

**Example:** the bettor tags 10 MLB games and 4 NFL games. MLB is toggled on by default; the bettor also switches NFL on and asks for a 5-leg parlay. The generator selects from those 14 tagged games. It does not independently introduce an NBA or NHL game the bettor never tagged, and it excludes any tagged league whose toggle is left off.

**Scope applies to every generated parlay.** The selected scope constrains Primary, Auto Hedge, and Contrarian outputs alike — no generated alternate can cross outside the chosen scope.

**No new conflict logic needed for cross-league parlays.** The no-conflicting-legs constraint (Section 9) is inherently game-scoped — two legs can only conflict if they're in the same game — so cross-league legs can never conflict with each other. All Leagues only changes the pool size, not the constraint-checking logic.

**Supported leagues have a capability matrix — not every sport supports every mode.** "Supported league" doesn't mean automatically eligible for every mode; each sport's Auto Hedge/Contrarian availability depends on how deep BettingView's capper coverage is for that sport. A starting matrix, filled in by the coverage investigation (Section 6):

| Sport | My Picks | Auto Hedge | Contrarian |
| --- | --- | --- | --- |
| MLB | ✓ | ✓ (measured, all markets under Section 4 rules) | When available (~6% of parlays overall) |
| NFL | ✓ | Unproven — small sample | Unproven — small sample |
| NCAAF | ✓ | Unproven — small sample | Unproven — small sample |
| NBA | ✓ | Unproven — no data yet | Unproven — no data yet |
| NHL | ✓ | When available | When available |
| ATP | ✓ | Not supported — no team concept | Not supported — no team concept |

My Picks always works for any supported league, since it never requires an alternate. The Auto Hedge and Contrarian columns come from the parlay-level coverage rerun (Section 6), which one MLB-heavy account dominates; they'll be revisited on a fresher, deeper snapshot. Contrarian ships as "when available": it produces an alternate on about 6% of parlays.

## 2.2 User Selection Invariants

- **The user's selections are the source of truth for the Primary parlay — in Select Your Own Picks only.** BettingView may rank and select among the tagged picks, but it may not silently replace, mutate, delete, or reinterpret them. This invariant doesn't apply to Auto-Generate (Section 2.3), which has no user selections to begin with — there, every leg is held to the ordinary qualification gate with no exception.
- **The Parlay Generator reuses Live tab's existing pick/game/capper data — it does not build a separate historical-data pipeline.** Today's games, today's picks, and each capper's all-time/last-20/streak/category-specific record are already fully available through the same services Live already uses. Anything the generator needs beyond that (like which side of a game a pick is on) is *derived at runtime* from data already present — `game.homeTeam` / `game.awayTeam` / `pick.team` — never recovered, backfilled, or fetched from a separate source. If a piece of information isn't already flowing through Live's own pick/game/capper objects, the answer is to derive it from what's there, not to go build a new data pipeline to get it.
- **Scope controls eligibility.** One on/off toggle per league that has tagged picks (Section 2.1) — MLB on with every other league off restricts the pool to MLB; every tagged league on permits picks from all of them. Both are just the natural outcome of which toggles are set, not separate modes.
- **Mode controls outside-pool access.** My Picks has no outside-pool access. Auto Hedge and Contrarian may introduce alternates only through their defined candidate rules (Sections 3–5).
- **Generated parlays are immutable snapshots.** Primary, Auto Hedge, and Contrarian outputs are separate generated parlay objects. Generating an alternate never modifies the underlying Parlay Pool.

## 2.3 Auto-Generate

Auto-Generate is a separate entry point, not a fourth construction mode — there is no tagged pool involved, so the invariants in Section 2.2 about protecting the user's selections don't apply here. Every leg in an Auto-Generate output is held to the ordinary qualification gate (Section 3) with no exception, because there's no user-supplied pick to exempt.

**Input:** scope (the same per-league toggles as Section 2.1) and leg count. No pick-tagging step.

**Construction:** BettingView runs the full pipeline — qualification (Section 3), relationship classification (Section 4), confidence/Wilson scoring (Section 7's Step 1 formula, reused here), and conflict validation (Section 9) — across every qualifying candidate in the chosen scope, then ranks the eligible set. Primary is the top-N ranked candidates that fill the requested leg count without violating the no-conflicting-legs constraint (one selection per game, no opposing sides, etc.).

**Alternates work differently here than Section 7's B/C.** Select Your Own Picks generates whole alternate parlays (B, C) because "how far has this strayed from what the user picked" is a meaningful trust signal there. Auto-Generate has no user thesis to measure distance from, so instead of generating B/C parlays, it surfaces a **ranked bench of runner-up candidates** beyond the Primary N. If the user rejects a specific leg, BettingView offers the next-best bench candidate as a replacement for that leg — but only if that candidate passes the same conflict check (Section 9) against the *rest of the current parlay*, not just a blanket "next-highest score." A runner-up that would conflict with an already-accepted leg is skipped in favor of the next one down, even if its raw score is higher.

**Ranking is never just "sort by win%."** The same qualification-then-confidence-score separation from Sections 3 and 7 applies: raw win rate decides eligibility, the Wilson-bound confidence score decides ordering among eligible candidates. A capper's category-specific performance, not an overall win rate, is what's being ranked — consistent with Section 3's market-specific qualification rule.

**Auto-Generate can prefer hedge/contrarian-compatible legs, without adopting Select Your Own Picks' three named modes.** Since Auto-Generate has full control over which candidates to include, it can weight candidate selection toward legs that also have an available hedge or contrarian relationship (Section 4), rather than ranking purely by qualification score and only discovering afterward that most legs can't hedge. This is a construction preference internal to Auto-Generate's own ranking, not a reuse of My Picks / Auto Hedge / Contrarian — those three remain specific to Select Your Own Picks (Section 2's entry-point split), and Auto-Generate doesn't inherit their B/C mutation-distance semantics.

## 3. Qualification Rules

**The 55% gate applies to engine-generated candidates, not to the user's original selections.** The bettor's tagged picks remain eligible for the Primary parlay because they are the user's explicit selections — BettingView never removes a user-tagged pick from Primary for falling short of 55%. Any capper record BettingView uses to introduce, replace, or justify an alternate leg in Auto Hedge or Contrarian must clear the same 55%+ market-specific threshold already used on the Sharp Money tab. There is no separate, looser threshold for secondary picks: if nothing clears 55%+ for a given leg, that leg simply has no hedge or contrarian option.

**Market-specific qualification:** a capper's win rate qualifies them only for the specific market it was earned in. A 60% moneyline capper is not automatically treated as a qualifying Overs or NRFI capper — each market (ML, spread, total, F5, 1Q, NRFI, props) is scored and qualified independently. This keeps the hierarchy honest: strength in one market never silently justifies a swap into a different one.

**Qualification is a gate, not a score.** "Does this candidate clear 55%+ in its market" is a binary pass/fail — it must never blend with the confidence scoring in Section 7. A 54.9% capper on a large sample does not qualify, full stop, regardless of how strong that sample is; a 55.1% capper on a tiny sample does qualify, and only then does its small sample size cost it in ranking. Keeping these two decisions strictly separate avoids edge cases where sample size accidentally overrides the eligibility bar.

## 4. Swap Classification

The underlying principle is **game-outcome dependency**, not simply team + market — but the dimension that principle runs along is broader than "same team, different market." A candidate can differ from the primary leg by team, by market, by entity (a player rather than a team), or by direction, and any of these can produce a valid Independent or Opposing alternate. To keep that broader dimension implementable rather than a judgment call, every candidate is tagged with one relationship type before it's classified:

- **SAME_GAME** — same game, no team-scoping claim (e.g. a team's moneyline vs. that game's total)
- **SAME_TEAM** — same team, different market
- **OPPOSING_TEAM** — the other team in the same game, any market
- **DIRECT_OPPOSITE** — the literal inverse of the primary's own market (e.g. a team's ML vs. the other team's ML)
- **PLAYER_TO_TEAM** — a player-level market on a team already represented in the primary
- **PLAYER_TO_PLAYER** — a player-level market against a different player

Relationship type isn't a fourth bucket alongside Correlated/Independent/Opposing — it's the finer-grained input the market-pair table below uses to decide which of those three a given primary/candidate pair falls into. The three-bucket outcome (Neither / Auto Hedge / Contrarian) hasn't changed; what's changed is that the table can now classify a row by relationship type instead of by market name alone, which is what lets new markets (a game total, a player prop) get added as new rows without inventing a new principle each time.

| Category | Principle | Allowed in |
| --- | --- | --- |
| **Correlated** | Candidate's outcome is substantially dependent on the primary's outcome | Neither — rejected as not a real alternative |
| **Independent** | Candidate represents a materially different outcome, even if the same team/game is involved | Auto Hedge only |
| **Opposing** | Candidate directly benefits from the primary losing | Contrarian only |

That principle still needs concrete rules — "substantially dependent" can't be a judgment call at build time. Instead of a row per market pair, every pick is described on three dimensions, and six rules derive the category from them. The original six-row table falls out of these rules unchanged; a self-check in the coverage harness confirms it.

- **Family:** side (moneyline, spread) or total (game total, team total, and NRFI/YRFI treated as a first-inning total: NRFI = Under, YRFI = Over).
- **Scope:** the period (full game, F5/1H, 1Q, any other period) plus, for totals, the level: game, team, or first inning. NRFI/YRFI picks are stored with period FULL_GAME, so the first-inning level is what keeps them distinct from the full-game total.
- **Direction:** for sides, which team; for totals, Over or Under.

A pick whose family, scope or direction can't be derived from existing data is excluded, never guessed. Today that means ATP (no team concept) and player props (inactive).

| Rule | Pair shape (same game) | Category | Mode |
| --- | --- | --- | --- |
| **R1** | Same scope, same family, same direction, different market or line: ML vs same-team spread, alternate spread lines, alternate total lines (Over 8.5 vs Over 7.5) | Correlated | Neither (rejected) |
| **R2** | Same scope, side vs side, opposing team | Opposing | Contrarian |
| **R3** | Same scope, total vs the same total, opposite direction (Over↔Under, NRFI↔YRFI) | Opposing | Contrarian |
| **R4** | Side vs total, any scope | Independent | Auto Hedge |
| **R5** | Nested scope (different period, or different total level), same family, same direction | Independent | Auto Hedge |
| **R6** | Nested scope, same family, opposite direction | Neither | Excluded |

Exact duplicates (same market, scope, direction and line) aren't alternates: they're excluded as candidates but still count toward the Contrarian headcount (Section 5). Same-scope totals on different targets, such as the opposing team's team total, stay unclassified (6 pairs in the coverage run).

| Original row | Rule |
| --- | --- |
| Team ML vs same-team spread (Correlated) | R1 |
| Team ML vs same-team 1Q/F5 ML (Independent) | R5, now applied to every period |
| Team ML vs same-team Over/Under (Independent) | R4 |
| Team ML vs opposing ML/spread (Opposing) | R2 |
| Team ML vs game Over/Under, SAME_GAME (Independent) | R4 |
| Team ML vs same-team player prop | Inactive placeholder until prop data exists |

Three judgment calls are built in. R5 covers every period, not just 1Q/F5. Nested totals in the same direction count as Independent, following the full-game ML vs F5 ML precedent, even though they're positively correlated in practice. Cross-period opposing pairs (R6), such as Team A ML vs Team B F5 ML, fit neither mode's definition and are excluded.

This also resolves a naming ambiguity from the original brainstorm: only the **Opposing** category is a hedge in the strict sense (if the primary loses, this wins). Independent swaps diversify exposure but don't offset it — they're grouped under Auto Hedge for product-naming continuity, but the underlying logic treats them differently from true opposing hedges.

## 5. Contrarian Qualification Logic

Contrarian is not "find any minority pick" — it's specifically "find a qualifying capper on the opposite side of a qualifying primary pick." A leg qualifies as a contrarian candidate when both are true:

1. **Opposite-side qualification** — a tracked capper on the opposing side of that game/market clears the same 55%+ market-specific threshold used everywhere else in the generator.
2. **Minority by capper count** — the primary's side has more tracked cappers on it than the opposing side (majority/minority is determined by *number of cappers*, not combined win rate).

If no capper on the opposing side clears 55%+, that leg has no contrarian option — same fallback behavior as Auto Hedge. This keeps Contrarian from becoming "pick something different for the sake of being different"; it only fires when there's a genuinely qualifying signal on the other side.

**Headcount scope.** Condition 2 counts cappers on the primary's own market and scope, split by direction: team vs team for a moneyline or spread, Over vs Under for a total (R3), NRFI vs YRFI. Exact duplicates of the primary count toward its side. A tie fails. In the coverage run, Over/Under flips passed this test 40% of the time, against 22% for team-side flips.

## 6. Data Coverage Check

Before committing to the three-mode UI, verify how often qualifying alternates actually exist, using a sample week of Sharp Money tab picks. Measure at both the **leg level** and the **parlay level** — leg-level coverage can look weak while parlay-level coverage is perfectly usable (a typical 5–6 leg parlay only needs one strong alternate to make Auto Hedge or Contrarian worthwhile), so leg-level numbers alone would understate the feature.

Run the same measurement separately for **single-league** and **multi-league** toggle configurations (Section 2.1). Since swap search for any given leg is still confined to that leg's own game and league, a multi-league parlay's coverage isn't simply the average of each league's individual coverage — a thin combined pool can perform worse than a deep single-league one even if each league looks fine on its own.

**Metrics to pull, split by Auto Hedge and Contrarian, and by scope:**

- % of individual legs with a qualifying alternate
- % of *parlays* with at least one qualifying alternate anywhere in the legs
- average number of qualifying alternates per leg
- % of legs with 2+ qualifying alternates
- % of qualifying alternates that come from a sufficiently large sample (not just barely over 55%)
- coverage broken out by sport and by market

Don't pre-commit to a hard cutoff like "under 15–20% means kill it" — the right threshold depends on which number is low. "Auto Hedge unavailable on 80% of parlays" is a dead feature; "Auto Hedge available on 80% of parlays but usually only modifies one leg" is a perfectly good feature that just doesn't get a Parlay C very often. Run the fuller metric set above first, then decide: if coverage is too low to produce a meaningful alternate on a typical parlay, ship the mode as "when available" or defer it — but let the actual distribution, not a guessed threshold, make that call. This check should run against the real schema before any UI work starts.

### Investigation Results (Sept 22, 2026)

Under the Section 4 rule set, Auto Hedge produces at least one alternate on 47.6% of parlays and Contrarian on 6.3%, both before any generation floor.

The run used an anonymized production snapshot dated Sept 15, 2026 (games Aug 6 to Sept 20; 4,984 picks across 6 accounts), restored to a disposable DB. Win rates were point-in-time (only picks graded before each parlay's date), keyed and gated exactly like the Sharp Money tab's 55% threshold. 1,015 parlays of 3 to 10 legs were simulated the way Build My Picks builds them.

| Parlay-level metric | Auto Hedge | Contrarian |
| --- | --- | --- |
| Parlays with ≥1 alternate | 47.6% | 6.3% |
| Parlays with ≥2 alternates | 37.6% | 2.2% |
| Average alternates per parlay | 1.69 | 0.13 |
| ≥1 alternate, SAME_GAME half of R4 disabled | 22.7% | 6.3% |
| ≥1 alternate, previous six-row table | 10.0% | 0.8% |

Coverage rises as point-in-time history builds up. Auto Hedge went from 4% of parlays in the first week to 73–86% over the last three weeks; Contrarian ranged from 0% to 24% week to week.

**What drives the numbers:**

- Auto Hedge comes mostly from R4 (1,472 of 1,711 qualifying alternates); R5 adds 239.
- Contrarian's 128 qualifying instances split between R2 (71) and R3 (57). Over/Under flips pass the Section 5 headcount far more often.
- Samples behind candidates are small: a median of 8 decided picks for Auto Hedge and 6 for Contrarian, with 56% and 70% under 10. The generation floor (Section 7) will cut into these numbers.
- Across all candidate pairs, the largest rejection reasons were conflict or correlation with another leg (49.7%) and failing 55% (39.4%). Only 2.6% were unclassified and 1.0% failed the headcount.

**Caveat — one account carries every result.** The main account (4,291 picks, 109 cappers, 73% MLB) produced all coverage. Four smaller accounts have 97–100% rule-eligible legs but 0% coverage: too few cappers per game for a candidate to reach 55% or a headcount majority. That's a volume problem, not a rule gap.

**Data quality checks:**

- Over/Under direction was derived for 100% of totals. Team-total matching succeeded for 98.6%; the 4 misses are an unregistered "USC" alias.
- Pick side is derived at runtime from `pick.team` against the game's `homeTeam`/`awayTeam` (commit 6565322): 94.8% clean match, the rest correctly unmatchable (ATP, synthetic rows).
- Zero player-prop picks exist, so props remain a placeholder in Section 4.

**Qualification and construction-availability are separate signals per candidate**, not one combined score: a pick can be *qualified* (clears 55%+, Section 3) while being *hedge-available* and/or *contrarian-available* independently — e.g. a 62% capper might have both, while a 61% capper on a different game has neither. See Section 9 for how this surfaces to the user before generating.

## 7. Ranking and Generation Cap (Select Your Own Picks)

The generator must never explode into one parlay per possible swap combination. Output is bounded by a ranking rule and a hard cap:

**Step 1 — Score every qualifying candidate swap with the Wilson lower bound (decided Sept 23, 2026).** z = 1.96 on the candidate capper's point-in-time, market-specific record; p = wins/decided, n = decided (pushes excluded, as in computeStats). LB = (p + z²/2n − z·√(p(1−p)/n + z²/4n²)) / (1 + z²/n). Wilson only orders candidates that already passed the 55% gate; it never replaces or adjusts the gate.

**Step 2 — Rank candidates by score, not by leg position.** The strongest qualifying swaps get applied first, regardless of which leg number they belong to.

**Step 3 — Generate incrementally, capped at 3 parlays total, each labeled by mutation distance** (how far it's strayed from what the user actually picked):

- Parlay A = Primary — 0 substitutions (exactly the original selection)
- Parlay B = Primary with the #1-ranked qualifying swap applied — 1 substitution
- Parlay C = Primary with the #1 and #2-ranked swaps applied together — 2 substitutions

No 4th parlay is generated, and no combinatorial sweep of every possible swap set is run. The substitution count (0/1/2) must be shown prominently in the UI for each generated parlay, not buried — the product's trust story depends on the user always being able to see exactly how far a given parlay has drifted from their own thesis.

**Step 4 — No generation floor in v1 (decided Sept 23, 2026).** Parlay B is generated whenever a qualifying swap exists, and Parlay C whenever a second non-conflicting one does. The qualification gate (≥55%, Section 3) decides eligibility; the Wilson score orders eligible candidates. They stay strictly separate.

This applies identically to Auto Hedge and Contrarian — each mode runs its own scoring/ranking pass over its own candidate pool (Independent swaps for Hedge, Opposing swaps for Contrarian), each capped at 3 parlays.

## 9. Constraint Validation and Explanation Layer

**No conflicting legs.** A generated parlay (any of A/B/C) must never contain two legs that can't both win — e.g. Cubs ML and Red Sox ML in the same game, Over 8.5 and Under 8.5 on the same total, or opposite sides of the same spread. This applies to every swap the engine considers: before a candidate is added to a generated parlay, check it against every other leg already in that parlay (including legs untouched by this particular swap) and reject the combination if a conflict exists. This is an extension of a constraint BettingView's manual parlay logic already assumes — no opposite sides of the same game — made explicit as a hard generator rule now that swaps can pull in legs the user never manually checked against each other.

**Why this was swapped.** Every substitution shown to the user carries its reasoning inline, e.g.: `Cubs ML → Cubs Over 8.5 · Secondary capper 57% Overs (40 picks) · Independent alternate market`.

**Why a stronger-looking alternate was NOT chosen.** When a candidate with a higher raw win% was passed over — usually because it failed the confidence/sample-size check in Section 7, not the 55% gate itself — surface that too, e.g.: `Not selected: Red Sox ML — 63% over 5 picks; insufficient sample size relative to the alternates used.` This is what keeps the feature legible as "BettingView's analytics, shown transparently" rather than a black box that occasionally does something surprising.

**Coverage preview before generating.** Before the user hits Build, show how many of the requested legs actually have a hedge or contrarian relationship available — e.g. "5 legs requested · 2 hedge-compatible." If the requested leg count can't be filled in the requested mode, don't silently generate a smaller or compromised parlay: offer explicit choices — build with fewer legs, expand scope (Section 2.1), or switch mode — and let the user pick. This uses the same qualified / hedge-available / contrarian-available three-flag model as the Investigation Results in Section 6, computed per candidate before construction runs.

## 10. Open Questions and Next Steps

- **Build the Relationship Classifier (Section 4) — next.** Implement the three dimensions and rules R1–R6 on Live's runtime pick/team/game data, with no migrations or backfills, and unit-test the full classification matrix. No Wilson scoring in this step.
- **Add conflict validation to My Picks.** Build My Picks takes the top N ranked picks with no conflict check, so two cappers' opposite sides of one game can both land in the Primary. Section 9 covers every generated parlay, including A. Open question: skip to the next-ranked pick, or keep it and warn.
- **Confirm the scoring formula (Section 7)** — Wilson lower bound proposed, not yet signed off. Before locking the generation floor, rerun the coverage harness with it: most qualifying candidates sit on fewer than 10 decided picks, so the floor's cost should be measured, not guessed.
- **Keep qualification and ranking separate.** The 55% raw win-rate gate decides eligibility; the Wilson score only orders eligible candidates and must never become an implicit threshold.
- **Rerun the coverage investigation on a fresh snapshot.** This one is six weeks deep and dominated by one account; update the capability matrix (Section 2.1) from the rerun.
- **Finalize the UI for the explanation layer (Section 9)** — how swap reasoning and "not selected" notes are displayed per leg, and how substitution count (0/1/2) is surfaced on each generated parlay.
- **Not in scope for v1:** a separate same-game-hedge feature. This paper treats "true opposing hedge" and Contrarian as the same mechanism (Sections 4–5).
- **Done:** runtime side-matching (commit 6565322); parlay-level coverage investigation (Section 6, Sept 22).
