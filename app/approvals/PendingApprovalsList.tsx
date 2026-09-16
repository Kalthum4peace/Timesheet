"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import {
  type ApprovalType,
  type Department,
  type TimesheetStatus,
  APPROVAL_TYPE_LABEL,
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
        <h1 className="text-xl font-semibold">Pending approvals</h1>
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
                className="flex items-center justify-between rounded-xl border border-border bg-surface p-4 hover:border-border-strong"
              >
                <div>
                  <p className="text-sm font-medium">{item.staffName}</p>
                  <p className="text-xs text-text-secondary">
                    {DEPARTMENT_LABEL[item.department]} · {monthLabel(item.year, item.month)}
                    {item.cycleNumber > 1 ? ` · Resubmitted (cycle ${item.cycleNumber})` : ""}
                  </p>
                </div>
                <span className="text-xs font-medium text-text-muted">
                  {APPROVAL_TYPE_LABEL[item.approvalType]} review
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
