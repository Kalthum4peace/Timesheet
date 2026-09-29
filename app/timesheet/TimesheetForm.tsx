"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { AttendanceGrid } from "@/components/AttendanceGrid";
import { StatusPill } from "@/components/StatusPill";
import { fetchPendingFinalApprovers } from "@/lib/pendingApprovers";
import { fetchAppToday } from "@/lib/appToday";
import { leadershipDepartment } from "@/lib/ownTimesheetDepartment";
import {
  type ApprovalType,
  type AttendanceStatus,
  type Department,
  type TimesheetStatus,
  timesheetStatusLabel,
  DEPARTMENT_LABEL,
  daysInMonth,
  dateKey,
  monthLabel,
  unfilledDays,
} from "@/lib/timesheet";

type Timesheet = {
  id: string;
  staff_id: string;
  location: string;
  department: Department;
  month: number;
  year: number;
  status: TimesheetStatus;
};

const MIN_YEAR = 2020;

export function TimesheetForm({ userId }: { userId: string }) {
  const supabase = useMemo(() => createClient(), []);
  const now = useMemo(() => new Date(), []);
  const realMonth = now.getMonth() + 1;
  const realYear = now.getFullYear();

  const [viewMonth, setViewMonth] = useState(realMonth);
  const [viewYear, setViewYear] = useState(realYear);
  const isCurrentMonth = viewMonth === realMonth && viewYear === realYear;
  const atEarliestMonth = viewYear <= MIN_YEAR && viewMonth <= 1;
  // Client feedback (demo, 2026-09-18): staff must not be able to reach a
  // future month at all — nothing to view there, and nothing should be
  // fillable. The real enforcement is server-side (timesheets_insert_staff
  // RLS policy); this just stops the UI from ever offering the dead end.
  const atLatestMonth = isCurrentMonth;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const [fullName, setFullName] = useState("");
  const [timesheet, setTimesheet] = useState<Timesheet | null>(null);
  const [entries, setEntries] = useState<Record<string, AttendanceStatus>>({});
  // Today's date key as the database sees it (see lib/appToday.ts). Days
  // after it can't be entered — the database rejects them.
  const [today, setToday] = useState<string | null>(null);
  // date key -> holiday name(s), national and organisation scope merged.
  const [holidays, setHolidays] = useState<Record<string, string>>({});
  // Only meaningful when timesheet.status === 'returning': null once the
  // return path has genuinely reached staff (editable), otherwise the id of
  // whichever approver still needs to acknowledge first.
  const [returnRecipient, setReturnRecipient] = useState<string | null>(null);
  // Which of SPM/HR are still pending — only meaningful at
  // pending_final_review, drives the role-aware status label.
  const [pendingFinal, setPendingFinal] = useState<ApprovalType[] | undefined>(undefined);

  function goToPreviousMonth() {
    setNotice(null);
    setError(null);
    setViewMonth((m) => (m === 1 ? 12 : m - 1));
    setViewYear((y) => (viewMonth === 1 ? y - 1 : y));
  }

  function goToNextMonth() {
    if (atLatestMonth) return;
    setNotice(null);
    setError(null);
    setViewMonth((m) => (m === 12 ? 1 : m + 1));
    setViewYear((y) => (viewMonth === 12 ? y + 1 : y));
  }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      setNotFound(false);
      setTimesheet(null);

      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("full_name, location, role")
        .eq("id", userId)
        .single();
      if (cancelled) return;
      if (profileError || !profile) {
        setError("Couldn't load your profile.");
        setLoading(false);
        return;
      }

      const { data: existing, error: existingError } = await supabase
        .from("timesheets")
        .select("id, staff_id, location, department, month, year, status")
        .eq("staff_id", userId)
        .eq("month", viewMonth)
        .eq("year", viewYear)
        .maybeSingle();
      if (cancelled) return;
      if (existingError) {
        setError("Couldn't load this month's timesheet.");
        setLoading(false);
        return;
      }

      let current = existing as Timesheet | null;

      // Auto-creating a draft only makes sense for the real current month —
      // navigating to a browsed past/future month should never spontaneously
      // create a stray timesheet row just because none exists yet.
      if (!current && isCurrentMonth) {
        // Leaders (team lead, department head, SPM, HR/Admin) have no
        // assignment row and don't need one — their department is fixed by
        // role (lib/ownTimesheetDepartment.ts). Everyone else, staff above
        // all, still needs a real assignment.
        let department = leadershipDepartment(profile.role);
        if (!department) {
          const { data: assignment, error: assignmentError } = await supabase
            .from("organizational_assignments")
            .select("department")
            .eq("staff_id", userId)
            .is("effective_to", null)
            .maybeSingle();
          if (cancelled) return;
          if (assignmentError || !assignment) {
            setError("You don't have a current department assignment yet — ask your administrator.");
            setLoading(false);
            return;
          }
          department = assignment.department as Department;
        }

        const { data: created, error: createError } = await supabase
          .from("timesheets")
          .insert({
            staff_id: userId,
            location: profile.location,
            department,
            month: viewMonth,
            year: viewYear,
            status: "draft",
          })
          .select("id, staff_id, location, department, month, year, status")
          .single();
        if (cancelled) return;
        if (createError || !created) {
          setError("Couldn't start this month's timesheet.");
          setLoading(false);
          return;
        }
        current = created as Timesheet;
      }

      if (!current) {
        setFullName(profile.full_name);
        setNotFound(true);
        setLoading(false);
        return;
      }

      const { data: attendance, error: attendanceError } = await supabase
        .from("attendance_entries")
        .select("date, status")
        .eq("timesheet_id", current.id);
      if (cancelled) return;
      if (attendanceError) {
        setError("Couldn't load your attendance entries.");
        setLoading(false);
        return;
      }

      // Public holidays for the viewed month. Purely helpful: if this read
      // fails the sheet still works, just without the suggestions.
      const { data: holidayRows } = await supabase
        .from("public_holidays")
        .select("date, name")
        .gte("date", dateKey(viewYear, viewMonth, 1))
        .lte("date", dateKey(viewYear, viewMonth, daysInMonth(viewYear, viewMonth)));
      if (cancelled) return;
      const holidayNames: Record<string, string[]> = {};
      for (const row of holidayRows ?? []) {
        const names = (holidayNames[row.date] ??= []);
        if (!names.includes(row.name)) names.push(row.name);
      }
      const holidayMap = Object.fromEntries(Object.entries(holidayNames).map(([d, names]) => [d, names.join(" / ")]));

      const serverToday = await fetchAppToday(supabase);
      if (cancelled) return;

      let recipient: string | null = null;
      if (current.status === "returning") {
        const { data: recipientId, error: recipientError } = await supabase.rpc(
          "current_return_recipient",
          { p_timesheet_id: current.id },
        );
        if (cancelled) return;
        if (recipientError) {
          setError("Couldn't check whether this return has reached you yet.");
          setLoading(false);
          return;
        }
        recipient = recipientId;
      }

      let finalPending: ApprovalType[] | undefined;
      if (current.status === "pending_final_review") {
        const byTimesheet = await fetchPendingFinalApprovers(supabase, [current.id]);
        if (cancelled) return;
        finalPending = byTimesheet[current.id];
      }

      setFullName(profile.full_name);
      setPendingFinal(finalPending);
      setTimesheet(current);
      const loaded: Record<string, AttendanceStatus> = Object.fromEntries(
        (attendance ?? []).map((row) => [row.date, row.status as AttendanceStatus]),
      );
      // Suggest PH on holidays the staff member hasn't filled in — but only
      // while the sheet is actually editable, never over a day they (or an
      // earlier save) already set, and NEVER for a day that hasn't arrived:
      // a future-dated row would make the database reject the whole
      // save-draft batch (attendance_entries takes no date after today). An
      // upcoming holiday is suggested on a later visit, once its day is here.
      // It is a starting value, not a lock: it isn't saved until they save,
      // and they can change it.
      const editableNow =
        current.status === "draft" || (current.status === "returning" && recipient === null);
      if (editableNow) {
        for (const date of Object.keys(holidayMap)) {
          if (!(date in loaded) && date <= serverToday) loaded[date] = "public_holiday";
        }
      }
      setToday(serverToday);
      setHolidays(holidayMap);
      setEntries(loaded);
      setReturnRecipient(recipient);
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [supabase, userId, viewMonth, viewYear, isCurrentMonth]);

  // 'returning' alone isn't enough — the return has to have actually
  // traveled all the way back to staff (current_return_recipient === null)
  // before editing/resubmitting is genuinely allowed. resubmit_timesheet
  // enforces this server-side regardless, but the UI should reflect it
  // rather than show an editable form that would just fail on submit.
  const editable =
    timesheet?.status === "draft" || (timesheet?.status === "returning" && returnRecipient === null);
  const totalDays = daysInMonth(viewYear, viewMonth);
  const unfilled = today ? unfilledDays(viewYear, viewMonth, entries, today) : null;
  // One timesheet per staff per month, and it locks on submission — so it can
  // only be submitted once every day, including the last, has been filled in.
  // The database enforces that (missing_attendance_days); this just says why
  // the button is unavailable instead of letting it fail.
  const canSubmit = unfilled !== null && unfilled.fillableNow === 0 && unfilled.stillToCome === 0;
  const lastDayLabel = `${totalDays} ${new Date(viewYear, viewMonth - 1, 1).toLocaleDateString("en-US", { month: "long" })}`;
  const submitBlockedReason = (() => {
    if (!unfilled || canSubmit) return null;
    const { fillableNow, stillToCome } = unfilled;
    const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
    if (fillableNow > 0 && stillToCome > 0) {
      return `Fill in the ${days(fillableNow)} still empty up to today. The month can be submitted once every day is filled in — that's from ${lastDayLabel}, its last day.`;
    }
    if (fillableNow > 0) return `Fill in the ${days(fillableNow)} still empty before submitting.`;
    return `You can submit once the month is complete — from ${lastDayLabel}, when its last day can be filled in. Days after today open up one at a time.`;
  })();

  // Only days that have arrived are ever sent. A row already stored with a
  // future date (a sheet pre-filled before the rule existed) is left as it is:
  // re-sending it would make the database reject the entire batch.
  function savableRows(timesheetId: string) {
    return Object.entries(entries)
      .filter(([date]) => today === null || date <= today)
      .map(([date, status]) => ({ timesheet_id: timesheetId, date, status }));
  }

  function setDay(day: number, status: AttendanceStatus) {
    setEntries((prev) => ({ ...prev, [dateKey(viewYear, viewMonth, day)]: status }));
  }

  async function handleSaveDraft() {
    if (!timesheet) return;
    setSaving(true);
    setError(null);
    setNotice(null);

    const rows = savableRows(timesheet.id);

    const { error: upsertError } =
      rows.length === 0
        ? { error: null }
        : await supabase.from("attendance_entries").upsert(rows, { onConflict: "timesheet_id,date" });

    setSaving(false);
    if (upsertError) {
      setError("Couldn't save your draft.");
      return;
    }
    setNotice("Draft saved.");
  }

  async function handleSubmit() {
    if (!timesheet) return;
    if (!canSubmit) {
      setError(submitBlockedReason ?? "This timesheet can't be submitted yet.");
      return;
    }

    setSubmitting(true);
    setError(null);
    setNotice(null);

    const rows = savableRows(timesheet.id);
    const { error: upsertError } =
      rows.length === 0
        ? { error: null }
        : await supabase.from("attendance_entries").upsert(rows, { onConflict: "timesheet_id,date" });
    if (upsertError) {
      setSubmitting(false);
      setError("Couldn't save your entries before submitting.");
      return;
    }

    const rpcName = timesheet.status === "returning" ? "resubmit_timesheet" : "submit_timesheet";
    const { error: submitError } = await supabase.rpc(rpcName, {
      p_timesheet_id: timesheet.id,
    });
    if (submitError) {
      setSubmitting(false);
      setError(submitError.message);
      return;
    }

    const { data: refreshed } = await supabase
      .from("timesheets")
      .select("id, staff_id, location, department, month, year, status")
      .eq("id", timesheet.id)
      .single();
    if (refreshed) {
      // An approver-role staff member's own timesheet goes straight to
      // pending_final_review on submit — the label needs the pending list
      // right away, not only after a reload.
      if (refreshed.status === "pending_final_review") {
        const byTimesheet = await fetchPendingFinalApprovers(supabase, [refreshed.id]);
        setPendingFinal(byTimesheet[refreshed.id]);
      } else {
        setPendingFinal(undefined);
      }
      setTimesheet(refreshed as Timesheet);
    }
    setSubmitting(false);
    setNotice(rpcName === "resubmit_timesheet" ? "Timesheet resubmitted." : "Timesheet submitted.");
  }

  const monthNav = (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={goToPreviousMonth}
        disabled={atEarliestMonth}
        aria-label="Previous month"
        className="rounded-lg border border-border-strong px-2.5 py-1 text-sm font-medium disabled:opacity-40"
      >
        ‹
      </button>
      <h1 className="min-w-[11ch] text-center text-xl font-semibold">{monthLabel(viewYear, viewMonth)}</h1>
      <button
        type="button"
        onClick={goToNextMonth}
        disabled={atLatestMonth}
        aria-label="Next month"
        className="rounded-lg border border-border-strong px-2.5 py-1 text-sm font-medium disabled:opacity-40"
      >
        ›
      </button>
    </div>
  );

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex items-start justify-between">
          {monthNav}
        </div>
        <p className="text-sm text-text-secondary">Loading…</p>
      </div>
    );
  }

  if (error && !timesheet) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex items-start justify-between">
          {monthNav}
        </div>
        <p className="text-sm text-returning">{error}</p>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex items-start justify-between">
          {monthNav}
        </div>
        <p className="text-sm text-text-secondary">
          {isCurrentMonth
            ? "Couldn't start this month's timesheet."
            : `No timesheet exists for ${monthLabel(viewYear, viewMonth)}.`}
        </p>
      </div>
    );
  }

  if (!timesheet) return null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent-on-tint">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M16 2v4M8 2v4M3 10h18" />
            </svg>
          </span>
          <div className="flex flex-col gap-1">
            {monthNav}
            <p className="text-sm text-text-secondary">
              {fullName} · {timesheet.location} · {DEPARTMENT_LABEL[timesheet.department]}
            </p>
          </div>
        </div>
      </div>

      <StatusPill label={timesheetStatusLabel(timesheet.status, timesheet.department, pendingFinal)} />
      {timesheet.status === "returning" && returnRecipient !== null && (
        <p className="text-sm text-text-secondary">
          Still on its way back to you — an earlier approver needs to acknowledge it first.
        </p>
      )}

      <AttendanceGrid
        year={viewYear}
        month={viewMonth}
        entries={entries}
        editable={editable}
        onChange={setDay}
        holidays={holidays}
        today={today ?? undefined}
      />

      {error && <p className="text-sm text-returning">{error}</p>}
      {notice && <p className="text-sm text-approved">{notice}</p>}

      {editable && submitBlockedReason && (
        <p id="submit-hint" className="text-sm text-text-secondary">
          {submitBlockedReason}
        </p>
      )}

      {editable && (
        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleSaveDraft}
            disabled={saving || submitting}
            className="rounded-lg border border-border-strong px-4 py-2 text-sm font-medium disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save draft"}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving || submitting || !canSubmit}
            aria-describedby={submitBlockedReason ? "submit-hint" : undefined}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent disabled:opacity-60"
          >
            {submitting
              ? "Submitting…"
              : timesheet.status === "returning"
                ? "Resubmit timesheet"
                : "Submit timesheet"}
          </button>
        </div>
      )}
    </div>
  );
}
