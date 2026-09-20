"use client";

import { useState, useTransition } from "react";
import { deactivateStaffMember } from "./actions";
import { DEPARTMENT_LABEL, type Department } from "@/lib/timesheet";

export type StaffMember = {
  id: string;
  fullName: string;
  email: string;
  role: string;
  department: Department | null;
  active: boolean;
};

const ROLE_LABEL: Record<string, string> = {
  staff: "Staff",
  team_lead: "Team lead",
  department_head: "Department head",
  spm: "SPM",
  hr: "HR",
  admin_hr: "HR / Admin",
  admin: "Admin",
};

function StaffRow({ member, isSelf }: { member: StaffMember; isSelf: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function deactivate() {
    setError(null);
    startTransition(async () => {
      const result = await deactivateStaffMember(member.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setConfirming(false);
    });
  }

  const meta = [ROLE_LABEL[member.role] ?? member.role, member.department ? DEPARTMENT_LABEL[member.department] : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className={member.active ? "" : "opacity-70"}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{member.fullName}</span>
            {isSelf && <span className="text-xs text-text-secondary">(you)</span>}
            {!member.active && (
              <span className="rounded-full border border-border-strong bg-surface-2 px-2 py-0.5 text-xs font-semibold text-text-primary">
                Deactivated
              </span>
            )}
          </div>
          <p className="text-xs text-text-secondary">{member.email}</p>
          <p className="text-xs text-text-secondary">{meta}</p>
        </div>

        {member.active && !isSelf && !confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded-lg border border-border-strong px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-surface-2"
          >
            Deactivate
          </button>
        )}
      </div>

      {confirming && (
        <div className="flex flex-col gap-3 rounded-lg border border-border-strong bg-surface-2 p-3">
          <p className="text-sm">
            Deactivate <span className="font-semibold">{member.fullName}</span>? They will be signed out and
            won&apos;t be able to log in again. Their past timesheets and approvals stay on record.
          </p>
          {error && <p className="text-sm text-returning">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={deactivate}
              disabled={pending}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-accent disabled:opacity-60"
            >
              {pending ? "Deactivating…" : "Yes, deactivate"}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
              disabled={pending}
              className="rounded-lg border border-border-strong px-3 py-1.5 text-sm font-medium disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

export function StaffList({ members, currentUserId }: { members: StaffMember[]; currentUserId: string }) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby="staff-accounts-heading">
      <div>
        <h2 id="staff-accounts-heading" className="text-lg font-semibold">
          Staff accounts
        </h2>
        <p className="text-sm text-text-secondary">
          Deactivating an account blocks sign-in. Nothing is deleted — history is kept.
        </p>
      </div>
      <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
        {members.map((m) => (
          <StaffRow key={m.id} member={m} isSelf={m.id === currentUserId} />
        ))}
      </ul>
    </section>
  );
}
