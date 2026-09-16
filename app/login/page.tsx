"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const APPROVER_ROLES = ["team_lead", "department_head", "spm", "hr"];

function landingPathForRole(role: string | undefined) {
  if (role === "admin") return "/admin";
  if (role && APPROVER_ROLES.includes(role)) return "/approvals";
  return "/timesheet";
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password) {
      setError("Enter your email and password.");
      return;
    }
    setError(null);
    setSubmitting(true);
    const supabase = createClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.user) {
      setSubmitting(false);
      setError("Couldn't sign in. Check your email and password.");
      return;
    }

    // Admin has no timesheet chain of its own (generate_approval_chain has
    // no rule for role='admin'), and approver roles (team_lead/
    // department_head/spm/hr) have no organizational_assignments row of
    // their own either, so /timesheet's auto-create dead-ends for them too
    // — route by role instead of assuming everyone lands the same place.
    const { data: profile } = await supabase.from("profiles").select("role").eq("id", data.user.id).single();
    setSubmitting(false);
    router.push(landingPathForRole(profile?.role));
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-sm">
      <h1 className="mb-1 text-xl font-semibold">Sign in</h1>
      <p className="mb-6 text-sm text-text-secondary">
        Use the account your administrator set up for you.
      </p>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="email" className="text-sm font-medium">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            placeholder="name@kalthum4peace.org"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="password" className="text-sm font-medium">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </div>
        {error && <p className="text-sm text-returning">{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          className="mt-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent disabled:opacity-60"
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
