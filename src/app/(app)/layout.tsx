import { AppSidebar } from "@/components/layout/app-sidebar";
import { requireUser } from "@/server/auth";

// Every route under here needs a live, per-request session - never
// statically prerender them. Without this, Next's build-time trial-render
// can hit requireUser()'s intentional throw (no session at build time)
// before it detects the cookies() call as a dynamic-API signal, failing the
// whole build instead of just marking these routes dynamic.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  return (
    <div className="flex min-h-screen flex-col md:flex-row md:gap-3 md:p-3">
      <AppSidebar
        user={{ name: user.name, email: user.email, profilePictureUrl: user.profilePictureUrl }}
      />
      <main className="flex-1 bg-gray-50 p-4 md:rounded-xl md:border md:border-gray-200 md:bg-white md:p-8 md:shadow-soft">
        {children}
      </main>
    </div>
  );
}
