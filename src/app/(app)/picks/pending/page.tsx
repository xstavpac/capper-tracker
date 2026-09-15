import Link from "next/link";
import { requireUser } from "@/server/auth";
import { getPendingPicksForUser } from "@/server/data/picks";
import { PendingTriage } from "@/components/dashboard/pending-triage";

export default async function PendingPicksPage() {
  const user = await requireUser();
  const picks = await getPendingPicksForUser(user.id);

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/dashboard" className="text-sm text-brand-600">
        &larr; Back to Dashboard
      </Link>
      <h1 className="mb-6 mt-2 text-xl font-semibold">Pending picks</h1>
      <PendingTriage picks={picks} />
    </div>
  );
}
