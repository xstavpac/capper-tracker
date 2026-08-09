"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { AuthCard, AUTH_PRIMARY_BUTTON_CLASS, AUTH_INPUT_CLASS } from "@/components/auth/auth-card";
import { GoogleIcon } from "@/components/auth/google-icon";

export default function SignUpPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<"google" | "password" | null>(null);
  const [checkEmail, setCheckEmail] = useState(false);

  async function handleGoogle() {
    setError(null);
    setLoading("google");
    const supabase = createSupabaseBrowserClient();
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (oauthError) {
      setError(oauthError.message);
      setLoading(null);
    }
  }

  async function handlePasswordSignUp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading("password");
    const supabase = createSupabaseBrowserClient();
    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    setLoading(null);
    if (signUpError) {
      setError(signUpError.message);
      return;
    }
    // A session comes back immediately only if email confirmation is off in
    // the Supabase dashboard - otherwise there's a pending user and nothing
    // to do here until they click the confirmation link.
    if (data.session) {
      router.push("/dashboard");
      router.refresh();
    } else {
      setCheckEmail(true);
    }
  }

  if (checkEmail) {
    return (
      <AuthCard heading="Check your email" subtitle={`We sent a confirmation link to ${email}.`}>
        <p className="text-sm text-gray-500">
          Click the link in that email to finish creating your account, then come back and sign in.
        </p>
        <Link
          href="/sign-in"
          className="mt-6 block text-center text-sm font-medium text-[#7F2FD4] hover:text-[#6b26b3]"
        >
          Back to sign in
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard heading="Create an account" subtitle="Start tracking your cappers for free">
      <button
        type="button"
        onClick={handleGoogle}
        disabled={loading !== null}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <GoogleIcon />
        Continue with Google
      </button>

      <div className="my-5 flex items-center gap-3">
        <div className="h-px flex-1 bg-gray-200" />
        <span className="text-xs text-gray-400">or</span>
        <div className="h-px flex-1 bg-gray-200" />
      </div>

      <form onSubmit={handlePasswordSignUp} className="space-y-3">
        <input
          type="email"
          required
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={AUTH_INPUT_CLASS}
        />
        <input
          type="password"
          required
          minLength={6}
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={AUTH_INPUT_CLASS}
        />

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button type="submit" disabled={loading !== null} className={AUTH_PRIMARY_BUTTON_CLASS}>
          {loading === "password" ? "Creating account..." : "Sign up"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-gray-500">
        Already have an account?{" "}
        <Link href="/sign-in" className="font-medium text-[#7F2FD4] hover:text-[#6b26b3]">
          Sign in
        </Link>
      </p>
    </AuthCard>
  );
}
