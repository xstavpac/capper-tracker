import { requireUser } from "@/server/auth";
import { getCappersWithPickCounts, findSuspectedDuplicateCappers } from "@/server/data/cappers";
import { MergeCappersPanel } from "@/components/settings/merge-cappers-panel";

export default async function SettingsPage() {
  const user = await requireUser();
  const [cappers, suspected] = await Promise.all([
    getCappersWithPickCounts(user.id),
    findSuspectedDuplicateCappers(user.id),
  ]);

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-6 text-xl font-semibold">Settings</h1>

      {cappers.length >= 2 ? (
        <MergeCappersPanel cappers={cappers} suspected={suspected} />
      ) : (
        <div className="rounded-card bg-white p-8 text-center text-sm text-gray-400 shadow-soft">
          Add at least two cappers to use the merge tool.
        </div>
      )}
    </div>
  );
}
