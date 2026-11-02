import { requireAdminOpsPage } from "@/server/admin-gate";
import { findUserById, listRecipients } from "@/server/data/pick-recipients";
import { AddRecipientForm, RecipientRowControls, type SourceOption } from "@/components/admin/recipient-controls";

// Pick recipients, admin-only (requireAdminOpsPage): users who also receive the source's IMPORTED picks. One small
// read for the list plus one lookup of the Telegram ingest user; no cache, no polling - reload to refresh.
export default async function RecipientsPage() {
  const admin = await requireAdminOpsPage();
  const [rows, ingestUser] = await Promise.all([
    listRecipients(),
    process.env.INGEST_USER_ID ? findUserById(process.env.INGEST_USER_ID) : Promise.resolve(null),
  ]);
  const fmt = (d: Date | null) => (d ? d.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "-");
  const who = (u: { name: string | null; email: string }) => (u.name ? `${u.name} (${u.email})` : u.email);

  const ingestConfigured = Boolean(process.env.INGEST_USER_ID);
  const ingestCovered = ingestUser ? rows.some((r) => r.source.id === ingestUser.id) : false;

  const sources: SourceOption[] = [{ id: admin.id, label: `${who(admin)} (you)` }];
  if (ingestUser && ingestUser.id !== admin.id) sources.push({ id: ingestUser.id, label: `${who(ingestUser)} (Telegram ingest)` });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Pick recipients</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Recipients also receive the picks imported on the source account: Telegram ingest, the catalog import form and review-queue approvals. Manual picks are never sent.
          Pause and Resume apply from the next import; Resume does not catch up on picks imported while paused. Remove stops new picks only; nothing already delivered is removed.
          Each delivered pick is an independent copy: editing, deleting or regrading the original does not change it.
        </p>
      </div>

      <p className="text-sm text-foreground">
        Telegram ingest posts as:{" "}
        {ingestUser ? (
          <span className="font-medium">{who(ingestUser)}</span>
        ) : ingestConfigured ? (
          <span className="font-medium text-[#DC2626] dark:text-[#F87171]">unknown user (INGEST_USER_ID matches no user)</span>
        ) : (
          <span className="font-medium text-muted-foreground">not configured</span>
        )}
      </p>
      {ingestUser && !ingestCovered && (
        <p role="alert" className="rounded-lg border border-[#DC2626] p-3 text-sm text-[#DC2626] dark:border-[#F87171] dark:text-[#F87171]">
          Telegram ingest posts as {who(ingestUser)}, who is not the source of any recipient. Telegram picks are not being sent to anyone.
        </p>
      )}

      <AddRecipientForm sources={sources} />

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No recipients.</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.id} className="space-y-2 rounded-lg border border-border bg-card p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-foreground">{who(r.recipient)}</span>
                <span className={`text-xs font-medium ${r.status === "ACTIVE" ? "text-foreground" : "text-muted-foreground"}`}>{r.status}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Receives picks imported by {who(r.source)} · added {fmt(r.createdAt)} · paused {fmt(r.pausedAt)} · resumed {fmt(r.resumedAt)}
              </p>
              <p className="break-all font-mono text-xs text-muted-foreground">{r.recipient.id}</p>
              <RecipientRowControls id={r.id} status={r.status} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
