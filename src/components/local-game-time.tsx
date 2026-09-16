"use client";

import { useEffect, useState } from "react";
import { formatInZone } from "@/lib/dates";

// Renders `date` in the viewer's own OS timezone (via
// Intl.DateTimeFormat().resolvedOptions().timeZone) instead of the app's
// fixed Eastern zone. The server has no way to know the viewer's real zone
// at render time, so the initial state is computed in UTC - deterministic
// from `date` alone, so it renders identically on the server and on the
// client's first hydration pass, avoiding a hydration mismatch - and a
// post-mount effect immediately swaps it to the viewer's actual local zone.
export function LocalGameTime({
  date,
  options,
}: {
  date: Date | string;
  options: Intl.DateTimeFormatOptions;
}) {
  const instant = typeof date === "string" ? date : date.toISOString();
  const [text, setText] = useState(() => formatInZone(new Date(instant), "UTC", options));

  useEffect(() => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setText(formatInZone(new Date(instant), timeZone, options));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- options is a literal at each call site; only the instant should retrigger this
  }, [instant]);

  return <>{text}</>;
}
