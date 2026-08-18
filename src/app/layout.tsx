import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bettingview",
  description: "Track the performance of every sports betting capper you follow.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}
