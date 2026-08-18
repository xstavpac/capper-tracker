import { requireUser } from "@/server/auth";
import { getCappersForUser } from "@/server/data/cappers";
import { BulkImportForm } from "@/components/dashboard/bulk-import-form";

export default async function BulkImportPage() {
  const user = await requireUser();
  const cappers = await getCappersForUser(user.id);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Betting Catalog Import</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          <a href="/picks" className="text-brand-600">
            Back to Picks
          </a>
        </p>
      </div>
      <BulkImportForm existingCapperNames={cappers.map((c) => c.name)} />
    </div>
  );
}
