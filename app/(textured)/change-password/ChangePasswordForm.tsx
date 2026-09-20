"use client";

import { useActionState } from "react";
import { changePassword, type ChangePasswordResult } from "./actions";
import { MIN_PASSWORD_LENGTH } from "@/lib/password";

const initialState: ChangePasswordResult = { ok: false, error: "" };

const inputClass =
  "rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent";

export function ChangePasswordForm({ forced }: { forced: boolean }) {
  const [state, formAction, pending] = useActionState(changePassword, initialState);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent-on-tint">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </span>
        <div>
          <h1 className="text-xl font-semibold">{forced ? "Set your new password" : "Change password"}</h1>
          <p className="text-sm text-text-secondary">
            {forced
              ? "Before you continue, replace the temporary password you were given with one only you know."
              : "Choose a new password for your account."}
          </p>
        </div>
      </div>

      {state.ok ? (
        <div className="flex max-w-md items-start gap-3 rounded-xl border border-approved-bg bg-approved-bg p-4">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mt-0.5 shrink-0 text-approved">
            <circle cx="12" cy="12" r="10" />
            <path d="m9 12 2 2 4-4" />
          </svg>
          <p className="text-sm text-approved">Password changed. Use the new one the next time you sign in.</p>
        </div>
      ) : (
        <form
          action={formAction}
          className="flex max-w-md flex-col gap-4 rounded-xl border border-border bg-surface p-6"
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="currentPassword" className="text-sm font-medium">
              {forced ? "Temporary password" : "Current password"}
            </label>
            <input
              id="currentPassword"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              className={inputClass}
            />
            {forced && (
              <p className="text-xs text-text-secondary">The one you just signed in with.</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="newPassword" className="text-sm font-medium">
              New password
            </label>
            <input
              id="newPassword"
              name="newPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              className={inputClass}
            />
            <p className="text-xs text-text-secondary">At least {MIN_PASSWORD_LENGTH} characters.</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="confirmPassword" className="text-sm font-medium">
              Confirm new password
            </label>
            <input
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              className={inputClass}
            />
          </div>

          {state.error && (
            <p role="alert" className="text-sm text-returning">
              {state.error}
            </p>
          )}

          <button
            type="submit"
            disabled={pending}
            className="self-start rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent disabled:opacity-60"
          >
            {pending ? "Saving…" : forced ? "Set password and continue" : "Change password"}
          </button>
        </form>
      )}
    </div>
  );
}
