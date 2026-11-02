import type { ReactNode } from "react";

// The question UI shared by the manual paste form (dashboard/bulk-import-form.tsx) and the Telegram ingest review
// queue (import/review-queue.tsx), so a question looks and words the same wherever it is asked. Presentation only:
// each caller decides what an answer does.

// Review-prompt choices: real buttons, 44px tall for touch.
export const promptButtonClass =
  "inline-flex min-h-[44px] items-center rounded-full border border-amber-500 bg-card px-3.5 text-left text-xs font-semibold text-amber-900 transition hover:bg-amber-100 dark:border-amber-600 dark:text-amber-200 dark:hover:bg-amber-900/30";
export const promptLinkClass =
  "inline-flex min-h-[44px] items-center font-semibold underline hover:text-amber-950 dark:hover:text-amber-100";
export const questionGroupTitleClass = "text-xs font-semibold uppercase tracking-wide";

// One question in the "Needs your answer" panel. Focusable so a row's "Answer below" link can land on it.
export function QuestionItem({ id, text, meta, children }: { id: string; text: string; meta: string; children: ReactNode }) {
  return (
    <li
      id={id}
      tabIndex={-1}
      className="scroll-mt-4 rounded-lg border border-amber-300 bg-card px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-amber-500 dark:border-amber-500/40"
    >
      <div className="break-words text-sm font-medium text-foreground">{text}</div>
      <div className="mt-0.5 break-words text-xs text-muted-foreground">{meta}</div>
      {children}
    </li>
  );
}

export function ChoiceButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={promptButtonClass + (disabled ? " cursor-not-allowed opacity-50" : "")}>
      {children}
    </button>
  );
}

// The row the choice buttons sit in (plus any trailing hint).
export function ChoiceRow({ children }: { children: ReactNode }) {
  return <div className="mt-1.5 flex flex-wrap items-center gap-1.5">{children}</div>;
}

// "No number found in this pick's text. Today's market total for this game is 8.5."
export function TotalLineExplainer({ reason, inferredLine }: { reason: "missing" | "garbled"; inferredLine: number }) {
  return (
    <div className="mt-1.5">
      {reason === "missing" ? "No number found in this pick's text." : "Couldn't read a valid number in this pick's text."} Today&apos;s
      market total for this game is <span className="font-semibold">{inferredLine}</span>.
    </div>
  );
}

// "More than one player is close to this name": a near-miss name (typedName set) is close to several players rather
// than shared by them.
export function playerQuestionShort(options: { typedName?: string }[]): string {
  return options.some((o) => o.typedName) ? "More than one player is close to this name" : "More than one player has this name";
}

export type ReasonOption = { label: string; playerName?: string; typedName?: string };

export function ambiguousReasonText(isPlayer: boolean, options: ReasonOption[]): string {
  if (options.length === 1) {
    // A player prompt with one option is a near-miss name's suggestion: "Brian Thomas Jr. — Jaguars WR".
    const [only] = options;
    if (isPlayer && only.playerName) {
      const detail = only.label.split(" — ")[1];
      return "Did you mean " + only.playerName + (detail ? " (" + detail + ")" : "") + "?";
    }
    return "Line plausibility narrowed this to " + only.label + ", but another signal disagreed - confirm it.";
  }
  return isPlayer ? playerQuestionShort(options) + " - which one?" : "Ambiguous team - could mean " + options.map((o) => o.label).join(" or ") + ".";
}

// The short meta-line wording of an ambiguous question.
export function ambiguousKindText(isPlayer: boolean, options: ReasonOption[]): string {
  return options.length === 1 ? ambiguousReasonText(isPlayer, options) : isPlayer ? playerQuestionShort(options) : "Ambiguous team";
}

// "Vegas John" is not an exact match for any saved capper. Did you mean ...? The callers put the answer buttons in.
export function CapperFuzzyPrompt({ name, suggestion, children }: { name: string; suggestion: string; children: ReactNode }) {
  return (
    <div className="mt-2 rounded-lg border border-amber-400 bg-amber-50/60 px-3 py-2.5 text-xs text-amber-900 dark:border-amber-500/60 dark:bg-amber-500/5 dark:text-amber-200">
      <div>
        <span className="font-semibold">&quot;{name}&quot;</span> isn&apos;t an exact match for any saved capper. Did you mean{" "}
        <span className="font-semibold">{suggestion}</span>?
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}
