import { requireUser } from "@/server/auth";
import { getCappersForUser } from "@/server/data/cappers";
import { getSportsWithLeagues, getPickPlanStatus } from "@/server/data/picks";
import { PickForm } from "@/components/dashboard/pick-form";
import { BulkImportForm } from "@/components/dashboard/bulk-import-form";
import { ImageBanner } from "@/components/ui/ImageBanner";
import catalogImportBanner from "../../../../../public/banners/catalogImport.png";

export default async function BulkImportPage() {
  const user = await requireUser();
  const [cappers, sports, planStatus] = await Promise.all([
    getCappersForUser(user.id),
    getSportsWithLeagues(),
    getPickPlanStatus(user.id),
  ]);

  return (
    <div className="mx-auto max-w-3xl">
      <ImageBanner src={catalogImportBanner} title="Betting Catalog Import" priority />
      <div className="mb-4">
        <p className="mt-1 text-sm text-muted-foreground">
          <a href="/picks" className="text-brand-600">
            Back to Picks
          </a>
        </p>
      </div>
      {/* Manual single-pick entry (moved here from /picks): the same PickForm, collapsed to a button until opened. */}
      <div className="mb-6">
        <PickForm cappers={cappers} sports={sports} atLimit={planStatus.atLimit} />
      </div>
      <BulkImportForm existingCapperNames={cappers.map((c) => c.name)} />
    </div>
  );
}
