import { requireUser } from "@/server/auth";
import { LIVE_SPORTS } from "@/server/data/odds";
import { ParlaySlipButton } from "@/components/parlay/parlay-slip-button";
import { ParlayPoolSection } from "@/components/parlay/parlay-pool-section";
import { AutoGenerateSection } from "@/components/parlay/auto-generate-section";
import { ImageBanner } from "@/components/ui/ImageBanner";
import parlayBanner from "../../../../public/banners/parlay.png";

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
    <div className="mx-auto max-w-5xl">
      <ImageBanner src={parlayBanner} title="Parlay Generator" priority mobileHeight={48} />
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Auto-Generate a parlay from today&apos;s games, or build one from your pooled picks.
        </p>
        <ParlaySlipButton />
      </div>

      <div className="mb-3">
        <h2 className="text-sm font-semibold text-foreground">Auto-Generate</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          One leg per game from today&apos;s unstarted games, using only your tracked cappers&apos; picks.
        </p>
      </div>
      <AutoGenerateSection leagues={LIVE_SPORTS.map((s) => s.label)} />

      <div className="mb-3 mt-8">
        <h2 className="text-sm font-semibold text-foreground">My Picks</h2>
      </div>
      <ParlayPoolSection />

      <div className="mt-8">
        <a href="/live" className="text-sm font-medium text-red-600 hover:underline">
          + Add picks from Live
        </a>
      </div>
    </div>
  );
}
