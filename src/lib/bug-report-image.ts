// Browser-only: shrink a screenshot before upload so a report costs a few
// hundred KB, not a few MB. Longest edge to SCREENSHOT_MAX_EDGE_PX, re-encoded
// as WebP, stepping quality (then size) down until it fits MAX_SCREENSHOT_BYTES.
// Returns an error string instead of throwing so the form can show it.

import { MAX_SCREENSHOT_BYTES, SCREENSHOT_MAX_EDGE_PX } from "@/lib/bug-report";

export type ShrinkResult = { ok: true; blob: Blob } | { ok: false; error: string };

const QUALITIES = [0.85, 0.7, 0.55, 0.4];
const SCALES = [1, 0.75, 0.5];

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
}

export async function shrinkScreenshot(file: File): Promise<ShrinkResult> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
    return { ok: false, error: "Screenshots must be PNG, JPEG or WebP images." };
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, error: "That image couldn't be read." };
  }

  const fit = Math.min(1, SCREENSHOT_MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
  try {
    for (const scale of SCALES) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * fit * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * fit * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return { ok: false, error: "Your browser can't shrink images." };
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of QUALITIES) {
        const blob = await toBlob(canvas, quality);
        // A browser without WebP encoding hands back PNG; skip it rather than send a big file.
        if (blob && blob.type === "image/webp" && blob.size <= MAX_SCREENSHOT_BYTES) return { ok: true, blob };
      }
    }
  } finally {
    bitmap.close();
  }
  return { ok: false, error: "That screenshot is too large to send. Try a smaller capture." };
}
