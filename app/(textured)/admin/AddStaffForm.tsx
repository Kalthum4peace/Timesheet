"use client";

import { useActionState, useState } from "react";
import { createStaffMember, type CreateStaffResult } from "./actions";
import { departmentHeadLabel, type Department } from "@/lib/timesheet";

type Profile = { id: string; full_name: string };

// Plain "hr" is retired for NEW staff (client decision, round 2, 2026-09-18):
// the HR position is always created as admin_hr going forward. Existing
// hr-role accounts are untouched and keep working. The one remaining
// HR-carrying option is admin_hr, labelled "HR / Admin" so it's clear this
// account gets Admin access too (and stays distinguishable from plain
// "Admin", which has no timesheet chain of its own). The label is the only
// thing to change if the client would rather it read just "HR".
const ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: "staff", label: "Staff" },
  { value: "team_lead", label: "Team lead" },
  { value: "department_head", label: "Department head" },
  { value: "spm", label: "SPM" },
  { value: "admin_hr", label: "HR / Admin" },
  { value: "admin", label: "Admin" },
];

const initialState: CreateStaffResult = { ok: false, error: "" };

const inputClass =
  "rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent";

// Client feedback (demo, 2026-09-18): "more colorful, user friendly,
// creative" — read as "feels sparse," not license to introduce new colors.
// This pass uses the existing accent token more deliberately (icon badge,
// section eyebrows, a wrapping card) rather than adding anything outside
// the locked warm-restrained-confident palette. See CLAUDE.md "Design
// direction" for the banned list this stays inside of (no gradients, no
// emoji-as-icons — these are inline SVGs matching the login page's icon
// style).
function SectionEyebrow({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-accent-on-tint">
      {icon}
      {children}
    </div>
  );
}

export function AddStaffForm({
  teamLeads,
  departmentHeads,
}: {
  teamLeads: Profile[];
  departmentHeads: Profile[];
}) {
  const [state, formAction, pending] = useActionState(createStaffMember, initialState);
  const [role, setRole] = useState("staff");
  const [department, setDepartment] = useState<Department | "">("");
  const departmentHeadFieldLabel = department ? departmentHeadLabel(department) : "Department head";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent-on-tint">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M19 8v6M22 11h-6" />
            </svg>
          </span>
          <div>
            <h1 className="text-xl font-semibold">Add staff member</h1>
            <p className="text-sm text-text-secondary">Create a login for a new team member.</p>
          </div>
        </div>
      </div>

      {state.ok ? (
        <div className="flex items-start gap-3 rounded-xl border border-approved-bg bg-approved-bg p-4">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mt-0.5 shrink-0 text-approved">
            <circle cx="12" cy="12" r="10" />
            <path d="m9 12 2 2 4-4" />
          </svg>
          <p className="text-sm text-approved">
            Account created. Share the temporary password with them directly — they can change it after
            signing in.
          </p>
        </div>
      ) : (
        <form
          action={formAction}
          className="flex max-w-md flex-col gap-5 rounded-xl border border-border bg-surface p-6"
        >
          <div className="flex flex-col gap-4">
            <SectionEyebrow
              icon={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 21v-2a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              }
            >
              Account details
            </SectionEyebrow>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="fullName" className="text-sm font-medium">
                Full name
              </label>
              <input id="fullName" name="fullName" type="text" required className={inputClass} />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="email" className="text-sm font-medium">
                Email
              </label>
              <input id="email" name="email" type="email" required className={inputClass} />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="hrNumber" className="text-sm font-medium">
                HR number
                <span className="ml-1 font-normal text-text-muted">(optional)</span>
              </label>
              <input
                id="hrNumber"
                name="hrNumber"
                type="text"
                className={inputClass}
                placeholder="Not a login credential — used for lookup only"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="location" className="text-sm font-medium">
                Location
              </label>
              <input id="location" name="location" type="text" required className={inputClass} />
            </div>
          </div>

          <div className="flex flex-col gap-4 border-t border-border pt-5">
            <SectionEyebrow
              icon={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="7" width="18" height="13" rx="2" />
                  <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              }
            >
              Role &amp; assignment
            </SectionEyebrow>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="role" className="text-sm font-medium">
                Role
              </label>
              <select
                id="role"
                name="role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className={inputClass}
              >
                {ROLE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {role === "staff" && (
              <>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="department" className="text-sm font-medium">
                    Department
                  </label>
                  <select
                    id="department"
                    name="department"
                    value={department}
                    onChange={(e) => setDepartment(e.target.value as Department | "")}
                    required
                    className={inputClass}
                  >
                    <option value="" disabled>
                      Select a department
                    </option>
                    <option value="medical">Medical</option>
                    <option value="operations">Operations</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="teamLeadId" className="text-sm font-medium">
                    Team lead
                  </label>
                  <select id="teamLeadId" name="teamLeadId" defaultValue="" required className={inputClass}>
                    <option value="" disabled>
                      Select a team lead
                    </option>
                    {teamLeads.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.full_name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="departmentHeadId" className="text-sm font-medium">
                    {departmentHeadFieldLabel}
                  </label>
                  <select
                    id="departmentHeadId"
                    name="departmentHeadId"
                    defaultValue=""
                    required
                    className={inputClass}
                  >
                    <option value="" disabled>
                      Select a {departmentHeadFieldLabel.toLowerCase()}
                    </option>
                    {departmentHeads.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.full_name}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}

            <div className="flex flex-col gap-1.5">
              <label htmlFor="password" className="text-sm font-medium">
                Temporary password
              </label>
              <input
                id="password"
                name="password"
                type="text"
                required
                minLength={8}
                placeholder="At least 8 characters"
                className={inputClass}
              />
            </div>
          </div>

          {state.error && <p className="text-sm text-returning">{state.error}</p>}

          <button
            type="submit"
            disabled={pending}
            className="flex items-center gap-2 self-start rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent disabled:opacity-60"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            {pending ? "Creating…" : "Create account"}
          </button>
        </form>
      )}
    </div>
  );
}
