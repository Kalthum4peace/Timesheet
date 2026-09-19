"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { AttendanceGrid } from "@/components/AttendanceGrid";
import { StatusPill } from "@/components/StatusPill";
import {
  type AttendanceStatus,
  type Department,
  type TimesheetStatus,
  timesheetStatusLabel,
  DEPARTMENT_LABEL,
  monthLabel,
} from "@/lib/timesheet";

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

export function ReturnedItemDetail({ userId, timesheetId }: { userId: string; timesheetId: string }) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  const [timesheet, setTimesheet] = useState<Timesheet | null>(null);
  const [entries, setEntries] = useState<Record<string, AttendanceStatus>>({});
  const [declineComment, setDeclineComment] = useState<string | null>(null);
  const [isMyTurn, setIsMyTurn] = useState(false);

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

      // Visible broadly to any approver who can see the timesheet — this
      // table's RLS delegates to timesheets' own visibility, unlike
      // approval_steps which restricts to the caller's own row.
      const { data: declineAction } = await supabase
        .from("timesheet_actions")
        .select("comment, cycle_number")
        .eq("timesheet_id", timesheetId)
        .eq("action", "declined")
        .order("cycle_number", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;

      const { data: recipientId, error: recipientError } = await supabase.rpc(
        "current_return_recipient",
        { p_timesheet_id: timesheetId },
      );
      if (cancelled) return;
      if (recipientError) {
        setError("Couldn't check whether it's your turn to acknowledge this.");
        setLoading(false);
        return;
      }

      setTimesheet(ts as unknown as Timesheet);
      setEntries(
        Object.fromEntries((attendance ?? []).map((row) => [row.date, row.status as AttendanceStatus])),
      );
      setDeclineComment(declineAction?.comment ?? null);
      setIsMyTurn(recipientId === userId);
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [supabase, userId, timesheetId]);

  async function handleAcknowledge() {
    setActing(true);
    setError(null);
    setNotice(null);
    const { error: rpcError } = await supabase.rpc("acknowledge_return_timesheet", {
      p_timesheet_id: timesheetId,
    });
    setActing(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setIsMyTurn(false);
    setNotice("Return acknowledged.");
  }

  if (loading) {
    return <p className="text-sm text-text-secondary">Loading…</p>;
  }

  if (error && !timesheet) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-returning">{error}</p>
        <Link href="/returned-items" className="text-sm text-accent-on-tint underline">
          Back to returned items
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
              <polyline points="9 14 4 9 9 4" />
              <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
            </svg>
          </span>
          <div>
            <Link href="/returned-items" className="text-xs text-text-secondary hover:text-text-primary">
              ← Returned items
            </Link>
            <h1 className="mt-1 text-xl font-semibold">{monthLabel(timesheet.year, timesheet.month)}</h1>
            <p className="text-sm text-text-secondary">
              {timesheet.profiles?.full_name ?? "Unknown staff"} · {timesheet.location} ·{" "}
              {DEPARTMENT_LABEL[timesheet.department]}
            </p>
          </div>
        </div>
      </div>

      <StatusPill label={timesheetStatusLabel(timesheet.status, timesheet.department)} />

      {declineComment && (
        <div className="rounded-xl border border-returning-bg bg-returning-bg p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-returning">Decline comment</p>
          <p className="mt-1 text-sm text-text-primary">{declineComment}</p>
        </div>
      )}

      <AttendanceGrid year={timesheet.year} month={timesheet.month} entries={entries} editable={false} />

      {error && <p className="text-sm text-returning">{error}</p>}
      {notice && <p className="text-sm text-approved">{notice}</p>}
      {!isMyTurn && !notice && (
        <p className="text-sm text-text-secondary">
          This isn&apos;t waiting on you right now — either it hasn&apos;t reached you yet, or
          you&apos;ve already acknowledged it.
        </p>
      )}

      {isMyTurn && (
        <div className="flex flex-col gap-3 rounded-xl border border-border border-l-4 border-l-accent bg-surface p-4">
          <p className="text-sm text-text-secondary">
            Acknowledging lets this return continue on its way back to the staff member.
          </p>
          <button
            type="button"
            onClick={handleAcknowledge}
            disabled={acting}
            className="self-start rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent outline-none transition-colors hover:bg-accent-on-tint focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
          >
            {acting ? "Working…" : "Acknowledge"}
          </button>
        </div>
      )}

      {notice && (
        <button
          type="button"
          onClick={() => router.push("/returned-items")}
          className="self-start rounded-lg border border-border-strong px-4 py-2 text-sm font-medium outline-none transition-colors hover:border-text-muted focus-visible:ring-2 focus-visible:ring-accent/30"
        >
          Back to returned items
        </button>
      )}
    </div>
  );
}
