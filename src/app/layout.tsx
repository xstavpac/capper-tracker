import type { Metadata, Viewport } from "next";
import "./globals.css";
// Page banners (components/banners/*): the shared pieces, then each banner's own art. Imported here rather than
// from the components so the tests, which load components under Node, never meet a .css import.
import "@/components/banners/banner-shared.css";
import "@/components/banners/live.css";
import "@/components/banners/dashboard.css";
import "@/components/banners/cappers.css";
import "@/components/banners/picks.css";
import "@/components/banners/parlay.css";
import "@/components/banners/import.css";
import "@/components/banners/charts.css";
// The /live and /picks skins (tiles, panels, chips, lists).
import "@/components/live/live-skin.css";
import "@/components/picks/picks-skin.css";
// The Record by category tiles' shared green and red (/dashboard and /live).
import "@/components/dashboard/category-tile.css";
import "@/components/parlay/combined-mix-box.css";

export const metadata: Metadata = {
  title: "Bettingview",
  description: "Track the performance of every sports betting capper you follow.",
};

// viewport-fit=cover so env(safe-area-inset-bottom) is non-zero on iPhones (the mobile tab bar pads by it).
export const viewport: Viewport = { viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}
