import Image, { type StaticImageData } from "next/image";
import type { CSSProperties } from "react";

type ImageBannerProps = {
  // Static import so the file's real pixel dimensions drive the desktop aspect ratio.
  src: StaticImageData;
  title: string;
  priority?: boolean;
  // Mobile height in px of the left-anchored crop; lower it only when the title would otherwise be clipped.
  mobileHeight?: number;
};

export function ImageBanner({ src, title, priority = false, mobileHeight = 68 }: ImageBannerProps) {
  const style = { "--banner-ar": `${src.width} / ${src.height}`, "--banner-mh": `${mobileHeight}px` } as CSSProperties;
  return (
    <div
      style={style}
      className={`relative mb-6 h-[var(--banner-mh)] w-full overflow-hidden rounded-xl border border-white/5 md:h-auto md:aspect-[var(--banner-ar)]`}
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
