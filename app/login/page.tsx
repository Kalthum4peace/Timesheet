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
  const [showPassword, setShowPassword] = useState(false);

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
    <div className="relative isolate overflow-hidden rounded-2xl">
      {/* Second (and only other) signature moment besides the header
          flourish — a quiet, low-opacity texture reserved for this screen,
          the app's other natural bookend. Sits fully behind the opaque
          form card below, so it never touches the form's own contrast. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          opacity: "var(--login-bg-opacity)",
          backgroundImage: "url(/kfp-logo.jpg)",
          backgroundSize: "480px",
          backgroundPosition: "center 20%",
          backgroundRepeat: "no-repeat",
        }}
      />
      <div className="mx-auto max-w-sm rounded-2xl border border-border bg-surface p-6">
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
            <div className="relative">
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 pr-10 text-sm outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-text-secondary hover:text-text-primary"
              >
                {showPassword ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 3l18 18" />
                    <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
                    <path d="M9.9 5.1A9.9 9.9 0 0 1 12 5c6.5 0 10 7 10 7a13.2 13.2 0 0 1-3.1 3.9M6.2 6.2A13.6 13.6 0 0 0 2 12s3.5 7 10 7a9.9 9.9 0 0 0 4.2-.9" />
                  </svg>
                )}
              </button>
            </div>
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
    </div>
  );
}
