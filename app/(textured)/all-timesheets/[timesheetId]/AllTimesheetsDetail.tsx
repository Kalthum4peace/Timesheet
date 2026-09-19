"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { AttendanceGrid } from "@/components/AttendanceGrid";
import { StatusPill } from "@/components/StatusPill";
import { fetchPendingFinalApprovers } from "@/lib/pendingApprovers";
import {
  type ApprovalType,
  type AttendanceStatus,
  type Department,
  type TimesheetStatus,
  timesheetStatusLabel,
  DEPARTMENT_LABEL,
  monthLabel,
} from "@/lib/timesheet";
import { SignOutButton } from "@/app/timesheet/SignOutButton";

type Timesheet = {
  id: string;
  staff_id: string;
  location: string;
  department: Department;
  month: number;
  year: number;
  status: TimesheetStatus;
  profiles: { full_name: string } | null;
};

type ActionType =
  | "submitted"
  | "approved"
  | "declined"
  | "return_acknowledged"
  | "edited"
  | "resubmitted";

const ACTION_LABEL: Record<ActionType, string> = {
  submitted: "submitted",
  approved: "approved",
  declined: "declined",
  return_acknowledged: "acknowledged the return",
  edited: "edited",
  resubmitted: "resubmitted",
};

type ActionRow = {
  action: ActionType;
  comment: string | null;
  cycle_number: number;
  created_at: string;
  profiles: { full_name: string } | null;
};

export function AllTimesheetsDetail({ timesheetId }: { timesheetId: string }) {
  const supabase = useMemo(() => createClient(), []);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timesheet, setTimesheet] = useState<Timesheet | null>(null);
  const [entries, setEntries] = useState<Record<string, AttendanceStatus>>({});
  const [actions, setActions] = useState<ActionRow[]>([]);
  const [pendingFinal, setPendingFinal] = useState<ApprovalType[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      const { data: ts, error: tsError } = await supabase
        .from("timesheets")
        .select("id, staff_id, location, department, month, year, status, profiles(full_name)")
        .eq("id", timesheetId)
        .maybeSingle();
      if (cancelled) return;
      if (tsError || !ts) {
        setError("Couldn't load this timesheet.");
        setLoading(false);
        return;
      }

      const { data: attendance, error: attendanceError } = await supabase
        .from("attendance_entries")
        .select("date, status")
        .eq("timesheet_id", timesheetId);
      if (cancelled) return;
      if (attendanceError) {
        setError("Couldn't load attendance entries.");
        setLoading(false);
        return;
      }

      const { data: actionRows, error: actionsError } = await supabase
        .from("timesheet_actions")
        .select("action, comment, cycle_number, created_at, profiles(full_name)")
        .eq("timesheet_id", timesheetId)
        .order("created_at", { ascending: true });
      if (cancelled) return;
      if (actionsError) {
        setError("Couldn't load this timesheet's history.");
        setLoading(false);
        return;
      }

      let finalPending: ApprovalType[] | undefined;
      if (ts.status === "pending_final_review") {
        const byTimesheet = await fetchPendingFinalApprovers(supabase, [timesheetId]);
        if (cancelled) return;
        finalPending = byTimesheet[timesheetId];
      }

      setPendingFinal(finalPending);
      setTimesheet(ts as unknown as Timesheet);
      setEntries(
        Object.fromEntries((attendance ?? []).map((row) => [row.date, row.status as AttendanceStatus])),
      );
      setActions((actionRows ?? []) as unknown as ActionRow[]);
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [supabase, timesheetId]);

  if (loading) {
    return <p className="text-sm text-text-secondary">Loading…</p>;
  }

  if (error && !timesheet) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-returning">{error}</p>
        <Link href="/all-timesheets" className="text-sm text-accent-on-tint underline">
          Back to all timesheets
        </Link>
      </div>
    );
  }

  if (!timesheet) return null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent-on-tint">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
          </span>
          <div>
            <Link href="/all-timesheets" className="text-xs text-text-secondary hover:text-text-primary">
              ← All timesheets
            </Link>
            <h1 className="mt-1 text-xl font-semibold">{monthLabel(timesheet.year, timesheet.month)}</h1>
            <p className="text-sm text-text-secondary">
              {timesheet.profiles?.full_name ?? "Unknown staff"} · {timesheet.location} ·{" "}
              {DEPARTMENT_LABEL[timesheet.department]}
            </p>
          </div>
        </div>
        <SignOutButton />
      </div>

      <StatusPill label={timesheetStatusLabel(timesheet.status, timesheet.department, pendingFinal)} />

      <AttendanceGrid year={timesheet.year} month={timesheet.month} entries={entries} editable={false} />

      {actions.length > 0 && (
        <div className="flex flex-col gap-1 rounded-xl border border-border border-l-4 border-l-accent bg-surface p-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">History</p>
          {actions.map((a, i) => (
            <div key={i} className="border-t border-border py-2 text-sm first:border-t-0 first:pt-0">
              <p>
                <span className="font-medium">{a.profiles?.full_name ?? "Unknown"}</span>{" "}
                {ACTION_LABEL[a.action]}
                {a.cycle_number > 1 ? ` (cycle ${a.cycle_number})` : ""} ·{" "}
                <span className="text-text-muted">
                  {new Date(a.created_at).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </span>
              </p>
              {a.comment && <p className="mt-0.5 text-text-secondary">&ldquo;{a.comment}&rdquo;</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
