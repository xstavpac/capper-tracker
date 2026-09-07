# Historical picks mis-stamped as phantom ATP (audit 2026-09-07)

Read-only audit run against production while fixing the ATP phantom-pick
fallback (`docs/resolver-team-gap-followups.md` #1). **Nothing here was
changed** - this is a list for a human to decide on. Standing rule: no
silent historical data corrections.

## Scope

75 total picks exist under the `ATP` Sport (the only non-team Sport row with
any picks - `Soccer` / `MMA` / `Tennis` / `Golf` rows exist but hold zero
picks). Every ATP pick has the placeholder shape (`awayTeam = "-"`,
`homeTeam = betDetail`) because ATP has no schedule/odds source - that shape
alone does **not** mean phantom; a real "Sinner ML" tennis pick looks the
same. The classifier below is: does the candidate name pass the new
positive-tennis-evidence check (known player, or tennis vocabulary)?

## Status breakdown of all 75 ATP picks

| status | count | note |
|---|---:|---|
| `CANCELLED` | 65 | already neutralised (manually cancelled earlier) |
| `PENDING` | 7 | **live** - see below |
| `WIN` | 2 | **graded, polluting a capper's record** |
| `LOSS` | 1 | **graded, polluting a capper's record** |

The 65 `CANCELLED` rows are mostly college-football teams (Chattanooga,
Villanova, Delaware State, UNLV, Hawaii, Memphis, Samford, Albany, ...),
plus a few CFL / MLS / WNBA teams and ~14 single-name MMA fighters
("Jalin Turner Moneyline" etc. from "Thunder MMA"). They are historical
noise; they don't grade or count, but the rows still exist.

## The 10 non-cancelled ATP picks - classification

### Genuine tennis picks - correctly `ATP`, no action needed
These are real ATP players. They're `PENDING` only because this app has no
tennis grading (expected - grade manually). **Not bugs.**

| id | capper | betDetail |
|---|---|---|
| `cmsw2wg1r00263juacaafiqlw` | NICKYCASHIN | `Fritz -1.5` (Taylor Fritz) |
| `cmsw2wg1r00283juampafn275` | NICKYCASHIN | `Bergs Moneyline` (Zizou Bergs) |
| `cmsw2wg1r002c3jua16z2ob5c` | NICKYCASHIN | `Tien -4.5` (Learner Tien) |

### Phantom mis-stamps - live or graded
| id | capper | status | betDetail | what it really is |
|---|---|---|---|---|
| `cmtq2w9aj00183jptbw6elpko` | CBLEZ | PENDING | `Mississippi -6.5` | NCAAF (Ole Miss / Miss State) |
| `cmtq2w9ah000w3jpt2ndo9xm6` | BET Sharper | PENDING | `Red +1.5` | unknown team - can't tell from text alone |
| `cmsqi0lof004weqa9ao90kpi6` | BET labs | PENDING | `Fire +13.5` | WNBA (Portland Fire) |
| `cmsqfvpyp000v3u4s6chg0wij` | BET LABS | **WIN** | `Fire +13.5` | WNBA (Portland Fire) - graded WIN, counts as an ATP win for BET LABS |
| `cmtnij3yc003814nuq1wigl21` | KIMSPICKS | **WIN** | `Trojans -22.5` | NCAAF (USC / Troy) - graded WIN, counts for KIMSPICKS |
| `cmt1u5jo4003u11yiziilhrsk` | Smart Money Sports | **LOSS** | `Sports Red Moneyline` | garbage parse text - graded LOSS, counts for Smart Money Sports |

### Ambiguous - needs a human call
| id | capper | status | betDetail | note |
|---|---|---|---|---|
| `cmsw2wg1r002a3juaheco4efc` | NICKYCASHIN | PENDING | `Walton -2.5 🏀` | Adam Walton is a real ATP player, but the 🏀 emoji says basketball. Same NICKYCASHIN batch as the 3 genuine tennis picks above. |

## Suggested options (your call - not done)

1. **The 3 graded phantoms** (`Fire +13.5` WIN, `Trojans -22.5` WIN,
   `Sports Red Moneyline` LOSS): these actively distort BET LABS /
   KIMSPICKS / Smart Money Sports records. Cleanest is to `CANCELLED` them
   (removes them from W/L and units, same as the 65 already cancelled) or
   delete them. Re-homing to the correct Sport would need the real
   opponent/game, which was never captured.
2. **The 3 PENDING phantoms** (`Mississippi`, `Red`, `Fire +13.5`): cancel
   or delete. `Mississippi` and `Fire +13.5` *could* be re-entered by the
   user against the right game; `Red` isn't identifiable.
3. **`Walton -2.5 🏀`**: ask, or leave as-is (it's PENDING and harmless
   until someone grades it).
4. **The 65 CANCELLED rows**: leave them - they're inert.

Every id above is scoped by exact primary key for whatever you decide.
