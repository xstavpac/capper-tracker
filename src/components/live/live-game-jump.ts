"use client";

import { createContext, createElement, useCallback, useContext, useEffect, useRef, type MutableRefObject, type ReactNode } from "react";

// How a row in the /live category panel sends the viewer to its game. The
// panel and the board are siblings (live/page.tsx), so the board mounted on the
// page registers what "go to this game" means for it and the panel just calls
// it: Feed scrolls to the game's card and pulses it (scrollToGameCard below),
// Grid selects the game in its detail panel (grid-live-board.tsx's
// handleSelectGame - the same thing a click in its game list does).
type JumpHandler = (gameId: string) => void;

const LiveGameJumpContext = createContext<MutableRefObject<JumpHandler | null> | null>(null);

export function LiveGameJumpProvider({ children }: { children: ReactNode }) {
  const handler = useRef<JumpHandler | null>(null);
  return createElement(LiveGameJumpContext.Provider, { value: handler }, children);
}

// Called by the board. Re-registers every render so the handler never holds a
// stale closure.
export function useRegisterLiveGameJump(handler: JumpHandler) {
  const ref = useContext(LiveGameJumpContext);
  useEffect(() => {
    if (!ref) return;
    ref.current = handler;
    return () => {
      if (ref.current === handler) ref.current = null;
    };
  });
}

// Called by the panel. A no-op when no board is mounted.
export function useLiveGameJump(): JumpHandler {
  const ref = useContext(LiveGameJumpContext);
  return useCallback((gameId: string) => ref?.current?.(gameId), [ref]);
}

export function liveGameCardId(gameId: string): string {
  return "live-game-" + gameId;
}

const PULSE_ANIMATION_ID = "live-game-jump";

// Feed's handler: bring the card to the middle of the screen and outline it
// for a moment. The outline is a Web Animation on the element, so the card's
// own classes, shadow and badges are never touched and nothing is left behind
// when it ends.
export function scrollToGameCard(gameId: string) {
  const card = document.getElementById(liveGameCardId(gameId));
  if (!card) return;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  card.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });

  for (const running of card.getAnimations()) if (running.id === PULSE_ANIMATION_ID) running.cancel();
  const pulse = card.animate(
    [
      { outline: "3px solid rgba(59, 130, 246, 0.95)", outlineOffset: "2px" },
      { outline: "3px solid rgba(59, 130, 246, 0.95)", outlineOffset: "2px", offset: 0.6 },
      { outline: "3px solid rgba(59, 130, 246, 0)", outlineOffset: "2px" },
    ],
    { duration: 1800, easing: "ease-out" }
  );
  pulse.id = PULSE_ANIMATION_ID;
}
