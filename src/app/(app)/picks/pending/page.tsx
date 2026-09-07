import Link from "next/link";
import { requireUser } from "@/server/auth";
import { getPendingPicksForUser, getPendingLegsForUser } from "@/server/data/picks";
import { PendingTriage } from "@/components/dashboard/pending-triage";
import { StuckParlayLegs } from "@/components/dashboard/stuck-parlay-legs";

export default async function PendingPicksPage() {
  const user = await requireUser();
  const [picks, stuckLegs] = await Promise.all([
    getPendingPicksForUser(user.id),
    getPendingLegsForUser(user.id),
  ]);

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/dashboard" className="text-sm text-brand-600">
        &larr; Back to Dashboard
      </Link>
      <h1 className="mb-6 mt-2 text-xl font-semibold">Pending picks</h1>
      <PendingTriage picks={picks} />

      <h2 className="mb-3 mt-8 text-lg font-semibold">Stuck parlay legs</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        Legs of a still-open parlay whose game finished but that haven&apos;t graded. Trailing legs of a
        parlay that already lost are excluded - those stay pending by design.
      </p>
      <StuckParlayLegs legs={stuckLegs} />
    </div>
  );
}
