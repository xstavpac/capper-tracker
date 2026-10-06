// Where a cumulative-units series peaks and bottoms out: the index of its first highest and first
// lowest value. Shared by the capper page's chart (its markers) and the chart card's header
// (PEAK / LOW), so both name the same points. Null for an empty series.
export function unitsExtremes(values: number[]): { peak: number; low: number } | null {
  if (values.length === 0) return null;
  let peak = 0;
  let low = 0;
  values.forEach((v, i) => {
    if (v > values[peak]) peak = i;
    if (v < values[low]) low = i;
  });
  return { peak, low };
}

// "+3.4u" / "−10.0u": a signed units figure with a real minus sign.
export function formatSignedUnits(value: number, digits: number): string {
  const text = Math.abs(value).toFixed(digits);
  const zero = Number(text) === 0;
  return (zero ? "" : value > 0 ? "+" : "−") + text + "u";
}
