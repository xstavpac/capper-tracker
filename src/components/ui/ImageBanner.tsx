import Image, { type StaticImageData } from "next/image";
import type { CSSProperties } from "react";

type ImageBannerProps = {
  // Static import so the file's real pixel dimensions drive the desktop aspect ratio.
  src: StaticImageData;
  title: string;
  priority?: boolean;
  // Tailwind height class for the mobile crop; override only when the default 68px clips the title.
  mobileHeightClass?: string;
};

export function ImageBanner({ src, title, priority = false, mobileHeightClass = "h-[68px]" }: ImageBannerProps) {
  const style = { "--banner-ar": `${src.width} / ${src.height}` } as CSSProperties;
  return (
    <div
      style={style}
      className={`relative mb-6 ${mobileHeightClass} w-full overflow-hidden rounded-xl border border-white/5 md:h-auto md:aspect-[var(--banner-ar)]`}
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
