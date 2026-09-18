"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import {
  type ApprovalType,
  type Department,
  type TimesheetStatus,
  approvalTypeLabel,
  APPROVAL_TYPE_ACTIVE_STATUS,
  DEPARTMENT_LABEL,
  monthLabel,
} from "@/lib/timesheet";
import { SignOutButton } from "@/app/timesheet/SignOutButton";

type RawStep = {
  id: string;
  timesheet_id: string;
  cycle_number: number;
  approval_type: ApprovalType;
  timesheets: {
    id: string;
    department: Department;
    month: number;
    year: number;
    status: TimesheetStatus;
    staff_id: string;
    profiles: { full_name: string } | null;
  } | null;
};

type PendingItem = {
  stepId: string;
  timesheetId: string;
  cycleNumber: number;
  approvalType: ApprovalType;
  department: Department;
  month: number;
  year: number;
  staffName: string;
};

export function PendingApprovalsList({ userId }: { userId: string }) {
  const supabase = useMemo(() => createClient(), []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<PendingItem[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      const { data: steps, error: stepsError } = await supabase
        .from("approval_steps")
        .select(
          "id, timesheet_id, cycle_number, approval_type, timesheets(id, department, month, year, status, staff_id, profiles(full_name))",
        )
        .eq("approver_id", userId)
        .eq("status", "pending");
      if (cancelled) return;
      if (stepsError) {
        setError("Couldn't load your pending approvals.");
        setLoading(false);
        return;
      }

      const rows = (steps ?? []) as unknown as RawStep[];

      // A prior cycle's row can still be 'pending' if that cycle was
      // declined before reaching this approval_type's layer (e.g. declined
      // at department_head, so the spm/hr rows created for that cycle never
      // got resolved). Resubmission always starts a new cycle_number with
      // entirely fresh rows, so the highest cycle_number among this
      // approver's own pending rows for a timesheet is always the live one
      // — collapse to that before deciding what's actionable, so a stale
      // cycle never shows twice.
      const maxCycleByTimesheet = new Map<string, number>();
      for (const row of rows) {
        const current = maxCycleByTimesheet.get(row.timesheet_id) ?? 0;
        if (row.cycle_number > current) maxCycleByTimesheet.set(row.timesheet_id, row.cycle_number);
      }
      const currentCycleRows = rows.filter(
        (row) => row.cycle_number === maxCycleByTimesheet.get(row.timesheet_id),
      );

      // A row is genuinely actionable now iff the parent timesheet's own
      // status says this approval_type's layer is the currently active one
      // — see APPROVAL_TYPE_ACTIVE_STATUS for why this (not a client-side
      // read of sibling approval_steps rows) is the correct check.
      const actionable = currentCycleRows.filter(
        (row) => row.timesheets && row.timesheets.status === APPROVAL_TYPE_ACTIVE_STATUS[row.approval_type],
      );

      setItems(
        actionable.map((row) => ({
          stepId: row.id,
          timesheetId: row.timesheet_id,
          cycleNumber: row.cycle_number,
          approvalType: row.approval_type,
          department: row.timesheets!.department,
          month: row.timesheets!.month,
          year: row.timesheets!.year,
          staffName: row.timesheets!.profiles?.full_name ?? "Unknown staff",
        })),
      );
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [supabase, userId]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent-on-tint">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M22 12h-6l-2 3h-4l-2-3H2" />
              <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
            </svg>
          </span>
          <div>
            <h1 className="text-xl font-semibold">Pending approvals</h1>
            <p className="text-sm text-text-secondary">Items waiting on your review right now.</p>
          </div>
        </div>
        <SignOutButton />
      </div>

      {loading && <p className="text-sm text-text-secondary">Loading…</p>}
      {error && <p className="text-sm text-returning">{error}</p>}

      {!loading && !error && items.length === 0 && (
        <p className="text-sm text-text-secondary">
          Nothing is waiting on your review right now.
        </p>
      )}

      {!loading && items.length > 0 && (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.stepId}>
              <Link
                href={`/approvals/${item.timesheetId}`}
                className="flex items-center gap-4 rounded-xl border border-border border-l-4 border-l-accent bg-surface p-4 transition-colors hover:border-border-strong hover:border-l-accent-on-tint"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent-on-tint">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                </span>
                <div className="flex-1">
                  <p className="text-sm font-medium">{item.staffName}</p>
                  <p className="text-xs text-text-secondary">
                    {DEPARTMENT_LABEL[item.department]} · {monthLabel(item.year, item.month)}
                    {item.cycleNumber > 1 ? ` · Resubmitted (cycle ${item.cycleNumber})` : ""}
                  </p>
                </div>
                <span className="text-xs font-medium text-text-muted">
                  {approvalTypeLabel(item.approvalType, item.department)} review
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
