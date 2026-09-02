# Axiom log-drain investigation (log retention for `grade-picks-run` et al.)

**Status (2026-09-01):** Complete. The Axiom account and the official Vercel
Log Drain are **connected and confirmed live** (visible in Vercel's
Integrations page). Vercel runtime logs now flow to Axiom's `vercel` dataset
with 30-day retention. **This was done entirely through the Axiom and Vercel
dashboards - no application code changes, no new dependencies, no redeploy.**
This document is the investigation that preceded the connection; the cost and
free-tier analysis below stands as the record.

**Why:** Vercel's own runtime-log view retains roughly the last ~24 hours
(confirmed empirically: `vercel logs --since 7d` and `--since 2026-08-30` both
bottomed out at ~2026-08-31T23:31Z). That is too short to reliably review the
`grade-picks-run` instrumentation across a real peak - e.g. the first NFL
regular-season Sunday - unless someone checks within a day of it. A log drain
to a service with longer retention fixes that.

**Epistemic tags**
- **Verified** - established directly from this repository, from a live vendor
  page fetched during this investigation, or from Vercel CLI output.
- **[ESTIMATE]** - modeled from observed structure; not measured against an
  actual drain.
- **Assumption** - explicitly stated, not confirmed from documentation.

---

## 1. Vercel Drains billing at our volume

### 1a. The billing model (Verified + one explicit assumption)

Reviewed: `/docs/drains`, `/docs/drains/using-drains`,
`/docs/manage-and-optimize-observability` (all fetched 2026-09-01).

- **Verified:** Drains are a **Pro / Enterprise** feature (this project is on
  Pro). The pricing table lists **"Drains Volume - $0.50" (Pro price)**.
- **Verified:** billed volume is defined as *"the uncompressed JSON
  serialization of each drained record, regardless of the format or encoding
  used to deliver it."* The bytes Axiom reports ingesting can be lower (it can
  receive compressed / protobuf) - the two figures are not comparable.
- **Verified:** a **Log** drain forwards the **whole project's** runtime, build,
  and static logs - every request record plus every `console.log` /
  `console.error` line - not just the `grade-picks-run` line.

> **Assumption, not confirmed:** I reviewed Vercel's Drains docs (`/docs/drains`,
> `/docs/drains/using-drains`, `/docs/manage-and-optimize-observability`). The
> Drains pricing table lists **"Drains Volume - $0.50" (Pro)** and defines
> billed volume as *"the uncompressed JSON serialization of each drained
> record."* I could **not find any documentation describing an included/free
> monthly Drains allowance on the Pro plan.** The cost estimate therefore
> **assumes all drain volume is billable at the published $0.50/GB** with no
> free tier. If Pro does include a Drains allowance, the real cost would be
> lower (likely $0). Either way, at our estimated ~0.08-0.3 GB/month the charge
> is **~$0.04-$0.15/month**, reaching $1/month only at roughly 25x current
> volume.

### 1b. Our actual log volume [ESTIMATE]

Derived from the 24h retention window pulled 2026-09-01 (`vercel logs --json`
for `/api/cron/grade-picks` and unfiltered hour samples). The CLI caps
responses at ~50 requests per page and paginates backward by time, so
per-hour request counts below are floor-ish and extrapolated.

| Source | Requests/day | ~Log bytes/request (Vercel request record + app log lines) | ~Bytes/day |
|---|---|---|---|
| `/api/cron/grade-picks` | 96 (Verified: `*/15`, 97 runs in the 24h window) | ~1.6 KB (record + 4 `getOddsForSport` cache-hit lines + 1 `grade-picks-run` ~620 B) | ~155 KB |
| other crons (`backfill-odds` x6, `refresh-odds` x1) | 7 | ~1 KB | ~7 KB |
| `refresh-scores` (5 sports x 3 phases + MLB/NFL stat snapshots + decay-delta) | 1 | ~15-25 KB | ~20 KB |
| `/api/public/live-scores` (marketing live-ticker poll; observed ~1/min even overnight: 46 in 45 min at 00:00Z, 43 in 42 min at 03:00Z) | ~1,500-2,500 | ~0.6 KB | ~1.1-1.5 MB |
| `/api/live/scores` (authenticated `/live` poll; only during logged-in sessions, bursty) | ~200-400 | ~0.7 KB | ~0.2 MB |
| page views (`/dashboard` ~1.1 KB, `/charts`, `/cappers/*`, etc.; bursty - one real browsing session visible ~20:56Z) | ~500-1,500 | ~0.5-1.1 KB | ~0.5-1 MB |
| build logs (a few deploys/week) | - | - | ~5-10 MB/month |

