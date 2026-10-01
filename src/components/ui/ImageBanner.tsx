import Image, { type StaticImageData } from "next/image";
import type { CSSProperties } from "react";

type ImageBannerProps = {
  // Static import so the file's real pixel dimensions drive the desktop aspect ratio.
  src: StaticImageData;
  title: string;
  priority?: boolean;
  // Show the whole image on mobile at its own aspect ratio instead of the fixed 68px left-anchored crop.
  fitMobile?: boolean;
};

export function ImageBanner({ src, title, priority = false, fitMobile = false }: ImageBannerProps) {
  const style = { "--banner-ar": `${src.width} / ${src.height}` } as CSSProperties;
  return (
    <div
      style={style}
      className={`relative mb-6 ${fitMobile ? "aspect-[var(--banner-ar)]" : "h-[68px]"} w-full overflow-hidden rounded-xl border border-white/5 md:h-auto md:aspect-[var(--banner-ar)]`}
    >
      <Image
        src={src}
        alt=""
        fill
        sizes="100vw"
        quality={90}
        priority={priority}
        className="object-cover object-left md:object-center"
      />
      <h1 className="sr-only">{title}</h1>
    </div>
  );
}
