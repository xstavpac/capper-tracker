import { SiteHeader } from "@/components/layout/site-header";
import { LiveTicker } from "@/components/marketing/live-ticker";
import { DesktopOnly, MobileOnly } from "@/components/layout/mobile-only";
import { SlateBarLoader, SlateChipsLoader } from "@/components/layout/slate-bar-loader";
import { MobileTabBar } from "@/components/layout/mobile-tab-bar";
import { ThemeProvider } from "@/components/layout/theme-provider";
import { ParlayPoolProvider } from "@/components/parlay/parlay-pool-context";
import { getLiveTickerGames } from "@/server/data/live-ticker";
import { requireUser } from "@/server/auth";
import { getPendingReviewCount } from "@/server/data/ingest-review-queue";
import { getNavFeatureFlags, ADMIN_OPS_CONSOLE_FLAG_KEY } from "@/server/data/feature-flags";

// Every route under here needs a live, per-request session - never
// statically prerender them. Without this, Next's build-time trial-render
// can hit requireUser()'s intentional throw (no session at build time)
// before it detects the cookies() call as a dynamic-API signal, failing the
// whole build instead of just marking these routes dynamic.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [user, tickerGames] = await Promise.all([requireUser(), getLiveTickerGames()]);
  // Admin menu-item visibility only, from the shared flag snapshot (no per-request
  // query). The gated pages do their own uncached check - see feature-flags.ts.
  // Pending Telegram-ingest review items for the Catalog Import badge: a cached per-user count, never a per-render query.
  const [[showAdminOps], reviewCount] = await Promise.all([
    getNavFeatureFlags([ADMIN_OPS_CONSOLE_FLAG_KEY], user.id),
    getPendingReviewCount(user.id),
  ]);

  return (
    <ThemeProvider initialTheme={user.themePreference}>
      <ParlayPoolProvider key={user.id} userId={user.id}>
        <div className="flex min-h-screen flex-col">
          <LiveTicker initialGames={tickerGames} />
          <SiteHeader
            user={{ name: user.name, email: user.email, profilePictureUrl: user.profilePictureUrl }}
            showAdminOps={showAdminOps}
            reviewCount={reviewCount}
            slate={
              <MobileOnly>
                <SlateBarLoader />
              </MobileOnly>
            }
            slateChips={
              <DesktopOnly>
                <SlateChipsLoader />
              </DesktopOnly>
            }
          />
          {/* Full width. Below md the bottom padding also clears the fixed tab bar. Its padding (p-4, md:p-8) is what ThemedPage's backdrop cancels - see themed-page.tsx. */}
          <main className="flex-1 bg-background p-4 max-md:pb-[calc(56px+env(safe-area-inset-bottom)+16px)] md:p-8">{children}</main>
          <MobileTabBar />
        </div>
      </ParlayPoolProvider>
    </ThemeProvider>
  );
}
