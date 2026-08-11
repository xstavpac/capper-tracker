import { requireUser } from "@/server/auth";

export default async function SettingsPage() {
  await requireUser();

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-6 text-xl font-semibold">Settings</h1>
    </div>
  );
}
