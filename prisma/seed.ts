import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Reference data only. Users, cappers, and picks are always created by the
// user at runtime — never seeded, since this is private per-account data.
const SPORTS: Record<string, string[]> = {
  NFL: ["NFL"],
  NBA: ["NBA"],
  MLB: ["MLB"],
  NHL: ["NHL"],
  NCAAF: ["NCAAF"],
  NCAAB: ["NCAAB"],
  Soccer: ["EPL", "La Liga", "Champions League", "MLS"],
  MMA: ["UFC"],
  Tennis: ["ATP", "WTA"],
  Golf: ["PGA"],
};

async function main() {
  for (const [sportName, leagues] of Object.entries(SPORTS)) {
    const sport = await prisma.sport.upsert({
      where: { name: sportName },
      update: {},
      create: { name: sportName },
    });

    for (const leagueName of leagues) {
      await prisma.league.upsert({
        where: { sportId_name: { sportId: sport.id, name: leagueName } },
        update: {},
        create: { sportId: sport.id, name: leagueName },
      });
    }
  }

  console.log("Seed complete: sports + leagues reference data loaded.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
