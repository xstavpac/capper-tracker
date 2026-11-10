# BettingView Auto Parlay + Hedge + Contrarian — White Paper

Sep 21, 2026 · @stav

## 1. Overview

BettingView's capper hierarchy already tracks category-specific win rates across moneyline, spreads, totals, first-half/first-5, quarters, NRFI, and player props. This feature turns that hierarchy into a parlay-construction engine rather than a static leaderboard.

The distinction from a standard "AI picks my parlay" tool is that the bettor's own selections stay the anchor. The Parlay Generator is one engine behind one card (#296): every pick in the bettor's slip is always a leg of the parlay — never gated, filtered or replaced (`generator.ts`, rule 1) — and the bettor chooses where the rest comes from. With **Best available** (the default) the engine fills the remaining legs from the in-scope slate, ranked by edge: every unstarted game in the leagues switched on, or, when the bettor has targeted games on Live, only those games plus the games of their own picks. With **Your picks only** it builds only from the slip. From the finished parlay it then derives two more, a **Hedge** (an alternate on the same game) and a **Contrarian** (the other side of the same bet), each swapping a leg only where an alternate passes the gate. A second mode, **Consensus Hybrid**, builds a priced same-game box from where cappers agree instead (Section 7.5). Every leg shows its record and sample size, and the engine records why candidates were dropped, so the output reads as an analytics-driven recommendation rather than a black box.

**Working name:** BettingView Auto Parlay + Hedge + Contrarian.

## 2. Core Architecture

