import { requireUser } from "@/server/auth";
import { getCapperRoster } from "@/server/data/capper-roster";
import { LIVE_SPORTS } from "@/server/data/odds";
import { ThemedPage } from "@/components/dashboard/themed-page";
import { ParlayBanner } from "@/components/parlay/parlay-banner";
import { ParlayWorkspace } from "@/components/parlay/parlay-workspace";

// The Parlay Generator: one card (generator-card.tsx) that builds a parlay
// from the user's slip picks plus the best qualified picks from their cappers -
// on the full slate, or only on the games they targeted on Live - with its
// Hedge and Contrarian, and Send to FanDuel.
export default async function ParlayPage() {
  const user = await requireUser();
  // The Favorites only star's "no favorites yet" note. The cached roster (shared with /picks and
  // /live, cleared on every favorite toggle) - no query of its own on a cache hit.
  const hasFavorites = (await getCapperRoster(user.id)).some((c) => c.isFavorite);

  return (
    <ThemedPage>
      <div className="mx-auto max-w-5xl space-y-3.5">
        <ParlayBanner />
        <ParlayWorkspace leagues={LIVE_SPORTS.map((s) => s.label)} hasFavorites={hasFavorites} />
      </div>
    </ThemedPage>
  );
}
