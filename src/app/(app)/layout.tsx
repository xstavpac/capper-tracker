import { AppSidebar } from "@/components/layout/app-sidebar";
import { requireUser } from "@/server/auth";

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
