"use client";

import { useActionState, useState } from "react";
import { createStaffMember, type CreateStaffResult } from "./actions";
import { SignOutButton } from "@/app/timesheet/SignOutButton";

type Profile = { id: string; full_name: string };

const ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: "staff", label: "Staff" },
  { value: "team_lead", label: "Team lead" },
  { value: "department_head", label: "Department head" },
  { value: "spm", label: "SPM" },
  { value: "hr", label: "HR" },
  { value: "admin", label: "Admin" },
];

const initialState: CreateStaffResult = { ok: false, error: "" };

export function AddStaffForm({
  teamLeads,
  departmentHeads,
}: {
  teamLeads: Profile[];
  departmentHeads: Profile[];
}) {
  const [state, formAction, pending] = useActionState(createStaffMember, initialState);
  const [role, setRole] = useState("staff");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <h1 className="text-xl font-semibold">Add staff member</h1>
        <SignOutButton />
      </div>

      {state.ok ? (
        <p className="text-sm text-approved">
          Account created. Share the temporary password with them directly — they can change it after
          signing in.
        </p>
      ) : (
        <form action={formAction} className="flex max-w-md flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="fullName" className="text-sm font-medium">
              Full name
            </label>
            <input
              id="fullName"
              name="fullName"
              type="text"
              required
              className="rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="email" className="text-sm font-medium">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              className="rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="location" className="text-sm font-medium">
              Location
            </label>
            <input
              id="location"
              name="location"
              type="text"
              required
              className="rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="role" className="text-sm font-medium">
              Role
            </label>
            <select
              id="role"
              name="role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
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
                  defaultValue=""
                  required
                  className="rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
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
                <select
                  id="teamLeadId"
                  name="teamLeadId"
                  defaultValue=""
                  required
                  className="rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
                >
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
                  Department head
                </label>
                <select
                  id="departmentHeadId"
                  name="departmentHeadId"
                  defaultValue=""
                  required
                  className="rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
                >
                  <option value="" disabled>
                    Select a department head
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
              className="rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </div>

          {state.error && <p className="text-sm text-returning">{state.error}</p>}

          <button
            type="submit"
            disabled={pending}
            className="mt-2 self-start rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent disabled:opacity-60"
          >
            {pending ? "Creating…" : "Create account"}
          </button>
        </form>
      )}
    </div>
  );
}
