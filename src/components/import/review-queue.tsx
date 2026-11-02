"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { dismissReviewItemAction, resolveReviewItemAction } from "@/server/actions/ingest-review";
import type { ReviewCard } from "@/server/data/ingest-review-queue";
import { playerLineIsNearMiss } from "@/lib/ingest-review-options";
import {
  CapperFuzzyPrompt,
  ChoiceButton,
  ChoiceRow,
  QuestionItem,
  TotalLineExplainer,
  ambiguousReasonText,
  promptButtonClass,
} from "@/components/import/review-question-ui";

// "Needs review" on the Catalog Import page: the questions the unattended Telegram ingest parked instead of asking.
// Renders nothing at all when there is nothing pending and nothing just answered, so a user without a queue sees no
// section and no layout shift. The list is the server's snapshot at page load; answering removes a card locally and
// refreshes the layout so the sidebar badge follows.

const QUESTION_NAMES: Record<ReviewCard["questionType"], string> = {
  AMBIGUOUS_TEAM: "Ambiguous team",
  PLAYER_AMBIGUITY: "Ambiguous player",
  MISSING_TOTAL_LINE: "Missing total number",
  CAPPER_FUZZY: "Capper name",
};

// The distinct answers behind a team / player question: a near-miss capper name multiplies each answer into
// "... - as <capper>" variants, which are one answer to the person reading the question.
function baseOptions(card: ReviewCard) {
  const seen = new Set<string>();
  const out: { label: string; playerName?: string; typedName?: string; nearMiss?: boolean }[] = [];
  for (const c of card.choices) {
    const label = c.label.split(" - as ")[0];
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ label, playerName: c.playerName ?? label.split(" — ")[0], ...(c.typedName ? { typedName: c.typedName } : {}) });
  }
  // Parked before typedName was stored: a near-miss is told from a shared name by comparing the roster names with the line.
  if (card.questionType === "PLAYER_AMBIGUITY" && !out.some((o) => o.typedName)) {
    const near = playerLineIsNearMiss(card.lineText, out.map((o) => o.playerName ?? ""));
    return out.map((o) => ({ ...o, nearMiss: near }));
  }
  return out;
}

type Answer = Awaited<ReturnType<typeof resolveReviewItemAction>>;

export function ReviewQueue({ initialCards }: { initialCards: ReviewCard[] }) {
  const router = useRouter();
  const [cards, setCards] = useState(initialCards);
  const [confirmations, setConfirmations] = useState<{ key: string; text: string }[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  if (cards.length === 0 && confirmations.length === 0) return null;

  function clearError(id: string) {
    setErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  async function answer(card: ReviewCard, run: () => Promise<Answer>, doneText: (pickLabel?: string) => string) {
    if (busy) return;
    setBusy(card.id);
    clearError(card.id);
    try {
      const res = await run();
      if (res.ok) {
        setCards((prev) => prev.filter((c) => c.id !== card.id));
        setConfirmations((prev) => [...prev, { key: card.id, text: doneText(res.pickLabel) }]);
        // The layout (sidebar badge) re-reads the revalidated count.
        startTransition(() => router.refresh());
      } else {
        setErrors((prev) => ({ ...prev, [card.id]: res.message }));
      }
    } catch {
      setErrors((prev) => ({ ...prev, [card.id]: "Something went wrong. Try again." }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      aria-labelledby="needs-review-title"
      className="mb-5 rounded-card border border-amber-400 bg-amber-50/60 p-5 text-amber-900 shadow-soft dark:border-amber-500/60 dark:bg-amber-500/5 dark:text-amber-200"
    >
      <h2 id="needs-review-title" className="text-base font-semibold">
        {cards.length > 0 ? "Needs review (" + cards.length + ")" : "All caught up"}
      </h2>
      {cards.length > 0 && <p className="mt-0.5 text-sm">Picks from your Telegram feed that need an answer before they can be logged.</p>}

      <div aria-live="polite">
        {confirmations.map((c) => (
          <p key={c.key} className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
            {c.text}
          </p>
        ))}
      </div>

      <ul className="mt-3 space-y-2 text-xs">
        {cards.map((card) => {
          const isPlayer = card.questionType === "PLAYER_AMBIGUITY";
          const first = card.choices[0];
          const choiceButtons = card.choices.map((c) => (
            <ChoiceButton
              key={c.id}
              disabled={busy !== null || !c.playable}
              onClick={() =>
                answer(
                  card,
                  () => resolveReviewItemAction(card.id, c.id),
                  (label) => "Logged " + (label ?? c.label) + " for " + (c.capperName ?? card.capperName) + "."
                )
              }
            >
              {c.label}
            </ChoiceButton>
          ));
          const dismiss = (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => answer(card, () => dismissReviewItemAction(card.id), () => "Dismissed: " + card.lineText)}
              className={promptButtonClass + " !border-border !text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"}
            >
              Dismiss
            </button>
          );
          const unmatched = card.choices.find((c) => !c.playable && c.unmatched)?.unmatched;
          return (
            <QuestionItem
              key={card.id}
              id={"review-item-" + card.id}
              text={card.lineText}
              meta={card.capperName + " · " + card.day + " · " + QUESTION_NAMES[card.questionType]}
            >
              {(card.questionType === "AMBIGUOUS_TEAM" || isPlayer) && (
                <>
                  <div className="mt-1.5 text-xs">{ambiguousReasonText(isPlayer, baseOptions(card))}</div>
                  <ChoiceRow>
                    {choiceButtons}
                    {dismiss}
                  </ChoiceRow>
                </>
              )}
              {card.questionType === "MISSING_TOTAL_LINE" && (
                <>
                  {first?.inferredLine !== undefined && <TotalLineExplainer reason={first.lineReason ?? "missing"} inferredLine={first.inferredLine} />}
                  <ChoiceRow>
                    {choiceButtons}
                    {dismiss}
                  </ChoiceRow>
                </>
              )}
              {card.questionType === "CAPPER_FUZZY" && (
                <CapperFuzzyPrompt name={card.capperName} suggestion={first?.capperName ?? ""}>
                  {choiceButtons}
                  {dismiss}
                </CapperFuzzyPrompt>
              )}
              {unmatched && <div className="mt-1 text-xs text-muted-foreground">Some answers are unavailable: {unmatched}</div>}
              {errors[card.id] && (
                <div role="alert" className="mt-1.5 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-500/10 dark:text-red-300">
                  {errors[card.id]}
                </div>
              )}
            </QuestionItem>
          );
        })}
      </ul>
    </section>
  );
}
