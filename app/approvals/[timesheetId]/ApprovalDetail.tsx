"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { AttendanceGrid } from "@/components/AttendanceGrid";
import {
  type AttendanceStatus,
  type ApprovalType,
  type Department,
  type TimesheetStatus,
  timesheetStatusLabel,
  DEPARTMENT_LABEL,
  APPROVAL_TYPE_ACTIVE_STATUS,
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

export function ApprovalDetail({ userId, timesheetId }: { userId: string; timesheetId: string }) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  const [timesheet, setTimesheet] = useState<Timesheet | null>(null);
  const [entries, setEntries] = useState<Record<string, AttendanceStatus>>({});
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [commentError, setCommentError] = useState<string | null>(null);

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
        setError("Couldn't load this timesheet — you may not have access to it.");
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

      const { data: myStepRow, error: myStepError } = await supabase
        .from("approval_steps")
        .select("id, cycle_number, approval_type, status")
        .eq("timesheet_id", timesheetId)
        .eq("approver_id", userId)
        .order("cycle_number", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      if (myStepError) {
        setError("Couldn't load your approval step for this timesheet.");
        setLoading(false);
        return;
      }

      // See APPROVAL_TYPE_ACTIVE_STATUS: the timesheet's own status (not a
      // client-side read of sibling approval_steps rows, which RLS only
      // exposes for the caller's own row) is the correct source for "is it
      // genuinely my turn."
      let blocked: string | null = null;
      if (!myStepRow) {
        blocked = "You aren't an approver on this timesheet.";
      } else if (myStepRow.status !== "pending") {
        blocked = `You already ${myStepRow.status} this timesheet.`;
      } else if (ts.status !== APPROVAL_TYPE_ACTIVE_STATUS[myStepRow.approval_type as ApprovalType]) {
        blocked = "An earlier approver hasn't acted on this timesheet yet.";
      }

      setTimesheet(ts as unknown as Timesheet);
      setEntries(
        Object.fromEntries((attendance ?? []).map((row) => [row.date, row.status as AttendanceStatus])),
      );
      setBlockedReason(blocked);
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [supabase, userId, timesheetId]);

  async function handleApprove() {
    setActing(true);
    setError(null);
    setNotice(null);
    const { error: rpcError } = await supabase.rpc("approve_timesheet", {
      p_timesheet_id: timesheetId,
      p_comment: comment.trim() || null,
    });
    if (rpcError) {
      setActing(false);
      setError(rpcError.message);
      return;
    }
    await refreshTimesheetStatus();
    setActing(false);
    setNotice("Timesheet approved.");
    setBlockedReason("You already approved this timesheet.");
  }

  async function handleDecline() {
    if (comment.trim().length === 0) {
      setCommentError("A comment is required to decline.");
      return;
    }
    setCommentError(null);
    setActing(true);
    setError(null);
    setNotice(null);
    const { error: rpcError } = await supabase.rpc("decline_timesheet", {
      p_timesheet_id: timesheetId,
      p_comment: comment.trim(),
    });
    if (rpcError) {
      setActing(false);
      setError(rpcError.message);
      return;
    }
    await refreshTimesheetStatus();
    setActing(false);
    setNotice("Timesheet declined and returned.");
    setBlockedReason("You already declined this timesheet.");
  }

  async function refreshTimesheetStatus() {
    const { data: refreshed } = await supabase
      .from("timesheets")
      .select("status")
      .eq("id", timesheetId)
      .single();
    if (refreshed) {
      setTimesheet((prev) => (prev ? { ...prev, status: refreshed.status } : prev));
    }
  }

  if (loading) {
    return <p className="text-sm text-text-secondary">Loading…</p>;
  }

  if (error && !timesheet) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-returning">{error}</p>
        <Link href="/approvals" className="text-sm text-accent-on-tint underline">
          Back to pending approvals
        </Link>
      </div>
    );
  }

  if (!timesheet) return null;

  const canAct = !blockedReason;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent-on-tint">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M16 2v4M8 2v4M3 10h18" />
            </svg>
          </span>
          <div>
            <Link href="/approvals" className="text-xs text-text-secondary hover:text-text-primary">
              ← Pending approvals
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

      <p className="rounded-lg border border-border-strong bg-surface-2 px-4 py-2 text-base font-semibold">
        {timesheetStatusLabel(timesheet.status, timesheet.department)}
      </p>

      <AttendanceGrid
        year={timesheet.year}
        month={timesheet.month}
        entries={entries}
        editable={false}
      />

      {error && <p className="text-sm text-returning">{error}</p>}
      {notice && <p className="text-sm text-approved">{notice}</p>}
      {!canAct && !notice && <p className="text-sm text-text-secondary">{blockedReason}</p>}

      {canAct && (
        <div className="flex flex-col gap-3 rounded-xl border border-border border-l-4 border-l-accent bg-surface p-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="comment" className="text-sm font-medium">
              Comment
              <span className="ml-1 font-normal text-text-muted">(required to decline)</span>
            </label>
            <textarea
              id="comment"
              rows={3}
              value={comment}
              onChange={(e) => {
                setComment(e.target.value);
                if (commentError) setCommentError(null);
              }}
              className="rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
              placeholder="Optional for approval, required for decline"
            />
            {commentError && <p className="text-sm text-returning">{commentError}</p>}
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleDecline}
              disabled={acting}
              className="rounded-lg border border-border-strong px-4 py-2 text-sm font-medium outline-none transition-colors hover:border-text-muted focus-visible:ring-2 focus-visible:ring-accent/30 disabled:opacity-60"
            >
              {acting ? "Working…" : "Decline"}
            </button>
            <button
              type="button"
              onClick={handleApprove}
              disabled={acting}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent outline-none transition-colors hover:bg-accent-on-tint focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
            >
              {acting ? "Working…" : "Approve"}
            </button>
          </div>
        </div>
      )}

      {notice && (
        <button
          type="button"
          onClick={() => router.push("/approvals")}
          className="self-start rounded-lg border border-border-strong px-4 py-2 text-sm font-medium outline-none transition-colors hover:border-text-muted focus-visible:ring-2 focus-visible:ring-accent/30"
        >
          Back to pending approvals
        </button>
      )}
    </div>
  );
}
