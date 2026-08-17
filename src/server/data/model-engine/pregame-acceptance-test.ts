// Proof for Build Step 6 (Pregame Evaluation) - runs the real Decay Delta
// Model Definition against tonight's actual live MLB slate, via OddsSnapshot
// (the same cached data source the Live odds and scores page reads), for
// games that haven't started yet. No synthetic data - every game below is
// whatever's actually cached in today's real OddsSnapshot row at the moment
// this runs. Run with:
//   npx tsx src/server/data/model-engine/pregame-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import { runModelDefinition } from "./orchestrate";
import { getPregameEventFacts } from "./pregame-facts";
import { decayDeltaModel } from "@/lib/model-engine/fixtures/decay-delta";
import type { OddsGame } from "@/server/data/odds";

async function main() {
  const sportKey = "baseball_mlb";
  const asOf = new Date(); // "now" - the actual moment of evaluation, per Build Step 6's asOf reasoning

  const snapshot = await prisma.oddsSnapshot.findFirst({ where: { sportKey }, orderBy: { fetchDate: "desc" } });
  if (!snapshot) {
    console.log(`No OddsSnapshot found for "${sportKey}" - nothing to evaluate this run.`);
    return;
  }

  const games = snapshot.data as unknown as OddsGame[];
  const notStarted = games.filter((g) => new Date(g.commenceTime) > asOf);

  console.log(
    `OddsSnapshot fetchDate=${snapshot.fetchDate}, ${games.length} total games cached today, ` +
      `${notStarted.length} not yet started as of asOf=${asOf.toISOString()}.\n`
  );

  if (notStarted.length === 0) {
    console.log("No not-yet-started games in today's snapshot right now - nothing to evaluate this run.");
    return;
  }

  for (const g of notStarted) {
    console.log(`\n===== ${g.awayTeam} @ ${g.homeTeam}  (commence ${g.commenceTime}) =====`);

    const pregame = await getPregameEventFacts(sportKey, g.homeTeam, g.awayTeam);
    if (!pregame) {
      console.log("getPregameEventFacts returned null (unexpected - this game came FROM today's snapshot).");
      continue;
    }
    const dogTeam = pregame.favTeam === null ? null : pregame.favTeam === g.homeTeam ? g.awayTeam : g.homeTeam;
    console.log(`favTeam=${pregame.favTeam ?? "(none derivable)"}  dogTeam=${dogTeam ?? "(n/a)"}  totalLine=${pregame.totalLine ?? "(none)"}  lineSource=${pregame.lineSource}`);

    const result = await runModelDefinition(decayDeltaModel, { sportKey, homeTeam: g.homeTeam, awayTeam: g.awayTeam, asOf });

    console.log("calc_fav_weighted (raw fav rate):", result.context["calc_fav_weighted"]);
    console.log("calc_dog_weighted (raw dog rate):", result.context["calc_dog_weighted"]);
    console.log("calc_fav_pct:", result.context["calc_fav_pct"]);
    console.log("calc_dog_pct:", result.context["calc_dog_pct"]);
    console.log("dv_decay_delta:", result.context["dv_decay_delta"]);
    console.log("outcome_edge:", result.outcomes["outcome_edge"]);
    console.log("bucket_decay_delta:", result.buckets["bucket_decay_delta"]);
    console.log("unavailableIds:", [...result.unavailableIds]);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
