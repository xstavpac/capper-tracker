import Link from "next/link";
import { requireUser } from "@/server/auth";
import { LIVE_SPORTS } from "@/server/data/odds";
import { ThemedPage } from "@/components/dashboard/themed-page";
import { ParlayBanner } from "@/components/parlay/parlay-banner";
import { ParlayWorkspace } from "@/components/parlay/parlay-workspace";

// The Parlay Generator. Auto-Generate (AutoGenerateSection) builds Parlay A
// and its Hedge/Contrarian variants from today's games. My Picks mode builds
// a parlay from exactly the
// picks the user has pooled (via the Parlay slip button, here or on Live),
// scoped by which leagues are toggled on, up to a requested leg count. No
// substitutions/alternates/hedge logic - the pool + scope + leg count is the
// whole construction.
export default async function ParlayPage() {
  await requireUser();

  return (
    <ThemedPage>
      <div className="mx-auto max-w-5xl space-y-3.5">
        <ParlayBanner />
        <ParlayWorkspace
          leagues={LIVE_SPORTS.map((s) => s.label)}
          addPicksLink={
            <Link href="/live" className="shrink-0 whitespace-nowrap text-xs font-semibold text-brand-600 hover:underline dark:text-brand-400">
              + Add picks from Live
            </Link>
          }
        />
      </div>
    </ThemedPage>
  );
}
