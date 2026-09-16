"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { AttendanceGrid } from "@/components/AttendanceGrid";
import {
  type AttendanceStatus,
  type Department,
  type TimesheetStatus,
  TIMESHEET_STATUS_LABEL,
  DEPARTMENT_LABEL,
  daysInMonth,
  dateKey,
  monthLabel,
} from "@/lib/timesheet";
import { SignOutButton } from "./SignOutButton";

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

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const [fullName, setFullName] = useState("");
  const [timesheet, setTimesheet] = useState<Timesheet | null>(null);
  const [entries, setEntries] = useState<Record<string, AttendanceStatus>>({});
  // Only meaningful when timesheet.status === 'returning': null once the
  // return path has genuinely reached staff (editable), otherwise the id of
  // whichever approver still needs to acknowledge first.
  const [returnRecipient, setReturnRecipient] = useState<string | null>(null);

  function goToPreviousMonth() {
    setNotice(null);
    setError(null);
    setViewMonth((m) => (m === 1 ? 12 : m - 1));
    setViewYear((y) => (viewMonth === 1 ? y - 1 : y));
  }

  function goToNextMonth() {
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
        .select("full_name, location")
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

        const { data: created, error: createError } = await supabase
          .from("timesheets")
          .insert({
            staff_id: userId,
            location: profile.location,
            department: assignment.department,
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

      setFullName(profile.full_name);
      setTimesheet(current);
      setEntries(
        Object.fromEntries((attendance ?? []).map((row) => [row.date, row.status as AttendanceStatus])),
      );
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
  const filledDays = Object.keys(entries).length;

  function setDay(day: number, status: AttendanceStatus) {
    setEntries((prev) => ({ ...prev, [dateKey(viewYear, viewMonth, day)]: status }));
  }

  async function handleSaveDraft() {
    if (!timesheet) return;
    setSaving(true);
    setError(null);
    setNotice(null);

    const rows = Object.entries(entries).map(([date, status]) => ({
      timesheet_id: timesheet.id,
      date,
      status,
    }));

    const { error: upsertError } = await supabase
      .from("attendance_entries")
      .upsert(rows, { onConflict: "timesheet_id,date" });

    setSaving(false);
    if (upsertError) {
      setError("Couldn't save your draft.");
      return;
    }
    setNotice("Draft saved.");
  }

  async function handleSubmit() {
    if (!timesheet) return;
    if (filledDays < totalDays) {
      setError(`Fill in all ${totalDays} days before submitting — ${totalDays - filledDays} remaining.`);
      return;
    }

    setSubmitting(true);
    setError(null);
    setNotice(null);

    const rows = Object.entries(entries).map(([date, status]) => ({
      timesheet_id: timesheet.id,
      date,
      status,
    }));
    const { error: upsertError } = await supabase
      .from("attendance_entries")
      .upsert(rows, { onConflict: "timesheet_id,date" });
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
    if (refreshed) setTimesheet(refreshed as Timesheet);
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
        aria-label="Next month"
        className="rounded-lg border border-border-strong px-2.5 py-1 text-sm font-medium"
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
          <SignOutButton />
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
          <SignOutButton />
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
          <SignOutButton />
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
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-1">
          {monthNav}
          <p className="text-sm text-text-secondary">
            {fullName} · {timesheet.location} · {DEPARTMENT_LABEL[timesheet.department]}
          </p>
        </div>
        <SignOutButton />
      </div>

      <div className="rounded-lg border border-border-strong bg-surface-2 px-4 py-2 text-base font-semibold text-text-primary">
        {TIMESHEET_STATUS_LABEL[timesheet.status]}
      </div>
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
      />

      {editable && (
        <p className="text-sm text-text-secondary">
          {filledDays} of {totalDays} days filled.
        </p>
      )}

      {error && <p className="text-sm text-returning">{error}</p>}
      {notice && <p className="text-sm text-approved">{notice}</p>}

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
            disabled={saving || submitting}
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