**Total: [ESTIMATE] ~2.5-4 MB/day = ~75-120 MB/month = ~0.08-0.12 GB/month.**
With headroom for undercounting and traffic growth: **up to ~0.3 GB/month.**

### 1c. Cost estimate (under the §1a assumption)

| Monthly drain volume | Vercel Drains cost @ $0.50/GB |
|---|---|
| 0.08 GB (central estimate) | **~$0.04** |
| 0.15 GB | ~$0.08 |
| 0.30 GB (headroom) | ~$0.15 |
| 2 GB (~25x current) | ~$1.00 |

Effectively free on the Vercel side for the foreseeable future.

**Volume levers, if ever wanted (not needed at this scale):** Vercel Drains
support (a) **environment filter** - drain Production only, skip
preview-deployment logs; (b) **sampling rules per request-path prefix** - e.g.
100% for `/api/cron/`, a low rate for everything else.

## 2. Axiom free tier - directly verified from the live pricing page

**Directly verified.** `https://axiom.co/pricing` was fetched during this
investigation (2026-09-01, including a re-fetch for verbatim strings). The
**Personal (free) plan** shows, as literal text on the page:

- ingest: **`"500 GB / mo"`**
- storage: **`"25 GB"`**
- retention: **`"30-day retention"`**
- price: **`"$0/month"`**, **`"Permanent. No credit card required."`**

(Paid tier, for contrast: **`"Axiom Cloud"` at `"$25/month"`** - not needed.)

This is from the live page as of this investigation, not cached knowledge or
older documentation.

**Our fit:** the [ESTIMATE] ~0.08-0.3 GB/month ingest is **0.016%-0.06% of the
500 GB/mo allowance**. Storage at 30-day retention stays around ~0.1-0.3 GB,
far under the 25 GB cap. We fit **comfortably and permanently within the free
tier, with roughly 100-500x headroom** before any limit. 30-day retention
replaces the current ~24h.

## 3. Recommendation

**Use the official Vercel -> Axiom Log Drain integration.**

Architecture:

```
console.log (unchanged)  ->  Vercel runtime log stream  ->  official Vercel Log Drain  ->  Axiom `vercel` dataset
                                                                                          (APL queries, 30-day retention on free)
```

- **No application code changes.** The `grade-picks-run` instrumentation in
  `src/app/api/cron/grade-picks/route.ts` (and the `refresh-scores-run` line)
  is untouched - the drain sits on top of the stdout/stderr Vercel already
  captures.
- **No new `package.json` dependency.** (`next-axiom` is only for optional Web
  Vitals capture - out of scope, do not install it.)
- **No redeploy.** The drain attaches to the already-running production
  deployment and begins forwarding immediately (Vercel docs: *"Vercel will
  immediately start forwarding data based on your configuration"*; Axiom docs:
  *"logs are captured automatically from existing deployments"*).

Whether the drain is initiated from the Vercel Marketplace, from Vercel **Team
Settings -> Drains**, or from Axiom's own onboarding is an implementation
detail - all three produce the same official Log Drain. The architectural
point for the record is the pipeline above.

### Requirements - explicit

| Requirement | Needed? |
|---|---|
| Application code changes | **No** - Axiom: *"No code changes... required for basic log capture"*; Vercel: log/trace correlation *"happens automatically without code changes"* |
| New `package.json` dependency | **No** - `next-axiom` is only for Web Vitals (requires wrapping `next.config` + `<AxiomWebVitals/>`); not in scope |
| Redeploy | **No** - the drain attaches to the live deployment's log stream |

The only scenario that would touch code / dependencies / redeploy is opting
into Axiom Web Vitals, which is not part of this goal.

## 4. After it's connected - querying

Axiom uses APL (Axiom Processing Language). Vercel logs land in the `vercel`
dataset. To pull the cron instrumentation:

- filter `['vercel'] | where message contains "grade-picks-run"` (and
  `"refresh-scores-run"`), optionally `parse_json()` the embedded JSON to chart
  `totalMs`, `remaining`, per-sport phase timings over time.
- the Vercel-Axiom integration also ships a pre-built Vercel dashboard and
  monitors.

## 5. Follow-up trigger

Revisit the C4 grading-throughput analysis (`docs/c4-grading-throughput.md`)
within ~30 days of the first NFL regular-season Sunday (season opens
2026-09-09) and the first heavy college-football Saturdays - that is the peak
workload the C4 triggers were designed to catch, and 30-day Axiom retention
makes that review possible without having to catch it within 24h.