> **Current flow.** The entry-point split (Select Your Own Picks / Auto-Generate) and the three-mode table below (My Picks / Auto Hedge / Contrarian) are the original design. The unified generator replaced them (#296, then the scoring series #378–#431): one card, where the slip's picks and, optionally, targeted games feed one engine whose Primary, Hedge and Contrarian come out together. Sections 1 and 7 and the pipeline below describe what ships; Sections 2.1–2.3, 4–6 and 9 still use the original vocabulary (My Picks, Parlay B/C, the scope invariant) where they have not been rewritten.

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

**Engine pipeline (internal stages, `generator.ts`):**

1. **Slip and pool** — the slip's picks (always legs) and the pool they are built beside: the in-scope leagues' unstarted games, or only the targeted games plus the games of the slip's picks. Loaded once into a snapshot; Regenerate runs on the held snapshot with no new request, and the snapshot is reloaded after two minutes, when a game in it is over, or when a game it drew from has kicked off (`snapshotIsStale`)
2. **Candidate filters** — Bet Types (`include-picks.ts`), the Favorites-only star, and a record to score. Slip picks are never filtered
3. **Qualification** — the market-specific eligibility gate (Section 3): `scoring.ts`'s shrunk, price-aware edge test for Standard, Your picks only, Hedge and Contrarian; the raw record of either half for Consensus Hybrid
4. **Scoring** — the same module scores each candidate: a shrunk win probability and its edge at the pick's own price (`rankScore`); eligible candidates only (Section 7.1)
5. **Ranking and selection** — order eligible candidates by edge (`rankScore`, then more decided picks, then pick id); `selection.ts` fills the legs under the constraints below (Section 7.2)
6. **Constraint validation** — same-game rules (`same-game-rules.ts`, and `blocks()` for Your picks only), max legs per game, Pick Mix quotas; applied inside the fill, never as an after-filter (Section 9)
7. **Hedge and Contrarian** — derived from the finished Primary, one search per leg inside the Swap setting. Hedge pairs candidates through the Relationship Classifier (Section 4) and the same gate; Contrarian takes the other side of the same bet (`contrarian-match.ts`) at its own price; both choose through `selection.ts` (Section 7.3)
8. **Run log** — every drop, with its reason, and the funnel per stage (`run-trace.ts`; the admin Generator tab). Showing the reasons to the user per leg is still open (Section 10)

Each stage is a separable unit — useful for testing the classifier, the scorer, and the constraint checker independently before wiring them into one generator.

## 2.1 Parlay Scope

The Parlay Generator is universal across supported leagues. Before choosing a leg count, the bettor selects which available leagues are included in the pool. A league appears only when the user has tagged at least one pick in that league. There is no special "MLB Only" mode or "All Leagues" mode — MLB, NFL, NBA, NHL, etc. are simply individual league options that can be turned on or off, and the result is whatever combination of leagues happens to be toggled on.

| Toggle state | Example | Eligible pool |
| --- | --- | --- |
| MLB on, others off | MLB toggled on, NFL/NBA off | User-tagged MLB picks only — the result of MLB being the only toggle on, not a distinct "MLB Only" mode. |
| Several toggled on | MLB + NFL on, NBA off | User-tagged picks from exactly those leagues — e.g. MLB and NFL together, with NBA excluded |
| Every tagged league on | MLB + NFL + NBA all on | User-tagged picks across every league the bettor has tagged — the result of every toggle being on, not a distinct "All Leagues" mode. |

Every tagged league defaults to on: adding a pick from a league switches that league on, and a league that already has picks in the slip starts on. A league the bettor switches off stays off, across reloads, until they add a new pick from it. (Until October 2026 MLB defaulted on and every other league off.)

> **Hard invariant: scope restricts the pool — it never expands the search.** No toggle configuration authorizes the generator to scan the full sports slate for new primary legs; toggling leagues on only widens the eligible pool to the user's tagged picks in those leagues. Auto Hedge and Contrarian may still reach outside the user's tagged selections, but only within the leagues currently toggled on and only according to their own qualification rules (Sections 3–5) — never into an untagged league, and never into a tagged league whose toggle is off.

**Example:** the bettor tags 10 MLB games and 4 NFL games. Both leagues are on by default; the bettor asks for a 5-leg parlay. The generator selects from those 14 tagged games. It does not independently introduce an NBA or NHL game the bettor never tagged, and it excludes any tagged league whose toggle is left off.

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

**Input:** scope (per-league toggles, every league on by default) and leg count. No pick-tagging step.

**Window:** each league's unstarted games today. NFL and NCAAF use the current football week instead — the same slate the Live board shows for them (the next game day plus four days).

**Construction:** BettingView runs the full pipeline — qualification (Section 3), relationship classification (Section 4), scoring (Section 7.1), and conflict validation (Section 9) — across every qualifying candidate in the chosen scope, then ranks the eligible set. Primary is the top-N ranked candidates that fill the requested leg count without violating the no-conflicting-legs constraint (one selection per game, no opposing sides, etc.).

**Alternates work differently here than the original B/C ladder (replaced; Section 7.3).** Select Your Own Picks generates whole alternate parlays (B, C) because "how far has this strayed from what the user picked" is a meaningful trust signal there. Auto-Generate has no user thesis to measure distance from, so instead of generating B/C parlays, it surfaces a **ranked bench of runner-up candidates** beyond the Primary N. If the user rejects a specific leg, BettingView offers the next-best bench candidate as a replacement for that leg — but only if that candidate passes the same conflict check (Section 9) against the *rest of the current parlay*, not just a blanket "next-highest score." A runner-up that would conflict with an already-accepted leg is skipped in favor of the next one down, even if its raw score is higher.

**Ranking is never just "sort by win%."** The same gate-then-score separation from Section 3 applies: the gate decides eligibility, and the edge (`rankScore`, from `scoring.ts`) decides ordering among eligible candidates. The edge is the candidate's estimated win probability minus the break-even of its own price, so a heavy favorite and a long shot are compared on the same scale; it replaced the Wilson lower bound (Section 7.1) for every mode. `selection.ts` then picks legs from the ordered list: the top candidate on Generate, a draw weighted by exp(beta × edge) on Regenerate (beta set by the Best / Diversified / Explore mode), one leg per game first, and never outside the gate. A capper's category-specific performance, not an overall win rate, is what's being ranked — consistent with Section 3's market-specific qualification rule.

**Auto-Generate can prefer hedge/contrarian-compatible legs, without adopting Select Your Own Picks' three named modes.** Since Auto-Generate has full control over which candidates to include, it can weight candidate selection toward legs that also have an available hedge or contrarian relationship (Section 4), rather than ranking purely by qualification score and only discovering afterward that most legs can't hedge. This is a construction preference internal to Auto-Generate's own ranking, not a reuse of My Picks / Auto Hedge / Contrarian — those three remain specific to Select Your Own Picks (Section 2's entry-point split), and Auto-Generate doesn't inherit their B/C mutation-distance semantics.

