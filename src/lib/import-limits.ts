// Per-import row cap for bulk pick import (bulkImportPicksAction).
//
// Why 500:
//  - A real paste is a day's card or slate: tens of picks. A capper's whole
//    history backfill is a few hundred at most. 500 covers both with room.
//  - The action resolves every item BEFORE the insert transaction (schedule +
//    odds lookups, all at once, no database), then finds or creates the
//    cappers and sports inside that transaction - three statements per NEW
//    capper, while the user's subscription row is locked. The cap bounds both:
//    the resolution fan-out and how long that transaction can run.
//  - It is half of FREE_PICK_LIMIT (1,000): a Free account can still fill its
//    entire allowance in two imports, and the entitlement check (which sees the
//    full batch size) is never the reason a legitimate import is refused.
//  - The insert transaction is sized well past this (see ENTITLEMENT_TX_OPTIONS in
//    subscriptions.ts): a 1,000-row batch is tested and completes.
//
// Kept out of the "use server" action file (which may only export async
// functions) so the client form and tests can import it too.
export const MAX_IMPORT_ROWS = 500;

// null when the import is within the cap; otherwise the message shown to the user.
// Checked BEFORE anything is written (the action creates cappers/sports as it
// resolves items), so an over-cap import changes nothing.
export function importRowCapError(rowCount: number): string | null {
  if (rowCount <= MAX_IMPORT_ROWS) return null;
  return (
    "This import has " +
    rowCount +
    " picks, but a single import is limited to " +
    MAX_IMPORT_ROWS +
    ". Nothing was imported - split it into batches of " +
    MAX_IMPORT_ROWS +
    " or fewer and import them one at a time."
  );
}
