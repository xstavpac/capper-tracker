"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { AuthCard, AUTH_PRIMARY_BUTTON_CLASS, AUTH_INPUT_CLASS } from "@/components/auth/auth-card";
import { GoogleIcon } from "@/components/auth/google-icon";
import { XIcon } from "@/components/auth/x-icon";

function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") || "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(() =>
    searchParams.get("error") === "auth_callback_failed" ? "Something went wrong signing you in. Please try again." : null
  );
  const [loading, setLoading] = useState<"google" | "x" | "password" | null>(null);

  // Shared by both OAuth buttons - "x" is Supabase's OAuth 2.0 X/Twitter
  // provider (distinct from its legacy "twitter" OAuth 1.0a provider, which
  // this app doesn't use).
  async function handleOAuth(provider: "google" | "x") {
    setError(null);
    setLoading(provider);
    const supabase = createSupabaseBrowserClient();
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(callbackUrl)}` },
    });
    if (oauthError) {
      setError(oauthError.message);
      setLoading(null);
    }
  }

  async function handlePasswordSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading("password");
    const supabase = createSupabaseBrowserClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(null);
    if (signInError) {
      setError(signInError.message === "Invalid login credentials" ? "Incorrect email or password." : signInError.message);
      return;
    }
    router.push(callbackUrl);
    router.refresh();
  }

  return (
    <AuthCard heading="Welcome back" subtitle="Sign in to your account">
      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => handleOAuth("google")}
          disabled={loading !== null}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <GoogleIcon />
          Continue with Google
        </button>
        <button
          type="button"
          onClick={() => handleOAuth("x")}
          disabled={loading !== null}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-black px-4 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <XIcon />
          Continue with X
        </button>
      </div>

      <p className="mt-3 text-center text-xs text-gray-400">
        By continuing, you agree to our{" "}
        <Link href="/privacy" className="font-medium text-gray-500 hover:text-gray-700">
          Privacy Policy
        </Link>
        .
      </p>

      <div className="my-5 flex items-center gap-3">
        <div className="h-px flex-1 bg-gray-200" />
        <span className="text-xs text-gray-400">or</span>
        <div className="h-px flex-1 bg-gray-200" />
      </div>

      <form onSubmit={handlePasswordSignIn} className="space-y-3">
        <input
          type="email"
          required
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={AUTH_INPUT_CLASS}
        />
        <div>
          <input
            type="password"
            required
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={AUTH_INPUT_CLASS}
          />
          <div className="mt-1.5 text-right">
            <Link href="/forgot-password" className="text-xs font-medium text-[#7F2FD4] hover:text-[#6b26b3]">
              Forgot password?
            </Link>
          </div>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button type="submit" disabled={loading !== null} className={AUTH_PRIMARY_BUTTON_CLASS}>
          {loading === "password" ? "Signing in..." : "Sign in"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-gray-500">
        Don&apos;t have an account?{" "}
        <Link href="/sign-up" className="font-medium text-[#7F2FD4] hover:text-[#6b26b3]">
          Sign up
        </Link>
      </p>
    </AuthCard>
  );
}

export default function SignInPage() {
  return (
    <Suspense>
      <SignInForm />
    </Suspense>
  );
}
