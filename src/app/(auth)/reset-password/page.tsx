"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { AuthCard, AUTH_PRIMARY_BUTTON_CLASS, AUTH_INPUT_CLASS } from "@/components/auth/auth-card";

// Landed on via the password-reset email link, after auth/callback has
// already exchanged the code for a real (recovery) session - updateUser
// here just sets a new password on that already-authenticated session.
export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const supabase = createSupabaseBrowserClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <AuthCard heading="Set a new password" subtitle="Choose a new password for your account">
      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          type="password"
          required
          minLength={6}
          placeholder="New password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={AUTH_INPUT_CLASS}
        />

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button type="submit" disabled={loading} className={AUTH_PRIMARY_BUTTON_CLASS}>
          {loading ? "Saving..." : "Save new password"}
        </button>
      </form>
    </AuthCard>
  );
}
