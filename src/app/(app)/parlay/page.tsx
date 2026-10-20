import { requireUser } from "@/server/auth";
import { LIVE_SPORTS } from "@/server/data/odds";
import { ThemedPage } from "@/components/dashboard/themed-page";
import { ParlayBanner } from "@/components/parlay/parlay-banner";
import { ParlayWorkspace } from "@/components/parlay/parlay-workspace";

// The Parlay Generator: one card (generator-card.tsx) that builds a parlay
// from the user's slip picks plus the best qualified picks from their cappers -
// on the full slate, or only on the games they targeted on Live - with its
// Hedge and Contrarian, and Send to FanDuel.
export default async function ParlayPage() {
  await requireUser();

  return (
    <ThemedPage>
      <div className="mx-auto max-w-5xl space-y-3.5">
        <ParlayBanner />
        <ParlayWorkspace leagues={LIVE_SPORTS.map((s) => s.label)} />
      </div>
    </ThemedPage>
  );
}