## 3. Qualification Rules

**The win-rate lever is now an edge gate (scoring series, #378/#386).** The "minimum win rate" setting (L, default 55%, whole percents from 0 to 75) keeps its label but no longer means a flat win-rate cutoff. It means *the edge a capper at L% would have at -110*: the required edge is L minus the -110 break-even (110/210), and a pick passes when its shrunk win probability minus the break-even of its own price is at least that. At -110 this is identical to the old flat gate; at shorter prices a pick needs a higher win rate, and at longer prices a lower one. L = 0 is no gate, and a pick with no record never passes. With L > 0 a pick with a real price must also clear the long-shot rule (`ls1`, SCORING_VERSION `hier-k20-logit-edge-min5-ls1-v2`): its capper's raw record in the scored category (wins over decided picks, pushes out) must be at least min(the break-even of the pick's own price, L%). A category prior above a long dog's break-even can no longer pass a capper with no wins, at any L > 0: 0-3 at +300 fails, 1-0 and 3-4 at +300 pass. The bar never asks more than the lever does, so lowering L still widens the pool below break-even (10-10 at -110 passes at 45) and a heavy favorite is judged by its edge (18-4 at -1000 has a 55% bar at L = 55, not 90.9%). A pick with no real price has no price of its own to clear, so the rule does not apply to it. This is the gate for Standard, Your picks only, Hedge, Contrarian and slip ranking, and `scoring.ts` is the only scorer: the Wilson rollback (`WILSON_RULES` / `LEGACY_RULES`) was removed in PR 9 (#431), so there is no flag to switch back. Contrarian (PR 7, #396) is the other side of the same bet (same bet type, line within a per-market tolerance), scored and gated by `scoring.ts` at its own price; the leg's own score is never compared. Every "55%" below should be read this way, except in Consensus Hybrid. The Wilson-bound ordering described in Sections 7 and 10 has been replaced by ranking on edge (`rankScore`) in `selection.ts`.

**Consensus Hybrid gates differently (PR 8, #405).** Hybrid also scores through `scoring.ts`, but its gate is the capper's *actual* record, not the shrunk estimate: a post passes when the raw win % of *either* record — the capper's record in this league alone, or across every league — reaches L (at L = 0, when either has any decided pick). There is no shrinkage, no price and no long-shot rule in the gate, so an 8-0 in-league capper with a bad overall record counts, and so does 30-20 overall with 2-8 in-league; a 0-for-N capper fails at every L above 0, and lowering L never removes anyone. The score only orders: each post is scored twice (in-league first; all leagues pooled and shrunk straight to the platform rate), and the position takes the better `rankScore` — an edge at the capper's own posted price, which can be negative — among only the records that cleared the gate, in-league on a tie; a record that failed the gate is never ranked. A position's supporters are then ordered by that score, then by decided sample, then by capper id. Standard keeps the shrunk gate above: the two differ on purpose (a 2-0 in-league capper with 5-15 elsewhere clears Hybrid at 55 and not Standard; Hybrid never looks at the price, Standard always does).

**The gate applies to engine-generated candidates, not to the user's original selections.** The bettor's tagged picks remain eligible for the Primary parlay because they are the user's explicit selections — BettingView never removes a user-tagged pick from Primary for failing the gate (slip picks are never gated or filtered; `scoring.ts` only ranks them, to settle a conflict between two of them or the max-legs-per-game cap). Any capper record BettingView uses to introduce, replace, or justify an alternate leg in Auto Hedge or Contrarian must pass the same gate at the same lever L (`passesGate` in `generator.ts`). There is no separate, looser threshold for secondary picks: if nothing passes for a leg, that leg simply has no hedge or contrarian option (`NO_ALTERNATE` for Hedge, `NO_QUALIFYING_CONTRARIAN` for Contrarian). The Sharp Money tab does not share this gate: it still uses a flat 55% raw win rate (`QUALIFYING_WIN_PCT` in `sharp-money.ts`), so the two can disagree about the same capper.

**Market-specific qualification:** a capper's win rate qualifies them only for the specific market it was earned in. A 60% moneyline capper is not automatically treated as a qualifying Overs or NRFI capper — each market (ML, spread, total, F5, 1Q, NRFI, props) is scored and qualified independently. This keeps the hierarchy honest: strength in one market never silently justifies a swap into a different one.

**Qualification is a gate, not a score — but for Standard the gate now reads the sample and the price.** "Does this candidate pass" is still a binary pass/fail decided before any ordering, and the edge (`rankScore`) only orders candidates that passed: nothing outside the gate is ever drawn (`selection.ts`). What changed is what the gate looks at. It is no longer a flat 55% on the raw win rate; a pick passes when its shrunk win probability reaches L plus the gap between its own break-even and the -110 break-even (`probability × 100 ≥ L + (breakEven − 110/210) × 100`, `gateCheck` in `scoring.ts`), and, with a real price, its raw record also clears the long-shot bar of Section 3. So there is no fixed cutoff in win rate: at L = 55 the required probability is 55% at -110, about 52.6% at +100 and about 62.6% at -150. And sample size now counts toward eligibility, not only toward ranking, because the estimate is shrunk toward the platform rate (prior strength 20 picks per level). Cases pinned in the acceptance tests: 11-9 (55% raw) at -110 with no priced history no longer clears 55; a 1-0 capper does not clear 55 but does at L = 0, where any graded record passes; a 40-10 record clears. The old statement — a 54.9% capper never qualifies and a 55.1% capper always does, whatever the sample — holds only for Consensus Hybrid, whose gate is the raw win % of either record against L with no shrinkage and no price (Section 3, above), so there a 1-0 capper passes at any L up to 75 and a 54.9% record fails at 55. In both, eligibility is decided first and ordering never becomes an implicit threshold.

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

*Updated to match what shipped in #396 (`contra-samebet-v1`). The earlier design, which paired legs through the R2/R3 classifier and required a capper-headcount majority, no longer applies.*

Contrarian is the other side of the same bet. For each primary leg, the generator looks for the opposite side of that same bet and swaps it in if it passes the scoring gate at its own price.

**Same bet type only.** A moneyline leg is only ever flipped to the other side of that game's moneyline, a spread to the other side of the spread, a total to the other side of the total. Moneyline-to-spread cross pairs are dropped.

**Qualification is the scoring gate at the alternate's own price.** The opposite side qualifies if it passes the `scoring.ts` gate (Section 3) using its own price and its own capper's record. It does not have to score below the original, and it does not need a capper-count majority: the opposite side swaps in even when the original leg scores higher. Among qualifying alternates, `selection.ts` chooses, the same way it does for Hedge.

**What counts as "the same bet".** The line on the opposite side must match within a per-market tolerance:

| Market | Tolerance |
|---|---|
| Spreads and totals: NBA, WNBA, NCAAB, NFL, NCAAF | ±1 |
| Totals: MLB, NHL, soccer | ±0.5 |
| Run line (MLB), puck line (NHL) | exact |
| Player props: yards | ±2.5 |
| Player props: basketball points and combos | ±1 |
| Player props: everything else | ±0.5 |

**Excluded.** Yes/no props never get a Contrarian, and soccer moneyline is excluded (a three-way market has no single "other side"). Soccer spreads and totals are kept.

**No qualifying alternate.** If nothing on the other side passes the gate, the leg stays as it was and the run log records `NO_QUALIFYING_CONTRARIAN`. Contrarian never fires just to be different; it needs a genuinely qualifying signal on the other side.

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

## 7. Ranking and Generation (the Parlay Generator)

This section replaces the original Select Your Own Picks design: a Wilson-ordered list of swaps (Step 1, decided Sept 23, 2026), capped at three parlays A / B / C labelled by substitution count (0 / 1 / 2). That design is gone, and so is the Wilson score. What decided and shipped instead is below.

### 7.1 Score — `scoring.ts` (#378, #380, #386)

A pick goes in and a score and its breakdown come out. One module serves Standard, Your picks only, Hedge, Contrarian and slip ranking; Consensus Hybrid reads it through the best-of-two path (7.5). It reads only what the snapshot already holds.

- **Win probability** is a three-level shrinkage with a prior strength of 20 picks per level: the platform's rate for the league and category (from the `platform_category_rates` rollup; a tier with under 30 decided picks falls back to a broader one — league and bet type, then bet type — and finally to 52%) → the capper's record in the category in the other leagues → their record in this league. The middle level is overall *minus* league, never overall, because overall already contains the in-league picks. Pushes never count; there is no recency weighting. A player prop with a market key reads its per-market record, never its category's.
- **Edge model**, for a pick with a real price from a capper with at least five real-priced picks in the category: each priced pick's edge is won minus its implied probability; the shrunk edge is moved to the pick's price on the log-odds scale (`histP = historical break-even + shrunkEdge`, `skill = logit(histP) − logit(historical break-even)`, `p = sigmoid(logit(the pick's break-even) + skill)`, `edge = p − the pick's break-even`). An edge earned at -110 does not carry to -2000 as raw points.
- **Win-rate model**, everything else: with no real price, the shrunk probability minus the platform's average break-even for the league and category, labelled "no price data"; with a real price but under five priced picks, the *worse* of the capper's edge and the platform's.
- **The gate and the long-shot rule** are Section 3. The edge that is gated is the edge that ranks (`rankScore`).

Before the switch the model was backtested against the old Wilson ranking (`scripts/t2-harness/scoring-backtest.sql`); the edge model came out ahead on small priced samples per bucket, which is a signal and not proof.

### 7.2 Select — `selection.ts` (#391, #394)

The gate decides who is eligible; selection decides which eligible candidates become legs. It reads the edge directly, with no tie bands.

- **Generate** is deterministic: edge descending, then bet key, then pick id. The same snapshot and settings always give the same parlay.
- **Regenerate** is a weighted draw without replacement, weight exp(beta × edge) × a reuse penalty, on a seeded generator. The mode sets beta per edge point: **Best** 0.8, **Diversified** 0.35 (the default), **Explore** 0.12. A leg used moments ago weighs 35% of itself, and the penalty halves every 12 hours; the last three parlays' legs are passed in as recent legs. Nothing outside the gate is ever drawn.
- **Constraints are applied inside the fill**, in this order of use: one leg per bet (whichever capper posted it); max legs per game (at most 10), counted with slip picks already on the game; the same-game rules; one leg per game before any same-game leg; and Pick Mix quotas (a strict pass that takes only what a share still wants, then an open pass; a category set to 0% is off and never fills a shortfall). A fill that ends short while candidates remain tries one swap — drop a chosen leg and refill — so a greedy first choice cannot leave a parlay short when a valid one exists. The leg count is at most 25.
- **Your picks only**, with more usable slip picks than the leg count, chooses the leg count of them. A Regenerate never repeats a combination already shown on the result card; when random draws keep repeating it enumerates the valid combinations in rank order for the first unseen one, and reports "no other parlays" only when the enumeration completes with nothing unseen. If its node or time budget runs out first it returns a valid draw that differs from the parlay on screen (`BUDGET_EXHAUSTED`), never "exhausted".
- If a Regenerate cannot find a combination it has not shown within its draw tries, it keeps the parlay on screen and says so; a Generate or Regenerate that cannot reach the leg count is short, and says why (the shortfall and "only N games have picks that clear your bar" messages), rather than padding with candidates outside the gate.

### 7.3 What is generated

One engine run gives three things, not a ladder of mutations:

- **Primary** — the slip's picks plus the selected legs. Two slip picks that cannot both be legs (opposing, or the same bet at any line) compete on score, then line; the loser is listed as dropped, with the reason. The Primary never swaps a slip pick.
- **Hedge** and **Contrarian** — for each leg inside the **Swap** setting (Suggested = the generated legs only; Your picks = the slip's legs only; All, the default), the engine searches the leg's own game for an alternate. A leg with no passing alternate stays as it is, with the reason (`OUT_OF_SCOPE`, `NO_ALTERNATE` for Hedge, `NO_QUALIFYING_CONTRARIAN` for Contrarian). The three Swap settings are all computed from the one run, so changing the setting does not regenerate anything.
- **No generation floor (decided Sept 23, 2026, kept).** A swap is made whenever an alternate passes the gate, however small the sample; the gate (Section 3) decides eligibility and the edge orders. The original three-parlay cap and the A / B / C substitution count are gone with the ladder they labelled. The signal they carried — how far this strays from what the bettor picked — is shown directly: each leg says whether it is the bettor's pick or generated, a swapped leg says what it replaces, and a leg picked by hand from its swap tray counts as one of the bettor's picks (`handSwapped`, #419).

### 7.4 Output bounds

The output is bounded by settings, not by a parlay cap: at most 25 legs, at most 10 per game, one Primary, and one Hedge and one Contrarian per Swap setting. A bet-types filter, the minimum win rate (0–75) and the Favorites-only star narrow the candidates; none of them touches the slip.

### 7.5 Consensus Hybrid — a different generator

Hybrid does not assemble legs with `selection.ts`. It builds consensus **positions** from the pool (`consensus.ts`): a team side (moneyline and spread supporters of one team merge into one position) or a total (Over or Under) on a game, supported by distinct cappers, one strong capper being enough. The gate is the capper's raw record (Section 3); the score orders. The optimizer (`hybrid.ts`) then prices each position on FanDuel's alternate-line ladders, places each leg's line from both teams' recent swings, and forms a **same-game box** — one team-side leg plus one total on one game — tuned to a target-odds band. A leg price floor of -600 applies. Below four legs the best box is the Primary with up to two alternates on other games; at four legs and up the leg count is a cap and the parlay is whole boxes (up to twelve games priced), never padded with single legs. With no box-eligible game it falls back to a cross-game hybrid of the top two positions. The run-log version strings name the rules a run was scored under: Standard `standard/hier-k20-logit-edge-min5-ls1-v2/sel-v1/contra-samebet-v1`, Hybrid `hybrid/hier-k20-logit-edge-min5-ls1-v2/hyb-rawgate-bo2-v2`.

## 9. Constraint Validation and Explanation Layer

**No conflicting legs.** A generated parlay (any of A/B/C) must never contain two legs that can't both win — e.g. Cubs ML and Red Sox ML in the same game, Over 8.5 and Under 8.5 on the same total, or opposite sides of the same spread. This applies to every swap the engine considers: before a candidate is added to a generated parlay, check it against every other leg already in that parlay (including legs untouched by this particular swap) and reject the combination if a conflict exists. This is an extension of a constraint BettingView's manual parlay logic already assumes — no opposite sides of the same game — made explicit as a hard generator rule now that swaps can pull in legs the user never manually checked against each other.

**Why this was swapped.** Every substitution shown to the user carries its reasoning inline, e.g.: `Cubs ML → Cubs Over 8.5 · Secondary capper 57% Overs (40 picks) · Independent alternate market`.

**Why a stronger-looking alternate was NOT chosen.** When a candidate with a higher raw win% was passed over — usually because its shrunk, price-aware estimate did not reach the gate (a short record is pulled toward the platform rate), or because the long-shot rule refused it — surface that too, e.g.: `Not selected: Red Sox ML — 63% over 5 picks; insufficient sample size relative to the alternates used.` The engine already records the reason for every dropped candidate in the run log (`BELOW_GATE`, with either `edge x < y` against the required edge, or the raw record against the long-shot bar; the admin Generator tab shows them). Showing it to the user, per leg, is the open UI question in Section 10. This is what keeps the feature legible as "BettingView's analytics, shown transparently" rather than a black box that occasionally does something surprising.

**Coverage preview before generating.** Before the user hits Build, show how many of the requested legs actually have a hedge or contrarian relationship available — e.g. "5 legs requested · 2 hedge-compatible." If the requested leg count can't be filled in the requested mode, don't silently generate a smaller or compromised parlay: offer explicit choices — build with fewer legs, expand scope (Section 2.1), or switch mode — and let the user pick. This uses the same qualified / hedge-available / contrarian-available three-flag model as the Investigation Results in Section 6, computed per candidate before construction runs.

## 10. Open Questions and Next Steps

- **Done: the Relationship Classifier (Section 4).** The three dimensions and rules R1–R6 run on Live's runtime pick/team/game data with no migrations or backfills (`relationship-classifier.ts`, with `relationship-classifier-acceptance-test.ts`). Hedge still pairs candidates through it; Contrarian has since moved to the same-bet match (`contrarian-match.ts`, PR 7).
- **Add conflict validation to My Picks.** Build My Picks takes the top N ranked picks with no conflict check, so two cappers' opposite sides of one game can both land in the Primary. Section 9 covers every generated parlay, including A. Open question: skip to the next-ranked pick, or keep it and warn.
- **Done: the scoring formula (Section 7).** The Wilson lower bound proposed there was replaced by `scoring.ts` (#378/#380, wired in #386): hierarchical shrinkage (in-league → other leagues → platform rate, prior strength 20), an edge model on real-priced history moved to the pick's price on the log-odds scale, and a win-rate fallback when a capper has fewer than five real-priced picks or the pick has no real price. It was compared against the old Wilson ranking and the first win-rate model in `scripts/t2-harness/scoring-backtest.sql` before the switch; that backtest favoured the edge model, on small priced samples per bucket, so it is a signal and not proof. The generation floor question is closed too: there is no floor (Section 7.3).
- **Keep qualification and ranking separate.** The gate (Section 3: the shrunk, price-aware edge gate for Standard and the others; the raw record of either half for Consensus Hybrid) decides eligibility; the edge (`rankScore`) only orders eligible candidates and must never become an implicit threshold. Hybrid's score can be negative for a post that passed its gate; ordering never removes it.
- **Rerun the coverage investigation on a fresh snapshot.** This one is six weeks deep and dominated by one account; update the capability matrix (Section 2.1) from the rerun.
- **Finalize the UI for the explanation layer (Section 9)** — how swap reasoning and "not selected" notes are displayed per leg, and how substitution count (0/1/2) is surfaced on each generated parlay.
- **Not in scope for v1:** a separate same-game-hedge feature. This paper treats "true opposing hedge" and Contrarian as the same mechanism (Sections 4–5).
- **Done:** runtime side-matching (commit 6565322); parlay-level coverage investigation (Section 6, Sept 22); scoring series: scoring module and data layer (#378, #380), Standard/Hedge/slip switch (#386), selection layer (#391), modes UI (#394), same-bet Contrarian (#396), long-shot rule (#402), Consensus Hybrid raw-record gate (#405), Wilson rollback removed (#431).
