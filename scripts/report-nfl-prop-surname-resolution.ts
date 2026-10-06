// READ-ONLY report: which NFL player-prop picks were resolved to the wrong
// player/game at import because the typed name is a bare surname shared by
// more than one rostered player ("McCaffrey" = Christian, 49ers RB, or Luke,
// Commanders WR)?
//
// A Pick stores no player id - only the typed playerName and the matched
// game's homeTeam/awayTeam - so "which player it resolved to" is read off the
// game: the roster candidate whose team is in the pick's game is the one the
// import chose. For every pick this prints the typed name, the game it was
// matched to, every cached-roster candidate for that name, and a verdict:
//
//   AMBIGUOUS-SURNAME  single typed word, 2+ roster players share it. The
//                      candidate marked "<- in this game" is who it resolved to.
//   WRONG-GAME         the name identifies exactly one roster player, but their
//                      team is not in the pick's game (wrong player, or a roster
//                      row that was stale at import).
//   NOT-ON-ROSTER      no cached-roster player matches the name at all.
//   OK                 exactly one roster player, and their team is in the game.
//
// Writes nothing: every DB read happens inside a SET TRANSACTION READ ONLY
// transaction, and nothing here ever calls an update/create.
//
//   DATABASE_URL=<prod read URL> npx tsx scripts/report-nfl-prop-surname-resolution.ts
//   options: --limit=400        max picks to evaluate (default 400)
//            --include-graded   also report graded picks from the last --days
//                               (a wrong-player pick whose namesake had a stat
//                               line grades silently instead of sticking)
//            --days=21          lookback for --include-graded (default 21)
//
// Prints the DB host (never credentials) first so you can confirm the target.
import { prisma } from "@/lib/prisma";
import { parsePlayerProp, parseTouchdownProp } from "@/lib/bet-line";
import { stripTeamNamesFromPlayerName } from "@/lib/parse-catalog";
import { normalizeName, isLikelyDuplicateName } from "@/lib/fuzzy-match";
import { stripNameSuffix } from "@/lib/player-roster-fallback";

function arg(name: string, fallback: string): string {
  return (process.argv.find((a) => a.startsWith("--" + name + "=")) ?? "--" + name + "=" + fallback).split("=")[1];
}

async function main() {
  const limit = Number(arg("limit", "400"));
  const days = Number(arg("days", "21"));
  const includeGraded = process.argv.includes("--include-graded");
  try {
    console.log("DB host:", new URL(process.env.DATABASE_URL ?? "").host);
  } catch {
    console.log("DB host: (unparseable DATABASE_URL)");
  }

  const { picks, roster } = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const picks = await tx.pick.findMany({
        where: {
          betType: "PLAYER_PROP",
          sport: { name: "NFL" },
          ...(includeGraded
            ? { gameTime: { gte: new Date(Date.now() - days * 86400000) } }
            : { status: "PENDING", gameTime: { lt: new Date(Date.now() - 6 * 3600 * 1000) } }),
        },
        orderBy: { gameTime: "desc" },
        take: limit,
        select: {
          id: true,
          status: true,
          betDetail: true,
          playerName: true,
          propMarket: true,
          homeTeam: true,
          awayTeam: true,
          gameTime: true,
          createdAt: true,
        },
      });
      const roster = await tx.nflRosterPlayer.findMany();
      return { picks, roster };
    },
    { timeout: 60000 }
  );

  console.log(
    (includeGraded ? `NFL player props in the last ${days} days` : "stuck PENDING NFL player props (past game time)") +
      `, up to ${limit}: ${picks.length}; cached roster rows: ${roster.length}`
  );

  const tally = new Map<string, number>();
  const rows: string[] = [];
  for (const p of picks) {
    const detail = p.betDetail ?? "";
    const raw = p.playerName ?? parsePlayerProp(detail)?.playerName ?? parseTouchdownProp(detail)?.playerName ?? "";
    const typed = stripNameSuffix(stripTeamNamesFromPlayerName(raw, [p.homeTeam, p.awayTeam], "NFL"));
    const nt = normalizeName(typed);
    const bare = !/\s/.test(typed);

    // Same tier order the import resolver uses (player-roster-fallback.ts):
    // exact full name, then fuzzy full name, then bare surname for one word.
    let candidates = nt ? roster.filter((r) => normalizeName(stripNameSuffix(r.fullName)) === nt) : [];
    if (candidates.length === 0 && nt) candidates = roster.filter((r) => isLikelyDuplicateName(stripNameSuffix(r.fullName), typed));
    if (candidates.length === 0 && nt && bare) candidates = roster.filter((r) => normalizeName(stripNameSuffix(r.lastName)) === nt);

    const inGame = (team: string) => team === p.homeTeam || team === p.awayTeam;
    const verdict =
      candidates.length === 0
        ? "NOT-ON-ROSTER"
        : candidates.length > 1
          ? bare
            ? "AMBIGUOUS-SURNAME"
            : "AMBIGUOUS-FULL-NAME"
          : inGame(candidates[0].team)
            ? "OK"
            : "WRONG-GAME";
    tally.set(verdict, (tally.get(verdict) ?? 0) + 1);

    rows.push(
      [
        `${verdict.padEnd(19)} ${p.status.padEnd(7)} "${typed}"${bare ? " (surname only)" : ""}  market=${p.propMarket ?? "?"}`,
        `    pick ${p.id}  imported ${p.createdAt.toISOString().slice(0, 16)}  text: ${detail}`,
        `    matched game: ${p.awayTeam} @ ${p.homeTeam}  ${p.gameTime.toISOString().slice(0, 16)}`,
        ...candidates.map(
          (c) => `    candidate: ${c.fullName} (${c.team}, ${c.position}, espn ${c.espnPlayerId})${inGame(c.team) ? "  <- in this game" : ""}`
        ),
      ].join("\n")
    );
  }

  console.log("\nVerdicts:");
  for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(5), k);
  console.log("\nPer pick:");
  for (const block of rows) console.log(block + "\n");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
