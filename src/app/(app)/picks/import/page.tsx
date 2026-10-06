import { requireUser } from "@/server/auth";
import { getCappersForUser } from "@/server/data/cappers";
import { getSportsWithLeagues, getPickPlanStatus } from "@/server/data/picks";
import { BulkImportForm } from "@/components/dashboard/bulk-import-form";
import { ImportPageHeader } from "@/components/import/import-page-header";
import { SupportedFormatsSection, WherePicksLandCard } from "@/components/import/supported-formats";

export default async function BulkImportPage() {
  const user = await requireUser();
  const [cappers, sports, planStatus] = await Promise.all([
    getCappersForUser(user.id),
    getSportsWithLeagues(),
    getPickPlanStatus(user.id),
  ]);

  return (
    <div className="mx-auto max-w-[1200px]">
      {/* Header + manual single-pick entry: the same PickForm, opened from the header button. */}
      <ImportPageHeader cappers={cappers} sports={sports} atLimit={planStatus.atLimit} />
      <BulkImportForm existingCapperNames={cappers.map((c) => c.name)} />
      <WherePicksLandCard />
      <SupportedFormatsSection />
    </div>
  );
}
