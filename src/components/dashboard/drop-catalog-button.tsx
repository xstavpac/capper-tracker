export const dropCatalogButtonClass =
  "inline-flex items-center gap-2 rounded-full border-2 border-purple-400 bg-purple-900 px-6 py-3 text-sm font-semibold text-white animate-glow-pulse transition hover:border-purple-300 hover:bg-purple-800 disabled:cursor-not-allowed disabled:opacity-50 disabled:animate-none disabled:shadow-none";

export function LightningIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" />
    </svg>
  );
}

export function DropCatalogLink({ href }: { href: string }) {
  return (
    <a href={href} className={dropCatalogButtonClass}>
      <LightningIcon />
      Drop Catalog
    </a>
  );
}
