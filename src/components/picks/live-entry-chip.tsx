// "Live entry": a pick imported while its game was already in progress (Pick.enteredLive). A small neutral chip in
// the /picks ledger's market-tag style; shown on the ledger row, the import preview row and the import result.
export function LiveEntryChip({ className = "" }: { className?: string }) {
  return (
    <span
      title="Entered while the game was in progress"
      className={
        "inline-flex items-center rounded-full bg-[#EEF0F4] px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-[0.05em] text-[#5B6275] dark:bg-muted dark:text-muted-foreground " +
        className
      }
    >
      Live entry
    </span>
  );
}
