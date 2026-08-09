import { signIn } from "@/auth";

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.47c-.28 1.5-1.13 2.78-2.4 3.63v3.02h3.88c2.27-2.09 3.57-5.17 3.57-8.84Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.95-2.9l-3.88-3.02c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.26v3.11C3.24 21.3 7.28 24 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.27a7.24 7.24 0 0 1 0-4.54V6.62H1.26a12 12 0 0 0 0 10.76l4.01-3.11Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.34.6 4.58 1.79l3.44-3.44C17.95 1.19 15.24 0 12 0 7.28 0 3.24 2.7 1.26 6.62l4.01 3.11c.95-2.85 3.6-4.96 6.73-4.96Z"
      />
    </svg>
  );
}

export default function SignInPage({
  searchParams,
}: {
  searchParams: { callbackUrl?: string };
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-card bg-white p-8 text-center shadow-soft">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-lg bg-[#7F77DD]">
          <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6" aria-hidden="true">
            <circle cx="10" cy="14" r="6.5" />
            <circle cx="10" cy="14" r="2.5" />
            <path d="M14.5 9.5L21 3" />
            <path d="M21 7.5V3h-4.5" />
          </svg>
        </div>
        <h1 className="text-xl font-semibold text-gray-900">Capper Tracker</h1>
        <p className="mt-1 text-sm text-gray-500">Sign in to track your cappers.</p>

        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: searchParams.callbackUrl || "/dashboard" });
          }}
          className="mt-6"
        >
          <button
            type="submit"
            className="flex w-full items-center justify-center gap-2 rounded-full border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 shadow-soft transition hover:bg-gray-50"
          >
            <GoogleIcon />
            Sign in with Google
          </button>
        </form>
      </div>
    </div>
  );
}
