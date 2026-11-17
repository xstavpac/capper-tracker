import type { Metadata, Viewport } from "next";
import "./globals.css";

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
