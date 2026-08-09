"use client";

import { useState } from "react";
import Link from "next/link";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { AuthCard, AUTH_PRIMARY_BUTTON_CLASS, AUTH_INPUT_CLASS } from "@/components/auth/auth-card";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const supabase = createSupabaseBrowserClient();
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent("/reset-password")}`,
    });
    setLoading(false);
    if (resetError) {
      setError(resetError.message);
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <AuthCard heading="Check your email" subtitle={`We sent a password reset link to ${email}.`}>
        <Link href="/sign-in" className="block text-center text-sm font-medium text-[#7F2FD4] hover:text-[#6b26b3]">
          Back to sign in
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard heading="Reset your password" subtitle="Enter your email and we'll send you a reset link">
      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          type="email"
          required
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={AUTH_INPUT_CLASS}
        />

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button type="submit" disabled={loading} className={AUTH_PRIMARY_BUTTON_CLASS}>
          {loading ? "Sending..." : "Send reset link"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-gray-500">
        <Link href="/sign-in" className="font-medium text-[#7F2FD4] hover:text-[#6b26b3]">
          Back to sign in
        </Link>
      </p>
    </AuthCard>
  );
}
